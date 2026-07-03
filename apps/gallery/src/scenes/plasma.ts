// 31 PLASMA — classic demoscene plasma reimagined as a spectral field. A flowing scalar
// field is the superposition of several sine waves over the plane plus an organic snoise
// domain offset, mapped through a vivid cosine palette. Level speeds the animation,
// bass raises contrast, spectrum bands morph the spatial frequencies, centroid shifts
// the hue, highs add fine ripple, and kicks send a radial bloom from centre.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_speed, u_amp, u_centroid, u_high, u_beat, u_seed;
uniform float u_spec[24];
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / max(u_res.y, 1e-4);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 5.0;
  float t = u_time * u_speed;

  // seed macro (u_seed=0 → unmodulated): another face of the same plasma —
  // different warp patch, orbit phases and palette rotation, all continuous
  float sd = u_seed * 6.28318;

  // organic domain warp so the field never looks like a static grid
  vec2 pw = p + 0.3 * vec2(
    snoise(vec3(p * 0.6 + u_seed * 11.0, t * 0.1)),
    snoise(vec3(p * 0.6 + 9.0 - u_seed * 7.0, t * 0.1))
  );

  // spectral frequency modulation: sample three representative bands
  float f_low = 1.0 + u_spec[2]  * 0.8;   // ~100 Hz  — modulates x freq
  float f_mid = 1.0 + u_spec[8]  * 0.6;   // ~600 Hz  — modulates y freq
  float f_hi2 = 1.0 + u_spec[14] * 0.4;   // ~2 kHz   — modulates diagonal

  // two radial centres that orbit slowly around the field
  vec2 c1 = vec2(cos(t * 0.13 + sd) * 1.5, sin(t * 0.17 + sd * 0.7) * 1.5);
  vec2 c2 = vec2(sin(t * 0.11 - sd) * 1.2, cos(t * 0.09 + sd * 1.3) * 1.8);

  // superposition of sine field terms
  float v = 0.0;
  v += sin(pw.x * 1.2 * f_low  + t * 0.7);
  v += sin(pw.y * 1.5 * f_mid  + t * 0.5);
  v += sin((pw.x + pw.y) * 0.9 * f_hi2 + t * 0.6);
  v += sin(length(pw - c1) * 2.0 - t * 1.1);
  v += sin(length(pw - c2) * 1.7 - t * 0.8);
  // fine high-frequency ripple, gated by u_high
  v += sin(pw.x * 4.0 + pw.y * 3.0 + t * 1.4) * clamp(u_high, 0.0, 1.0) * 0.6;

  // normalise to ~0..1, then modulate contrast via bass amplitude
  float vn = clamp((v / 6.0 + 0.5) * (0.5 + u_amp * 1.2), 0.0, 1.0);

  // cosine palette; centroid shifts the hue toward warmer tones
  float hue = vn * 1.6 + clamp(u_centroid, 0.0, 1.0) * 0.45 + u_seed * 0.5;
  vec3 col = palette(hue,
    vec3(0.5, 0.5, 0.5),
    vec3(0.5, 0.5, 0.5),
    vec3(1.0, 1.0, 0.9),
    vec3(0.0, 0.33, 0.67)
  );

  // kick pulse: radial brightness bloom emanating from centre
  float r = length(p);
  float bloom = max(0.0, 1.0 - r * 0.45);
  col += col * clamp(u_beat, 0.0, 1.0) * bloom * 0.9;

  // subtle vignette + gamma
  vec2 dv = uv - 0.5;
  col *= 1.0 - dot(dv, dv) * 1.1;
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.88)), 1.0);
}`;

export function createPlasma(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let seed = 0;

  return {
    macros: {
      seed: (v) => {
        seed = v;
      },
    },
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_speed, 0.4 + audio.level * 1.4);
      gl.uniform1f(u.u_amp, audio.bass);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_seed, seed);
      gl.uniform1fv(u.u_spec, audio.spectrum);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
