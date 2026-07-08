// 75 FLAG — a Verlet-integrated cloth grid hangs from a fixed pole edge and
// ripples in a wind field. The pole-side column of the grid is a rigid
// anchor (never touched by integration or constraints); every other point
// is Verlet-integrated under a wind acceleration and relaxed against its
// neighbours (structural + shear distance constraints) only a handful of
// iterations per frame, so a sudden gust visibly deforms the cloth before
// the solver fully catches up over the next few frames — the same
// travelling-disturbance trick verlet.ts uses for its ropes, applied to a
// 2D grid instead of a 1D chain. The flag surface itself is a real
// triangle-mesh (not GL_LINES): each grid cell is split into two triangles,
// so it reads as a solid glowing sheet at any resolution instead of relying
// on unsupported line width.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const COLS = 22; // grid columns, pole (c=0) to free edge (c=COLS-1)
const ROWS = 13; // grid rows, top to bottom
const ITER = 4; // constraint relaxation iterations/frame (kept low so gusts travel visibly)

const POLE_X = -1.0; // pre-aspect world x of the pole (divided by aspect at draw time)
const FLAG_WIDTH = 1.4; // pre-aspect world width of the cloth at rest
const TOP_Y = 0.55;
const BOTTOM_Y = -0.45;
const REST_X = FLAG_WIDTH / (COLS - 1);
const REST_Y = (TOP_Y - BOTTOM_Y) / (ROWS - 1);
const DIAG_REST = Math.hypot(REST_X, REST_Y);

const POLE_HALF_W = 0.018;
const POLE_TOP = TOP_Y + 0.12;
const POLE_BOTTOM = BOTTOM_Y - 0.15;

const WIND_BASE = 0.55; // ambient wind so the flag is never still even in silence
const WIND_BASS_SCALE = 1.6; // bass -> steady wind strength (continuous)
const GUST_ADD = 3.2; // kick -> instantaneous gust impulse (structural trigger, no flash)
const GUST_MAX = 6.0;
const GUST_DECAY = 4.5; // exponential settle of the gust back to the steady wind
const GRAVITY = 0.35; // gentle sag when wind is weak
const TURB_BASE = 0.5; // ambient per-point turbulence so folds ripple, not just billow flat
const LEVEL_TURB_SCALE = 1.4; // level -> sway amplitude (turbulence amplitude)
const DETAIL_AMP = 0.022; // high -> fine high-frequency cloth ripple (cosmetic overlay only)

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in float a_fold;
uniform float u_aspect;
out vec2 v_uv;
out float v_fold;
void main(){
  vec2 p = a_pos;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  v_uv = a_uv;
  v_fold = a_fold;
}`;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
in vec2 v_uv;
in float v_fold;
uniform float u_centroid;
uniform float u_energy;
out vec4 o;
void main(){
  if (v_uv.x < 0.0) {
    // flagpole rod: neutral metal shade, not part of the cloth palette
    float rshade = 0.5 + 0.28 * v_uv.y;
    o = vec4(vec3(0.42, 0.44, 0.48) * rshade * u_energy, 1.0);
    return;
  }
  // Horizontal colour bands (varies with v_uv.y) whose hue phase drifts with
  // the spectral centroid -- an abstract colour scheme, not a real flag.
  vec3 base = palette(
    v_uv.y * 1.6 + u_centroid * 1.3,
    vec3(0.55, 0.5, 0.5),
    vec3(0.45, 0.45, 0.45),
    vec3(1.0, 0.9, 0.7),
    vec3(0.0, 0.33, 0.67)
  );
  // Local curvature (a cheap Laplacian of the cloth surface, computed on the
  // CPU each frame) reads as fold shading: ridges catch light, troughs dim.
  float shade = 0.72 + clamp(v_fold * 7.0, -0.4, 0.55);
  vec3 col = base * shade * u_energy;
  o = vec4(col, 1.0);
}`;

function solveConstraint(
  pos: Float32Array,
  idxA: number,
  idxB: number,
  rest: number,
  fixedA: boolean,
  fixedB: boolean,
  stiffness: number,
): void {
  if (fixedA && fixedB) return;
  const dx = pos[idxB] - pos[idxA];
  const dy = pos[idxB + 1] - pos[idxA + 1];
  const dist = Math.max(Math.hypot(dx, dy), 1e-6);
  const diff = ((dist - rest) / dist) * stiffness;
  if (fixedA) {
    pos[idxB] -= dx * diff;
    pos[idxB + 1] -= dy * diff;
  } else if (fixedB) {
    pos[idxA] += dx * diff;
    pos[idxA + 1] += dy * diff;
  } else {
    const cx = dx * diff * 0.5;
    const cy = dy * diff * 0.5;
    pos[idxA] += cx;
    pos[idxA + 1] += cy;
    pos[idxB] -= cx;
    pos[idxB + 1] -= cy;
  }
}

