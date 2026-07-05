// 54 TYPO — kinetic typography. A grid of procedural glyphs (hash-driven 5x7 dot
// matrices, no real font) forms rows of pseudo-text. barPhase sweeps a
// "crystallization" front top-to-bottom each bar: rows behind the front settle into
// a stable monochrome glyph, rows ahead still flicker as unformed accent-coloured
// noise. novelty/change re-draws the underlying "word" (the per-cell glyph seed),
// crossfading smoothly between the old and new pattern rather than cutting. bass
// thickens/sharpens the dot strokes, centroid tints the accent hue, and kickPulse
// adds a brief localised glow only to the row band the front has just crystallized
// (never a full-screen flash). Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_bass, u_centroid, u_barPhase, u_kick, u_seedPrev, u_seedNext, u_wordMix;
out vec4 o;

// one 5x7 dot-matrix cell: on/off per sub-dot, soft-thresholded so bass can push
// the threshold (more lit dots = bolder strokes) and sharpen/soften the edge
// (contrast) without ever going fully binary.
float dotOn(vec2 local, float id, float thr, float edge){
  vec2 g = floor(local * vec2(5.0, 7.0));
  float r = hash11(dot(g, vec2(12.9898, 78.233)) + id * 13.7);
  return 1.0 - smoothstep(thr - edge, thr + edge, r);
}

void main(){
  float aspect = u_res.x / u_res.y;
  const float COLS = 28.0;
  float rowsF = COLS / aspect * (5.0 / 7.0);

  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 guv = vec2(uv.x * COLS, (1.0 - uv.y) * rowsF); // row 0 = top of screen
  vec2 cellIdx = floor(guv);
  vec2 cellFrac = fract(guv);
  float colIdx = cellIdx.x;
  float rowIdx = cellIdx.y;

  // margin/gutter between glyphs so the grid reads as separated characters
  const float margin = 0.13;
  vec2 local = clamp((cellFrac - margin) / (1.0 - 2.0 * margin), 0.0, 0.999);
  float inMask = step(0.0, cellFrac.x - margin) * step(cellFrac.x, 1.0 - margin)
               * step(0.0, cellFrac.y - margin) * step(cellFrac.y, 1.0 - margin);

  // bass -> stroke thickness (threshold) and contrast (edge softness)
  float thr = 0.52 - u_bass * 0.16;
  float edge = mix(0.22, 0.05, clamp(u_bass * 1.3, 0.0, 1.0));

  // stable "word" content: a glyph id per cell, crossfaded between the previous
  // and next re-draw (novelty/change) so a swap dissolves instead of cutting.
  float baseId = hash11(colIdx * 3.11 + rowIdx * 7.77);
  float onPrev = dotOn(local, baseId * 61.0 + u_seedPrev * 97.0, thr, edge);
  float onNext = dotOn(local, baseId * 61.0 + u_seedNext * 97.0, thr, edge);
  float wm = smoothstep(0.0, 1.0, u_wordMix);
  float targetOn = mix(onPrev, onNext, wm) * inMask;

  // unformed state: a low-rate flicker independent of the word content, standing
  // in for "ink" that has not crystallized yet (always-on autonomous motion).
  float noisyOn = dotOn(local, baseId * 61.0 + floor(u_time * 2.4) * 211.0, thr, max(edge, 0.12)) * inMask;

  // barPhase drives a top-to-bottom crystallization front, once per bar.
  float rowFrac = (rowIdx + 0.5) / rowsF;
  const float band = 0.09;
  float confirm = smoothstep(rowFrac - band, rowFrac + band, u_barPhase);
  float front = exp(-pow((u_barPhase - rowFrac) * rowsF * 1.15, 2.0));

  float inkAmt = mix(noisyOn * 0.7, targetOn, confirm);
  // gentle always-on shimmer so even settled glyphs are never perfectly frozen
  inkAmt *= 1.0 + 0.05 * sin(u_time * 1.7 + rowIdx * 0.8 + colIdx * 0.5);
  inkAmt = clamp(inkAmt, 0.0, 1.0);

  // monotone background + a single accent colour (centroid-tinted, slow drift)
  vec3 bg = vec3(0.045, 0.05, 0.065) + 0.02 * sin(uv.y * 24.0 + u_time * 0.08);
  vec3 stable = vec3(0.9, 0.92, 0.94);
  float hue = 0.55 + u_centroid * 0.4 + sin(u_time * 0.045) * 0.02;
  vec3 accent = palette(hue, vec3(0.5, 0.45, 0.5), vec3(0.5, 0.45, 0.5), vec3(1.0), vec3(0.0, 0.33, 0.67));
  vec3 inkCol = mix(accent, stable, confirm);

  vec3 col = mix(bg, inkCol, inkAmt);
  col += accent * front * 0.14;          // faint always-on trace of the scan line
  col += accent * front * u_kick * 0.9;  // kick: localised boost, only the just-confirmed row band

  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const frac = (x: number): number => x - Math.floor(x);

export function createTypo(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;

  // "word" state: two glyph seeds (prev/next) crossfaded on novelty/change so a
  // re-draw dissolves smoothly rather than cutting.
  let wordGen = 0;
  let seedPrev = 0.171;
  let seedNext = 0.171;
  let wordMix = 1;
  let sinceChange = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      sinceChange += dt;
      if (audio.change > 0.5 && sinceChange > 3.2) {
        wordGen += 1;
        seedPrev = seedNext;
        seedNext = frac(wordGen * 0.618034 + 0.171);
        wordMix = 0;
        sinceChange = 0;
      }
      wordMix = Math.min(1, wordMix + dt / 0.9);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_barPhase, audio.barPhase);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_seedPrev, seedPrev);
      gl.uniform1f(u.u_seedNext, seedNext);
      gl.uniform1f(u.u_wordMix, wordMix);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
