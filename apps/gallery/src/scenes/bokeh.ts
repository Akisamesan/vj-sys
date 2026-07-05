// 60 BOKEH — a drifting field of defocused light globes. Twenty-eight soft, pastel
// discs wander lazily across the frame in slow Lissajous paths; the low end makes
// the whole depth-of-field "breathe" (every disc swells and settles together), the
// 24-band spectrum hands each disc a size family (low bands run large and soft,
// high bands stay small and crisp), level speeds the drift, centroid tips the
// warm/cool balance, and each kick hands one disc (round-robin) a local glow pulse
// — never a full-screen flash. Pure fragment; overlaps are composited with a
// screen blend (bounded to [0,1] per channel) instead of additive so the globes
// never blow out to a white sheet.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 28; // globe count (7x4 jittered grid)
const COLS = 7;
const ROWS = 4;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_centroid;
uniform vec2 u_pos[${N}];
uniform float u_radius[${N}];
uniform float u_hueOff[${N}];
uniform float u_boost[${N}];
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 1.7;

  // faint gradient so the frame never reads as pure black, even in silence
  vec3 col = mix(vec3(0.035,0.03,0.05), vec3(0.05,0.045,0.07), uv.y);

  float toneShift = (u_centroid - 0.35) * 0.35;

  for (int i = 0; i < ${N}; i++) {
    vec2 dv = p - u_pos[i];
    float dist = length(dv);
    float r = max(u_radius[i], 0.001);
    float t = clamp(dist / r, 0.0, 1.0);
    // soft bokeh disc: bright plateau near the centre, gentle fall-off toward the edge
    float disk = 1.0 - smoothstep(0.35, 1.0, t);
    disk = disk * disk * (3.0 - 2.0 * disk);

    float hue = fract(u_hueOff[i] + toneShift);
    vec3 tint = palette(hue, vec3(0.72,0.68,0.74), vec3(0.24,0.22,0.27), vec3(1.0,0.9,1.05), vec3(0.02,0.14,0.34));

    float glow = disk * (0.5 + u_boost[i] * 0.95);
    vec3 orb = clamp(tint * glow, 0.0, 1.0);
    // screen blend keeps the running composite bounded to [0,1] per channel, so
    // overlapping globes never additive-blow-out into a white sheet
    col = 1.0 - (1.0 - col) * (1.0 - orb);
  }

  o = vec4(pow(max(col, 0.0), vec3(0.92)), 1.0);
}`;

export function createBokeh(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);

  const bandIdx = new Int32Array(N);
  const baseX = new Float32Array(N);
  const baseY = new Float32Array(N);
  const ampX = new Float32Array(N);
  const ampY = new Float32Array(N);
  const freqA = new Float32Array(N);
  const freqB = new Float32Array(N);
  const phaseA = new Float32Array(N);
  const phaseB = new Float32Array(N);
  const sizeBase = new Float32Array(N);
  const hueOff = new Float32Array(N);

  const cellW = 2.8 / COLS;
  const cellH = 1.5 / ROWS;

  for (let i = 0; i < N; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    baseX[i] = -1.4 + (col + 0.5) * cellW + (Math.random() - 0.5) * cellW * 0.6;
    baseY[i] = -0.75 + (row + 0.5) * cellH + (Math.random() - 0.5) * cellH * 0.6;
    ampX[i] = cellW * (0.3 + Math.random() * 0.35);
    ampY[i] = cellH * (0.3 + Math.random() * 0.35);
    freqA[i] = 0.15 + Math.random() * 0.25;
    freqB[i] = 0.12 + Math.random() * 0.22;
    phaseA[i] = Math.random() * Math.PI * 2;
    phaseB[i] = Math.random() * Math.PI * 2;

    // spectrum band -> size family: low bands run large/soft, high bands small/crisp
    const band = Math.floor((i * BAND_COUNT) / N);
    bandIdx[i] = band;
    const bandFrac = band / (BAND_COUNT - 1);
    const rangeMin = 0.1 - bandFrac * 0.065; // 0.10 (low) .. 0.035 (high)
    const rangeMax = 0.22 - bandFrac * 0.13; // 0.22 (low) .. 0.09 (high)
    sizeBase[i] = rangeMin + Math.random() * (rangeMax - rangeMin);

    hueOff[i] = i / N + Math.random() * 0.05;
  }

  // static per-globe hue offsets never change frame to frame; upload once.
  gl.useProgram(prog);
  gl.uniform1fv(u.u_hueOff, hueOff);

  const pos = new Float32Array(N * 2);
  const radius = new Float32Array(N);
  const boost = new Float32Array(N);
  let kickIdx = 0;
  let flowT = 0;
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // level -> drift speed (always > 0 so globes keep wandering in silence)
      flowT += dt * (0.3 + audio.level * 1.3);
      // bass -> depth-of-field breathing, shared by every globe
      const focusPulse = 1.0 + audio.bass * 0.7;

      // kick -> hand one globe (round-robin) a local glow pulse, never a full flash
      if (audio.kick) {
        boost[kickIdx] = 1;
        kickIdx = (kickIdx + 1) % N;
      }
      const decay = Math.exp(-dt * 3.2);
      for (let i = 0; i < N; i++) boost[i] *= decay;

      for (let i = 0; i < N; i++) {
        pos[i * 2] = baseX[i] + ampX[i] * Math.sin(flowT * freqA[i] + phaseA[i]);
        pos[i * 2 + 1] = baseY[i] + ampY[i] * Math.cos(flowT * freqB[i] + phaseB[i]);
        const specFactor = 0.6 + audio.spectrum[bandIdx[i]] * 0.9;
        radius[i] = sizeBase[i] * specFactor * focusPulse;
      }

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform2fv(u.u_pos, pos);
      gl.uniform1fv(u.u_radius, radius);
      gl.uniform1fv(u.u_boost, boost);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
