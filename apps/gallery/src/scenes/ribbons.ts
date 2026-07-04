// 09 RIBBONS — a dozen-plus glowing ribbons drifting through a cheap pseudo-curl
// flow field, each trailing a short fading tail. Ribbon index doubles as a
// spectrum band (low ribbons = bass = warm, high ribbons = treble = cool);
// level quickens the drift, high roughens the field into turbulence, and a
// kick teleports a rotating handful of ribbons to a fresh starting point.
// CPU-integrated triangle-strip quads (real width, since line width is
// unsupported on the QA's SwiftShader backend) through HDR PostFX.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N_RIBBONS = 16;
const TRAIL_LEN = 32;
const BOUND = 1.7;
const RESET_COUNT = 3;

const VS = `#version 300 es
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

const FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Cheap pseudo-curl: not a genuine divergence-free field, just two
// differently-phased sums of sines/cosines across x/y/z/t so each ribbon
// (offset by its own z slice) wanders on an independent, self-sustaining
// path. `turb` (driven by audio.high) adds a higher-frequency term that
// widens the directional spread ("turbulence").
function flowVel(
  x: number,
  y: number,
  z: number,
  t: number,
  turb: number,
  out: Float32Array,
): void {
  const a = Math.sin(x * 1.3 + z * 2.1 - t * 0.31) + Math.cos(y * 1.7 - z * 1.3 + t * 0.19) * 0.8;
  const b = Math.cos(x * 0.9 - z * 1.7 + t * 0.23) + Math.sin(y * 1.1 + z * 0.7 - t * 0.27) * 0.8;
  const a2 = Math.sin(x * 3.1 - y * 2.3 + t * 0.5 + z * 4.0);
  const b2 = Math.cos(x * 2.7 + y * 3.3 - t * 0.44 + z * 3.3);
  out[0] = a + a2 * turb;
  out[1] = b + b2 * turb;
}

export function createRibbons(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const vertsPerRibbon = TRAIL_LEN * 2;
  const stride = 5; // x,y,r,g,b
  const buf = new Float32Array(N_RIBBONS * vertsPerRibbon * stride);

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride * 4, 8);
  gl.bindVertexArray(null);

  // Per-ribbon state: head position, a fixed z-slice offset into the flow
  // field (so ribbons don't move in lockstep), and a ring-buffer trail.
  const headX = new Float32Array(N_RIBBONS);
  const headY = new Float32Array(N_RIBBONS);
  const zOff = new Float32Array(N_RIBBONS);
  const histX: Float32Array[] = [];
  const histY: Float32Array[] = [];
  const writeIdx = new Int32Array(N_RIBBONS);

  function spawn(r: number): void {
    const x = (Math.random() * 2 - 1) * BOUND;
    const y = (Math.random() * 2 - 1) * BOUND;
    headX[r] = x;
    headY[r] = y;
    for (let k = 0; k < TRAIL_LEN; k++) {
      histX[r][k] = x;
      histY[r][k] = y;
    }
    writeIdx[r] = 0;
  }

  for (let r = 0; r < N_RIBBONS; r++) {
    histX.push(new Float32Array(TRAIL_LEN));
    histY.push(new Float32Array(TRAIL_LEN));
    zOff[r] = r * 1.37 + 4.1;
    spawn(r);
  }

  let resetCursor = 0;
  let rw = 1,
    rh = 1;
  const vel = new Float32Array(2);
  const warm = [1.0, 0.42, 0.16];
  const cool = [0.2, 0.55, 1.0];

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);
      const turb = 0.25 + audio.high * 1.35;
      const speed = 0.5 + audio.level * 1.6;
      const bandCount = audio.spectrum.length;

      // Kick: structural trigger — a rotating handful of ribbons teleport to
      // a fresh origin and their trail history resets with them (no streak
      // across the screen). Rotates through all ribbons over successive kicks.
      if (audio.kick) {
        for (let i = 0; i < RESET_COUNT; i++) {
          spawn((resetCursor + i) % N_RIBBONS);
        }
        resetCursor = (resetCursor + RESET_COUNT) % N_RIBBONS;
      }

      for (let r = 0; r < N_RIBBONS; r++) {
        flowVel(headX[r] * 0.9, headY[r] * 0.9, zOff[r], t, turb, vel);
        let nx = headX[r] + vel[0] * speed * fdt * 0.4;
        let ny = headY[r] + vel[1] * speed * fdt * 0.4;
        if (nx > BOUND) nx -= 2 * BOUND;
        else if (nx < -BOUND) nx += 2 * BOUND;
        if (ny > BOUND) ny -= 2 * BOUND;
        else if (ny < -BOUND) ny += 2 * BOUND;
        headX[r] = nx;
        headY[r] = ny;
        writeIdx[r] = (writeIdx[r] + 1) % TRAIL_LEN;
        histX[r][writeIdx[r]] = nx;
        histY[r][writeIdx[r]] = ny;
      }

      // Build the quad-strip vertex buffer: for each ribbon, walk its trail
      // oldest -> newest and emit a left/right pair offset perpendicular to
      // the local tangent, tapering width and brightness from tail to head.
      let vi = 0;
      for (let r = 0; r < N_RIBBONS; r++) {
        const bandFrac = r / (N_RIBBONS - 1);
        const bandIdx = Math.min(bandCount - 1, Math.floor(bandFrac * (bandCount - 1)));
        const amp = audio.spectrum[bandIdx];
        const cr = warm[0] + (cool[0] - warm[0]) * bandFrac;
        const cg = warm[1] + (cool[1] - warm[1]) * bandFrac;
        const cb = warm[2] + (cool[2] - warm[2]) * bandFrac;
        const halfW = 0.01 + amp * 0.026;
        const glow = 0.22 + amp * 1.5;
        const baseIdx = (writeIdx[r] + 1) % TRAIL_LEN; // oldest surviving sample

        for (let k = 0; k < TRAIL_LEN; k++) {
          const idx = (baseIdx + k) % TRAIL_LEN;
          // Clamp neighbours in *temporal* (k) space, not ring-slot space, so
          // the ends use a one-sided difference instead of wrapping into the
          // opposite (unrelated) end of the ring.
          const prevIdx = (baseIdx + Math.max(0, k - 1)) % TRAIL_LEN;
          const nextIdx = (baseIdx + Math.min(TRAIL_LEN - 1, k + 1)) % TRAIL_LEN;
          const px = histX[r][idx];
          const py = histY[r][idx];
          const tx = histX[r][nextIdx] - histX[r][prevIdx];
          const ty = histY[r][nextIdx] - histY[r][prevIdx];
          const len = Math.max(1e-5, Math.hypot(tx, ty));
          const perpX = -ty / len;
          const perpY = tx / len;
          const fade = k / (TRAIL_LEN - 1);
          const w = halfW * (0.12 + 0.88 * fade);
          const b = glow * Math.pow(fade, 1.3);

          buf[vi * stride] = px + perpX * w;
          buf[vi * stride + 1] = py + perpY * w;
          buf[vi * stride + 2] = cr * b;
          buf[vi * stride + 3] = cg * b;
          buf[vi * stride + 4] = cb * b;
          vi++;

          buf[vi * stride] = px - perpX * w;
          buf[vi * stride + 1] = py - perpY * w;
          buf[vi * stride + 2] = cr * b;
          buf[vi * stride + 3] = cg * b;
          buf[vi * stride + 4] = cb * b;
          vi++;
        }
      }

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_aspect, rw / rh);
      for (let r = 0; r < N_RIBBONS; r++) {
        gl.drawArrays(gl.TRIANGLE_STRIP, r * vertsPerRibbon, vertsPerRibbon);
      }
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.0 + audio.level * 0.6,
        exposure: 1.1 + audio.kickPulse * 0.25,
        aberration: 0.0012 + audio.change * 0.0018,
        grain: 0.035,
        vignette: 1.15,
        flash: audio.kickPulse * 0.35,
        threshold: 0.5,
        time: t,
      });
    },
  };
}
