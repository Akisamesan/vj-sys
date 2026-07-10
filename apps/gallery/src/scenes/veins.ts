// 71 VEINS — leaf-vein growth via space colonization (Runions-Fuhrer style
// auxin flow). A cloud of "attraction points" (mesophyll cells) fills a
// leaf-shaped domain; every growth step each surviving point pulls its
// single nearest vein node toward it, that node sprouts one new node along
// the averaged pull direction, and points within reach of the fresh network
// are consumed. Repeated over many steps this produces branching, non-random
// vein trees that thin from a thick trunk to fine capillary tips — distinct
// from 70 CORAL's undirected random branching because every branch is aimed
// by a live attraction field. Consumed points quietly respawn elsewhere in
// the leaf so growth never fully halts. Segments are camera-facing quads
// (normal-offset triangles, not GL_LINES — 1px lines vanish on the headless
// SwiftShader QA renderer) tapered per-node from a "flux" value (1 + sum of
// descendant flux) so trunks read thick and tips read thin, echoing the
// auxin-flow metaphor. HDR PostFX adds bloom/grain without any beat-synced
// flash.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const MAX_NODES = 2600;
const MAX_ATTRACT = 260;
const KICK_INJECT = 24;

// Leaf silhouette: a vesica-like taper (pointed petiole at the bottom,
// pointed tip at the top) in aspect-independent "world" units; the vertex
// shader divides x by the live aspect ratio at draw time.
const LEAF_RX = 0.62;
const LEAF_RY = 0.85;
const LEAF_TAPER = 0.72;

const INFLUENCE_R = 0.34;
const INFLUENCE_R2 = INFLUENCE_R * INFLUENCE_R;
const KILL_DIST = 0.05;
const KILL_DIST2 = KILL_DIST * KILL_DIST;
const STEP_LEN = 0.032;

const BASE_RATE = 70; // growth steps/sec at bass=0 (keeps motion alive in quiet passages)
const BASS_RATE_SCALE = 260; // extra steps/sec at bass=1
const MAX_STEPS_PER_FRAME = 6;

const THICK_MIN = 0.006;
const THICK_MAX = 0.05;
const FLUX_NORM = 70;
const FLUX_POWER = 0.35;
const BRIGHT_MULT = 2.6; // explicit visibility floor (see SCENES.md LOW_VIS recipe)

const RESPAWN_MIN = 0.4;
const RESPAWN_MAX = 2.4;

const PALETTE_STOPS: readonly [number, number, number, number][] = [
  [0.0, 0.1, 0.5, 0.18], // leaf green
  [0.38, 0.42, 0.58, 0.1], // yellow-green
  [0.68, 0.85, 0.55, 0.08], // amber
  [1.0, 0.78, 0.14, 0.07], // autumn red
];

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec3 a_col;
uniform float u_aspect;
out vec3 v_col;
void main(){
  vec2 sc = a_pos;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  v_col = a_col;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

function leafHalfWidth(y: number): number {
  const v = y / LEAF_RY;
  const v2 = v * v;
  if (v2 >= 1) return 0;
  return LEAF_RX * Math.pow(1 - v2, LEAF_TAPER);
}

function paletteColor(t: number, out: Float32Array): void {
  const tt = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < PALETTE_STOPS.length - 2 && tt > PALETTE_STOPS[i + 1][0]) i++;
  const a = PALETTE_STOPS[i];
  const b = PALETTE_STOPS[i + 1];
  const span = Math.max(1e-6, b[0] - a[0]);
  const f = Math.min(1, Math.max(0, (tt - a[0]) / span));
  out[0] = a[1] + (b[1] - a[1]) * f;
  out[1] = a[2] + (b[2] - a[2]) * f;
  out[2] = a[3] + (b[3] - a[3]) * f;
}

