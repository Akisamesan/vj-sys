// 83 PENROSE — a non-periodic 5-fold quasicrystal built from a de Bruijn pentagrid:
// five families of evenly-angled parallel lines are folded (floor/fract) into a tiling
// of thick/thin rhombus-proxy cells, coloured in complementary hues. Bass breathes the
// grid scale, level drifts the whole field like slow wind, the centroid tunes hue, high
// sharpens the grout lines, and change/novelty relocates the symmetry centre between
// musical regimes. Kicks send a soft ring of lit tiles outward from that centre — never
// a full-screen flash, just the wavefront of the quasicrystal catching light as it
// passes. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res, u_ringCenter;
uniform float u_time, u_scale, u_drift, u_edge, u_hue, u_kickPulse, u_ringR, u_rot, u_seed;
out vec4 o;

const float PI = 3.14159265359;

// distance (in grid units) from v to the nearest integer grid line: 0 on the line,
// 0.5 at the midpoint between two consecutive lines.
float lineDist(float v){ float f = fract(v); return 0.5 - abs(f - 0.5); }

// pentagrid family k (k=0..4): unit normal at 36*k degrees, unit spacing, a generic
// per-family offset (golden-ratio steps keep the five families from ever tripling up).
float gridV(vec2 p, int k, float scale, float seedShift){
  float a = float(k) * (PI / 5.0);
  vec2 n = vec2(cos(a), sin(a));
  float shift = float(k) * 0.61803398875 + seedShift;
  return dot(n, p) * scale + shift;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 2.4;

  // level -> slow flow of the whole field; seed macro -> continuous domain offset
  vec2 driftDir = normalize(vec2(0.6, 0.8));
  p += driftDir * u_drift;
  p += vec2(u_seed * 17.0, -u_seed * 11.0);

  // change/novelty regime retarget: slow reorientation around the (also relocating)
  // ring centre, eased in JS so this is always a drift, never a cut.
  float ca = cos(u_rot), sa = sin(u_rot);
  vec2 pr = p - u_ringCenter;
  pr = mat2(ca, -sa, sa, ca) * pr;
  vec2 pg = pr + u_ringCenter;

  float seedShift = u_seed * 0.7;
  float v0 = gridV(pg, 0, u_scale, seedShift);
  float v1 = gridV(pg, 1, u_scale, seedShift);
  float v2 = gridV(pg, 2, u_scale, seedShift);
  float v3 = gridV(pg, 3, u_scale, seedShift);
  float v4 = gridV(pg, 4, u_scale, seedShift);

  float f0 = floor(v0), f1 = floor(v1), f2 = floor(v2), f3 = floor(v3), f4 = floor(v4);
  float d0 = lineDist(v0), d1 = lineDist(v1), d2 = lineDist(v2), d3 = lineDist(v3), d4 = lineDist(v4);

  // grout: minimum distance to any of the five line families
  float edge = min(d0, min(d1, min(d2, min(d3, d4))));

  // the two closest families locally bound this cell; their index gap (folded to 1 or
  // 2) tells thick (72/108 deg) rhombus apart from thin (36/144 deg) rhombus.
  int i1 = 0; float m1 = d0;
  int i2 = 1; float m2 = d1;
  if (m2 < m1) { float tm = m1; m1 = m2; m2 = tm; int ti = i1; i1 = i2; i2 = ti; }
  if (d2 < m2) { if (d2 < m1) { m2 = m1; i2 = i1; m1 = d2; i1 = 2; } else { m2 = d2; i2 = 2; } }
  if (d3 < m2) { if (d3 < m1) { m2 = m1; i2 = i1; m1 = d3; i1 = 3; } else { m2 = d3; i2 = 3; } }
  if (d4 < m2) { if (d4 < m1) { m2 = m1; i2 = i1; m1 = d4; i1 = 4; } else { m2 = d4; i2 = 4; } }

  int diff = i1 - i2; if (diff < 0) diff = -diff;
  float folded = min(float(diff), 5.0 - float(diff));
  float thick = step(folded, 1.5); // 1 = thick-rhombus family pair, 0 = thin

  // full five-tuple floor index -> a stable per-cell identity for subtle shading.
  float cellId = f0 * 13.0 + f1 * 31.0 + f2 * 57.0 + f3 * 91.0 + f4 * 127.0 + u_seed * 197.0;
  float rnd = hash11(cellId);

  float hue = u_hue + u_seed * 0.4;
  vec3 thickCol = palette(hue,       vec3(0.5), vec3(0.42), vec3(1.0), vec3(0.0, 0.15, 0.3));
  vec3 thinCol  = palette(hue + 0.5, vec3(0.5), vec3(0.42), vec3(1.0), vec3(0.0, 0.15, 0.3));
  vec3 base = mix(thinCol, thickCol, thick);
  base *= 0.55 + 0.3 * rnd;

  float edgeMask = 1.0 - smoothstep(0.0, u_edge, edge);
  vec3 col = mix(base, base * 0.35, edgeMask * 0.7);   // grout: darken, never erase the fill
  col = mix(col, vec3(1.0), edgeMask * 0.1);           // faint bright seam for crispness

  // kick: a soft ring of lit tiles expanding from the (regime-relocatable) centre —
  // never a full-screen flash, just a travelling wavefront gated by kickPulse.
  float r = length(p - u_ringCenter);
  float band = exp(-pow((r - u_ringR) * 3.2, 2.0));
  vec3 accent = clamp(mix(vec3(0.95, 0.88, 0.75), thickCol * 1.3 + 0.15, 0.4), 0.0, 0.92);
  col = mix(col, accent, band * u_kickPulse * 0.4);

  vec2 dv = uv - 0.5; col *= 1.0 - dot(dv, dv) * 0.25;
  o = vec4(pow(max(col, 0.0), vec3(0.85)), 1.0);
}`;

export function createPenrose(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let seed = 0;
  let drift = 0;
  let ringR = -10;
  let centerX = 0,
    centerY = 0,
    targetX = 0,
    targetY = 0;
  let rot = 0,
    rotTarget = 0;
  let regimeCooldown = 0;

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
      // level -> slow flow of the whole quasicrystal
      drift += dt * (0.05 + audio.level * 0.4);

      // kickPulse -> expanding ring trigger (retriggers cleanly on every kick)
      if (audio.kick) ringR = 0;
      ringR = Math.min(8, ringR + dt * 4.2);

      // change/novelty -> regime transition: relocate the symmetry centre and nudge
      // orientation, both eased continuously so it reads as a drift, not a cut.
      regimeCooldown -= dt;
      const changeSig = Math.max(audio.change, Math.min(1, audio.novelty * 0.5));
      if (changeSig > 0.55 && regimeCooldown <= 0) {
        targetX = (Math.random() - 0.5) * 0.7;
        targetY = (Math.random() - 0.5) * 0.7;
        rotTarget += (Math.random() - 0.5) * 0.5;
        regimeCooldown = 2.2;
      }
      const ease = 1 - Math.exp(-dt * 0.8);
      centerX += (targetX - centerX) * ease;
      centerY += (targetY - centerY) * ease;
      rot += (rotTarget - rot) * ease;

      // bass -> breathing scale (idle sine keeps it alive even in silence)
      const breathe = Math.sin(t * 0.12) * 0.05;
      const scale = 3.2 * (1 + breathe) + audio.bass * 1.3;
      // high -> sharper (narrower) grout lines
      const edgeW = Math.max(0.018, 0.05 - Math.min(audio.high, 1) * 0.032);
      // centroid -> hue of the thick/thin complementary pair
      const hue = 0.5 + audio.centroid * 0.35;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_drift, drift);
      gl.uniform1f(u.u_edge, edgeW);
      gl.uniform1f(u.u_hue, hue);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1f(u.u_ringR, ringR);
      gl.uniform2f(u.u_ringCenter, centerX, centerY);
      gl.uniform1f(u.u_rot, rot);
      gl.uniform1f(u.u_seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
