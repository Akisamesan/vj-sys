// 19 DLA — diffusion-limited aggregation. A single seed crystal sits at the centre of a
// 192x192 occupancy grid; a swarm of walkers random-walks out from its growing perimeter
// and freezes onto the cluster the instant it touches an 8-neighbour of an already-stuck
// cell, building a lightning/coral-like dendrite one cell at a time. Attachment order
// (generation) is recorded per cell and pushed once into a growing GPU point buffer —
// nothing is ever re-simulated on the GPU, only appended. On first mount the CPU sim is
// fast-forwarded synchronously to a well-developed dendrite so the very first frame is
// never a bare dot. When the cluster's radius nears the grid edge it holds the full bloom
// for a beat, then reseeds; the just-finished cluster is kept as a fading "echo" layer so
// a reset never cuts to a near-empty frame either. Additive points through HDR PostFX; a
// second, much fainter point layer renders the live walker swarm itself, and a kick
// ignites a rotating batch of it so the response reads as a visible perimeter shimmer
// without ever flashing the whole frame.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const GRID = 192;
const HALF = GRID / 2;
const MAX_POINTS = GRID * GRID; // hard upper bound: each cell can stick exactly once
const BASE_WALKERS = 220;
const MAX_EXTRA = 120;
const MAX_WALKERS = BASE_WALKERS + MAX_EXTRA;
const STEP_LEN = 1.0;
const TAU = Math.PI * 2;
// Startup fast-forward: run the CPU sim synchronously (no GPU/audio involved) before the
// first frame so the scene never opens on a single dot. Empirically ~5e5-7e5 steps reaches
// this radius in ~40-70ms — a one-off mount cost, capped hard so it can never hang.
const WARMUP_TARGET_RADIUS = HALF - 20;
const WARMUP_MAX_STEPS = 1_200_000;
// A kick lights this many walkers (a rotating window of the live swarm) at full heat,
// independent of whether the pool is already saturated, so every kick reads even back to
// back; ECHO_DECAY/HEAT_DECAY set how many seconds those envelopes take to fade.
const KICK_HEAT_BATCH = 70;
const ECHO_DECAY = 1.3;
const HEAT_DECAY = 1.1;

const CLUSTER_VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_gen;
uniform float u_aspect, u_maxGen, u_centroid, u_pxPerCell, u_bass, u_alpha;
out vec3 v_col;
void main(){
  vec2 p = a_pos;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = u_pxPerCell * (2.2 + u_bass * 0.3);
  float gn = clamp(a_gen / max(u_maxGen, 1.0), 0.0, 1.0);
  // young/central cells (low gn) read cool; freshly-stuck tips (high gn) read warm.
  float hue = 0.33 - gn * 0.33 + u_centroid * 0.25;
  vec3 col = palette(hue, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67));
  v_col = col * (1.3 + gn * 0.9) * 2.0 * u_alpha;
}`;

const CLUSTER_FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = smoothstep(0.25, 0.0, r2);
  o = vec4(v_col * a, 1.0);
}`;