export function createVeins(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // ---- Attraction points (mesophyll cells) ----
  const attractX = new Float32Array(MAX_ATTRACT);
  const attractY = new Float32Array(MAX_ATTRACT);
  const attractAlive = new Uint8Array(MAX_ATTRACT);
  const attractRespawnT = new Float32Array(MAX_ATTRACT);
  const scratch = new Float32Array(2);

  function sampleLeafPoint(out: Float32Array): void {
    for (let tries = 0; tries < 24; tries++) {
      const y = (Math.random() * 2 - 1) * LEAF_RY;
      const hw = leafHalfWidth(y);
      if (hw <= 0.0005) continue;
      const x = (Math.random() * 2 - 1) * hw;
      out[0] = x;
      out[1] = y;
      return;
    }
    out[0] = 0;
    out[1] = 0;
  }

  for (let p = 0; p < MAX_ATTRACT; p++) {
    sampleLeafPoint(scratch);
    attractX[p] = scratch[0];
    attractY[p] = scratch[1];
    attractAlive[p] = 1;
  }

  // ---- Vein nodes (flat tree: nodeParent[i] < i always) ----
  const nodeX = new Float32Array(MAX_NODES);
  const nodeY = new Float32Array(MAX_NODES);
  const nodeParent = new Int32Array(MAX_NODES);
  const nodeGen = new Int32Array(MAX_NODES);
  const accumX = new Float32Array(MAX_NODES);
  const accumY = new Float32Array(MAX_NODES);
  const accumCount = new Int32Array(MAX_NODES);
  const fluxArr = new Float32Array(MAX_NODES);

  let nodeCount = 1;
  nodeX[0] = 0;
  nodeY[0] = -LEAF_RY * 0.97;
  nodeParent[0] = -1;
  nodeGen[0] = 0;
  let maxGen = 1;

  function growStep(): void {
    if (nodeCount === 0) return;
    accumX.fill(0, 0, nodeCount);
    accumY.fill(0, 0, nodeCount);
    accumCount.fill(0, 0, nodeCount);

    for (let p = 0; p < MAX_ATTRACT; p++) {
      if (!attractAlive[p]) continue;
      const px = attractX[p];
      const py = attractY[p];
      let bestD2 = Infinity;
      let bestI = -1;
      for (let i = 0; i < nodeCount; i++) {
        const dx = px - nodeX[i];
        const dy = py - nodeY[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestI = i;
        }
      }
      if (bestI < 0) continue;
      if (bestD2 < KILL_DIST2) {
        attractAlive[p] = 0;
        attractRespawnT[p] = RESPAWN_MIN + Math.random() * (RESPAWN_MAX - RESPAWN_MIN);
        continue;
      }
      if (bestD2 < INFLUENCE_R2) {
        const d = Math.sqrt(bestD2) || 1e-6;
        accumX[bestI] += (px - nodeX[bestI]) / d;
        accumY[bestI] += (py - nodeY[bestI]) / d;
        accumCount[bestI]++;
      }
    }

    const front = nodeCount;
    for (let i = 0; i < front; i++) {
      if (accumCount[i] === 0) continue;
      if (nodeCount >= MAX_NODES) break;
      const dx = accumX[i] / accumCount[i];
      const dy = accumY[i] / accumCount[i];
      const len = Math.hypot(dx, dy) || 1e-6;
      const gi = nodeCount++;
      nodeX[gi] = nodeX[i] + (dx / len) * STEP_LEN;
      nodeY[gi] = nodeY[i] + (dy / len) * STEP_LEN;
      nodeParent[gi] = i;
      nodeGen[gi] = nodeGen[i] + 1;
      if (nodeGen[gi] > maxGen) maxGen = nodeGen[gi];
    }
  }

  function updateAttractors(dt: number, jitter: number): void {
    for (let p = 0; p < MAX_ATTRACT; p++) {
      if (!attractAlive[p]) {
        attractRespawnT[p] -= dt;
        if (attractRespawnT[p] <= 0) {
          sampleLeafPoint(scratch);
          attractX[p] = scratch[0];
          attractY[p] = scratch[1];
          attractAlive[p] = 1;
        }
        continue;
      }
      if (jitter <= 0.0001) continue;
      const nx = attractX[p] + (Math.random() - 0.5) * jitter;
      const ny = attractY[p] + (Math.random() - 0.5) * jitter;
      const hw = leafHalfWidth(ny);
      if (hw > 0.0005 && Math.abs(nx) <= hw) {
        attractX[p] = nx;
        attractY[p] = ny;
      }
    }
  }

  const kickGlowX = new Float32Array(KICK_INJECT);
  const kickGlowY = new Float32Array(KICK_INJECT);
  let kickCursor = 0;

  function injectKick(): void {
    for (let i = 0; i < KICK_INJECT; i++) {
      const idx = (kickCursor + i) % MAX_ATTRACT;
      sampleLeafPoint(scratch);
      attractX[idx] = scratch[0];
      attractY[idx] = scratch[1];
      attractAlive[idx] = 1;
      attractRespawnT[idx] = 0;
      kickGlowX[i] = attractX[idx];
      kickGlowY[i] = attractY[idx];
    }
    kickCursor = (kickCursor + KICK_INJECT) % MAX_ATTRACT;
  }

  function computeFlux(): void {
    for (let i = 0; i < nodeCount; i++) fluxArr[i] = 1;
    for (let i = nodeCount - 1; i >= 1; i--) {
      const par = nodeParent[i];
      if (par >= 0) fluxArr[par] += fluxArr[i];
    }
  }

  function thicknessOf(idx: number): number {
    const frac = Math.min(1, fluxArr[idx] / FLUX_NORM);
    return THICK_MIN + (THICK_MAX - THICK_MIN) * Math.pow(frac, FLUX_POWER);
  }

  // Warm the network up synchronously so the very first rendered frame
  // already shows structure instead of a bare root point.
  for (let i = 0; i < 160; i++) growStep();

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const stride = 5; // x,y,r,g,b
  const maxVerts = (MAX_NODES - 1) * 6 + KICK_INJECT * 6;
  const buf = new Float32Array(maxVerts * stride);

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride * 4, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride * 4, 8);
  gl.bindVertexArray(null);

  const colorScratch = new Float32Array(3);
  let growthAccum = 0;
  let rw = 1;
  let rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 1 / 30);

      // bass (continuous) -> growth speed: steps/sec accumulate fractionally
      // so the pace stays smooth across frame-rate variation.
      const rate = BASE_RATE + audio.bass * BASS_RATE_SCALE;
      growthAccum += rate * fdt;
      let steps = 0;
      while (growthAccum >= 1 && steps < MAX_STEPS_PER_FRAME) {
        growStep();
        growthAccum -= 1;
        steps++;
      }
      growthAccum = Math.min(growthAccum, MAX_STEPS_PER_FRAME);

      // high (continuous) -> attraction-point distribution jitter.
      const jitter = 0.006 + audio.high * 0.05;
      updateAttractors(fdt, jitter);

      // kick (trigger) -> inject a fresh cluster of attraction points,
      // reactivating growth in a rotating region of the leaf.
      if (audio.kick) injectKick();

      computeFlux();

      // centroid (slow) -> vein hue: green -> yellow -> autumn red.
      const hueT = Math.min(1, Math.max(0, audio.centroid * 1.3));
      paletteColor(hueT, colorScratch);

      // level (continuous) -> thickness + glow intensity.
      const levelThick = 0.7 + audio.level * 0.6;
      const levelGlow = 0.55 + audio.level * 1.2;
      const genDenom = Math.max(1, maxGen);

      let vi = 0;
      for (let i = 1; i < nodeCount; i++) {
        const par = nodeParent[i];
        const ax = nodeX[par];
        const ay = nodeY[par];
        const bx = nodeX[i];
        const by = nodeY[i];
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1e-6;
        const nx = -dy / len;
        const ny = dx / len;
        const wA = thicknessOf(par) * levelThick;
        const wB = thicknessOf(i) * levelThick;

        const genFrac = nodeGen[i] / genDenom;
        const bright = BRIGHT_MULT * (0.45 + 0.55 * genFrac) * levelGlow;
        const cr = colorScratch[0] * bright;
        const cg = colorScratch[1] * bright;
        const cb = colorScratch[2] * bright;

        const a0x = ax + nx * wA;
        const a0y = ay + ny * wA;
        const a1x = ax - nx * wA;
        const a1y = ay - ny * wA;
        const b0x = bx + nx * wB;
        const b0y = by + ny * wB;
        const b1x = bx - nx * wB;
        const b1y = by - ny * wB;

        buf[vi * stride] = a0x;
        buf[vi * stride + 1] = a0y;
        buf[vi * stride + 2] = cr;
        buf[vi * stride + 3] = cg;
        buf[vi * stride + 4] = cb;
        vi++;
        buf[vi * stride] = b0x;
        buf[vi * stride + 1] = b0y;
        buf[vi * stride + 2] = cr;
        buf[vi * stride + 3] = cg;
        buf[vi * stride + 4] = cb;
        vi++;
        buf[vi * stride] = a1x;
        buf[vi * stride + 1] = a1y;
        buf[vi * stride + 2] = cr;
        buf[vi * stride + 3] = cg;
        buf[vi * stride + 4] = cb;
        vi++;
        buf[vi * stride] = a1x;
        buf[vi * stride + 1] = a1y;
        buf[vi * stride + 2] = cr;
        buf[vi * stride + 3] = cg;
        buf[vi * stride + 4] = cb;
        vi++;
        buf[vi * stride] = b0x;
        buf[vi * stride + 1] = b0y;
        buf[vi * stride + 2] = cr;
        buf[vi * stride + 3] = cg;
        buf[vi * stride + 4] = cb;
        vi++;
        buf[vi * stride] = b1x;
        buf[vi * stride + 1] = b1y;
        buf[vi * stride + 2] = cr;
        buf[vi * stride + 3] = cg;
        buf[vi * stride + 4] = cb;
        vi++;
      }

      // Local, decaying glow at the kick's injection points — a structural,
      // non-flashing readout of the trigger (see SCENES.md KICK_WEAK recipe).
      const glowSize = 0.026;
      const glowB = audio.kickPulse * 2.6;
      const gcr = 1.0 * glowB;
      const gcg = 0.82 * glowB;
      const gcb = 0.4 * glowB;
      for (let g = 0; g < KICK_INJECT; g++) {
        const gx = kickGlowX[g];
        const gy = kickGlowY[g];
        const x0 = gx - glowSize;
        const x1 = gx + glowSize;
        const y0 = gy - glowSize;
        const y1 = gy + glowSize;
        buf[vi * stride] = x0;
        buf[vi * stride + 1] = y0;
        buf[vi * stride + 2] = gcr;
        buf[vi * stride + 3] = gcg;
        buf[vi * stride + 4] = gcb;
        vi++;
        buf[vi * stride] = x1;
        buf[vi * stride + 1] = y0;
        buf[vi * stride + 2] = gcr;
        buf[vi * stride + 3] = gcg;
        buf[vi * stride + 4] = gcb;
        vi++;
        buf[vi * stride] = x0;
        buf[vi * stride + 1] = y1;
        buf[vi * stride + 2] = gcr;
        buf[vi * stride + 3] = gcg;
        buf[vi * stride + 4] = gcb;
        vi++;
        buf[vi * stride] = x0;
        buf[vi * stride + 1] = y1;
        buf[vi * stride + 2] = gcr;
        buf[vi * stride + 3] = gcg;
        buf[vi * stride + 4] = gcb;
        vi++;
        buf[vi * stride] = x1;
        buf[vi * stride + 1] = y0;
        buf[vi * stride + 2] = gcr;
        buf[vi * stride + 3] = gcg;
        buf[vi * stride + 4] = gcb;
        vi++;
        buf[vi * stride] = x1;
        buf[vi * stride + 1] = y1;
        buf[vi * stride + 2] = gcr;
        buf[vi * stride + 3] = gcg;
        buf[vi * stride + 4] = gcb;
        vi++;
      }

      post.bind();
      gl.clearColor(0.014, 0.045, 0.02, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf.subarray(0, vi * stride));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.drawArrays(gl.TRIANGLES, 0, vi);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.85 + audio.level * 0.5,
        exposure: 1.0 + audio.level * 0.15,
        aberration: 0.0006 + audio.change * 0.001,
        grain: 0.03,
        vignette: 1.15,
        flash: 0,
        threshold: 0.5,
        time: t,
      });
    },
  };
}
