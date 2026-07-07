// 73 BUBBLES — soap-film thin-film interference. A tiled field of drifting metaball
// bubbles is shaded with a per-channel cosine palette keyed on local membrane
// "thickness" (an fBm swirl riding the metaball potential), so each bubble carries its
// own slowly rotating rainbow and neighbours show a visible seam where they touch —
// exactly how real foam looks. level drives the swirl/drift flow speed, bass breathes
// the interference band width, centroid shifts the overall colour temperature, kicks
// send a localised ripple through nearby membranes, and highs sharpen the Fresnel rim
// that gives each bubble its glassy roundness. Pure fragment (hashed-grid metaballs).

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_flow, u_bass, u_centroid, u_kick, u_high, u_seed;
out vec4 o;

vec2 hashCell(vec2 p){
  p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3)));
  return fract(sin(p) * 43758.5453123);
}

// 5-octave IQ-style fbm (matches domainwarp.ts) used for the in-membrane swirl.
float fbmS(vec2 p, float t){
  float a = 0.5, f = 0.0;
  mat2 R = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++){
    f += a * snoise(vec3(p, t * 0.15));
    p = R * p;
    a *= 0.5;
  }
  return f;
}

// One hashed-grid bubble: soft metaball weight, plus bookkeeping for the nearest
// bubble under this pixel (used for the Fresnel rim and per-bubble colour variety).
void bubbleCell(vec2 cell, vec2 p, float T, float speedT,
    inout float field, inout float bestW, inout float bestDistN, inout float bestPhase){
  vec2 h = hashCell(cell);
  vec2 h2 = hashCell(cell + vec2(91.7, 13.3));
  float baseR = mix(0.22, 0.42, h.x);
  // Slow breathing "life" cycle (never fully vanishes) reads as gentle birth/regrowth.
  float life = 0.35 + 0.65 * (0.5 + 0.5 * sin(T * 0.05 * (0.4 + h.y) + h.x * 6.2831));
  float r = baseR * life;
  float ang = h2.y * 6.2831 + speedT * (0.12 + 0.22 * h.y);
  vec2 center = cell + 0.5 + vec2(cos(ang), sin(ang)) * (0.30 * (1.0 - h.x * 0.4));
  vec2 d = p - center;
  float dist = length(d);
  float w = (r * r) / (dist * dist + r * r * 0.16 + 1e-4);
  field += w;
  if (w > bestW){
    bestW = w;
    bestDistN = dist / max(r, 1e-3);
    bestPhase = h.x * 3.1 + h2.x * 2.3;
  }
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 5.2;
  // seed macro: slide the whole foam field + palette phase (u_seed=0 is unmodulated).
  p += vec2(u_seed * 37.0, -u_seed * 23.0);

  float T = u_time;
  float speedT = T * u_flow;

  vec2 base = floor(p);
  float field = 0.0, bestW = 0.0, bestDistN = 3.0, bestPhase = 0.0;
  for (int dy = -1; dy <= 1; dy++){
    for (int dx = -1; dx <= 1; dx++){
      bubbleCell(base + vec2(float(dx), float(dy)), p, T, speedT, field, bestW, bestDistN, bestPhase);
    }
  }

  float mask = smoothstep(0.45, 1.35, field);

  // Membrane thickness: metaball potential + a per-bubble fbm swirl (drifts with
  // level via speedT) + a slow bass-driven breathing + a localised kick ripple.
  vec2 swirlP = p * 1.6 + vec2(bestPhase * 4.0, -bestPhase * 3.0) + vec2(speedT * 0.35, -speedT * 0.25);
  float swirl = fbmS(swirlP, speedT);
  float breathe = 1.0 + u_bass * 0.55 * sin(T * 0.4 + bestPhase * 6.2831);
  float ripple = u_kick * exp(-bestDistN * 2.0) * sin(bestDistN * 9.0 - T * 7.0) * 0.5;
  float thickness = field * 0.16 + swirl * breathe * 0.5 + ripple + bestPhase * 0.25;

  // bass widens/narrows the rainbow bands; centroid is the overall colour temperature.
  float bandFreq = 2.4 + u_bass * 2.0;
  float hueShift = u_centroid * 0.6 + u_seed * 0.35;
  vec3 filmCol = palette(thickness * bandFreq + hueShift,
    vec3(0.55, 0.55, 0.55), vec3(0.38, 0.38, 0.38),
    vec3(1.0, 1.15, 1.3), vec3(0.12, 0.34, 0.58));
  // Faux sphere shading: dimmer core, brighter toward the rim.
  filmCol *= 0.72 + 0.4 * smoothstep(0.0, 1.0, clamp(bestDistN, 0.0, 1.0));

  // Fresnel-style edge ring (sharper with high), applied via mix() so it can never
  // blow past white the way a raw additive highlight would.
  float ringW = 4.0 + u_high * 5.0;
  float dR = (bestDistN - 1.0) * ringW;
  float rim = exp(-dR * dR);

  vec3 bg = vec3(0.02, 0.035, 0.06) + vec3(0.015, 0.01, 0.03) * sin(uv.y * 3.0 + T * 0.05);
  vec3 col = mix(bg, filmCol, mask);
  col = mix(col, vec3(1.0, 0.97, 0.93), rim * mask * (0.16 + u_high * 0.32));

  vec2 vd = uv - 0.5;
  col *= 1.0 - dot(vd, vd) * 0.3;

  o = vec4(pow(max(col, 0.0), vec3(0.88)), 1.0);
}`;

export function createBubbles(ctx: SceneContext): Scene {
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
      gl.uniform1f(u.u_flow, 0.22 + audio.level * 1.3);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
