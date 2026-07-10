// 100 SUPERNOVA — the collection's finale. A pulsing stellar core (driven by
// the summed 24-band spectrum, not a raw kick flash) radiates debris streaks
// whose per-band length/brightness trace the full spectrum around the
// circle (angle = band, like 90 RADIAL_EQ but explosive rather than
// symmetric-bloom). Every kick launches an expanding shockwave ring — a
// structural trigger, propagated rather than flashed — and genuine musical
// "drops" (novelty spikes) retarget the palette hue and fire a wider,
// brighter multi-ring burst, so the biggest visual events line up with
// actual song structure rather than every beat. Pure fragment, 1 pass, all
// intensity built from mix()/exp() falloffs to stay under the WHITE budget.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const MAX_RINGS = 4;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_aspect, u_energy, u_level, u_centroid, u_high, u_rot, u_hueJump;
uniform float u_spec[${BAND_COUNT}];
uniform float u_ring_r[${MAX_RINGS}];
uniform float u_ring_w[${MAX_RINGS}];
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x) + u_rot;

  float hue = 0.58 + u_centroid * 0.5 + u_hueJump;
  vec3 hot = vec3(0.85, 0.92, 1.0);
  vec3 cool = vec3(0.95, 0.35, 0.08);
  vec3 col = vec3(0.0);

  // Core: radius/brightness driven by summed spectral energy (continuous),
  // not a raw per-kick flash.
  float coreRad = 0.05 + u_energy * 0.11;
  float core = exp(-pow(r / max(coreRad, 0.001), 2.0));
  col += mix(cool, hot, clamp(u_energy * 1.3, 0.0, 1.0)) * core * (1.1 + u_energy * 0.9);

  // Radial debris streaks: angle -> spectrum band, length -> that band's energy.
  float bandF = fract(a / 6.28318530718) * ${BAND_COUNT}.0;
  int bandIdx = int(clamp(bandF, 0.0, ${BAND_COUNT - 1}.0));
  float e = max(0.0, u_spec[bandIdx]);
  float streakLen = coreRad + e * 0.75;
  float edgeSoft = 0.02 + u_high * 0.02;
  float streak = smoothstep(streakLen + edgeSoft, streakLen - edgeSoft, r) * smoothstep(coreRad * 0.6, coreRad, r);
  // Narrow each streak's angular width so 24 distinct spokes read clearly.
  float wedge = fract(bandF) - 0.5;
  float wedgeMask = smoothstep(0.5, 0.5 - (0.18 + u_high * 0.1), abs(wedge));
  vec3 debrisCol = palette(hue + float(bandIdx) / ${BAND_COUNT}.0 * 0.4, vec3(0.5), vec3(0.5), hot, cool);
  col = mix(col, col + debrisCol * (0.35 + e * 1.1), streak * wedgeMask);

  // Faint ember field so silence never reads pure black.
  float ember = (0.02 + 0.02 * (0.5 + 0.5 * snoise(vec3(p * 3.0, u_time * 0.05)))) * smoothstep(coreRad, 1.1, r);
  col += cool * ember;

  // Kick-launched shockwave rings, structural (propagated, not flashed).
  for (int i = 0; i < ${MAX_RINGS}; i++) {
    float rr = u_ring_r[i];
    float ww = u_ring_w[i];
    if (rr < 0.0) continue;
    float ring = exp(-pow((r - rr) / max(ww, 0.001), 2.0));
    col += mix(hot, vec3(1.0, 0.85, 1.0), u_hueJump) * ring * 0.55;
  }

  // Cool outer vignette; the frame stays a dark stage for the eruption.
  col *= 1.0 - smoothstep(0.55, 1.15, r) * 0.75;
  col *= 0.85 + u_level * 0.35;

  o = vec4(pow(max(col, vec3(0.0)), vec3(0.88)), 1.0);
}`;

interface RingState {
  r: number;
  w: number;
  speed: number;
  active: boolean;
}

export function createSupernova(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let rot = 0;
  let hueJump = 0;
  let lastDropT = -10;

  const rings: RingState[] = [];
  for (let i = 0; i < MAX_RINGS; i++) rings.push({ r: -1, w: 0.08, speed: 0.5, active: false });
  let ringCursor = 0;

  const ringR = new Float32Array(MAX_RINGS);
  const ringW = new Float32Array(MAX_RINGS);

  function launchRing(speed: number, width: number): void {
    rings[ringCursor] = { r: 0.0, w: width, speed, active: true };
    ringCursor = (ringCursor + 1) % MAX_RINGS;
  }

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // mid (continuous): slow rotation of the debris field.
      rot += dt * (0.05 + audio.mid * 0.15);

      // kick (trigger): a shockwave ring, propagated outward — structural
      // readout of the beat.
      if (audio.kick) launchRing(0.55 + audio.bass * 0.5, 0.07);

      // novelty spike (structural "drop"): retarget the palette hue and fire
      // an extra wide/bright ring burst, so the finale's biggest moments
      // line up with real song structure, not every beat.
      if (audio.change > 0.55 && t - lastDropT > 2.0) {
        lastDropT = t;
        launchRing(0.9, 0.14);
        launchRing(0.75, 0.1);
      }
      const dropEnv = Math.max(0, 1 - (t - lastDropT) * 0.6);
      hueJump += (dropEnv * 0.5 - hueJump) * (1 - Math.exp(-dt * 3));

      for (const ring of rings) {
        if (!ring.active) continue;
        ring.r += dt * ring.speed;
        ring.w += dt * 0.05;
        if (ring.r > 1.3) ring.active = false;
      }
      for (let i = 0; i < MAX_RINGS; i++) {
        ringR[i] = rings[i].active ? rings[i].r : -1;
        ringW[i] = rings[i].w;
      }

      // Summed spectral energy drives the core (continuous, not per-kick).
      let energy = 0;
      for (let i = 0; i < BAND_COUNT; i++) energy += audio.spectrum[i];
      energy = Math.min(1.4, energy / BAND_COUNT);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_energy, energy);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_rot, rot);
      gl.uniform1f(u.u_hueJump, hueJump);
      gl.uniform1fv(u.u_spec, audio.spectrum);
      gl.uniform1fv(u.u_ring_r, ringR);
      gl.uniform1fv(u.u_ring_w, ringW);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
