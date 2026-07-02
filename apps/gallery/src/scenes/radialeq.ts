// 90 RADIAL_EQ — radial bar-graph bloom: 24 spectrum bands wrap around a circle as
// smooth polar petals mirrored top/bottom into a blossoming flower of sound. Concentric
// beat rings expand from the centre on every kick; a glowing core pulses with bass.

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
uniform float u_time, u_aspect;
uniform float u_spec[${BAND_COUNT}];
uniform float u_bass, u_beat, u_level, u_centroid, u_high;
uniform float u_ring_r;
out vec4 o;

void main(){
  // Aspect-correct polar coords centred on the screen
  vec2 q = (gl_FragCoord.xy - 0.5*u_res) / u_res.y;
  float r = length(q);
  float a = atan(q.y, q.x);            // -PI..PI

  // Fold top↔bottom for bilateral flower symmetry: angle lives in [0, PI]
  float fa = abs(a);                    // 0..PI
  float ft = fa / 3.14159265;          // 0..1

  // Map to spectrum band [0..BAND_COUNT-1]
  float fband   = clamp(ft * float(${BAND_COUNT}), 0.0, float(${BAND_COUNT}) - 1.001);
  int   band     = int(fband);
  float band_frac = fract(fband);       // position within band (for separators)

  float sv = u_spec[band];

  // ── Petal ────────────────────────────────────────────────────────────────
  float baseR   = 0.04 + u_bass * 0.05;
  float amp     = 0.26 + u_level * 0.22;
  float petal_r = baseR + sv * amp;

  // Filled interior with soft outer edge
  float fill = smoothstep(petal_r + 0.013, petal_r - 0.008, r)
             * smoothstep(0.0, baseR * 0.55, r);

  // Bright tip glow — sharpened by highs
  float sharp = 18.0 + u_high * 32.0;
  float tip   = exp(-pow((r - petal_r) * sharp, 2.0))
              * smoothstep(0.0, baseR * 0.45, r);

  // Thin radial separator between adjacent bands
  float sep = smoothstep(0.0, 0.06, min(band_frac, 1.0 - band_frac));
  fill *= sep;
  tip  *= sep;

  // Sparkle at tips driven by highs
  float spark = step(1.0 - u_high * 0.75, hash11(float(band) + u_time * 7.3));
  tip  += tip * spark * u_high * 1.4;

  // ── Beat ring ─────────────────────────────────────────────────────────────
  float rr   = clamp(u_ring_r, 0.0, 1.5);
  float ring = exp(-pow((r - rr) * 22.0, 2.0))
             * u_beat * max(0.0, 1.0 - rr * 0.72);

  // ── Core glow ─────────────────────────────────────────────────────────────
  float core = smoothstep(0.09, 0.0, r) * (0.35 + u_bass * 1.7 + u_level * 0.7);
  core      += smoothstep(0.04, 0.0, r) * u_level * 2.2;

  // ── Colour ───────────────────────────────────────────────────────────────
  float hue    = float(band) / float(${BAND_COUNT}) + u_centroid * 0.45 + u_time * 0.022;
  vec3 palA    = vec3(0.5);
  vec3 palB    = vec3(0.5);
  vec3 palC    = vec3(1.0);
  vec3 palD    = vec3(0.0, 0.33, 0.67);
  vec3 col     = palette(hue,        palA, palB, palC, palD);
  vec3 tipCol  = palette(hue + 0.13, palA, palB, palC, palD);

  vec3 c  = col    * fill * (0.55 + sv * 0.95);   // petal body
  c      += tipCol * tip  * (1.9 + u_high * 1.1); // bright tip + sparkle
  c      += vec3(0.72, 0.88, 1.0) * ring * 2.2;   // expanding beat ring (cold blue-white)
  c      += vec3(1.0,  0.72, 0.45) * core;         // warm core

  // Vignette
  c *= 1.0 - smoothstep(0.35, 0.88, r);

  // Gamma
  o = vec4(pow(max(c, 0.0), vec3(0.85)), 1.0);
}`;

export function createRadialEq(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const spec = new Float32Array(BAND_COUNT);
  let ringR = 0;
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // Boost and clamp spectrum for visual impact
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.4, audio.spectrum[i] * 1.85);

      // Expanding beat ring: reset to near-zero on kick, grow outward, hide when past edge
      if (audio.kick) ringR = 0.02;
      ringR += dt * (0.52 + audio.level * 0.38);
      if (ringR > 1.38) ringR = 0;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1fv(u.u_spec, spec);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_ring_r, ringR);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
