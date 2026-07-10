// 70 CORAL — a deterministic branching-graph coral growing on the reef bed. CPU-side
// state (per-branch tip position/direction/generation/thickness) extends every frame;
// each branch segment is expanded into a normal-offset quad (two triangles, never
// GL_LINES — see SCENES.md's LOW_VIS quad-expansion recipe, same technique as
// ribbons.ts/verlet.ts) so it reads at any resolution including the 640x360 headless
// QA capture. A handful of base branches are grown synchronously at mount (a fixed-step
// warmup, no wall-clock reads) so the reef is never a bare seed even in silence. Small
// additive "polyp" points ride along every committed branch node for extra coverage and
// texture, and a short-lived glow pulse marks each fresh fork so a kick reads as a
// visible, localised event rather than a screen flash. Additive quads + points through
// HDR PostFX over a still, deep reef-water gradient background.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const MAX_BRANCHES = 56;
const MAX_POINTS = 26; // committed points per branch (excludes the live growing tip)
const BASE_BRANCHES = 7;
const SEGMENT_LEN = 0.06;
const GROW_BASE = 0.16;
const GROW_BASS_SCALE = 0.42;
const FORK_BASE_SPREAD = 0.5;
const FORK_HIGH_SCALE = 0.85;
const KICK_FORKS = 2;
const THICKNESS_BASE = 0.022;
const THICKNESS_TAPER = 0.76;
const THICKNESS_MIN = 0.0035;
const GLOW_DECAY = 1.4;
const PULSE_DECAY = 1.6;
const PULSE_SLOTS = 24;
const SWAY_AMP = 0.028;
const SWAY_FREQ = 0.5;
const BOUND_X = 1.5;
const BOUND_Y_TOP = 1.05;
const BOUND_Y_BOTTOM = -1.2;
const WARMUP_ITERS = 260;
const WARMUP_FORK_EVERY = 30;

// Lines are camera-facing quads, not GL_LINES: gl.lineWidth is unhonoured on the
// headless SwiftShader QA renderer, so 1px lines would vanish there.
const LINE_VS = `#version 300 es
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

const LINE_FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Polyp / fork-pulse points: real screen-space size via gl_PointSize (not a thin
// primitive), radial falloff so it reads as a soft glowing bump rather than a square.
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
  gl_PointSize = clamp(u_pxScale * a_size, 1.5, 30.0);
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

// Deep shallow-water backdrop: a still vertical gradient plus a very faint moving
// caustic ray so the background itself is never a flat dead pixel.
const BG_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform float u_time, u_bass;
void main(){
  vec3 deep = vec3(0.012, 0.05, 0.065);
  vec3 shallow = vec3(0.03, 0.10, 0.125);
  vec3 col = mix(deep, shallow, v_uv.y);
  float ray = sin(v_uv.x * 10.0 + u_time * 0.12) * 0.5 + 0.5;
  ray *= smoothstep(0.0, 1.0, v_uv.y);
  col += vec3(0.02, 0.05, 0.05) * ray * (0.35 + u_bass * 0.5) * 0.4;
  o = vec4(col, 1.0);
}`;

// Cosine-free three-stop cyclic gradient (pink -> orange -> purple -> pink), used as
// coral hue. Written into `out` at `offset` to avoid per-vertex allocation.
const PINK: readonly [number, number, number] = [1.0, 0.32, 0.58];
const ORANGE: readonly [number, number, number] = [1.0, 0.5, 0.14];
const PURPLE: readonly [number, number, number] = [0.58, 0.28, 0.92];

function coralColor(phase: number, out: Float32Array, offset: number): void {
  const p = phase - Math.floor(phase);
  let a: readonly [number, number, number];
  let b: readonly [number, number, number];
  let f: number;
  if (p < 1 / 3) {
    a = PINK;
    b = ORANGE;
    f = p * 3;
  } else if (p < 2 / 3) {
    a = ORANGE;
    b = PURPLE;
    f = (p - 1 / 3) * 3;
  } else {
    a = PURPLE;
    b = PINK;
    f = (p - 2 / 3) * 3;
  }
  out[offset] = a[0] + (b[0] - a[0]) * f;
  out[offset + 1] = a[1] + (b[1] - a[1]) * f;
  out[offset + 2] = a[2] + (b[2] - a[2]) * f;
}

