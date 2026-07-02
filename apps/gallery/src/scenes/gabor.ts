// 39 GABOR — noise-steered Gabor stripe field: locally parallel bands whose orientation
// and frequency vary across space, reading like brushed silk / wood-grain that swirls
// with the music. Three octaves of orientation noise give rich interleaved grain; a
// perpendicular sparkle ripple gates on highs; kicks bloom the crests. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_oScale, u_freq, u_rot, u_drift, u_high, u_centroid, u_beat;
out vec4 o;

float gaborBand(vec2 p, float osc, float freq, float phaseOff) {
  float ang = snoise(vec3(p * osc, u_time * 0.07)) * 3.14159 + u_rot;
  vec2 dir = vec2(cos(ang), sin(ang));
  float phase = dot(p, dir) * freq;
  return sin(phase + u_time * u_drift + phaseOff);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 4.0;

  // Three octaves of Gabor-like stripes at different scales and orientations
  float b1 = gaborBand(p, u_oScale,        u_freq,        0.0);
  float b2 = gaborBand(p, u_oScale * 1.7,  u_freq * 1.6,  1.3)  * 0.6;
  float b3 = gaborBand(p, u_oScale * 2.8,  u_freq * 2.5, -0.9)  * 0.35;
  float band = b1 + b2 + b3;

  // Normalize to 0..1
  float norm = clamp(band * 0.5 + 0.5, 0.0, 1.0);

  // Crest lines — narrower smoothstep on high energy = crisper filaments
  float halfW = max(0.04, 0.18 - u_high * 0.14);
  float crest = smoothstep(0.5 - halfW, 0.5 + halfW, norm);
  crest *= 1.0 + u_beat * 0.9;

  // Beat frequency jolt on primary orientation
  vec2 beatDir = vec2(cos(u_rot), sin(u_rot));
  float jolt = sin(dot(p, beatDir) * (u_freq + u_beat * 4.0) + u_time * u_drift);
  float joltCrest = clamp(jolt * 0.5 + 0.5, 0.0, 1.0);
  crest = mix(crest, joltCrest, u_beat * 0.35);

  // Perpendicular sparkle ripple gated by highs
  float angPerp = snoise(vec3(p * u_oScale * 1.3, u_time * 0.09 + 5.0)) * 3.14159
                  + u_rot + 1.5708;
  vec2 dirPerp = vec2(cos(angPerp), sin(angPerp));
  float sparkleRaw = sin(dot(p, dirPerp) * u_freq * 4.0 + u_time * u_drift * 1.8);
  float sparkle = pow(clamp(sparkleRaw * 0.5 + 0.5, 0.0, 1.0), 4.0) * u_high;

  // Palette — centroid hue offset drives colour temperature
  float hue = 0.55 + u_centroid * 0.35 + band * 0.06;
  vec3 baseCol = palette(hue,
    vec3(0.38, 0.32, 0.28),
    vec3(0.32, 0.28, 0.22),
    vec3(1.0,  0.9,  0.8),
    vec3(0.0,  0.12, 0.28));

  vec3 col = baseCol * (0.25 + norm * 0.55);
  col += vec3(0.95, 0.98, 1.0) * crest  * 0.8;
  col += vec3(0.75, 0.88, 1.0) * sparkle * 0.45;
  col *= 1.0 + u_beat * 0.5;

  // Vignette
  vec2 dv = uv - 0.5;
  col *= 1.0 - dot(dv, dv) * 1.1;

  // Gamma
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.85)), 1.0);
}`;

export function createGabor(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let rot = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // Integrate orientation from mid energy so the grain field turns smoothly
      rot += audio.mid * dt * 0.9;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);

      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_oScale, 0.8);
      gl.uniform1f(u.u_freq, 3.0 + audio.bass * 8.0);
      gl.uniform1f(u.u_rot, rot);
      gl.uniform1f(u.u_drift, 0.3 + audio.level * 2.2);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
