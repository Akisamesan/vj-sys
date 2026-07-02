// 34 HEXGRID — pulsing hexagonal cell grid. Each hex cell lights up by the energy
// of a frequency band (log-spaced spectrum mapped radially: bass at centre, highs
// at periphery); a kick sends a bright ring expanding across the cells; centroid
// tints the palette. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2  u_res;
uniform float u_time, u_aspect, u_bass, u_beat, u_ring_r, u_high, u_centroid, u_level;
uniform float u_spec[24];
out vec4 o;

// Nearest hex cell in a flat-top axial grid.
// Returns vec4(localOffset.xy, cellCenter.xy) where localOffset is the vector
// from the nearest hex centre to the sample point.
vec4 hexCell(vec2 p) {
  vec2 s  = vec2(1.0, 1.7320508);
  vec4 hC = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h  = vec4(p - hC.xy*s, p - (hC.zw + 0.5)*s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw)
    ? vec4(h.xy, hC.xy)
    : vec4(h.zw, hC.zw + 0.5);
}

// Hex interior distance: 0 at cell centre, ~0.5 at boundary.
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, normalize(vec2(1.0, 1.732))), p.x);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  // Aspect-correct, centred coordinate (-0.5..0.5 in y, wider in x).
  vec2 p  = (uv - 0.5) * vec2(u_aspect, 1.0);

  // Bass breathing: more bass → grid expands (cells widen).
  float gridScale = 10.0 + u_bass * 2.0;
  vec4  hc        = hexCell(p * gridScale);
  vec2  localOff  = hc.xy;
  vec2  cellId    = hc.zw;

  // ed: 0 = cell centre, ~0.5 = hex boundary.
  float ed = hexDist(localOff);

  // Cell screen-space position (used for ring distance + band mapping).
  vec2  cellCenter = cellId * vec2(1.0, 1.7320508) / gridScale;
  float cellR      = length(cellCenter);

  // Radial band mapping: bass bands at centre, high bands at periphery.
  int   bandIdx = int(clamp(cellR / 0.72 * 24.0, 0.0, 23.0));
  float energy  = max(0.0, u_spec[bandIdx]);

  // Per-cell temporal flicker via hash.
  float flicker = 0.85 + 0.15 * hash11(dot(cellId, vec2(127.1, 311.7)) + floor(u_time * 7.0));

  // Glow fill: interior brightness proportional to band energy.
  float fill = (1.0 - smoothstep(0.38, 0.46, ed)) * energy * flicker;

  // Thin bright border near hex edge; u_high raises inner edge → narrower border.
  float bInner = 0.40 + u_high * 0.05;   // 0.40..0.45
  float bOuter = 0.48;
  float rise   = smoothstep(bInner, bInner + 0.03, ed);
  float fall   = 1.0 - smoothstep(bOuter - 0.01, bOuter + 0.01, ed);
  float border = rise * fall * (0.4 + energy * 0.7 + u_high * 0.4);

  // Expanding kick ring: bright halo travels outward from grid centre.
  float ring = u_beat * smoothstep(0.07, 0.0, abs(cellR - u_ring_r));

  // Palette: hue from radial band + centroid shift + slow time drift.
  float hue = float(bandIdx) / 24.0 * 0.6 + u_centroid * 0.4 + u_time * 0.007;
  vec3  col = palette(hue,
    vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67));

  float lum = fill + border + ring * 0.5;
  lum *= max(0.0, 0.15 + u_level * 1.8);
  vec3 fc = col * lum;
  fc += vec3(0.85, 0.93, 1.0) * ring * 0.6;   // cool-white ring flash

  // Vignette.
  vec2 vd = uv - 0.5;
  fc *= 1.0 - dot(vd, vd) * 1.2;

  // Gamma.
  o = vec4(pow(max(fc, vec3(0.0)), vec3(0.85)), 1.0);
}`;

export function createHexgrid(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const spec = new Float32Array(24);
  let rw = 1,
    rh = 1;
  let kickTime = -100;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      // Scale and clamp spectrum for headroom.
      for (let i = 0; i < 24; i++) spec[i] = Math.min(1.2, audio.spectrum[i] * 1.7);

      // Track kick time; ring radius grows linearly from zero after each kick.
      if (audio.kick) kickTime = t;
      const ringR = Math.max(0, (t - kickTime) * 0.65);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_ring_r, ringR);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1fv(u.u_spec, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
