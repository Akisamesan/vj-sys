// 46 LATTICE — a 9×9×9 wireframe grid of points, warped by a coherent 3D noise
// field and breathing even in silence. Bass swells the warp amplitude, a slow
// orbiting camera spins faster with level, high sharpens (brightens) the edge
// glow, centroid rotates the palette hue, and a kick gives the whole cage a
// structural expand-and-settle pulse (a scale change, never a flash).
//
// Technique note: the spec calls for vertex-shader snoise displacement +
// GL_LINES, mirroring platonic.ts. But platonic.ts is currently QA-flagged
// LOW_VIS (thin GL_LINES are invisible to the headless SwiftShader renderer,
// which ignores gl.lineWidth) — see SCENES.md's "細線系" recipe. So, like
// ribbons.ts/verlet.ts, edges are expanded into real-width camera-facing
// quads. Because the quad expansion needs final 2D screen positions, the
// whole pipeline (coherent-noise warp -> yaw/pitch rotation -> perspective
// projection) runs on the CPU per vertex instead of in the vertex shader; the
// GPU program is a trivial passthrough. The noise field itself is a cheap,
// deterministic sum of phase-shifted sines/cosines per axis (same spirit as
// ribbons.ts's "pseudo-curl", informed by engine/glsl.ts's snoise/curlNoise
// design — position*scale + time*speed — but hand-rolled for the CPU).

import { program } from "../engine/gl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const GRID_N = 9;
const SPACING = 2 / (GRID_N - 1);
const HALF_WIDTH = 0.0082; // NDC half-thickness of a lattice edge quad
const BRIGHT_MULT = 1.55; // explicit brightness boost (LOW_VIS recipe: don't rely on bloom alone)
const HIGH_BRIGHT = 0.85; // high -> extra glow multiplier ("鋭さ")
const NOISE_FREQ = 1.15;
const NOISE_SPEED_BASE = 0.22;
const NOISE_SPEED_LEVEL = 0.2;
const AMP_MIN = 0.055; // idle warp amplitude — grid keeps breathing in silence (BLACK/STATIC)
const AMP_BASS = 0.55;
const BASE_SCALE = 0.92;
const KICK_SCALE = 0.22; // structural expand-then-settle pulse amplitude
const YAW_BASE = 0.11;
const YAW_LEVEL = 0.5;
const PITCH_BASE = 0.045;
const PITCH_LEVEL = 0.1;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec3 a_col;
out vec3 v_col;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_col = a_col;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Cheap coherent 3D displacement field: three independently phase-shifted
// sine/cosine sums (irrational-ish frequency ratios so the grid's finite
// extent doesn't reveal an obvious repeat). Smooth and continuous in both
// space and time, standing in for the GPU snoise the vertex shader can't run
// (see file header).
function noiseDisplace(x: number, y: number, z: number, t: number, out: Float32Array): void {
  out[0] =
    Math.sin(x * 2.1 + y * 1.3 - z * 1.7 + t * 0.31) * 0.6 +
    Math.cos(y * 3.4 - z * 2.2 + t * 0.19) * 0.4;
  out[1] =
    Math.cos(y * 2.3 - x * 1.9 + z * 1.1 + t * 0.27) * 0.6 +
    Math.sin(z * 3.1 + x * 2.6 - t * 0.23) * 0.4;
  out[2] =
    Math.sin(z * 2.7 + x * 1.6 - y * 2.4 - t * 0.29) * 0.6 +
    Math.cos(x * 3.3 - y * 1.8 + t * 0.21) * 0.4;
}

// Cosine palette (matches engine/glsl.ts's palette(t, 0.5,0.5,1,vec3(0,.33,.66))).
function palette(t: number, out: Float32Array): void {
  out[0] = 0.5 + 0.5 * Math.cos(6.28318 * (t + 0.0));
  out[1] = 0.5 + 0.5 * Math.cos(6.28318 * (t + 0.33));
  out[2] = 0.5 + 0.5 * Math.cos(6.28318 * (t + 0.66));
}

