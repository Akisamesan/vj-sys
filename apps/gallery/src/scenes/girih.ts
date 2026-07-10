// 84 GIRIH — Islamic geometric strapwork rosettes tiled across a hexagonal
// lattice. Each cell folds its local polar coordinate into an N-fold wedge
// (N cycles 3/4/5 on musical change, echoing traditional hexagram/pentagram
// girih motifs) and traces two rotated polygon-edge outlines per cell — a
// double stroke that reads as interlaced strapwork, continuous across cell
// boundaries because every cell renders the same phase-locked motif. bass
// widens the strap, mid drives a slow overall rotation, kick propagates a
// "next rosette lights up" wave across the lattice (structural, not a
// flash), centroid drifts the traditional gold/turquoise/indigo palette,
// high sharpens the strap edges and adds crossing sparkle.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_aspect, u_bass, u_mid, u_high, u_centroid, u_level;
uniform float u_rot, u_order, u_wave_r, u_seed;
out vec4 o;

// Nearest hex cell in a flat-top axial grid (same convention as 34 HEXGRID).
vec4 hexCell(vec2 p) {
  vec2 s  = vec2(1.0, 1.7320508);
  vec4 hC = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h  = vec4(p - hC.xy*s, p - (hC.zw + 0.5)*s);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw)
    ? vec4(h.xy, hC.xy)
    : vec4(h.zw, hC.zw + 0.5);
}

// Signed distance-ish field to the nearest edge of a regular N-gon (apothem R)
// in angle-folded space; |d|==0 traces the polygon boundary.
float polyEdge(float r, float a, float n, float R) {
  float seg = 6.28318530718 / n;
  float aa = mod(a, seg) - seg * 0.5;
  return r * cos(aa) - R;
}

float strap(float r, float a, float rotOff, float n, float R, float w) {
  float d0 = polyEdge(r, a + rotOff, n, R);
  float d1 = polyEdge(r, a + rotOff + 3.14159265 / n, n, R);
  float e0 = smoothstep(w, w * 0.25, abs(d0));
  float e1 = smoothstep(w, w * 0.25, abs(d1));
  return max(e0, e1);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);

  // bass (continuous): lattice breathes, which also thickens the strap in
  // screen space since the grid scale shrinks.
  float gridScale = 6.4 - u_bass * 0.6;
  vec4 hc = hexCell(p * gridScale + vec2(u_seed * 37.0, -u_seed * 23.0));
  vec2 localOff = hc.xy;
  vec2 cellId = hc.zw;
  float r = length(localOff);
  float a = atan(localOff.y, localOff.x);

  // bass (continuous): strap width.
  float w = 0.05 + u_bass * 0.035;

  float rosette = strap(r, a, u_rot, u_order, 0.30, w);
  // Inner smaller rosette at the opposite phase for extra filigree.
  rosette = max(rosette, strap(r, a, u_rot + 0.35, u_order, 0.16, w * 0.7) * 0.85);

  // Per-cell rim so unlit cells still read as "the pattern" at rest (BLACK guard).
  float rim = smoothstep(0.48, 0.44, r) * 0.05;

  // kick (trigger): a lit-rosette wave propagates outward from the origin
  // across the lattice, cell by cell — a structural readout, no flash.
  float cellR = length(cellId) * 0.6;
  float wave = smoothstep(0.55, 0.0, abs(cellR - u_wave_r));
  float lit = 0.35 + 0.65 * wave;

  // high (continuous): crossing sparkle where the two straps overlap.
  float cross = strap(r, a, u_rot, u_order, 0.30, w) * strap(r, a, u_rot + 0.35, u_order, 0.16, w * 0.7);
  float sparkle = smoothstep(0.5, 1.0, cross) * u_high;

  float hue = 0.08 + u_centroid * 0.5 + u_time * 0.006;
  vec3 gold = vec3(0.85, 0.62, 0.18);
  vec3 turquoise = vec3(0.10, 0.55, 0.52);
  vec3 indigo = vec3(0.10, 0.12, 0.35);
  vec3 col = palette(hue, vec3(0.4, 0.35, 0.3), vec3(0.35, 0.3, 0.3), gold, turquoise);

  vec3 fc = mix(indigo * 0.35, col, rosette * lit) + rim * indigo * 2.0;
  fc += vec3(1.0, 0.96, 0.85) * sparkle * 0.6;
  fc *= 0.6 + u_level * 0.6;

  vec2 vd = uv - 0.5;
  fc *= 1.0 - dot(vd, vd) * 0.7;

  o = vec4(pow(max(fc, vec3(0.0)), vec3(0.88)), 1.0);
}`;

export function createGirih(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let rot = 0;
  let order = 3;
  let orderTarget = 3;
  let lastChangeT = -10;
  let waveT = -10;
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
    frame(t, dt, audio: AudioEngine) {
      // mid (continuous): slow overall rotation of the strapwork.
      rot += dt * (0.03 + audio.mid * 0.1);

      // Structural regime change: cycles the base polygon order (traditional
      // girih favours 3/4/5-fold motifs) on strong musical transitions.
      if (audio.change > 0.45 && t - lastChangeT > 1.4) {
        const opts = [3, 4, 5];
        orderTarget = opts[Math.floor(audio.centroid * opts.length) % opts.length];
        lastChangeT = t;
      }
      order += (orderTarget - order) * (1 - Math.exp(-dt * 2.0));

      // kick (trigger): restart the lit-rosette wave from the lattice origin.
      if (audio.kick) waveT = t;
      const waveR = Math.max(0, (t - waveT) * 2.2);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_mid, audio.mid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_rot, rot);
      gl.uniform1f(u.u_order, order);
      gl.uniform1f(u.u_wave_r, waveR);
      gl.uniform1f(u.u_seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