export function createCoral(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const progLine = program(gl, LINE_VS, LINE_FS);
  const uLine: Uniforms = uniforms(gl, progLine);
  const progPoint = program(gl, POINT_VS, POINT_FS);
  const uPoint: Uniforms = uniforms(gl, progPoint);
  const progBg = program(gl, FULLSCREEN_VS, BG_FS);
  const uBg: Uniforms = uniforms(gl, progBg);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // --- branch graph state (flat, index = branch, MAX_POINTS committed points each) ---
  const ptX = new Float32Array(MAX_BRANCHES * MAX_POINTS);
  const ptY = new Float32Array(MAX_BRANCHES * MAX_POINTS);
  const count = new Int32Array(MAX_BRANCHES); // committed point count per branch
  const dirAngle = new Float32Array(MAX_BRANCHES);
  const angVel = new Float32Array(MAX_BRANCHES);
  const gen = new Int32Array(MAX_BRANCHES);
  const growing = new Uint8Array(MAX_BRANCHES);
  const thickness = new Float32Array(MAX_BRANCHES);
  const colorSeed = new Float32Array(MAX_BRANCHES);
  const seedPhase = new Float32Array(MAX_BRANCHES);
  const growAccum = new Float32Array(MAX_BRANCHES);
  const tipX = new Float32Array(MAX_BRANCHES);
  const tipY = new Float32Array(MAX_BRANCHES);
  const glow = new Float32Array(MAX_BRANCHES); // fork flash envelope, 1 -> 0
  let numBranches = 0;

  // --- fork glow pulses: short-lived localised flashes marking recent kicks ---
  const pulseX = new Float32Array(PULSE_SLOTS);
  const pulseY = new Float32Array(PULSE_SLOTS);
  const pulseLife = new Float32Array(PULSE_SLOTS);
  let pulseCursor = 0;

  function pushPulse(x: number, y: number): void {
    pulseX[pulseCursor] = x;
    pulseY[pulseCursor] = y;
    pulseLife[pulseCursor] = 1;
    pulseCursor = (pulseCursor + 1) % PULSE_SLOTS;
  }

  function addBranch(x: number, y: number, angle: number, g: number): number {
    let idx = -1;
    if (numBranches < MAX_BRANCHES) {
      idx = numBranches;
      numBranches++;
    } else {
      for (let i = BASE_BRANCHES; i < MAX_BRANCHES; i++) {
        if (!growing[i]) {
          idx = i;
          break;
        }
      }
      if (idx === -1) idx = BASE_BRANCHES + ((Math.random() * (MAX_BRANCHES - BASE_BRANCHES)) | 0);
    }
    const base = idx * MAX_POINTS;
    ptX[base] = x;
    ptY[base] = y;
    count[idx] = 1;
    dirAngle[idx] = angle;
    angVel[idx] = 0;
    gen[idx] = g;
    growing[idx] = 1;
    thickness[idx] = Math.max(THICKNESS_MIN, THICKNESS_BASE * Math.pow(THICKNESS_TAPER, g));
    colorSeed[idx] = Math.random();
    seedPhase[idx] = Math.random() * Math.PI * 2;
    growAccum[idx] = 0;
    tipX[idx] = x;
    tipY[idx] = y;
    glow[idx] = 1;
    return idx;
  }

  function forkFrom(parentIdx: number, forkSpread: number): void {
    const ang = dirAngle[parentIdx] + (Math.random() * 2 - 1) * forkSpread;
    addBranch(tipX[parentIdx], tipY[parentIdx], ang, gen[parentIdx] + 1);
    pushPulse(tipX[parentIdx], tipY[parentIdx]);
  }

  // Advances every growing branch's tip by `speed*fdt`, committing a fixed point once
  // enough length has accumulated. Direction wanders via a slow per-branch angular
  // random walk so branches curve organically instead of growing dead-straight.
  function growAll(fdt: number, speed: number): void {
    for (let b = 0; b < numBranches; b++) {
      if (!growing[b]) continue;
      angVel[b] += (Math.random() - 0.5) * 0.9 * fdt;
      angVel[b] *= 0.98;
      dirAngle[b] += angVel[b] * fdt;
      const nx = tipX[b] + Math.sin(dirAngle[b]) * speed * fdt;
      const ny = tipY[b] + Math.cos(dirAngle[b]) * speed * fdt;
      tipX[b] = nx;
      tipY[b] = ny;
      growAccum[b] += speed * fdt;
      if (nx < -BOUND_X || nx > BOUND_X || ny > BOUND_Y_TOP || ny < BOUND_Y_BOTTOM) {
        growing[b] = 0;
      } else if (growAccum[b] >= SEGMENT_LEN && count[b] < MAX_POINTS) {
        const base = b * MAX_POINTS;
        const pi = count[b];
        ptX[base + pi] = nx;
        ptY[base + pi] = ny;
        count[b] = pi + 1;
        growAccum[b] -= SEGMENT_LEN;
        if (count[b] >= MAX_POINTS) growing[b] = 0;
      }
    }
  }

  // Base branches from a small seed cluster on the reef bed, fanned upward so the
  // structure reads immediately. Fixed-step warmup (no wall-clock) grows them to a
  // developed cluster with a few pre-forks before the first real frame renders,
  // satisfying the BLACK/LOW_VIS floor even in total silence.
  for (let i = 0; i < BASE_BRANCHES; i++) {
    const frac = i / (BASE_BRANCHES - 1);
    const ang = (frac - 0.5) * 2.1 + (Math.random() - 0.5) * 0.25;
    const ox = (frac - 0.5) * 0.6;
    addBranch(ox, -0.92, ang, 0);
  }
  for (let s = 0; s < WARMUP_ITERS; s++) {
    growAll(1 / 60, GROW_BASE);
    if (s > 20 && s % WARMUP_FORK_EVERY === 0 && numBranches < MAX_BRANCHES) {
      const parent = (Math.random() * numBranches) | 0;
      if (count[parent] >= 2) forkFrom(parent, FORK_BASE_SPREAD);
    }
  }
  // Warmup forks/growth shouldn't leave residual "just kicked" flashes at mount.
  glow.fill(0);
  pulseLife.fill(0);

  // --- GL buffers ---
  const MAX_SEGMENTS = MAX_BRANCHES * MAX_POINTS;
  const quadBuf = new Float32Array(MAX_SEGMENTS * 6 * 5); // 6 verts/segment, x,y,r,g,b
  const pointBuf = new Float32Array((MAX_SEGMENTS + PULSE_SLOTS) * 6); // x,y,r,g,b,size
  const colorScratch = new Float32Array(3);

  const vaoLine = gl.createVertexArray()!;
  const vboLine = gl.createBuffer()!;
  gl.bindVertexArray(vaoLine);
  gl.bindBuffer(gl.ARRAY_BUFFER, vboLine);
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

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 1 / 30);

      // Continuous: bass drives growth speed.
      const growSpeed = GROW_BASE + audio.bass * GROW_BASS_SCALE;
      growAll(fdt, growSpeed);
      for (let b = 0; b < numBranches; b++) glow[b] *= Math.exp(-fdt * GLOW_DECAY);
      for (let s = 0; s < PULSE_SLOTS; s++) pulseLife[s] *= Math.exp(-fdt * PULSE_DECAY);

      // Trigger: kick spawns new branch points off existing tips at a random angle —
      // a structural change (new geometry), not a flash. High widens the angle spread.
      if (audio.kick) {
        const forkSpread = FORK_BASE_SPREAD + audio.high * FORK_HIGH_SCALE;
        for (let k = 0; k < KICK_FORKS; k++) {
          let parent = (Math.random() * numBranches) | 0;
          for (let tries = 0; tries < 5 && count[parent] < 2; tries++) {
            parent = (Math.random() * numBranches) | 0;
          }
          forkFrom(parent, forkSpread);
        }
      }

      // Slow rotation through the reef palette; centroid nudges the phase directly.
      const huePhase = t * 0.015 + audio.centroid * 0.9;
      const levelBoost = audio.level;

      let qi = 0;
      let pi2 = 0;
      for (let b = 0; b < numBranches; b++) {
        const base = b * MAX_POINTS;
        const segCount = count[b];
        coralColor(huePhase + colorSeed[b] * 0.15, colorScratch, 0);
        const cr = colorScratch[0],
          cg = colorScratch[1],
          cb = colorScratch[2];
        const halfWMax = thickness[b] * (0.55 + levelBoost * 0.9);
        const swayScale = SWAY_AMP * (0.3 + 0.15 * gen[b]);

        for (let i = 0; i < segCount; i++) {
          const s0 = swayScale * Math.min(1, i / 8);
          const p0rx = ptX[base + i],
            p0ry = ptY[base + i];
          const p0x = p0rx + Math.sin(seedPhase[b] + i * 0.7 + t * SWAY_FREQ) * s0;
          const p0y =
            p0ry + Math.cos(seedPhase[b] * 1.3 + i * 0.5 + t * SWAY_FREQ * 0.8) * s0 * 0.6;

          let p1rx: number, p1ry: number, idx1: number;
          if (i === segCount - 1) {
            p1rx = tipX[b];
            p1ry = tipY[b];
            idx1 = segCount;
          } else {
            p1rx = ptX[base + i + 1];
            p1ry = ptY[base + i + 1];
            idx1 = i + 1;
          }
          const s1 = swayScale * Math.min(1, idx1 / 8);
          const p1x = p1rx + Math.sin(seedPhase[b] + idx1 * 0.7 + t * SWAY_FREQ) * s1;
          const p1y =
            p1ry + Math.cos(seedPhase[b] * 1.3 + idx1 * 0.5 + t * SWAY_FREQ * 0.8) * s1 * 0.6;

          const dx = p1x - p0x,
            dy = p1y - p0y;
          const len = Math.max(1e-5, Math.hypot(dx, dy));
          const nx = -dy / len,
            ny = dx / len;
          const taper = 1.0 - 0.3 * (i / Math.max(1, segCount));
          const w = halfWMax * taper;
          const growFrac = i === segCount - 1 ? 1.0 : 0.85;
          const glowAdd = glow[b] * 1.6 * (i >= segCount - 2 ? 1 : 0.3);
          const bright = (1.3 + levelBoost * 1.1) * growFrac + glowAdd;
          const r = cr * bright,
            g = cg * bright,
            bl = cb * bright;

          quadBuf[qi++] = p0x + nx * w;
          quadBuf[qi++] = p0y + ny * w;
          quadBuf[qi++] = r;
          quadBuf[qi++] = g;
          quadBuf[qi++] = bl;
          quadBuf[qi++] = p1x + nx * w;
          quadBuf[qi++] = p1y + ny * w;
          quadBuf[qi++] = r;
          quadBuf[qi++] = g;
          quadBuf[qi++] = bl;
          quadBuf[qi++] = p0x - nx * w;
          quadBuf[qi++] = p0y - ny * w;
          quadBuf[qi++] = r;
          quadBuf[qi++] = g;
          quadBuf[qi++] = bl;
          quadBuf[qi++] = p0x - nx * w;
          quadBuf[qi++] = p0y - ny * w;
          quadBuf[qi++] = r;
          quadBuf[qi++] = g;
          quadBuf[qi++] = bl;
          quadBuf[qi++] = p1x + nx * w;
          quadBuf[qi++] = p1y + ny * w;
          quadBuf[qi++] = r;
          quadBuf[qi++] = g;
          quadBuf[qi++] = bl;
          quadBuf[qi++] = p1x - nx * w;
          quadBuf[qi++] = p1y - ny * w;
          quadBuf[qi++] = r;
          quadBuf[qi++] = g;
          quadBuf[qi++] = bl;

          // Polyp dot riding this committed node (level -> size/brightness).
          const pb = 0.9 + levelBoost * 0.6;
          pointBuf[pi2++] = p0x;
          pointBuf[pi2++] = p0y;
          pointBuf[pi2++] = cr * pb;
          pointBuf[pi2++] = cg * pb;
          pointBuf[pi2++] = cb * pb;
          pointBuf[pi2++] = thickness[b] * (1.6 + levelBoost * 0.8);
        }
      }

      // Fork glow pulses: a decaying localised flash at each recent branch point —
      // makes the kick response legible without ever flashing the full frame.
      for (let s = 0; s < PULSE_SLOTS; s++) {
        const life = pulseLife[s];
        if (life < 0.02) continue;
        coralColor(huePhase, colorScratch, 0);
        const br = 2.2 * life;
        pointBuf[pi2++] = pulseX[s];
        pointBuf[pi2++] = pulseY[s];
        pointBuf[pi2++] = colorScratch[0] * br;
        pointBuf[pi2++] = colorScratch[1] * br;
        pointBuf[pi2++] = colorScratch[2] * br;
        pointBuf[pi2++] = 0.05 * (0.4 + life);
      }

      post.bind();
      gl.clearColor(0.012, 0.05, 0.065, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.disable(gl.BLEND);
      gl.useProgram(progBg);
      gl.uniform1f(uBg.u_time, t);
      gl.uniform1f(uBg.u_bass, audio.bass);
      gl.bindVertexArray(tri);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.useProgram(progLine);
      gl.uniform1f(uLine.u_aspect, rw / rh);
      gl.bindVertexArray(vaoLine);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboLine);
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
        exposure: 1.05 + audio.kickPulse * 0.12,
        aberration: 0.001 + audio.change * 0.0015,
        grain: 0.03,
        vignette: 1.1,
        flash: audio.kickPulse * 0.15,
        threshold: 0.5,
        time: t,
      });
    },
  };
}
