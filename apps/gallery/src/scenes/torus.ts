// 41 TORUS — additive (P,Q) torus-knot line-strip that re-knots on musical change.
// Neon centreline generated fully in the VS (no attribute buffer, gl_VertexID only).
// Topology steps on novelty, bass breathes scale, kick flashes, centroid shifts palette.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 3000;
const TAU = 6.28318530718;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform float u_yaw, u_pitch, u_scale, u_aspect;
uniform float u_centroid, u_kick, u_high, u_t;
uniform float u_P, u_Q, u_off;
out vec3 v_col;
void main(){
  float s  = float(gl_VertexID) / float(${N - 1}) * ${TAU};
  float ph = s * u_P;
  float r  = 2.0 + cos(s * u_Q);
  float x  = r * cos(ph) + u_off * (-sin(ph));
  float y  = r * sin(ph) + u_off * cos(ph);
  float z  = -sin(s * u_Q);
  // normalise: r max ≈ 3, z max = 1  →  fit in ≈ 1-unit radius
  vec3 p = vec3(x, y, z) * (1.0 / 3.6);
  // yaw
  float cy = cos(u_yaw), sy = sin(u_yaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  // pitch
  float cp = cos(u_pitch), sp = sin(u_pitch);
  p = vec3(p.x, cp*p.y - sp*p.z, sp*p.y + cp*p.z);
  // perspective (camera at z = 2.6)
  float persp = 1.0 / (2.6 - p.z * 0.4);
  vec2 clip = p.xy * u_scale * persp;
  clip.x /= u_aspect;
  gl_Position = vec4(clip, 0.0, 1.0);
  float depth   = 0.5 + p.z * 0.35;
  float shimmer = hash11(float(gl_VertexID) * 0.0137 + u_t * 2.7) * u_high * 0.4;
  // offset copy is dimmed so the tube illusion reads as thickness, not a twin
  float dimOff  = 1.0 - min(abs(u_off) * 5.0, 0.7);
  v_col = palette(
    u_centroid * 0.6 + s / ${TAU} * 0.4 + depth * 0.2,
    vec3(0.5), vec3(0.5), vec3(1.0, 0.9, 0.8), vec3(0.0, 0.25, 0.5)
  ) * (0.25 + depth * 0.8 + shimmer) * (1.0 + u_kick * 1.5) * dimOff;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Curated (P,Q) knot pairs — both in 2..5, P≠Q
const KNOTS: [number, number][] = [
  [2, 3],
  [3, 2],
  [2, 5],
  [5, 2],
  [3, 4],
  [4, 3],
  [5, 3],
  [3, 5],
  [4, 5],
  [5, 4],
];

export function createTorus(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;

  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // Empty VAO — geometry is generated entirely in the VS via gl_VertexID
  const vao = gl.createVertexArray()!;

  let rw = 1,
    rh = 1;
  let yaw = 0,
    pitch = 0;
  let scaleCur = 0.65;
  let pCur = 2.0,
    qCur = 3.0;
  let knotIdx = 0;
  let lastKnot = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },

    frame(t, dt, audio: AudioEngine) {
      // Step knot topology on musical change
      if (audio.change > 0.55 && t - lastKnot > 2.5) {
        knotIdx = (knotIdx + 1) % KNOTS.length;
        lastKnot = t;
      }
      const [pT, qT] = KNOTS[knotIdx];
      const ease = 1 - Math.exp(-dt * 1.5);
      pCur += (pT - pCur) * ease;
      qCur += (qT - qCur) * ease;

      // Rotation speed driven by level
      yaw += dt * (0.18 + audio.level * 0.9);
      pitch += dt * 0.12;

      // Scale breathes with bass
      scaleCur += (0.65 + audio.bass * 0.22 - scaleCur) * (1 - Math.exp(-dt * 6));

      // ---- render ----
      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_pitch, pitch);
      gl.uniform1f(u.u_scale, scaleCur);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_t, t);
      gl.uniform1f(u.u_P, pCur);
      gl.uniform1f(u.u_Q, qCur);
      gl.bindVertexArray(vao);

      // Main centreline
      gl.uniform1f(u.u_off, 0.0);
      gl.drawArrays(gl.LINE_STRIP, 0, N);

      // Faint tangential-offset copy for tube-thickness illusion
      gl.uniform1f(u.u_off, 0.15);
      gl.drawArrays(gl.LINE_STRIP, 0, N);

      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.1 + audio.level * 0.5,
        exposure: 1.1 + audio.kickPulse * 0.3,
        aberration: 0.001 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.4,
        threshold: 0.5,
        time: t,
      });
    },
  };
}
