// 49 ASCII — a terminal phosphor readout. The screen is a fixed grid of procedural
// 5x5 dot-matrix glyphs (hash-based, no real font, see matrix.ts); each cell's dot
// density stands in for character "ink". A column's local waveform amplitude sets
// how dense its glyphs are, the log spectrum biases whole column-bands (high bands
// read denser/brighter), the centroid sweeps the phosphor hue amber<->green<->cyan,
// and bass/level breathe the global contrast. A kick only thickens a handful of
// rows for one decaying beat — never a full-screen flash. Pure fragment pass.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

// Column count for the glyph grid (60-90 reads as a legible terminal density).
const COLS = 72;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time;
uniform float u_wave[${COLS}];
uniform float u_spectrum[${BAND_COUNT}];
uniform float u_centroid, u_bass, u_level, u_kick;
out vec4 o;

// Procedural 5x5 dot-matrix glyph: each sub-cell lights up with probability
// lit (a quantized brightness level), so denser levels read as "heavier" chars.
float glyphDot(vec2 p, float gid, float lit){
  vec2 g = floor(clamp(p, 0.0, 0.999) * 5.0);
  float idx = g.x + g.y * 5.0;
  float h = hash11(idx * 0.173 + gid * 3.71);
  return step(1.0 - lit, h);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float cols = ${COLS}.0;
  float aspect = u_res.x / u_res.y;
  float rows = cols / aspect; // keep cells square-ish

  int col = int(clamp(floor(uv.x * cols), 0.0, cols - 1.0));
  int row = int(floor(uv.y * rows));
  vec2 cellUv = vec2(fract(uv.x * cols), fract(uv.y * rows));

  // Column-groups map onto spectrum bands (COLS/BAND_COUNT columns per band).
  int band = int(clamp(floor((float(col) + 0.5) / cols * ${BAND_COUNT}.0), 0.0, ${BAND_COUNT - 1}.0));
  float waveAmp = u_wave[col];
  float bandVal = u_spectrum[band];
  float bandGain = mix(0.55, 1.35, float(band) / ${BAND_COUNT - 1}.0); // high bands bias denser

  // No expansion curve here: a <1 power (the previous version used 0.6/0.8)
  // inflates near-zero input a lot more than it inflates loud input, which
  // crushes exactly the quiet/loud contrast a column-by-column read needs.
  // Keeping this linear preserves the waveform's own zero-crossing/peak shape
  // as sparse-vs-dense columns, and the spectrum term stays a minor bias.
  float wv = clamp(waveAmp, 0.0, 1.0);
  float sv = clamp(bandVal, 0.0, 1.0);
  float breathing = 0.03 * sin(u_time * 0.12 + float(row) * 0.05); // slow autonomous drift

  float contrast = 0.85 + u_level * 0.28 + u_bass * 0.12;

  // A small, slowly-rotating subset of rows takes the kick punch (structural,
  // localized, decaying with kickPulse -- never a full-frame flash).
  float pulseSel = step(0.86, hash11(float(row) * 1.71 + floor(u_time * 0.5) * 4.37));

  float lum = (0.14 + breathing + wv * 0.72 + sv * bandGain * 0.16) * contrast;
  lum += pulseSel * u_kick * 0.28;
  lum = clamp(lum, 0.05, 0.92);

  // Quantize into discrete brightness levels (the "ASCII ramp").
  float qLum = floor(lum * 6.0 + 0.5) / 6.0;

  // Glyph identity drifts on its own (independent of audio) so the screen never
  // freezes even in silence; offset per-cell so changes are not screen-synced.
  float gid = floor(u_time * 2.2 + hash11(float(col) * 12.9898 + float(row) * 78.233) * 37.0);

  // Small margin per cell (gutter) so the grid reads as discrete characters.
  vec2 gp = (cellUv - 0.5) * 1.18 + 0.5;
  float glyphVal = 0.0;
  if (gp.x >= 0.0 && gp.x <= 1.0 && gp.y >= 0.0 && gp.y <= 1.0) {
    glyphVal = glyphDot(gp, gid, qLum);
  }

  // Phosphor hue sweep: amber (low centroid) <-> green (mid) <-> cyan (high).
  float hueT = clamp(u_centroid, 0.0, 1.0);
  vec3 amber = vec3(1.0, 0.55, 0.05);
  vec3 green = vec3(0.15, 1.0, 0.35);
  vec3 cyan  = vec3(0.10, 0.85, 1.0);
  vec3 tint = mix(mix(amber, green, clamp(hueT * 2.0, 0.0, 1.0)), cyan, clamp((hueT - 0.5) * 2.0, 0.0, 1.0));

  vec3 col3 = min(tint * glyphVal, vec3(0.95)); // hard safety clamp, never true white
  o = vec4(col3, 1.0);
}`;

export function createAscii(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const waveCol = new Float32Array(COLS);
  const spec = new Float32Array(BAND_COUNT);
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      // Sample wave[512] down into one local-amplitude value per column.
      const wave = audio.wave;
      const n = wave.length;
      for (let c = 0; c < COLS; c++) {
        const start = Math.floor((c * n) / COLS);
        const end = Math.floor(((c + 1) * n) / COLS);
        let sum = 0;
        for (let i = start; i < end; i++) sum += Math.abs(wave[i]);
        waveCol[c] = end > start ? sum / (end - start) : 0;
      }
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.3, audio.spectrum[i] * 1.5);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1fv(u.u_wave, waveCol);
      gl.uniform1fv(u.u_spectrum, spec);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
