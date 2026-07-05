// 61 PRISM — white light splits through a prism into a radiating rainbow. 24 spectrum
// bands each own one hue band, fanned out around the centre; bass opens the dispersion
// angle, centroid rotates the base hue, level breathes the overall brightness, and each
// kick sends a localized radial stretch pulse through the beams (no central flash). Pure
// fragment (angle/distance field, additive band overlay).

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2  u_res;
uniform float u_time, u_bass, u_level, u_centroid, u_kick, u_seed;
uniform float u_spec[${BAND_COUNT}];
out vec4 o;

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main(){
  float aspect = u_res.x / u_res.y;
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(p);
  float ang = atan(p.y, p.x); // -PI..PI

  // slow autonomous drift + seed macro (continuous, seed=0 -> identity rotation)
  float rot = u_time * 0.045 + u_seed * 6.2831853;
  float a01 = fract((ang + rot) / 6.2831853 + 0.5);

  // 24 angular slices, one per spectrum band
  float bandF = clamp(a01 * float(${BAND_COUNT}), 0.0, float(${BAND_COUNT}) - 1.001);
  int   band  = int(bandF);
  float bf    = fract(bandF);
  float sv    = u_spec[band];

  // bass -> dispersion angle: how much of each slice the beam fills (closed beam ->
  // fully split fan). distToCenter 0 at slice centre .. 1 at the seam between bands.
  float duty        = mix(0.25, 0.92, u_bass);
  float distToCenter = abs(bf - 0.5) * 2.0;
  float sector       = smoothstep(duty, duty * 0.35, distToCenter);

  // kick -> localized radial elongation pulse of this beam only (no central flash)
  float kickVar = 0.3 + 0.35 * hash11(float(band) * 13.17);
  float beamLen = 0.28 + sv * 0.55 + u_kick * kickVar;

  // traveling energy ripple along the beam: keeps autonomous motion + texture
  float wave   = 0.5 + 0.5 * sin(r * 22.0 - u_time * 2.2 - float(band) * 0.6);
  float radial = smoothstep(beamLen + 0.05, beamLen - 0.22, r) * (0.55 + 0.45 * wave);

  float beam = sector * radial;

  // centroid -> base hue offset, rotating the whole rainbow
  float hue = float(band) / float(${BAND_COUNT}) + u_centroid * 0.5 + u_seed * 0.15;
  vec3 rainbow = hsv2rgb(vec3(fract(hue), 0.85, 1.0));

  vec3 col = rainbow * beam * (1.3 + sv * 0.7);

  // secondary faint radial rainbow rings: places bands along the radial axis too,
  // overlaid on the angular fan (thin travelling rings, each tinted by its own band)
  float ringPos  = fract(r * 2.6 - u_time * 0.12);
  int   ringBand = int(clamp(ringPos * float(${BAND_COUNT}), 0.0, float(${BAND_COUNT}) - 1.001));
  float ringVal  = u_spec[ringBand];
  float ringHue  = ringPos + u_centroid * 0.5 + u_seed * 0.15;
  float ringSharp = pow(max(0.0, cos(ringPos * 6.2831853)), 6.0);
  col += hsv2rgb(vec3(fract(ringHue), 0.8, 1.0)) * ringSharp * ringVal * 0.55;

  // small white core: the light before it splits. Kept tight so it never dominates.
  float core = exp(-r * r * 90.0) * 0.55;
  col += vec3(1.0) * core;

  // level -> overall brightness (breathes with loudness, never black in silence)
  col *= 0.5 + u_level * 0.9;

  // gentle vignette + filmic-ish compression (avoids hard white-outs)
  vec2 d = uv - 0.5; col *= 1.0 - dot(d, d) * 0.35;
  vec3 tone = 1.0 - exp(-max(col, 0.0) * 1.15);
  o = vec4(tone, 1.0);
}`;

export function createPrism(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const spec = new Float32Array(BAND_COUNT);
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
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.3, audio.spectrum[i] * 1.6);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_seed, seed);
      gl.uniform1fv(u.u_spec, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
