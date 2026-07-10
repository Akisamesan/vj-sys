// 88 MAZE — a growing maze carved by randomized depth-first backtracking on a fixed
// grid. CPU-side state machine: a stack of visited cells, one carve/backtrack step at
// a time (never wall-clock driven — the step budget each frame comes from dt and
// audio.bass). Carved rooms and corridors are axis-aligned quads (two triangles each,
// never GL_LINES — see SCENES.md's LOW_VIS quad-expansion recipe, same technique as
// coral.ts/ribbons.ts/verlet.ts) so the maze reads at any resolution including the
// 640x360 headless QA capture. Two generation slots ping-pong: when the active maze's
// stack empties (every cell visited), a fresh maze starts growing in the other slot
// while the finished one fades out over a few seconds — a seamless regrow with no
// flash cut. Additive quads + a bright frontier spark through HDR PostFX over a still
// dark circuit-board backdrop.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const GRID = 22;
const CELLN = GRID * GRID;
const HALF = 0.86;
const CELL = (2 * HALF) / GRID;
const FILL = 0.72;
const HALFW_BASE = CELL * 0.5 * FILL;
const STEP_BASE = 9; // carve steps/sec in silence
const STEP_BASS_SCALE = 20; // extra steps/sec at full bass
const MAX_STEPS_FRAME = 48;
const KICK_BURST = 7; // steps taken at once on a kick (structural trigger)
const RETIRE_DECAY = 0.85; // fade-out rate of a completed maze, per second
const RECENCY_DECAY = 1.3; // "just carved" glow decay, per second
const PULSE_SLOTS = 16;
const PULSE_DECAY = 2.2;
const WARMUP_STEPS = 140; // fixed-step growth at mount so t=0 is never a bare seed

const EMPTY = 0;
const ACTIVE = 1;
const RETIRING = 2;

const DX: readonly number[] = [1, -1, 0, 0];
const DY: readonly number[] = [0, 0, 1, -1];

// Lines are camera-facing... here axis-aligned quads, not GL_LINES: gl.lineWidth is
// unhonoured on the headless SwiftShader QA renderer, so 1px lines would vanish there.
const QUAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec3 a_col;
uniform float u_aspect;
out vec3 v_col;
void main(){
  vec2 sc = a_pos;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  v_col = a_col;
}`;

const QUAD_FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Frontier spark / kick-burst pulses: real screen-space size via gl_PointSize, radial
// falloff so it reads as a soft glowing bump rather than a hard square.
const POINT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec3 a_col;
layout(location=2) in float a_size;
uniform float u_aspect, u_pxScale;
out vec3 v_col;
void main(){
  vec2 sc = a_pos;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  gl_PointSize = clamp(u_pxScale * a_size, 1.5, 34.0);
  v_col = a_col;
}`;

const POINT_FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = smoothstep(0.25, 0.0, r2);
  o = vec4(v_col * a, 1.0);
}`;

// Dark circuit-board backdrop: a still vertical gradient plus a faint diagonal scan
// glow tied to bass, so the background itself is never a flat dead pixel.
const BG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform float u_time, u_bass;
void main(){
  vec3 top = vec3(0.022, 0.026, 0.045);
  vec3 bottom = vec3(0.008, 0.010, 0.02);
  vec3 col = mix(bottom, top, v_uv.y);
  float scan = sin((v_uv.x + v_uv.y) * 14.0 - u_time * 0.15);
  scan = smoothstep(0.72, 1.0, scan);
  col += vec3(0.02, 0.05, 0.07) * scan * (0.3 + u_bass * 0.6);
  o = vec4(col, 1.0);
}`;

// Cosine-free three-stop cyclic gradient (cyan -> electric blue -> violet -> cyan),
// used as the maze's circuit hue. Written into `out` at `offset` to avoid per-vertex
// allocation, same pattern as coral.ts's coralColor.
const CYAN: readonly [number, number, number] = [0.25, 0.95, 1.0];
const BLUE: readonly [number, number, number] = [0.32, 0.46, 1.0];
const VIOLET: readonly [number, number, number] = [0.78, 0.3, 1.0];

