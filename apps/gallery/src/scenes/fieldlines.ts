// 81 FIELDLINES — streamlines of a moving noise flow field: glowing flow lines
// trace LIC-style streaks aligned with a snoise angle field, vortices drift and
// reorganise with the music like iron filings in a magnetic field. Pure fragment
// (per-pixel flow-aligned LIC approximation).

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2  u_res;
uniform float u_time, u_fScale, u_speed, u_stepH, u_sharp, u_centroid, u_beat;
uniform vec2  u_offset;
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p  = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 3.0;

  float animT    = u_time * u_speed;
  // Direction comes from a single snoise angle field. (True curlNoise costs ~36
  // snoise per sample; at this step count that would tank the framerate, so we use
  // a smooth angle field — streamlines read the same as flowing field lines.)
  float seedA    = snoise(vec3((p + u_offset) * u_fScale, animT)) * 6.28318;
  float fieldSpd = 0.4 + 0.6 * abs(snoise(vec3((p + u_offset) * u_fScale + 4.0, animT)));
  float angle    = seedA;

  // LIC: march forward then backward, re-sampling the angle field each step and
  // accumulating high-frequency noise along the path — samples average high where
  // aligned (streak) and low across (gap), producing flow-aligned lines.
  float acc = 0.0;
  float h   = u_stepH;
  vec2  pos = p;

  for (int i = 0; i < 8; i++) {
    float a = snoise(vec3((pos + u_offset) * u_fScale, animT)) * 6.28318;
    pos += vec2(cos(a), sin(a)) * h;
    acc += snoise(vec3(pos * 9.5, animT * 0.22)) * 0.5 + 0.5;
  }
  pos = p;
  for (int i = 0; i < 8; i++) {
    float a = snoise(vec3((pos + u_offset) * u_fScale, animT)) * 6.28318;
    pos -= vec2(cos(a), sin(a)) * h;
    acc += snoise(vec3(pos * 9.5, animT * 0.22)) * 0.5 + 0.5;
  }
  acc /= 16.0;

  // Contrast boost: high → crisper flow lines (thin bright streaks emerge)
  acc = pow(clamp(acc, 0.0, 1.0), 2.5 + u_sharp * 7.0);

  // Palette: centroid drives hue, local flow angle adds per-vortex tint
  vec3 col = palette(
    u_centroid * 0.7 + angle / 6.28318 * 0.3 + 0.05,
    vec3(0.45, 0.45, 0.55),
    vec3(0.50, 0.40, 0.45),
    vec3(1.00, 0.90, 0.80),
    vec3(0.00, 0.10, 0.30)
  );
  // Brighter where the field is fast; kick pulse blooms overall brightness
  col  = col * acc * (0.35 + fieldSpd * 1.5);
  col *= 1.0 + u_beat * 2.2;

  // Vignette
  vec2 dv = uv - 0.5;
  col *= 1.0 - dot(dv, dv) * 1.4;

  // Gamma
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.8)), 1.0);
}`;

export function createFieldlines(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  // Slowly-accumulated offset so big musical changes restructure vortices
  let offsetX = 0.0;
  let offsetY = 0.0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // change/novelty drift shifts which part of the curl field is sampled
      offsetX += dt * audio.change * 0.18;
      offsetY += dt * audio.novelty * 0.09;

      // bass → larger vortex size (smaller fScale = coarser curl features)
      const fScale = Math.max(0.3, 1.0 - audio.bass * 0.62);
      // level → animation speed (field churns faster with energy)
      const speed = 0.08 + audio.level * 0.28;
      // bass → streak length (longer steps = longer flow lines)
      const stepH = 0.028 + audio.bass * 0.042;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_fScale, fScale);
      gl.uniform1f(u.u_speed, speed);
      gl.uniform1f(u.u_stepH, stepH);
      gl.uniform1f(u.u_sharp, audio.high * 0.85);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform2f(u.u_offset, offsetX, offsetY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
