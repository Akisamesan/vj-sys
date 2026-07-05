// 45 RIBBONTRAIL — a small handful of cursors, each driven directly by audio
// features through a coupled Lissajous-style orbit, trace a persistent glowing
// trail: the "ink stroke" of the music. Unlike 09 RIBBONS (particles drifting
// through a pseudo-curl flow field with autonomous physics), the cursor here has
// no physics of its own — its position at every instant is a deterministic
// function of (bass, centroid, level, high, t), never Math.random(). A
// fixed-length ring buffer per trail records cursor history; every frame the
// whole ring is re-expanded CPU-side into a normal-offset quad strip (two
// triangles per segment, GL_TRIANGLES — the LOW_VIS-safe recipe from
// ribbons.ts, no GL_LINES) so older samples taper to a thin, dim thread while
// the newest few are a bright, thick head. HDR PostFX adds the bloom.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N_TRAILS = 3;
const RING = 512;

// Angular velocity of the two coupled phases: bass drives x's "clock", centroid
// drives y's — integrated every frame (phase += freq*dt) rather than evaluated
// as sin(t*freq), so a change in bass/centroid bends the curve smoothly instead
// of snapping its instantaneous phase (t*freq would jump proportionally to t).
const FREQ_X_BASE = 0.55;
const FREQ_X_BASS_GAIN = 1.35;
const FREQ_Y_BASE = 0.4;
const FREQ_Y_CENTROID_GAIN = 1.6;
const FREQ_TRAIL_SPREAD = 0.07;

const AMP_X_BASE = 1.3; // world x is divided by aspect in the VS, so it must exceed 1
const AMP_X_LEVEL_GAIN = 0.5;
const AMP_Y_BASE = 0.78;
const AMP_Y_LEVEL_GAIN = 0.3;
const HARMONIC_MIX = 0.22; // cross-coupled 2nd harmonic for a non-elliptical orbit

const JITTER_GAIN = 0.05;

const WIDTH_BASE = 0.018;
const WIDTH_BASS_GAIN = 0.052;

const GLOW_BASE = 0.85;
const GLOW_LEVEL_GAIN = 0.9;
const GLOW_EXP_BASE = 1.1;
const GLOW_EXP_HIGH_GAIN = 1.8; // high sharpens the tail->head falloff ("glow sharpness")

const HUE_DRIFT = 0.015; // slow autonomous hue rotation, keeps it alive in silence
const HUE_CENTROID_GAIN = 0.5;
const HUE_KICK_JUMP = 0.42; // instantaneous hue jump baked into new samples on a kick

