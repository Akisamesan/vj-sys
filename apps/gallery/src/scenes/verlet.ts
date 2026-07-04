// 10 VERLET — hanging ropes under gravity, wind and beat impulses. Ten
// Verlet-integrated ropes (18 points each) sway in a slowly turning breeze;
// a kick jolts the points near each anchor and the resulting tension wave
// visibly runs down to the tips over the next several frames, since the
// distance-constraint solver only relaxes a few iterations per frame and
// cannot fully resolve the disturbance in one step. Additive quad strands
// through HDR PostFX; tension (stretch from rest length) glows cyan -> white.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const NUM_ROPES = 10;
const POINTS = 18;
const ITER = 4; // constraint iterations/frame — kept low so tension waves travel visibly
const BASE_REST = 0.095; // rest length between adjacent points (world units)
const ANCHOR_Y = 0.92;
const RANGE = 1.6; // anchor x half-spread, pre-aspect-divide
const DAMPING = 0.985;
const GRAVITY_BASE = 0.9;
const GRAVITY_LEVEL_SCALE = 2.0;
const WIND_BASE = 0.18;
const WIND_BASS_SCALE = 0.65;
const IMPULSE_VELOCITY = 3.4;

// Ropes are drawn as camera-facing quads (not GL_LINES): line-width is not
// honoured by the headless SwiftShader QA renderer, so a 1px GL_LINES rope
// would be near-invisible there (same fix ribbons.ts uses for its strands).
const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_tension;
out float v_tension;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_tension = a_tension;
}`;

const FS = `#version 300 es
precision highp float;
in float v_tension;
uniform float u_high;
out vec4 o;
void main(){
  vec3 base = vec3(0.10, 0.55, 0.95);
  vec3 hot  = vec3(1.0, 1.0, 1.0);
  float k = clamp(v_tension * 6.0, 0.0, 1.0);
  float sharp = mix(0.6, 2.4, clamp(u_high, 0.0, 1.0));
  vec3 col = mix(base, hot, pow(k, sharp));
  float glow = 1.3 + u_high * 1.3;
  o = vec4(col * glow, 1.0);
}`;

export function createVerlet(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // Flat [x,y] per point, rope-major: point (r,i) lives at (r*POINTS+i)*2.
  const curr = new Float32Array(NUM_ROPES * POINTS * 2);
  const prev = new Float32Array(NUM_ROPES * POINTS * 2);
  const restLen = new Float32Array(NUM_ROPES);

  for (let r = 0; r < NUM_ROPES; r++) {
    const ax = -RANGE + (2 * RANGE * (r + 0.5)) / NUM_ROPES;
    const rest = BASE_REST + (Math.random() - 0.5) * 0.02;
    restLen[r] = rest;
    const lean = (Math.random() - 0.5) * 0.35; // gentle initial droop, not a straight vertical line
    for (let i = 0; i < POINTS; i++) {
      const idx = (r * POINTS + i) * 2;
      const x = ax + (lean * i) / (POINTS - 1);
      const y = ANCHOR_Y - rest * i;
      curr[idx] = x;
      curr[idx + 1] = y;
      prev[idx] = x;
      prev[idx + 1] = y;
    }
  }

  const segCount = NUM_ROPES * (POINTS - 1);
  const vertCount = segCount * 6; // 2 triangles (6 verts) per segment quad
  const vbuf = new Float32Array(vertCount * 3); // x,y,tension per vertex
  const HALF_WIDTH = 0.0065; // NDC half-thickness of a rope strand

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vbuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
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

      // Continuous: level -> gravity/sway amplitude, bass -> wind force. The wind
      // direction meanders on its own (function of t) so there is always some
      // ambient sway even when bass is silent; bass only scales its strength.
      const gravity = GRAVITY_BASE + audio.level * GRAVITY_LEVEL_SCALE;
      const windMag = WIND_BASE + audio.bass * WIND_BASS_SCALE;
      const windAngle = 0.55 * Math.sin(t * 0.11) + 0.35 * Math.sin(t * 0.037 + 2.1);
      const accelX = Math.cos(windAngle) * windMag;
      const accelY = -gravity + Math.sin(windAngle) * windMag * 0.25;

      // Trigger: kick jolts the points near each anchor. The distance-constraint
      // solver below only relaxes a handful of iterations/frame, so this
      // disturbance takes several frames to reach the tips — a travelling
      // tension wave rather than an instant snap.
      if (audio.kick) {
        for (let r = 0; r < NUM_ROPES; r++) {
          const dirX = (r % 2 === 0 ? 1 : -1) * 0.4;
          const dirY = -1;
          const n = Math.hypot(dirX, dirY);
          const dvx = (dirX / n) * IMPULSE_VELOCITY * fdt;
          const dvy = (dirY / n) * IMPULSE_VELOCITY * fdt;
          const hit = Math.min(4, POINTS - 1);
          for (let i = 1; i <= hit; i++) {
            const idx = (r * POINTS + i) * 2;
            prev[idx] -= dvx;
            prev[idx + 1] -= dvy;
          }
        }
      }

      // Verlet integration (point 0 of each rope is the fixed anchor).
      for (let r = 0; r < NUM_ROPES; r++) {
        for (let i = 1; i < POINTS; i++) {
          const idx = (r * POINTS + i) * 2;
          const vx = (curr[idx] - prev[idx]) * DAMPING;
          const vy = (curr[idx + 1] - prev[idx + 1]) * DAMPING;
          prev[idx] = curr[idx];
          prev[idx + 1] = curr[idx + 1];
          curr[idx] += vx + accelX * fdt * fdt;
          curr[idx + 1] += vy + accelY * fdt * fdt;
        }
      }

      // Distance-constraint relaxation, a few iterations/frame (soft, not rigid).
      for (let iter = 0; iter < ITER; iter++) {
        for (let r = 0; r < NUM_ROPES; r++) {
          const rest = restLen[r];
          for (let i = 0; i < POINTS - 1; i++) {
            const idxA = (r * POINTS + i) * 2;
            const idxB = idxA + 2;
            const dx = curr[idxB] - curr[idxA];
            const dy = curr[idxB + 1] - curr[idxA + 1];
            const dist = Math.max(Math.hypot(dx, dy), 1e-6);
            const diff = (dist - rest) / dist;
            if (i === 0) {
              // point A is the fixed anchor: only B moves, and moves the full amount.
              curr[idxB] -= dx * diff;
              curr[idxB + 1] -= dy * diff;
            } else {
              const cx = dx * diff * 0.5;
              const cy = dy * diff * 0.5;
              curr[idxA] += cx;
              curr[idxA + 1] += cy;
              curr[idxB] -= cx;
              curr[idxB + 1] -= cy;
            }
          }
        }
      }

      // Rebuild the quad buffer; each segment's tension = leftover stretch after
      // this frame's relaxation, i.e. exactly the wavefront that hasn't caught up.
      // Positions are expanded into a thin camera-facing quad in aspect-corrected
      // NDC space so the strand reads as a solid glowing line at any resolution.
      const aspect = rw / rh;
      let vi = 0;
      for (let r = 0; r < NUM_ROPES; r++) {
        const rest = restLen[r];
        for (let i = 0; i < POINTS - 1; i++) {
          const idxA = (r * POINTS + i) * 2;
          const idxB = idxA + 2;
          const dx = curr[idxB] - curr[idxA];
          const dy = curr[idxB + 1] - curr[idxA + 1];
          const dist = Math.hypot(dx, dy);
          const tension = Math.abs(dist - rest) / rest;

          const axp = curr[idxA] / aspect,
            ayp = curr[idxA + 1];
          const bxp = curr[idxB] / aspect,
            byp = curr[idxB + 1];
          const ndx = bxp - axp,
            ndy = byp - ayp;
          const nlen = Math.hypot(ndx, ndy) || 1e-6;
          const nx = (-ndy / nlen) * HALF_WIDTH,
            ny = (ndx / nlen) * HALF_WIDTH;

          const a0x = axp + nx,
            a0y = ayp + ny;
          const a1x = axp - nx,
            a1y = ayp - ny;
          const b0x = bxp + nx,
            b0y = byp + ny;
          const b1x = bxp - nx,
            b1y = byp - ny;
          // two triangles: (a0,b0,a1) and (a1,b0,b1)
          vbuf[vi++] = a0x;
          vbuf[vi++] = a0y;
          vbuf[vi++] = tension;
          vbuf[vi++] = b0x;
          vbuf[vi++] = b0y;
          vbuf[vi++] = tension;
          vbuf[vi++] = a1x;
          vbuf[vi++] = a1y;
          vbuf[vi++] = tension;
          vbuf[vi++] = a1x;
          vbuf[vi++] = a1y;
          vbuf[vi++] = tension;
          vbuf[vi++] = b0x;
          vbuf[vi++] = b0y;
          vbuf[vi++] = tension;
          vbuf[vi++] = b1x;
          vbuf[vi++] = b1y;
          vbuf[vi++] = tension;
        }
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
      // Continuous: high -> glow sharpness + brightness.
      gl.uniform1f(u.u_high, audio.high);
      gl.drawArrays(gl.TRIANGLES, 0, vertCount);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.9 + audio.level * 0.4,
        exposure: 1.05 + audio.kickPulse * 0.2,
        aberration: 0.0008 + audio.change * 0.0015,
        grain: 0.035,
        vignette: 1.15,
        flash: audio.kickPulse * 0.3,
        threshold: 0.55,
        time: t,
      });
    },
  };
}
