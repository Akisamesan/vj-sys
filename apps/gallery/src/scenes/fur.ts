// 72 FUR — combed anisotropic fur field: a curl-noise tangent flow drives short,
// densely packed "combed" strokes with a Kajiya-Kay-style directional highlight and
// fine per-strand grain. Differs from FIELDLINES (long marched LIC streamlines) and
// GABOR (infinite continuous stripe bands): here the field is chopped into short,
// randomised-length dashes per flow lane so it reads as brushed fur/pelt rather than
// flowing water or woven silk. Kicks "comb" the flow — a structural realignment (or,
// sometimes, a ruffle) of the whole field, never a flash. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2  u_res;
uniform float u_flowT, u_curlScale, u_density, u_shininess, u_centroid;
uniform float u_combAmt, u_messAmt, u_combAngle;
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p  = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 3.2;

  // Tangent flow direction from a divergence-free curl-noise field.
  vec3 curl = curlNoise(vec3(p * u_curlScale, u_flowT), u_flowT * 0.6);
  float ang = atan(curl.y, curl.x);

  // Kick "comb": blend the whole field toward one random direction (align), or
  // scatter it with an extra rotation kick (ruffle) — a structural change that
  // decays with kickPulse, not an instantaneous flash.
  float messAng = snoise(vec3(p * 2.2, u_flowT * 0.7 + 9.0)) * 3.14159 * u_messAmt;
  vec2 T0 = vec2(cos(ang + messAng), sin(ang + messAng));
  vec2 combDir = vec2(cos(u_combAngle), sin(u_combAngle));
  vec2 T  = normalize(mix(T0, combDir, u_combAmt * 0.85));
  vec2 N  = vec2(-T.y, T.x);

  // Local flow-aligned coordinate frame (per-pixel, Gabor-style basis) — but used
  // to break the field into short dashed strokes rather than infinite bands.
  float alongT = dot(p, T) * u_density;
  float alongN = dot(p, N) * u_density;
  float laneId = floor(alongN);
  float laneF  = fract(alongN);

  // Per-lane random attributes: stroke length, phase offset, brightness variance.
  float lh1 = hash11(laneId * 12.9898);
  float lh2 = hash11(laneId * 78.233 + 3.7);
  float lh3 = hash11(laneId * 33.1  + 7.1);
  float strandLen = mix(0.55, 1.8, lh1);
  float within = fract(alongT / strandLen + lh2 * 37.0);
  // Short bump per period along the strand: strokes fade in/out instead of running on.
  float taper = smoothstep(0.0, 0.22, within) * smoothstep(1.0, 0.72, within);

  // Fine hair-grain: per-strand high-frequency shading, like individual fibres.
  float grain = 0.6 + 0.4 * snoise(vec3(alongT * 5.0, laneId * 4.0, u_flowT * 0.15));

  // Hair fibre core: a thin bright line across the lane; narrows with density/high.
  float halfW = mix(0.22, 0.07, clamp(u_shininess / 40.0, 0.0, 1.0));
  float core = 1.0 - smoothstep(0.0, halfW, abs(laneF - 0.5));
  float strand = core * taper * grain * (0.6 + 0.4 * lh3);

  // Kajiya-Kay anisotropic highlight: brightest where the tangent runs
  // perpendicular to a fixed light direction.
  vec2 L = vec2(0.6, 0.8);
  float TdotL = dot(T, L);
  float spec = pow(sqrt(max(0.0, 1.0 - TdotL * TdotL)), u_shininess);

  // Fur palette: brown -> gold -> near-black, phase driven by spectral centroid.
  float hue = 0.06 + u_centroid * 0.22 + lh1 * 0.03;
  vec3 base = palette(hue,
    vec3(0.30, 0.20, 0.12),
    vec3(0.26, 0.20, 0.12),
    vec3(1.00, 0.85, 0.55),
    vec3(0.02, 0.06, 0.14));

  vec3 col = base * (0.16 + 0.12 * grain);
  col += base * strand;
  col = mix(col, vec3(1.0, 0.92, 0.75), spec * strand * 0.55);
  col *= 1.0 + u_combAmt * 0.3;

  // Vignette + gamma.
  vec2 dv = uv - 0.5;
  col *= 1.0 - dot(dv, dv) * 1.15;
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.85)), 1.0);
}`;

export function createFur(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let flowT = 0;
  let combAngle = 0;
  let combSign = 1; // +1 = comb (align to combAngle), -1 = ruffle (scatter)

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(_t, dt, audio: AudioEngine) {
      // level -> sway speed: how fast the flow field churns (wind through fur);
      // a small floor keeps it alive in silence.
      flowT += dt * (0.05 + audio.level * 0.4);

      // kick -> a fresh comb impulse: pick a new direction and comb/ruffle mode.
      if (audio.kick) {
        combAngle = Math.random() * Math.PI * 2;
        combSign = Math.random() < 0.62 ? 1 : -1;
      }
      const combAmt = combSign > 0 ? audio.kickPulse : 0;
      const messAmt = combSign < 0 ? audio.kickPulse : 0;

      // bass -> curl scale (curvature/tightness of the flow field)
      const curlScale = 0.55 + audio.bass * 1.5;
      // high -> stroke density and specular sharpness
      const density = 7.0 + audio.high * 11.0;
      const shininess = 6.0 + audio.high * 36.0;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_flowT, flowT);
      gl.uniform1f(u.u_curlScale, curlScale);
      gl.uniform1f(u.u_density, density);
      gl.uniform1f(u.u_shininess, shininess);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_combAmt, combAmt);
      gl.uniform1f(u.u_messAmt, messAmt);
      gl.uniform1f(u.u_combAngle, combAngle);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
