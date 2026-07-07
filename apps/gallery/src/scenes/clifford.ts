// 80 CLIFFORD — a Clifford strange attractor as a living point cloud. Tens of
// thousands of points ride the discrete map x'=sin(a·y)+c·cos(a·x),
// y'=sin(b·x)+d·cos(b·y), tracing dense lace-like filaments across the plane —
// the flat, intricate counterpart to 78 ATTRACTOR's 3D Lorenz wings. A handful
// of parallel orbits feed a ring buffer so the picture stays crisp while
// turning over continuously; bass/kick slowly drift the map's shape, level
// drives how fast fresh points arrive, centroid rotates the palette. Additive
// points through a restrained HDR bloom.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 24000; // ring-buffer capacity (points resident on screen at once)
const K = 48; // parallel orbits advanced per iteration batch
const WARMUP_ITERS = 200; // per-seed transient discard before the first fill

// Classic Clifford parameters (Pickover) — a dense, lacy chaotic regime.
// Audio drifts around this anchor rather than jumping to arbitrary a/b/c/d,
// which would risk landing in a boring periodic window.
const A_BASE = -1.4,
  A_AMP = 0.5;
const B_BASE = 1.6,
  B_AMP = 0.45;
const C_BASE = 1.0,
  C_KICK = 0.22,
  C_WOBBLE = 0.05;
const D_BASE = 0.7,
  D_KICK = 0.18,
  D_WOBBLE = 0.04;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec2 a_pos;
uniform float u_scale, u_aspect, u_centroid, u_high;
out vec3 v_col;
void main(){
  vec2 p = a_pos * u_scale;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  float rad = length(a_pos);
  float hue = fract(0.55 + u_centroid*0.42 + rad*0.09);
  vec3 col = palette(hue, vec3(0.5,0.5,1.0), vec3(0.5,0.5,0.0), vec3(1.0,1.0,1.0), vec3(0.5,0.0,0.0));
  float envelope = 0.22 + u_high*0.3;
  v_col = col * envelope * 2.0; // explicit brightness x2 — additive points read thin otherwise (LOW_VIS)
  gl_PointSize = clamp(2.6 - u_high*0.9, 1.5, 3.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

export function createClifford(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const pos = new Float32Array(N * 2);

  const sx = new Float32Array(K);
  const sy = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    sx[i] = (Math.random() - 0.5) * 1.6;
    sy[i] = (Math.random() - 0.5) * 1.6;
  }

  function stepSeed(i: number, pa: number, pb: number, pc: number, pd: number): void {
    const x = sx[i],
      y = sy[i];
    const nx = Math.sin(pa * y) + pc * Math.cos(pa * x);
    const ny = Math.sin(pb * x) + pd * Math.cos(pb * y);
    sx[i] = nx;
    sy[i] = ny;
  }

  let writeCursor = 0;

  // Warm up: discard the initial transient so every seed is already riding the
  // attractor, then fill the ring buffer once so frame 1 shows the full shape
  // instead of a sparse cloud growing in from nothing.
  for (let i = 0; i < K; i++) {
    for (let s = 0; s < WARMUP_ITERS; s++) stepSeed(i, A_BASE, B_BASE, C_BASE, D_BASE);
  }
  for (let batch = 0; batch < N / K; batch++) {
    for (let i = 0; i < K; i++) {
      stepSeed(i, A_BASE, B_BASE, C_BASE, D_BASE);
      pos[writeCursor * 2] = sx[i];
      pos[writeCursor * 2 + 1] = sy[i];
      writeCursor = (writeCursor + 1) % N;
    }
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;
  let aF = A_BASE,
    bF = B_BASE;
  let batchAcc = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // bass -> a,b: a slow, continuous morph of the map's shape (own low-pass
      // on top of the engine's smoothing so the drift reads as breathing, not
      // per-beat pumping).
      const aTarget = A_BASE + (audio.bass - 0.5) * A_AMP;
      const bTarget = B_BASE + (audio.bass - 0.5) * B_AMP;
      const kSlow = 1 - Math.exp(-dt * 0.7);
      aF += (aTarget - aF) * kSlow;
      bF += (bTarget - bF) * kSlow;

      // kickPulse -> c,d: a small continuous kick (decaying drift, never a
      // reset) plus a tiny always-on wobble so the shape keeps breathing even
      // in silence.
      const pc = C_BASE + Math.sin(t * 0.083) * C_WOBBLE + audio.kickPulse * C_KICK;
      const pd = D_BASE + Math.sin(t * 0.071 + 1.7) * D_WOBBLE - audio.kickPulse * D_KICK;

      // level -> how many fresh points replace the oldest ones this frame
      // (orbit update speed); never zero so the cloud is always alive.
      const batchRate = 45 + audio.level * 140;
      batchAcc += dt * batchRate;
      const batches = Math.min(6, Math.floor(batchAcc));
      batchAcc -= batches;
      for (let batch = 0; batch < batches; batch++) {
        for (let i = 0; i < K; i++) {
          stepSeed(i, aF, bF, pc, pd);
          pos[writeCursor * 2] = sx[i];
          pos[writeCursor * 2 + 1] = sy[i];
          writeCursor = (writeCursor + 1) % N;
        }
      }

      // Clifford's x,y are always bounded by 1+|c|, 1+|d| (sin/cos <= 1) —
      // auto-frame from that bound so drifting c,d never over/under-scales.
      const bound = 1 + Math.max(Math.abs(pc), Math.abs(pd));
      const scale = 0.88 / bound;

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.drawArrays(gl.POINTS, 0, N);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.85 + audio.level * 0.35,
        exposure: 1.05 + audio.kickPulse * 0.15,
        aberration: 0.0008 + audio.change * 0.0015,
        grain: 0.035,
        vignette: 1.1,
        flash: audio.kickPulse * 0.18,
        threshold: 0.62,
        time: t,
      });
    },
  };
}
