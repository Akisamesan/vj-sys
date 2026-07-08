// 92 PARTICLE_FFT — a bar-graph equalizer built entirely out of falling particles.
// 24 columns (one per spectrum band) fountain small glowing squares upward at a rate
// and launch speed driven by that band's energy; gravity (tied to overall level) pulls
// them back down and they fade as they sink past the baseline, so each "bar" is really
// a churning cloud of grains rather than a solid mesh. Kick gives every band a light
// pop plus a louder outward burst from the centre columns — a structural accent, not a
// flash. Centroid slowly rotates the palette phase across the bands; high sharpens the
// grains from soft fuzzy squares into crisp ones. CPU-integrated point sprites (square,
// not circular), mix()-blended (no additive stacking) through a restrained PostFX pass.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const BANDS = 24;
const MAX_PARTICLES = 3600;
const GROUND_Y = -0.82;
const BAND_SPAN = 1.84; // x in [-0.92, 0.92]
const BAND_W = BAND_SPAN / BANDS;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_band;
layout(location=2) in float a_life;
uniform float u_pxScale, u_centroid, u_high;
out vec3 v_col;
out float v_life;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  float hue = a_band/${BANDS.toFixed(1)}*0.85 + u_centroid*0.4;
  vec3 col = palette(hue, vec3(0.55,0.5,0.5), vec3(0.45,0.45,0.4), vec3(1.0,0.9,0.7), vec3(0.0,0.15,0.35));
  // Explicit brightness multiplier (LOW_VIS additive-point recipe): visible squares,
  // not a bloom-only smear.
  v_col = col * (0.9 + a_life*0.7) * 2.0;
  v_life = a_life;
  float sizePx = 5.0 + a_life*8.0 + u_high*5.0;
  gl_PointSize = clamp(sizePx * u_pxScale, 3.0, 34.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; in float v_life;
uniform float u_high;
out vec4 o;
void main(){
  // Square (Chebyshev) footprint, not a circular point — this is a small quad,
  // not a dot. u_high sharpens the edge from a soft fuzzy square to a crisp one.
  vec2 d = abs(gl_PointCoord - 0.5);
  float edge = max(d.x, d.y);
  float soft = mix(0.46, 0.09, u_high);
  float a = (1.0 - smoothstep(0.5-soft, 0.5, edge)) * v_life;
  if (a <= 0.002) discard;
  o = vec4(v_col, a);
}`;

export function createParticleFft(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;

  // Per-particle state, CPU-integrated. Ring-buffer allocation: a monotonically
  // advancing write cursor recycles the oldest slot on spawn, which is safe here
  // because MAX_PARTICLES gives generous headroom over the steady-state population
  // (see spawn-rate comment below).
  const px = new Float32Array(MAX_PARTICLES);
  const py = new Float32Array(MAX_PARTICLES);
  const pvx = new Float32Array(MAX_PARTICLES);
  const pvy = new Float32Array(MAX_PARTICLES);
  const pband = new Float32Array(MAX_PARTICLES);
  const page = new Float32Array(MAX_PARTICLES).fill(1e9); // start "dead"
  const buf = new Float32Array(MAX_PARTICLES * 4); // x, y, band, life
  let cursor = 0;

  const spawnAcc = new Float32Array(BANDS);

  function spawn(band: number, vy0: number, vxSpread: number): void {
    const i = cursor;
    cursor = (cursor + 1) % MAX_PARTICLES;
    const xCenter = -0.92 + (band + 0.5) * BAND_W;
    px[i] = xCenter + (Math.random() - 0.5) * BAND_W * 0.55;
    py[i] = GROUND_Y + Math.random() * 0.015;
    pvx[i] = (Math.random() - 0.5) * vxSpread;
    pvy[i] = vy0;
    pband[i] = band;
    page[i] = 0;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);
      // level (continuous) drives gravity: louder overall level -> faster fall/churn.
      const gravity = 1.8 + audio.level * 2.4;

      // Kick: structural trigger, not a flash. (a) a light emission bump across every
      // band so the whole field visibly "breathes" on the hit, (b) a louder outward
      // burst from the centre columns that pops up and sideways, distinct from the
      // steady per-band fountains.
      let kickBoost = 0;
      if (audio.kick) {
        kickBoost = 1;
        const centerLo = (BANDS / 2) | 0;
        for (let k = 0; k < 42; k++) {
          const band = centerLo - 2 + ((Math.random() * 5) | 0);
          spawn(Math.max(0, Math.min(BANDS - 1, band)), 1.3 + Math.random() * 1.0, 2.4);
        }
      }

      // spectrum[24] (spatial layout): each band's energy sets its column's spawn
      // rate and launch speed. A small ambient floor rate keeps the field alive
      // (and non-black) even in silence.
      for (let b = 0; b < BANDS; b++) {
        const energy = audio.spectrum[b] ?? 0;
        const rate = 4.0 + energy * 42.0 + kickBoost * 3.0;
        spawnAcc[b] += rate * fdt;
        const vy0 = 0.4 + energy * 1.7 + Math.random() * 0.2;
        while (spawnAcc[b] >= 1) {
          spawnAcc[b] -= 1;
          spawn(b, vy0, 0.06);
        }
      }

      for (let i = 0; i < MAX_PARTICLES; i++) {
        page[i] += fdt;
        pvy[i] -= gravity * fdt;
        pvx[i] *= Math.exp(-fdt * 1.5);
        px[i] += pvx[i] * fdt;
        py[i] += pvy[i] * fdt;

        let life = Math.min(1, page[i] / 0.05); // fade in
        const belowGround = GROUND_Y - py[i];
        if (belowGround > 0) life *= Math.max(0, 1 - belowGround / 0.35); // fade out as it sinks
        if (page[i] > 6.0) life = 0; // safety cap for stray long hangtime

        buf[i * 4] = px[i];
        buf[i * 4 + 1] = py[i];
        buf[i * 4 + 2] = pband[i];
        buf[i * 4 + 3] = life;
      }

      post.bind();
      gl.clearColor(0.012, 0.013, 0.02, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
      gl.enable(gl.BLEND);
      // mix()-based glow rather than additive stacking (avoids WHITE blowouts when
      // many grains overlap).
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(u.u_pxScale, rh / 360);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.drawArrays(gl.POINTS, 0, MAX_PARTICLES);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.55 + audio.level * 0.25,
        exposure: 1.05,
        aberration: 0.0007 + audio.change * 0.0014,
        grain: 0.03,
        vignette: 1.15,
        flash: 0, // beat norm: no flash/strobe for BPM; kick is a structural trigger above
        threshold: 0.55,
        time: t,
      });
    },
  };
}