const KICK_TIP_BOOST = 1.8; // localized brightness pop at the trail tip on a kick
const KICK_TIP_SHARPNESS = 12; // concentrates the boost to only the newest samples

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_hb; // x=hue, y=brightness
uniform float u_aspect;
out vec3 v_col;
void main(){
  vec2 sc = a_pos;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  vec3 base = palette(a_hb.x, vec3(0.55,0.35,0.55), vec3(0.45,0.45,0.4), vec3(1.0,1.0,0.8), vec3(0.0,0.33,0.6));
  v_col = base * a_hb.y;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

export function createRibbontrail(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const stride = 4; // x,y,hue,bright
  const vertsPerSeg = 6; // two triangles per segment, GL_TRIANGLES (no strip)
  const vertsPerTrail = (RING - 1) * vertsPerSeg;
  const totalVerts = N_TRAILS * vertsPerTrail;
  const buf = new Float32Array(totalVerts * stride);

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride * 4, 8);
  gl.bindVertexArray(null);

  // Per-trail state: two coupled phase accumulators and a ring buffer of
  // (x, y, hue) history. Fully deterministic in (t, audio) — no Math.random.
  const phaseX = new Float32Array(N_TRAILS);
  const phaseY = new Float32Array(N_TRAILS);
  const writeIdx = new Int32Array(N_TRAILS);
  const histX: Float32Array[] = [];
  const histY: Float32Array[] = [];
  const histHue: Float32Array[] = [];

  for (let trIdx = 0; trIdx < N_TRAILS; trIdx++) {
    // Golden-angle-spaced initial phase offsets decorrelate the trails
    // (deterministic constants, not Math.random). The whole ring starts
    // pre-filled at this resting position so the first ~RING frames don't
    // pop in from a degenerate origin point.
    phaseX[trIdx] = trIdx * 2.399963;
    phaseY[trIdx] = trIdx * 1.253;
    const x0 = AMP_X_BASE * Math.sin(phaseX[trIdx]);
    const y0 = AMP_Y_BASE * Math.cos(phaseY[trIdx]);
    const hue0 = trIdx / N_TRAILS;
    histX.push(new Float32Array(RING).fill(x0));
    histY.push(new Float32Array(RING).fill(y0));
    histHue.push(new Float32Array(RING).fill(hue0));
  }

  // Scratch per-point arrays reused across trails to avoid per-frame GC churn.
  const Lx = new Float32Array(RING);
  const Ly = new Float32Array(RING);
  const Rx = new Float32Array(RING);
  const Ry = new Float32Array(RING);
  const hueArr = new Float32Array(RING);
  const brightArr = new Float32Array(RING);

  let rw = 1;
  let rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);

      // Deterministic jitter from `high` and t only: a couple of incommensurate
      // sine terms read as a treble-driven shimmer rather than one obvious wobble.
      const jitterAmt = audio.high * JITTER_GAIN;
      const jitterX = jitterAmt * (Math.sin(t * 23.1 + 1.7) * 0.6 + Math.sin(t * 41.3 + 4.1) * 0.4);
      const jitterY = jitterAmt * (Math.cos(t * 19.7 + 0.6) * 0.6 + Math.cos(t * 37.9 + 2.3) * 0.4);

      const ampX = AMP_X_BASE + audio.level * AMP_X_LEVEL_GAIN;
      const ampY = AMP_Y_BASE + audio.level * AMP_Y_LEVEL_GAIN;
      const halfW = WIDTH_BASE + audio.bass * WIDTH_BASS_GAIN;
      const glowGain = GLOW_BASE + audio.level * GLOW_LEVEL_GAIN;
      const glowExp = GLOW_EXP_BASE + audio.high * GLOW_EXP_HIGH_GAIN;

      for (let trIdx = 0; trIdx < N_TRAILS; trIdx++) {
        const freqX = FREQ_X_BASE + audio.bass * FREQ_X_BASS_GAIN + trIdx * FREQ_TRAIL_SPREAD;
        const freqY =
          FREQ_Y_BASE + audio.centroid * FREQ_Y_CENTROID_GAIN + trIdx * FREQ_TRAIL_SPREAD * 0.8;
        phaseX[trIdx] += freqX * fdt;
        phaseY[trIdx] += freqY * fdt;
        const px = phaseX[trIdx];
        const py = phaseY[trIdx];
        const cx =
          ampX * Math.sin(px) + ampX * HARMONIC_MIX * Math.sin(2.0 * py + trIdx * 2.1) + jitterX;
        const cy =
          ampY * Math.cos(py) + ampY * HARMONIC_MIX * Math.cos(2.0 * px + trIdx * 2.1) + jitterY;

        // Base hue drifts slowly (autonomous, keeps moving in silence) and leans
        // on centroid for the "warmth" of the moment; a kick jumps it instantly
        // via kickPulse (structural trigger — no flash), so freshly written
        // samples mark the beat as a color band that then ages with the trail.
        const hueBase = (t * HUE_DRIFT + audio.centroid * HUE_CENTROID_GAIN + trIdx / N_TRAILS) % 1;
        const hue = hueBase + HUE_KICK_JUMP * audio.kickPulse;

        const w = (writeIdx[trIdx] + 1) % RING;
        writeIdx[trIdx] = w;
        histX[trIdx][w] = cx;
        histY[trIdx][w] = cy;
        histHue[trIdx][w] = hue;
      }

      // Rebuild the whole vertex buffer every frame: walk each ring oldest ->
      // newest, offset each sample by the local tangent normal into a left/right
      // pair, and taper width/brightness by age so old samples fade to a thin
      // dim thread while the newest few form the bright head.
      let vi = 0;
      for (let trIdx = 0; trIdx < N_TRAILS; trIdx++) {
        const hx = histX[trIdx];
        const hy = histY[trIdx];
        const hh = histHue[trIdx];
        const baseIdx = (writeIdx[trIdx] + 1) % RING; // oldest surviving sample

        for (let k = 0; k < RING; k++) {
          const idx = (baseIdx + k) % RING;
          // Clamp neighbours in temporal (k) space, not ring-slot space, so the
          // ends use a one-sided difference instead of wrapping into the
          // opposite (unrelated) end of the ring.
          const prevIdx = (baseIdx + Math.max(0, k - 1)) % RING;
          const nextIdx = (baseIdx + Math.min(RING - 1, k + 1)) % RING;
          const px = hx[idx];
          const py = hy[idx];
          const tx = hx[nextIdx] - hx[prevIdx];
          const ty = hy[nextIdx] - hy[prevIdx];
          const len = Math.max(1e-5, Math.hypot(tx, ty));
          const perpX = -ty / len;
          const perpY = tx / len;
          const fade = k / (RING - 1);
          const width = halfW * (0.12 + 0.88 * fade);
          // Localized tip glow on a kick (not a screen flash): concentrated to
          // only the newest samples via a steep power of `fade`, decaying with
          // kickPulse over ~0.2s — reads as the stroke's tip punctuating, not
          // a strobe (SCENES.md's KICK_WEAK recipe: local glow, no flash).
          const tipBoost =
            1 + KICK_TIP_BOOST * audio.kickPulse * Math.pow(fade, KICK_TIP_SHARPNESS);
          const bright = glowGain * Math.pow(fade, glowExp) * tipBoost;

          Lx[k] = px + perpX * width;
          Ly[k] = py + perpY * width;
          Rx[k] = px - perpX * width;
          Ry[k] = py - perpY * width;
          hueArr[k] = hh[idx];
          brightArr[k] = bright;
        }

        for (let k = 0; k < RING - 1; k++) {
          const h0 = hueArr[k];
          const b0 = brightArr[k];
          const h1 = hueArr[k + 1];
          const b1 = brightArr[k + 1];
          // tri 1: L_k, R_k, L_{k+1}
          buf[vi * stride] = Lx[k];
          buf[vi * stride + 1] = Ly[k];
          buf[vi * stride + 2] = h0;
          buf[vi * stride + 3] = b0;
          vi++;
          buf[vi * stride] = Rx[k];
          buf[vi * stride + 1] = Ry[k];
          buf[vi * stride + 2] = h0;
          buf[vi * stride + 3] = b0;
          vi++;
          buf[vi * stride] = Lx[k + 1];
          buf[vi * stride + 1] = Ly[k + 1];
          buf[vi * stride + 2] = h1;
          buf[vi * stride + 3] = b1;
          vi++;
          // tri 2: R_k, R_{k+1}, L_{k+1}
          buf[vi * stride] = Rx[k];
          buf[vi * stride + 1] = Ry[k];
          buf[vi * stride + 2] = h0;
          buf[vi * stride + 3] = b0;
          vi++;
          buf[vi * stride] = Rx[k + 1];
          buf[vi * stride + 1] = Ry[k + 1];
          buf[vi * stride + 2] = h1;
          buf[vi * stride + 3] = b1;
          vi++;
          buf[vi * stride] = Lx[k + 1];
          buf[vi * stride + 1] = Ly[k + 1];
          buf[vi * stride + 2] = h1;
          buf[vi * stride + 3] = b1;
          vi++;
        }
      }

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.drawArrays(gl.TRIANGLES, 0, totalVerts);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.05 + audio.level * 0.55,
        exposure: 1.05 + audio.high * 0.2,
        aberration: 0.001 + audio.change * 0.0015,
        grain: 0.03,
        vignette: 1.1,
        flash: 0, // no flash on kick — the hue jump + tip boost carry the beat instead
        threshold: 0.5,
        time: t,
      });
    },
  };
}