function mazeColor(phase: number, out: Float32Array, offset: number): void {
  const p = phase - Math.floor(phase);
  let a: readonly [number, number, number];
  let b: readonly [number, number, number];
  let f: number;
  if (p < 1 / 3) {
    a = CYAN;
    b = BLUE;
    f = p * 3;
  } else if (p < 2 / 3) {
    a = BLUE;
    b = VIOLET;
    f = (p - 1 / 3) * 3;
  } else {
    a = VIOLET;
    b = CYAN;
    f = (p - 2 / 3) * 3;
  }
  out[offset] = a[0] + (b[0] - a[0]) * f;
  out[offset + 1] = a[1] + (b[1] - a[1]) * f;
  out[offset + 2] = a[2] + (b[2] - a[2]) * f;
}

export function createMaze(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const progQuad = program(gl, QUAD_VS, QUAD_FS);
  const uQuad: Uniforms = uniforms(gl, progQuad);
  const progPoint = program(gl, POINT_VS, POINT_FS);
  const uPoint: Uniforms = uniforms(gl, progPoint);
  const progBg = program(gl, FULLSCREEN_VS, BG_FS);
  const uBg: Uniforms = uniforms(gl, progBg);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // --- two ping-ponging maze generations, flat arrays indexed by [slot*CELLN + cell] ---
  const visited = new Uint8Array(2 * CELLN);
  const edgeRight = new Uint8Array(2 * CELLN); // passage to cell (x+1,y)
  const edgeDown = new Uint8Array(2 * CELLN); // passage to cell (x,y+1)
  const recency = new Float32Array(2 * CELLN); // "just carved" glow, 1 -> 0
  const stack = new Int32Array(2 * CELLN);
  const stackLen = new Int32Array(2);
  const state = new Int32Array(2).fill(EMPTY);
  const fade = new Float32Array(2);
  const current = new Int32Array(2).fill(-1);
  const dirsScratch = new Int8Array(4);
  let activeSlot = 0;

  function resetGen(g: number): void {
    const base = g * CELLN;
    visited.fill(0, base, base + CELLN);
    edgeRight.fill(0, base, base + CELLN);
    edgeDown.fill(0, base, base + CELLN);
    recency.fill(0, base, base + CELLN);
    const start = (Math.random() * CELLN) | 0;
    visited[base + start] = 1;
    recency[base + start] = 1;
    stack[base] = start;
    stackLen[g] = 1;
    current[g] = start;
    fade[g] = 1;
  }

  function completeGen(g: number): void {
    state[g] = RETIRING;
    fade[g] = 1;
    const other = 1 - g;
    resetGen(other);
    state[other] = ACTIVE;
    activeSlot = other;
  }

  // One DFS step: carve into a random unvisited neighbour, or backtrack if the
  // current cell (stack top) has none left. Returns the cell index touched (for
  // pulse placement) or -1 if the generation just completed and swapped.
  function carveStep(g: number): number {
    if (state[g] !== ACTIVE) return -1;
    if (stackLen[g] === 0) {
      completeGen(g);
      return -1;
    }
    const base = g * CELLN;
    const curIdx = stack[base + stackLen[g] - 1];
    const cx = curIdx % GRID;
    const cy = (curIdx / GRID) | 0;
    let opts = 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID) continue;
      const ni = ny * GRID + nx;
      if (!visited[base + ni]) dirsScratch[opts++] = d;
    }
    if (opts > 0) {
      const d = dirsScratch[(Math.random() * opts) | 0];
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      const ni = ny * GRID + nx;
      if (d === 0) edgeRight[base + curIdx] = 1;
      else if (d === 1) edgeRight[base + ni] = 1;
      else if (d === 2) edgeDown[base + curIdx] = 1;
      else edgeDown[base + ni] = 1;
      visited[base + ni] = 1;
      recency[base + ni] = 1;
      stack[base + stackLen[g]] = ni;
      stackLen[g]++;
      current[g] = ni;
      return ni;
    }
    stackLen[g]--;
    if (stackLen[g] > 0) current[g] = stack[base + stackLen[g] - 1];
    return current[g];
  }

  // --- kick-burst glow pulses: short-lived localised flashes riding the DFS tip ---
  const pulseX = new Float32Array(PULSE_SLOTS);
  const pulseY = new Float32Array(PULSE_SLOTS);
  const pulseLife = new Float32Array(PULSE_SLOTS);
  let pulseCursor = 0;

  function cellX(idx: number): number {
    return -HALF + CELL * ((idx % GRID) + 0.5);
  }
  function cellY(idx: number): number {
    return -HALF + CELL * (((idx / GRID) | 0) + 0.5);
  }

  function pushPulse(idx: number): void {
    pulseX[pulseCursor] = cellX(idx);
    pulseY[pulseCursor] = cellY(idx);
    pulseLife[pulseCursor] = 1;
    pulseCursor = (pulseCursor + 1) % PULSE_SLOTS;
  }

  // Seed the first generation and grow it through a fixed-step warmup (no wall-clock
  // reads) so the very first frame already shows a developed maze, satisfying the
  // BLACK/LOW_VIS floor even in total silence.
  resetGen(0);
  state[0] = ACTIVE;
  for (let s = 0; s < WARMUP_STEPS; s++) carveStep(0);
  recency.fill(0); // warmup growth shouldn't leave residual "just carved" glow at mount

  // --- GL buffers ---
  const MAX_QUADS = CELLN * 4; // generous bound: <=CELLN nodes + <=CELLN edges, x2 gens
  const quadBuf = new Float32Array(MAX_QUADS * 6 * 5); // 6 verts/quad, x,y,r,g,b
  const MAX_POINTS = PULSE_SLOTS + 4;
  const pointBuf = new Float32Array(MAX_POINTS * 6); // x,y,r,g,b,size
  const colorScratch = new Float32Array(3);

  function pushQuad(
    qi: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    g: number,
    b: number,
  ): number {
    quadBuf[qi++] = x0;
    quadBuf[qi++] = y0;
    quadBuf[qi++] = r;
    quadBuf[qi++] = g;
    quadBuf[qi++] = b;
    quadBuf[qi++] = x1;
    quadBuf[qi++] = y0;
    quadBuf[qi++] = r;
    quadBuf[qi++] = g;
    quadBuf[qi++] = b;
    quadBuf[qi++] = x0;
    quadBuf[qi++] = y1;
    quadBuf[qi++] = r;
    quadBuf[qi++] = g;
    quadBuf[qi++] = b;
    quadBuf[qi++] = x0;
    quadBuf[qi++] = y1;
    quadBuf[qi++] = r;
    quadBuf[qi++] = g;
    quadBuf[qi++] = b;
    quadBuf[qi++] = x1;
    quadBuf[qi++] = y0;
    quadBuf[qi++] = r;
    quadBuf[qi++] = g;
    quadBuf[qi++] = b;
    quadBuf[qi++] = x1;
    quadBuf[qi++] = y1;
    quadBuf[qi++] = r;
    quadBuf[qi++] = g;
    quadBuf[qi++] = b;
    return qi;
  }

  const vaoQuad = gl.createVertexArray()!;
  const vboQuad = gl.createBuffer()!;
  gl.bindVertexArray(vaoQuad);
  gl.bindBuffer(gl.ARRAY_BUFFER, vboQuad);
  gl.bufferData(gl.ARRAY_BUFFER, quadBuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
  gl.bindVertexArray(null);

  const vaoPoint = gl.createVertexArray()!;
  const vboPoint = gl.createBuffer()!;
  gl.bindVertexArray(vaoPoint);
  gl.bindBuffer(gl.ARRAY_BUFFER, vboPoint);
  gl.bufferData(gl.ARRAY_BUFFER, pointBuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;
  let stepsAccum = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 1 / 30);

      for (let i = 0; i < 2 * CELLN; i++) recency[i] *= Math.exp(-fdt * RECENCY_DECAY);
      for (let s = 0; s < PULSE_SLOTS; s++) pulseLife[s] *= Math.exp(-fdt * PULSE_DECAY);
      for (let g = 0; g < 2; g++) {
        if (state[g] === RETIRING) {
          fade[g] *= Math.exp(-fdt * RETIRE_DECAY);
          if (fade[g] < 0.02) state[g] = EMPTY;
        }
      }

      // Continuous: bass drives dig speed (steps/sec).
      stepsAccum += (STEP_BASE + audio.bass * STEP_BASS_SCALE) * fdt;
      let used = 0;
      while (stepsAccum >= 1 && used < MAX_STEPS_FRAME) {
        carveStep(activeSlot);
        stepsAccum -= 1;
        used++;
      }

      // Trigger: kick advances the dig several steps at once (a structural jump, not
      // a flash) and leaves a trail of decaying glow pulses along the burst.
      if (audio.kick) {
        for (let k = 0; k < KICK_BURST; k++) {
          const touched = carveStep(activeSlot);
          if (touched >= 0) pushPulse(touched);
        }
      }

      const huePhase = t * 0.02 + audio.centroid * 0.8;
      const levelBoost = audio.level;
      const widthScale = 0.78 + levelBoost * 0.45;

      let qi = 0;
      let pi2 = 0;
      for (let g = 0; g < 2; g++) {
        if (state[g] === EMPTY) continue;
        const base = g * CELLN;
        const dimMul = state[g] === RETIRING ? fade[g] : 1;
        mazeColor(huePhase + g * 0.12, colorScratch, 0);
        const cr = colorScratch[0],
          cg = colorScratch[1],
          cb = colorScratch[2];
        const hw = HALFW_BASE * widthScale;

        for (let idx = 0; idx < CELLN; idx++) {
          if (!visited[base + idx]) continue;
          const cx = cellX(idx),
            cy = cellY(idx);
          const bright = (1.05 + levelBoost * 0.9 + recency[base + idx] * 1.3) * dimMul;
          const r = cr * bright,
            g2 = cg * bright,
            b = cb * bright;
          qi = pushQuad(qi, cx - hw, cy - hw, cx + hw, cy + hw, r, g2, b);

          const x = idx % GRID;
          if (x < GRID - 1 && edgeRight[base + idx]) {
            qi = pushQuad(qi, cx - hw, cy - hw, cx + CELL + hw, cy + hw, r, g2, b);
          }
          const y = (idx / GRID) | 0;
          if (y < GRID - 1 && edgeDown[base + idx]) {
            qi = pushQuad(qi, cx - hw, cy - hw, cx + hw, cy + CELL + hw, r, g2, b);
          }
        }

        // Frontier: the actively growing tip gets a sharp, extra-bright spark.
        // High controls its brightness/sharpness; kickPulse adds a punch on impact.
        if (state[g] === ACTIVE && current[g] >= 0) {
          const fx = cellX(current[g]),
            fy = cellY(current[g]);
          const fbright = 1.9 + audio.high * 1.3 + audio.kickPulse * 1.4;
          pointBuf[pi2++] = fx;
          pointBuf[pi2++] = fy;
          pointBuf[pi2++] = cr * fbright;
          pointBuf[pi2++] = cg * fbright;
          pointBuf[pi2++] = cb * fbright;
          pointBuf[pi2++] = (CELL * 1.3 + CELL * audio.high * 0.9) * 60;
        }
      }

      // Kick-burst trail: decaying localised sparks so a kick reads as a visible,
      // legible event without ever flashing the full frame.
      mazeColor(huePhase, colorScratch, 0);
      for (let s = 0; s < PULSE_SLOTS; s++) {
        const life = pulseLife[s];
        if (life < 0.02) continue;
        const br = 2.1 * life;
        pointBuf[pi2++] = pulseX[s];
        pointBuf[pi2++] = pulseY[s];
        pointBuf[pi2++] = colorScratch[0] * br;
        pointBuf[pi2++] = colorScratch[1] * br;
        pointBuf[pi2++] = colorScratch[2] * br;
        pointBuf[pi2++] = CELL * (0.5 + life * 0.6) * 60;
      }

      post.bind();
      gl.clearColor(0.008, 0.01, 0.02, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.disable(gl.BLEND);
      gl.useProgram(progBg);
      gl.uniform1f(uBg.u_time, t);
      gl.uniform1f(uBg.u_bass, audio.bass);
      gl.bindVertexArray(tri);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.useProgram(progQuad);
      gl.uniform1f(uQuad.u_aspect, rw / rh);
      gl.bindVertexArray(vaoQuad);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboQuad);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, quadBuf.subarray(0, qi));
      gl.drawArrays(gl.TRIANGLES, 0, qi / 5);

      gl.useProgram(progPoint);
      gl.uniform1f(uPoint.u_aspect, rw / rh);
      gl.uniform1f(uPoint.u_pxScale, Math.min(rw, rh));
      gl.bindVertexArray(vaoPoint);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboPoint);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pointBuf.subarray(0, pi2));
      gl.drawArrays(gl.POINTS, 0, pi2 / 6);

      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.0 + levelBoost * 0.5,
        exposure: 1.05 + audio.kickPulse * 0.1,
        aberration: 0.001 + audio.change * 0.0015,
        grain: 0.03,
        vignette: 1.15,
        flash: audio.kickPulse * 0.12,
        threshold: 0.5,
        time: t,
      });
    },
  };
}
