// 59 STROBE — not a screen-wide flash, but the strobe *rig itself*: a grid of round
// lamps set in a dark chassis. Only a bar/phrase-synced subset chases across the
// grid at any moment (column sweep / row sweep / diagonal sweep / alternating
// checker blink), never the whole panel at once. barPhase drives the chase
// position, novelty/change swaps which chase pattern is running (a structural,
// section-level cut — not a per-beat flicker), bass raises how many lamps may be
// lit simultaneously (capped well below full-panel), kickPulse gives only the
// lamps already lit a short punch, and centroid tints the neon hue. Pure fragment:
// each pixel resolves its cell, a chase "score", and a lamp SDF.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res, u_grid;
uniform float u_phase, u_mode, u_density, u_hue, u_kick;
out vec4 o;

float wrapDist(float a, float b){
  float d = abs(a - b);
  return min(d, 1.0 - d);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 g = uv * u_grid;
  vec2 cellId = floor(g);
  vec2 f = fract(g) - 0.5;
  float cols = u_grid.x;
  float rows = u_grid.y;
  float cx = (cellId.x + 0.5) / cols;
  float cy = (cellId.y + 0.5) / rows;

  float travel = fract(u_phase);
  int m = int(u_mode + 0.5);

  // Chase "score": how eligible this cell is right now. Thresholded below by a
  // density budget so only a bounded slice of the panel ever lights at once.
  float score = 0.0;
  if (m == 0) {
    // column sweep, rows lag slightly for a skewed wavefront (not a flat bar)
    float lag = (cy - 0.5) * 0.16;
    float d = wrapDist(cx, fract(travel + lag));
    score = 1.0 - d * 2.0;
  } else if (m == 1) {
    // row sweep, columns lag slightly
    float lag = (cx - 0.5) * 0.16;
    float d = wrapDist(cy, fract(travel + lag));
    score = 1.0 - d * 2.0;
  } else if (m == 2) {
    // diagonal sweep
    float diag = fract((cx + cy) * 0.5);
    float d = wrapDist(diag, travel);
    score = 1.0 - d * 2.0;
  } else {
    // alternating checker blink: half the grid holds per quarter-bar, then swaps.
    // A brief attack on the swap instant reads as each lamp's own decay pulse
    // rather than a screen-wide flash.
    float quarter = floor(travel * 4.0);
    float group = mod(cellId.x + cellId.y, 2.0);
    float onGroup = step(abs(mod(quarter, 2.0) - group), 0.5);
    float qLocal = fract(travel * 4.0);
    float attack = exp(-qLocal * 6.0) * 0.35;
    float h = hash11(cellId.x * 12.9898 + cellId.y * 78.233 + quarter * 3.7);
    score = onGroup * clamp(0.55 + 0.45 * h + attack, 0.0, 1.0);
  }
  score = clamp(score, 0.0, 1.0);

  // Density budget: bass raises how much of the panel may be lit, capped ~30%.
  float thresh = 1.0 - u_density;
  float lit = smoothstep(thresh - 0.06, thresh + 0.06, score);

  // kickPulse only punches lamps that are already part of the chase — dark
  // lamps stay dark, so there is no whole-panel flash on the beat.
  float ambient = 0.055;
  float bri = ambient + lit * (1.0 + u_kick * 0.5);

  float d = length(f);
  float lampR = 0.34;
  float glow = smoothstep(lampR, lampR - 0.05, d);
  float socket = smoothstep(0.46, 0.40, d) - glow;

  float hue = 0.56 + u_hue * 0.4;
  vec3 neon = palette(hue, vec3(0.45, 0.42, 0.5), vec3(0.35, 0.35, 0.4), vec3(1.0, 0.9, 1.15), vec3(0.0, 0.12, 0.22));

  vec3 bg = vec3(0.02, 0.025, 0.035) * (0.75 + 0.25 * smoothstep(0.5, 0.25, max(abs(f.x), abs(f.y))));
  vec3 lampCol = neon * clamp(bri, 0.0, 1.3);

  vec3 col = bg;
  col += socket * vec3(0.05, 0.06, 0.08);
  col = mix(col, lampCol, glow);

  col = clamp(col, 0.0, 1.15);
  col = pow(col, vec3(0.92));
  o = vec4(col, 1.0);
}`;

export function createStrobe(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1;
  let rh = 1;
  let cols = 16;
  let rows = 9;
  let mode = 0;
  let lastChangeT = -10;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      cols = 16;
      rows = Math.max(5, Math.min(14, Math.round((cols * h) / w)));
    },
    frame(t, _dt, audio: AudioEngine) {
      // Section-level cut, not a per-beat one: a hold time keeps a sustained
      // change reading from re-triggering the pattern swap every frame.
      if (audio.change > 0.42 && t - lastChangeT > 2.4) {
        mode = (mode + 1) % 4;
        lastChangeT = t;
      }
      const density = Math.min(0.3, Math.max(0.1, 0.1 + audio.bass * 0.2));
      // barPhase drives the chase; a slow autonomous drift keeps the rig moving
      // (and off BLACK) even before tempo locks or during silence.
      const phase = audio.barPhase + t * 0.05;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform2f(u.u_grid, cols, rows);
      gl.uniform1f(u.u_phase, phase);
      gl.uniform1f(u.u_mode, mode);
      gl.uniform1f(u.u_density, density);
      gl.uniform1f(u.u_hue, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