export function createLattice(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const N = GRID_N;
  const vIdx = (i: number, j: number, k: number): number => (i * N + j) * N + k;

  const vertCount = N * N * N;
  const baseX = new Float32Array(vertCount);
  const baseY = new Float32Array(vertCount);
  const baseZ = new Float32Array(vertCount);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      for (let k = 0; k < N; k++) {
        const idx = vIdx(i, j, k);
        baseX[idx] = -1 + i * SPACING;
        baseY[idx] = -1 + j * SPACING;
        baseZ[idx] = -1 + k * SPACING;
      }

  // Axis-aligned edges only (each vertex links to its +1 neighbour along x/y/z).
  const edgesA: number[] = [];
  const edgesB: number[] = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++)
      for (let k = 0; k < N; k++) {
        const idx = vIdx(i, j, k);
        if (i < N - 1) {
          edgesA.push(idx);
          edgesB.push(vIdx(i + 1, j, k));
        }
        if (j < N - 1) {
          edgesA.push(idx);
          edgesB.push(vIdx(i, j + 1, k));
        }
        if (k < N - 1) {
          edgesA.push(idx);
          edgesB.push(vIdx(i, j, k + 1));
        }
      }
  const edgeCount = edgesA.length; // 3*(N-1)*N*N = 1944 for N=9
  const edgeA = new Int32Array(edgesA);
  const edgeB = new Int32Array(edgesB);

  // Per-frame scratch: projected screen position + rotated depth per vertex.
  const scrX = new Float32Array(vertCount);
  const scrY = new Float32Array(vertCount);
  const rotZ = new Float32Array(vertCount);
  const nOut = new Float32Array(3);
  const colOut = new Float32Array(3);

  const stride = 5; // x, y, r, g, b
  const vbuf = new Float32Array(edgeCount * 6 * stride);

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vbuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride * 4, 8);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;
  let yaw = 0,
    pitch = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      yaw += dt * (YAW_BASE + audio.level * YAW_LEVEL);
      pitch += dt * (PITCH_BASE + audio.level * PITCH_LEVEL);

      const amp = AMP_MIN + audio.bass * AMP_BASS;
      const noiseSpeed = NOISE_SPEED_BASE + audio.level * NOISE_SPEED_LEVEL;
      const noiseT = t * noiseSpeed;
      const scale = BASE_SCALE * (1 + audio.kickPulse * KICK_SCALE);
      const aspect = rw / rh;
      const brightMul = BRIGHT_MULT * (1 + audio.high * HIGH_BRIGHT);
      const hueBase = audio.centroid;

      const cy = Math.cos(yaw),
        sy = Math.sin(yaw);
      const cp = Math.cos(pitch),
        sp = Math.sin(pitch);

      for (let idx = 0; idx < vertCount; idx++) {
        const x0 = baseX[idx],
          y0 = baseY[idx],
          z0 = baseZ[idx];
        noiseDisplace(x0 * NOISE_FREQ, y0 * NOISE_FREQ, z0 * NOISE_FREQ, noiseT, nOut);
        const dx = x0 + nOut[0] * amp;
        const dy = y0 + nOut[1] * amp;
        const dz = z0 + nOut[2] * amp;

        // yaw around Y, then pitch around X.
        const rx = cy * dx + sy * dz;
        const rz1 = -sy * dx + cy * dz;
        const ry = cp * dy - sp * rz1;
        const rz = sp * dy + cp * rz1;

        const persp = 1 / (2.6 - rz * 0.4);
        scrX[idx] = (rx * scale * persp) / aspect;
        scrY[idx] = ry * scale * persp;
        rotZ[idx] = rz;
      }

      let vi = 0;
      for (let e = 0; e < edgeCount; e++) {
        const ia = edgeA[e],
          ib = edgeB[e];
        const ax = scrX[ia],
          ay = scrY[ia];
        const bx = scrX[ib],
          by = scrY[ib];
        const tx = bx - ax,
          ty = by - ay;
        const len = Math.max(Math.hypot(tx, ty), 1e-5);
        const px = (-ty / len) * HALF_WIDTH;
        const py = (tx / len) * HALF_WIDTH;

        const depth = 0.5 + (rotZ[ia] + rotZ[ib]) * 0.2;
        palette(hueBase * 0.6 + depth * 0.25, colOut);
        const b = (0.45 + depth * 0.85) * brightMul;
        const cr = colOut[0] * b,
          cg = colOut[1] * b,
          cb = colOut[2] * b;

        const a0x = ax + px,
          a0y = ay + py;
        const a1x = ax - px,
          a1y = ay - py;
        const b0x = bx + px,
          b0y = by + py;
        const b1x = bx - px,
          b1y = by - py;

        vbuf[vi++] = a0x;
        vbuf[vi++] = a0y;
        vbuf[vi++] = cr;
        vbuf[vi++] = cg;
        vbuf[vi++] = cb;
        vbuf[vi++] = b0x;
        vbuf[vi++] = b0y;
        vbuf[vi++] = cr;
        vbuf[vi++] = cg;
        vbuf[vi++] = cb;
        vbuf[vi++] = a1x;
        vbuf[vi++] = a1y;
        vbuf[vi++] = cr;
        vbuf[vi++] = cg;
        vbuf[vi++] = cb;
        vbuf[vi++] = a1x;
        vbuf[vi++] = a1y;
        vbuf[vi++] = cr;
        vbuf[vi++] = cg;
        vbuf[vi++] = cb;
        vbuf[vi++] = b0x;
        vbuf[vi++] = b0y;
        vbuf[vi++] = cr;
        vbuf[vi++] = cg;
        vbuf[vi++] = cb;
        vbuf[vi++] = b1x;
        vbuf[vi++] = b1y;
        vbuf[vi++] = cr;
        vbuf[vi++] = cg;
        vbuf[vi++] = cb;
      }

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vbuf);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, 0, edgeCount * 6);
      gl.disable(gl.BLEND);

      // Kick is expressed only as the structural scale pulse above — no flash.
      post.draw(rw, rh, {
        bloom: 0.95 + audio.level * 0.4,
        exposure: 1.05,
        aberration: 0.001 + audio.change * 0.0015,
        grain: 0.035,
        vignette: 1.15,
        flash: 0,
        threshold: 0.55,
        time: t,
      });
    },
  };
}
