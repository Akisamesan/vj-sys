// 85 QUILT — generative patchwork quilt. The screen is a grid of square blocks;
// each block procedurally picks one of a few classic quilt motifs (diagonal
// half-square triangles, four-triangle pinwheel, concentric square rings) from
// a hash of its cell id. Rows are assigned spectrum bands (top→bottom sweeps
// low→high) driving block brightness/saturation; bass breathes the block
// density; a kick makes a whole row/column/rect of blocks re-roll their motif
// at once (structural trigger, not a flash); centroid drifts the palette
// phase. Thin dark seams separate the blocks. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_aspect, u_bass, u_centroid, u_kickPulse;
uniform float u_spec[24];
uniform float u_flip_axis, u_flip_width_cells, u_flip_gen;
uniform vec2 u_flip_pos;
uniform float u_seed, u_energy, u_density;
out vec4 o;

// Warm quilt hue groups (red/rust/gold/amber) plus a rare cool accent group
// (slot 4). u_seed/u_centroid rotate the whole family continuously.
vec3 warmColor(float slot, float jitter){
  float warmHue = 0.01 + 0.06*slot;
  float hue = mix(warmHue, 0.54, step(3.5, slot));
  hue = fract(hue + u_centroid*0.10 + u_seed*0.12 + jitter*0.012 + u_time*0.003);
  return palette(hue, vec3(0.55,0.42,0.32), vec3(0.32,0.28,0.22), vec3(1.0,1.0,0.85), vec3(0.02,0.06,0.14));
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p  = uv * vec2(u_aspect, 1.0);
  // seed macro: slide the block domain (continuous — grid pans, no cut).
  p += vec2(u_seed*0.35, -u_seed*0.22);

  // bass + density macro: block size / grid density (continuous, macro defaults to 0).
  float gridN = 7.0 + u_bass*6.0 + u_density*8.0;
  vec2 gp     = p * gridN;
  vec2 cellId = floor(gp);
  vec2 bl     = fract(gp);
  vec2 cellFrac = (cellId + 0.5) / gridN;

  // Kick-triggered region: a row / column / rect of blocks re-rolls motif together.
  float widthFrac = u_flip_width_cells / gridN;
  float inRow  = step(abs(cellFrac.y - u_flip_pos.y), widthFrac);
  float inCol  = step(abs(cellFrac.x - u_flip_pos.x), widthFrac);
  float inRect = inRow * inCol;
  float inRegion = u_flip_axis < 0.5 ? inRow : (u_flip_axis < 1.5 ? inCol : inRect);

  float gen   = inRegion * u_flip_gen;
  float hSeed = dot(cellId, vec2(127.1, 311.7)) + gen*991.7 + 41.0;
  float motifH = hash11(hSeed);
  float colorH = hash11(hSeed + 71.0);
  float jitter = hash11(hSeed + 133.0);

  int motif = motifH < 0.36 ? 0 : (motifH < 0.7 ? 1 : 2);

  float slotA = floor(colorH * 5.0);
  float slotB = mod(slotA + 2.0, 5.0);
  vec3 colA = warmColor(slotA, jitter);
  vec3 colB = warmColor(slotB, jitter + 11.0) * 0.6;

  float shape;
  if (motif == 0) {
    // diagonal half-square triangles, orientation per-cell
    float diagFlip = step(0.5, jitter);
    float d = mix(bl.x - bl.y, bl.x + bl.y - 1.0, diagFlip);
    float w = fwidth(d) * 1.5 + 1e-4;
    shape = smoothstep(-w, w, d);
  } else if (motif == 1) {
    // four-triangle pinwheel, alternating two tones
    vec2 c  = bl - 0.5;
    float d1 = c.x - c.y;
    float d2 = c.x + c.y;
    float w1 = fwidth(d1) * 1.5 + 1e-4;
    float w2 = fwidth(d2) * 1.5 + 1e-4;
    float s1 = smoothstep(-w1, w1, d1);
    float s2 = smoothstep(-w2, w2, d2);
    shape = abs(s1 - s2);
  } else {
    // concentric square rings
    float stripeCount = 3.0 + floor(jitter * 4.0);
    float r = max(abs(bl.x - 0.5), abs(bl.y - 0.5));
    float rings = fract(r * stripeCount);
    float w = fwidth(r * stripeCount) * 1.5 + 1e-4;
    shape = smoothstep(0.5 - w, 0.5 + w, rings);
  }

  vec3 col = mix(colB, colA, shape);

  // spectrum[24] spatial mapping: row -> band -> brightness/saturation.
  int bandIdx = int(clamp(cellFrac.y * 24.0, 0.0, 23.0));
  float energy = clamp(u_spec[bandIdx] * 1.15, 0.0, 1.0);
  col *= 0.38 + energy * 0.72;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.35 + energy * 0.55);

  // gentle autonomous life (not beat-locked flashing).
  col *= 0.95 + 0.05 * sin(u_time*1.1 + jitter*6.283 + cellId.x*0.37 + cellId.y*0.21);

  // seam: thin dark line at block borders.
  float edge  = min(min(bl.x, 1.0 - bl.x), min(bl.y, 1.0 - bl.y));
  float seamW = 0.018 + 0.006 * u_bass;
  float wEdge = fwidth(edge) + 1e-4;
  float seamMask = smoothstep(seamW - wEdge, seamW + wEdge, edge);
  col *= mix(0.22, 1.0, seamMask);

  // localized stitching glow on the flipped region's seams at kick time (no full flash).
  col += vec3(1.0, 0.9, 0.72) * inRegion * u_kickPulse * (1.0 - seamMask) * 0.5;

  col *= 1.0 + u_energy * 0.6;

  o = vec4(pow(max(col, 0.0), vec3(0.9)), 1.0);
}`;

export function createQuilt(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const spec = new Float32Array(24);
  let rw = 1,
    rh = 1;

  let seed = 0,
    energyMacro = 0,
    densityMacro = 0;
  let flipAxis = 2,
    flipWidthCells = 2.5,
    flipGen = 0,
    flipPosX = 0.5,
    flipPosY = 0.5;

  return {
    macros: {
      seed: (v) => {
        seed = v;
      },
      energy: (v) => {
        energyMacro = v;
      },
      density: (v) => {
        densityMacro = v;
      },
    },
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      for (let i = 0; i < 24; i++) spec[i] = Math.min(1.3, audio.spectrum[i] * 1.6);

      // kick: pick a fresh row / column / rect region and bump the flip generation
      // so cells inside it re-roll to a new motif+colour (structural trigger).
      if (audio.kick) {
        flipGen += 1;
        const r = Math.random();
        if (r < 0.4) {
          flipAxis = 0;
          flipPosX = Math.random();
          flipPosY = Math.random();
          flipWidthCells = 1.5 + Math.random() * 2.0;
        } else if (r < 0.8) {
          flipAxis = 1;
          flipPosX = Math.random();
          flipPosY = Math.random();
          flipWidthCells = 1.5 + Math.random() * 2.0;
        } else {
          flipAxis = 2;
          flipPosX = 0.15 + Math.random() * 0.7;
          flipPosY = 0.15 + Math.random() * 0.7;
          flipWidthCells = 2.5 + Math.random() * 2.5;
        }
      }

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1fv(u.u_spec, spec);
      gl.uniform1f(u.u_flip_axis, flipAxis);
      gl.uniform2f(u.u_flip_pos, flipPosX, flipPosY);
      gl.uniform1f(u.u_flip_width_cells, flipWidthCells);
      gl.uniform1f(u.u_flip_gen, flipGen);
      gl.uniform1f(u.u_seed, seed);
      gl.uniform1f(u.u_energy, energyMacro);
      gl.uniform1f(u.u_density, densityMacro);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
