// 63 GODRAYS (light) — sunlight breaking through cloud gaps. A virtual sun sits
// just outside the frame; layered ridged fBm noise sampled along the angle from
// that sun to each pixel forms radial shafts (seamless in angle since it walks
// the unit circle), attenuated by distance for a soft pseudo-volumetric look.
// centroid slowly swings the sun's direction, bass thickens/lengthens the shafts,
// the top of the spectrum sharpens their fineness, level lifts overall brightness,
// and kicks add only a small local glow hugging the sun — never a full flash.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_bass, u_level, u_centroid, u_highfine, u_kick, u_seed;
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_res.x/u_res.y, 1.0);

  // Sun direction: slow autonomous drift (still moves in silence) plus a gentle
  // centroid sway, kept above the horizon so the light never dips below frame.
  // u_seed macro adds a continuous extra rotation (0 = unmodulated image).
  float wobble = sin(u_time*0.037)*0.55 + sin(u_time*0.019 + 1.7)*0.25;
  wobble += (u_centroid - 0.35) * 1.3;
  wobble += u_seed * 1.2;
  wobble = clamp(wobble, -1.25, 1.25);
  float angle = 1.5708 + wobble;
  vec2 sun = 1.15 * vec2(cos(angle), sin(angle));

  vec2 toPix = p - sun;
  float dist = length(toPix);
  vec2 dir = toPix / max(dist, 1e-4);

  // Angular fBm: dir traces the unit circle, so noise sampled from it is
  // seamless in angle and near-constant along a radial line -> a "spoke".
  float freq = 4.0 + u_bass * 9.0;        // bass: how many/dense the shafts are
  float growth = 2.15 + u_highfine * 1.4; // highs: how quickly octaves get finer
  float fbm = 0.0;
  float amp = 0.6;
  for (int i = 0; i < 3; i++) {
    fbm += amp * abs(snoise(vec3(dir*freq, u_time*0.045 + u_seed*2.0 + float(i)*3.7)));
    freq *= growth;
    amp *= 0.55;
  }
  float rays = pow(clamp(1.0 - fbm, 0.0, 1.0), 2.2);

  // Clouds patchily occlude the shafts, drifting slowly.
  float cloud = snoise(vec3(p*1.4 + vec2(u_time*0.02, 0.0), u_time*0.015));
  rays *= mix(0.35, 1.0, smoothstep(-0.35, 0.55, cloud));

  // Longer reach (bass) instead of a hard cutoff, plus a soft ambient halo so
  // the light always reads even where the noisy shafts happen to be sparse.
  float decay = mix(1.9, 0.75, clamp(u_bass*1.3, 0.0, 1.0));
  float halo = exp(-dist*1.1);
  float shaft = rays * exp(-dist*decay) + halo*0.22;

  // Cool sky backdrop, slightly warmer near the horizon; faint cloud tinting
  // keeps it from ever reading flat/black.
  vec3 skyTop = vec3(0.045, 0.06, 0.16);
  vec3 skyHorizon = vec3(0.16, 0.12, 0.24);
  vec3 sky = mix(skyHorizon, skyTop, clamp(p.y + 0.5, 0.0, 1.0));
  sky += cloud * 0.02;

  vec3 sunCol = vec3(1.0, 0.74, 0.36);
  float bloom = 0.3 + u_level * 0.85;
  // mix(), not +=, so the core never becomes a hard white blob (nudges toward
  // the warm sun colour, capped well short of 1.0).
  vec3 col = mix(sky, sunCol, clamp(shaft * bloom, 0.0, 0.88));

  // Kick: a small glow hugging the sun only (dist decays fast), not a flash.
  float glow = exp(-dist*4.0) * u_kick;
  col = mix(col, sunCol, clamp(glow * 0.5, 0.0, 0.6));

  o = vec4(pow(max(col, 0.0), vec3(0.9)), 1.0);
}`;

export function createGodrays(ctx: SceneContext): Scene {
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
      let highFine = 0;
      for (let i = 18; i < 24; i++) highFine += audio.spectrum[i];
      highFine /= 6;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_highfine, highFine);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