export function createFlag(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const N = COLS * ROWS;
  const curr = new Float32Array(N * 2);
  const prev = new Float32Array(N * 2);
  const foldVal = new Float32Array(N);
  const renderX = new Float32Array(N);
  const renderY = new Float32Array(N);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      const x = POLE_X + c * REST_X;
      const droop = (c / (COLS - 1)) * 0.06 * (0.4 + 0.6 * (r / (ROWS - 1)));
      const jitter = (Math.random() - 0.5) * 0.01;
      const y = TOP_Y - r * REST_Y - droop + jitter;
      curr[idx * 2] = x;
      curr[idx * 2 + 1] = y;
      prev[idx * 2] = x;
      prev[idx * 2 + 1] = y;
    }
  }

  const cellCount = (COLS - 1) * (ROWS - 1);
  const flagVertCount = cellCount * 6;
  const POLE_VERTS = 6;
  const vertCount = flagVertCount + POLE_VERTS;
  const STRIDE = 5; // x, y, u, v, fold
  const vbuf = new Float32Array(vertCount * STRIDE);

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vbuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE * 4, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE * 4, 16);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;
  let gust = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 1 / 30);

      // Continuous: level -> sway amplitude via looser constraints + less damping.
      const stiffness = 1.0 - 0.45 * audio.level;
      const damping = 0.965 + 0.027 * audio.level;

      // Trigger: kick -> gust impulse, exponential decay back to the steady wind
      // (structural, not a flash: it deforms the cloth, nothing strobes).
      gust *= Math.exp(-fdt * GUST_DECAY);
      if (audio.kick) gust = Math.min(GUST_MAX, gust + GUST_ADD);

      // Continuous: bass -> steady wind strength.
      const windMag = WIND_BASE + audio.bass * WIND_BASS_SCALE + gust;
      const turbAmp = TURB_BASE + audio.level * LEVEL_TURB_SCALE;

      // Verlet integration. Column c=0 (the pole edge) is a rigid anchor and is
      // never advanced here, so it stays exactly where it was initialised.
      for (let r = 0; r < ROWS; r++) {
        for (let c = 1; c < COLS; c++) {
          const idx = (r * COLS + c) * 2;
          const phase = t * 2.1 + c * 0.42 + r * 0.23;
          const turb = Math.sin(phase);
          const accelX = windMag + turb * turbAmp * 0.35;
          const accelY =
            -GRAVITY + turb * turbAmp * 0.6 + Math.sin(phase * 0.5 + 1.7) * turbAmp * 0.25;
          const vx = (curr[idx] - prev[idx]) * damping;
          const vy = (curr[idx + 1] - prev[idx + 1]) * damping;
          prev[idx] = curr[idx];
          prev[idx + 1] = curr[idx + 1];
          curr[idx] += vx + accelX * fdt * fdt;
          curr[idx + 1] += vy + accelY * fdt * fdt;
        }
      }

      // Distance-constraint relaxation: structural (horizontal/vertical) + shear
      // diagonals, a few iterations/frame so a gust's deformation is visibly
      // still resolving over the next several frames rather than snapping instantly.
      for (let iter = 0; iter < ITER; iter++) {
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS - 1; c++) {
            const idxA = (r * COLS + c) * 2;
            const idxB = (r * COLS + c + 1) * 2;
            solveConstraint(curr, idxA, idxB, REST_X, c === 0, false, stiffness);
          }
        }
        for (let c = 1; c < COLS; c++) {
          for (let r = 0; r < ROWS - 1; r++) {
            const idxA = (r * COLS + c) * 2;
            const idxB = ((r + 1) * COLS + c) * 2;
            solveConstraint(curr, idxA, idxB, REST_Y, false, false, stiffness);
          }
        }
        for (let r = 0; r < ROWS - 1; r++) {
          for (let c = 0; c < COLS - 1; c++) {
            const idxA = (r * COLS + c) * 2;
            const idxB = ((r + 1) * COLS + c + 1) * 2;
            solveConstraint(curr, idxA, idxB, DIAG_REST, c === 0, false, stiffness);
            const idxC = (r * COLS + c + 1) * 2;
            const idxD = ((r + 1) * COLS + c) * 2;
            solveConstraint(curr, idxC, idxD, DIAG_REST, false, c === 0, stiffness);
          }
        }
      }

      // Local curvature (discrete Laplacian) doubles as fold shading in the shader.
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const idx = r * COLS + c;
          let lap = 0;
          if (c > 0 && c < COLS - 1) {
            lap += curr[(idx - 1) * 2 + 1] - 2 * curr[idx * 2 + 1] + curr[(idx + 1) * 2 + 1];
          }
          if (r > 0 && r < ROWS - 1) {
            lap += curr[(idx - COLS) * 2 + 1] - 2 * curr[idx * 2 + 1] + curr[(idx + COLS) * 2 + 1];
          }
          foldVal[idx] = lap;
        }
      }

      // Continuous: high -> fine high-frequency ripple overlay. Purely cosmetic
      // (not fed back into the physics state), so the solver stays stable.
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const idx = r * COLS + c;
          const ripple = DETAIL_AMP * audio.high * Math.sin(c * 1.9 - t * 9.0 + r * 0.7);
          renderX[idx] = curr[idx * 2];
          renderY[idx] = curr[idx * 2 + 1] + ripple;
        }
      }

      // Build the triangle mesh: two triangles per grid cell, real filled area
      // (not GL_LINES), so it reads clearly at any resolution.
      let vi = 0;
      for (let r = 0; r < ROWS - 1; r++) {
        for (let c = 0; c < COLS - 1; c++) {
          const i00 = r * COLS + c;
          const i10 = r * COLS + c + 1;
          const i01 = (r + 1) * COLS + c;
          const i11 = (r + 1) * COLS + c + 1;
          const u00 = c / (COLS - 1),
            v00 = r / (ROWS - 1);
          const u10 = (c + 1) / (COLS - 1);
          const v01 = (r + 1) / (ROWS - 1);

          vbuf[vi++] = renderX[i00];
          vbuf[vi++] = renderY[i00];
          vbuf[vi++] = u00;
          vbuf[vi++] = v00;
          vbuf[vi++] = foldVal[i00];

          vbuf[vi++] = renderX[i10];
          vbuf[vi++] = renderY[i10];
          vbuf[vi++] = u10;
          vbuf[vi++] = v00;
          vbuf[vi++] = foldVal[i10];

          vbuf[vi++] = renderX[i01];
          vbuf[vi++] = renderY[i01];
          vbuf[vi++] = u00;
          vbuf[vi++] = v01;
          vbuf[vi++] = foldVal[i01];

          vbuf[vi++] = renderX[i10];
          vbuf[vi++] = renderY[i10];
          vbuf[vi++] = u10;
          vbuf[vi++] = v00;
          vbuf[vi++] = foldVal[i10];

          vbuf[vi++] = renderX[i11];
          vbuf[vi++] = renderY[i11];
          vbuf[vi++] = u10;
          vbuf[vi++] = v01;
          vbuf[vi++] = foldVal[i11];

          vbuf[vi++] = renderX[i01];
          vbuf[vi++] = renderY[i01];
          vbuf[vi++] = u00;
          vbuf[vi++] = v01;
          vbuf[vi++] = foldVal[i01];
        }
      }

      // Flagpole rod: a static filled quad (uv.x < 0 marks it in the shader).
      const plB = POLE_X - POLE_HALF_W;
      const prB = POLE_X + POLE_HALF_W;
      vbuf[vi++] = plB;
      vbuf[vi++] = POLE_BOTTOM;
      vbuf[vi++] = -1;
      vbuf[vi++] = 0;
      vbuf[vi++] = 0;
      vbuf[vi++] = prB;
      vbuf[vi++] = POLE_BOTTOM;
      vbuf[vi++] = -1;
      vbuf[vi++] = 0;
      vbuf[vi++] = 0;
      vbuf[vi++] = plB;
      vbuf[vi++] = POLE_TOP;
      vbuf[vi++] = -1;
      vbuf[vi++] = 1;
      vbuf[vi++] = 0;
      vbuf[vi++] = prB;
      vbuf[vi++] = POLE_BOTTOM;
      vbuf[vi++] = -1;
      vbuf[vi++] = 0;
      vbuf[vi++] = 0;
      vbuf[vi++] = prB;
      vbuf[vi++] = POLE_TOP;
      vbuf[vi++] = -1;
      vbuf[vi++] = 1;
      vbuf[vi++] = 0;
      vbuf[vi++] = plB;
      vbuf[vi++] = POLE_TOP;
      vbuf[vi++] = -1;
      vbuf[vi++] = 1;
      vbuf[vi++] = 0;

      post.bind();
      gl.clearColor(0.02, 0.025, 0.035, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vbuf);
      gl.disable(gl.BLEND);
      gl.uniform1f(u.u_aspect, rw / rh);
      // Continuous: centroid -> palette phase (colour bands), level -> brightness.
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_energy, 1.0 + audio.level * 0.3);
      gl.drawArrays(gl.TRIANGLES, 0, vertCount);

      post.draw(rw, rh, {
        bloom: 0.45 + audio.level * 0.35,
        exposure: 1.0,
        aberration: 0.0006 + audio.change * 0.001,
        grain: 0.03,
        vignette: 1.1,
        flash: 0,
        threshold: 0.65,
        time: t,
      });
    },
  };
}