const SPARK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_heat;
uniform float u_aspect, u_pxPerCell, u_glow;
out float v_a;
void main(){
  vec2 p = a_pos;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  // a_heat is 1 right when a walker is kicked into being/lit, decaying over ~1s: a
  // localised, structural burst at the frontier rather than a full-frame flash.
  gl_PointSize = u_pxPerCell * (1.3 + a_heat * 1.6);
  v_a = u_glow + a_heat * 1.8;
}`;

const SPARK_FS = `#version 300 es
precision highp float;
in float v_a; out vec4 o;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = smoothstep(0.25, 0.0, r2);
  o = vec4(vec3(0.55, 0.75, 0.95) * v_a * a, 1.0);
}`;

export function createDla(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const progCluster = program(gl, CLUSTER_VS, CLUSTER_FS);
  const uCluster: Uniforms = uniforms(gl, progCluster);
  const progSpark = program(gl, SPARK_VS, SPARK_FS);
  const uSpark: Uniforms = uniforms(gl, progSpark);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // --- occupancy grid state ---
  const occ = new Uint8Array(GRID * GRID);
  const gen = new Int32Array(GRID * GRID).fill(-1);
  let genCounter = 1;
  let clusterRadius = 0;
  let holdFrames = 0;

  // --- CPU-side append-only point buffer (x, y in grid units centred on 0, generation) ---
  const cpuBuf = new Float32Array(MAX_POINTS * 3);
  let pointCount = 0;
  let uploaded = 0;

  // --- fading "echo" of the previous cluster, shown while the new seed regrows ---
  const echoBuf = new Float32Array(MAX_POINTS * 3);
  let echoCount = 0;
  let echoMaxGen = 1;
  let echoAlpha = 0;

  function pushPoint(ix: number, iy: number, g: number): void {
    if (pointCount >= MAX_POINTS) return;
    const o = pointCount * 3;
    cpuBuf[o] = (ix - HALF) / HALF;
    cpuBuf[o + 1] = (iy - HALF) / HALF;
    cpuBuf[o + 2] = g;
    pointCount++;
  }

  // --- walker pool ---
  const wx = new Float32Array(MAX_WALKERS);
  const wy = new Float32Array(MAX_WALKERS);
  const heading = new Float32Array(MAX_WALKERS);
  const heat = new Float32Array(MAX_WALKERS); // kick-lit glow envelope, 1 -> 0
  const sparkBuf = new Float32Array(MAX_WALKERS * 3); // x, y, heat
  let walkerBoost = 0;
  let lastBoostCount = 0;
  let activeWalkerCount = BASE_WALKERS;
  let headingJitter = 0.12;
  let kickBurstCursor = 0;

  function spawnRadius(): number {
    return Math.min(HALF - 4, clusterRadius + 14);
  }

  function respawnWalker(i: number, sr: number, heatVal: number = 0): void {
    const ang = Math.random() * TAU;
    wx[i] = HALF + Math.cos(ang) * sr;
    wy[i] = HALF + Math.sin(ang) * sr;
    heading[i] = Math.random() * TAU;
    heat[i] = heatVal;
  }

  function hasNeighbor(cx: number, cy: number): boolean {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        if (occ[(cy + oy) * GRID + (cx + ox)]) return true;
      }
    }
    return false;
  }

  function resetCluster(): void {
    // Snapshot the just-completed cluster into the fading echo layer *before* wiping
    // it, so a reset never cuts straight to a bare seed on a near-empty frame.
    if (pointCount > 0) {
      echoBuf.set(cpuBuf.subarray(0, pointCount * 3));
      echoCount = pointCount;
      echoMaxGen = Math.max(genCounter - 1, 1);
      echoAlpha = 1.0;
      gl.bindBuffer(gl.ARRAY_BUFFER, vboEcho);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, echoBuf.subarray(0, echoCount * 3));
    }
    occ.fill(0);
    gen.fill(-1);
    heat.fill(0);
    const cx = HALF | 0,
      cy = HALF | 0;
    occ[cy * GRID + cx] = 1;
    gen[cy * GRID + cx] = 0;
    genCounter = 1;
    clusterRadius = 0;
    pointCount = 0;
    uploaded = 0;
    pushPoint(cx, cy, 0);
    const sr = spawnRadius();
    for (let i = 0; i < MAX_WALKERS; i++) respawnWalker(i, sr);
    walkerBoost = 0;
    lastBoostCount = 0;
  }

  function stepWalker(i: number, sr: number): void {
    const cx = Math.round(wx[i]);
    const cy = Math.round(wy[i]);
    if (
      cx >= 1 &&
      cx < GRID - 1 &&
      cy >= 1 &&
      cy < GRID - 1 &&
      !occ[cy * GRID + cx] &&
      hasNeighbor(cx, cy)
    ) {
      occ[cy * GRID + cx] = 1;
      gen[cy * GRID + cx] = genCounter;
      pushPoint(cx, cy, genCounter);
      genCounter++;
      const dx = cx - HALF,
        dy = cy - HALF;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > clusterRadius) clusterRadius = r;
      respawnWalker(i, spawnRadius());
      return;
    }
    heading[i] += (Math.random() * 2 - 1) * headingJitter;
    wx[i] += Math.cos(heading[i]) * STEP_LEN;
    wy[i] += Math.sin(heading[i]) * STEP_LEN;
    const dx = wx[i] - HALF,
      dy = wy[i] - HALF;
    const escapeR = sr + 30;
    if (dx * dx + dy * dy > escapeR * escapeR) respawnWalker(i, sr);
  }

  // One-off synchronous fast-forward at mount: grows the seed to a well-developed
  // dendrite before the first frame is ever drawn (see WARMUP_TARGET_RADIUS above).
  // Uses the full walker pool (not just the base count) purely to converge faster;
  // normal per-frame growth afterwards is unaffected.
  function warmup(): void {
    let steps = 0;
    while (clusterRadius < WARMUP_TARGET_RADIUS && steps < WARMUP_MAX_STEPS) {
      stepWalker(steps % MAX_WALKERS, spawnRadius());
      steps++;
    }
  }

  // --- GL buffers ---
  const vaoCluster = gl.createVertexArray()!;
  const vboCluster = gl.createBuffer()!;
  gl.bindVertexArray(vaoCluster);
  gl.bindBuffer(gl.ARRAY_BUFFER, vboCluster);
  gl.bufferData(gl.ARRAY_BUFFER, cpuBuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
  gl.bindVertexArray(null);

  const vaoSpark = gl.createVertexArray()!;
  const vboSpark = gl.createBuffer()!;
  gl.bindVertexArray(vaoSpark);
  gl.bindBuffer(gl.ARRAY_BUFFER, vboSpark);
  gl.bufferData(gl.ARRAY_BUFFER, sparkBuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
  gl.bindVertexArray(null);

  const vaoEcho = gl.createVertexArray()!;
  const vboEcho = gl.createBuffer()!;
  gl.bindVertexArray(vaoEcho);
  gl.bindBuffer(gl.ARRAY_BUFFER, vboEcho);
  gl.bufferData(gl.ARRAY_BUFFER, echoBuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
  gl.bindVertexArray(null);

  // Grow the initial seed to a well-developed dendrite before any frame renders.
  resetCluster();
  warmup();

  let rw = 1,
    rh = 1;
  let pxPerCell = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
      pxPerCell = Math.min(w, h) / GRID;
    },
    frame(t, dt, audio: AudioEngine) {
      // bass sets the total random-walk step budget for this frame (growth speed).
      headingJitter = 0.12 + audio.level * 2.4;
      echoAlpha *= Math.exp(-dt * ECHO_DECAY);

      // kick: ignite a rotating batch of the *live* swarm at full heat — this fires
      // every kick, even back to back, regardless of whether the pool below is
      // already saturated — and, while there's still room, wake a few dormant
      // extra walkers from the perimeter as genuinely new search points (new
      // branches). Both envelopes decay back to baseline over a phrase, never snap.
      walkerBoost *= Math.exp(-dt * 0.35);
      if (audio.kick) {
        walkerBoost = Math.min(MAX_EXTRA, walkerBoost + 60);
        for (let j = 0; j < KICK_HEAT_BATCH; j++) {
          heat[(kickBurstCursor + j) % activeWalkerCount] = 1;
        }
        kickBurstCursor = (kickBurstCursor + KICK_HEAT_BATCH) % MAX_WALKERS;
      }
      const boostCount = Math.min(MAX_EXTRA, Math.floor(walkerBoost));
      if (boostCount > lastBoostCount) {
        const sr = spawnRadius();
        for (let i = lastBoostCount; i < boostCount; i++) respawnWalker(BASE_WALKERS + i, sr, 1);
      }
      lastBoostCount = boostCount;
      activeWalkerCount = BASE_WALKERS + boostCount;
      for (let i = 0; i < activeWalkerCount; i++) heat[i] *= Math.exp(-dt * HEAT_DECAY);

      if (holdFrames > 0) {
        // full bloom reached: freeze the cluster for a beat, but keep the swarm
        // drifting so the scene never reads as a static screenshot.
        holdFrames--;
        for (let i = 0; i < activeWalkerCount; i++) {
          heading[i] += (Math.random() * 2 - 1) * headingJitter;
          wx[i] += Math.cos(heading[i]) * STEP_LEN * 0.5;
          wy[i] += Math.sin(heading[i]) * STEP_LEN * 0.5;
        }
        if (holdFrames === 0) resetCluster();
      } else {
        const sr = spawnRadius();
        const stepsThisFrame = Math.round(260 + audio.bass * 900);
        for (let s = 0; s < stepsThisFrame; s++) stepWalker(s % activeWalkerCount, sr);
        if (clusterRadius > HALF - 4) holdFrames = 40;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, vboCluster);
      if (pointCount > uploaded) {
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          uploaded * 12,
          cpuBuf.subarray(uploaded * 3, pointCount * 3),
        );
        uploaded = pointCount;
      }

      for (let i = 0; i < activeWalkerCount; i++) {
        sparkBuf[i * 3] = (wx[i] - HALF) / HALF;
        sparkBuf[i * 3 + 1] = (wy[i] - HALF) / HALF;
        sparkBuf[i * 3 + 2] = heat[i];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, vboSpark);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, sparkBuf.subarray(0, activeWalkerCount * 3));

      post.bind();
      gl.clearColor(0.01, 0.012, 0.02, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.useProgram(progCluster);
      gl.uniform1f(uCluster.u_aspect, rw / rh);
      gl.uniform1f(uCluster.u_centroid, audio.centroid);
      gl.uniform1f(uCluster.u_pxPerCell, pxPerCell);
      gl.uniform1f(uCluster.u_bass, audio.bass);

      if (echoAlpha > 0.015 && echoCount > 0) {
        gl.uniform1f(uCluster.u_maxGen, echoMaxGen);
        gl.uniform1f(uCluster.u_alpha, echoAlpha * 0.85);
        gl.bindVertexArray(vaoEcho);
        gl.drawArrays(gl.POINTS, 0, echoCount);
      }

      gl.uniform1f(uCluster.u_maxGen, Math.max(genCounter - 1, 1));
      gl.uniform1f(uCluster.u_alpha, 1.0);
      gl.bindVertexArray(vaoCluster);
      gl.drawArrays(gl.POINTS, 0, pointCount);

      gl.useProgram(progSpark);
      gl.uniform1f(uSpark.u_aspect, rw / rh);
      gl.uniform1f(uSpark.u_pxPerCell, pxPerCell);
      gl.uniform1f(uSpark.u_glow, 0.1 + audio.kickPulse * 1.0);
      gl.bindVertexArray(vaoSpark);
      gl.drawArrays(gl.POINTS, 0, activeWalkerCount);

      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.15 + audio.level * 0.35,
        exposure: 1.05 + audio.kickPulse * 0.12,
        aberration: 0.001 + audio.change * 0.002,
        grain: 0.035,
        vignette: 1.15,
        flash: 0,
        threshold: 0.45,
        time: t,
      });
    },
  };
}
