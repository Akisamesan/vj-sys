// 77 SPRINGMESH — a trampoline-like grid of mass points connected by Hooke's-law
// springs (F = -k*(dist-restLength), reduced here to a height field: each node
// pulls toward its four neighbours' height and its own velocity is viscously
// damped). Unlike waves.ts's leapfrog wave-equation PDE (previous-height memory,
// no explicit velocity), this is a proper discrete mass-spring network integrated
// with semi-implicit Euler per node — springier, less ringy, settles distinctly.
// The mesh edges are anchored to a virtual zero frame, which both reads as a
// trampoline rim and keeps the field's mean height self-correcting (no DC creep).
// Kicks drop a localized downward impulse near a random interior node that
// rebounds and radiates outward through the spring lattice over several frames.
// Rendered as an actual filled triangle mesh (not GL_LINES) seen from a tilted
// three-quarter angle with simple painter's-order back-to-front draws (no depth
// buffer) and per-vertex Blinn-Phong lighting from a central-difference normal.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";
import { BAND_COUNT } from "../engine/audio.ts";

const N = 30; // grid nodes per side
const CELLS = N - 1;
const MARGIN = 4; // keep spectrum injection points off the anchored rim

const K_BASE = 7.0;
const K_BASS_SCALE = 9.0;
const DAMP_BASE = 1.7;
const DAMP_LEVEL_SCALE = 1.05;
const DAMP_MIN = 0.35;
const KICK_IMPULSE = 15.0;
const KICK_RADIUS = 2; // grid cells, falloff footprint of a kick
const MICRO_SCALE = 3.2; // spectrum -> continuous micro-impulse strength
const AMBIENT_SCALE = 0.55; // always-on autonomous drive (independent of audio)
const HEIGHT_DECAY = 0.9992; // gentle mean-reversion safety net (DC drift guard)
const HEIGHT_CLAMP = 2.4;
const VEL_CLAMP = 40;

// Camera: tilted three-quarter view. gy in [-1,1] doubles as pseudo-depth so a
// simple front-to-back draw order (rows ascending) is a correct painter's sort
// without a depth buffer.
const PERSP = 0.55;
const X_SCALE = 0.98;
const Y_SCALE = 0.68;
const VIS_H = 0.4;
const OFFSET_Y = 0.0;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_height;
layout(location=2) in vec2 a_normal;
layout(location=3) in float a_glow;
out float v_height;
out vec2 v_normal;
out float v_glow;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_height = a_height;
  v_normal = a_normal;
  v_glow = a_glow;
}`;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
in float v_height;
in vec2 v_normal;
in float v_glow;
uniform float u_high, u_kickPulse, u_centroid, u_energy, u_hue, u_seed;
out vec4 o;
void main(){
  vec3 normal = normalize(vec3(v_normal * 7.5, 1.0));
  vec3 lightDir = normalize(vec3(0.38, 0.6, 0.7));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  float diff = max(dot(normal, lightDir), 0.0);
  vec3 halfV = normalize(lightDir + viewDir);
  float shininess = mix(16.0, 100.0, clamp(u_high, 0.0, 1.0));
  float spec = pow(max(dot(normal, halfV), 0.0), shininess);

  // metallic / cool-blue palette; centroid + hue macro drift the phase.
  // seed macro (0 = identity) adds its own continuous phase offset so it
  // reads as a distinct "face" of the same mesh under a seed sweep.
  float phase = 0.06 + clamp(u_centroid, 0.0, 1.0) * 0.42 + u_hue + u_seed * 0.5;
  vec3 metal = palette(phase, vec3(0.30, 0.38, 0.48), vec3(0.34, 0.36, 0.34), vec3(1.0, 1.0, 1.0), vec3(0.55, 0.62, 0.74));

  float mixv = clamp(v_height * 0.9 + 0.5, 0.0, 1.0);
  vec3 deep = vec3(0.07, 0.11, 0.19);
  vec3 col = mix(deep, metal, mixv);
  col = col * (0.72 + 0.85 * diff);
  col += vec3(0.85, 0.92, 1.0) * spec * (0.8 + 0.6 * u_high);
  col *= 1.35 + u_energy * 0.6;

  // localized decaying glow at the last kick's impact node — a structural
  // trigger response, not a full-screen flash.
  col += vec3(0.55, 0.85, 1.25) * v_glow * u_kickPulse * 2.4;

  o = vec4(pow(max(col, 0.0), vec3(0.92)), 1.0);
}`;

export function createSpringmesh(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const count = N * N;
  const height = new Float32Array(count);
  let velCur = new Float32Array(count);
  let velNext = new Float32Array(count);
  const normX = new Float32Array(count);
  const normY = new Float32Array(count);

  // Map each spectrum band to a grid node in the mesh interior so bands read
  // as distinct injection sites rather than a single spot.
  const bandCols = 6;
  const bandRows = Math.ceil(BAND_COUNT / bandCols);
  const bandIdx = new Int32Array(BAND_COUNT);
  for (let b = 0; b < BAND_COUNT; b++) {
    const bc = b % bandCols;
    const br = Math.floor(b / bandCols);
    const ci = Math.round(MARGIN + (bc / Math.max(1, bandCols - 1)) * (N - 1 - 2 * MARGIN));
    const rj = Math.round(MARGIN + (br / Math.max(1, bandRows - 1)) * (N - 1 - 2 * MARGIN));
    bandIdx[b] = rj * N + ci;
  }

  let kickI = -1000,
    kickJ = -1000;

  const segCount = CELLS * CELLS;
  const vertCount = segCount * 6;
  const vbuf = new Float32Array(vertCount * 6); // x,y,height,nx,ny,glow

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vbuf.byteLength, gl.DYNAMIC_DRAW);
  const STRIDE = 24;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIDE, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 12);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 20);
  gl.bindVertexArray(null);

  // Macro state (all default 0 => unmodulated).
  let macroEnergy = 0;
  let macroHue = 0;
  let macroSeed = 0;
  let macroChaos = 0;

  let rw = 1,
    rh = 1;

  const screenX = new Float32Array(count);
  const screenY = new Float32Array(count);
  const glowArr = new Float32Array(count);

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    macros: {
      energy: (v) => {
        macroEnergy = v;
      },
      hue: (v) => {
        macroHue = v;
      },
      seed: (v) => {
        macroSeed = v;
      },
      chaos: (v) => {
        macroChaos = v;
      },
    },
    frame(t, dt, audio: AudioEngine) {
      const dtc = Math.min(Math.max(dt, 0), 1 / 24);

      // Continuous: bass -> spring stiffness (propagation speed/hardness),
      // level -> damping (higher level = looser damping = longer sustain).
      const k = K_BASE + audio.bass * K_BASS_SCALE;
      const damping = Math.max(DAMP_MIN, DAMP_BASE - audio.level * DAMP_LEVEL_SCALE);

      // Autonomous ambient drive so the mesh never sits perfectly still, even
      // in silence. seed macro drifts its phase continuously (0 = identity).
      const seedPhase = macroSeed * 6.28318;
      const ambI = Math.round((0.5 + 0.3 * Math.sin(t * 0.17 + seedPhase)) * (N - 1));
      const ambJ = Math.round((0.5 + 0.3 * Math.cos(t * 0.13 + seedPhase * 1.3 + 1.1)) * (N - 1));
      const ambIdx = Math.max(0, Math.min(count - 1, ambJ * N + ambI));
      velCur[ambIdx] += Math.sin(t * 0.9) * AMBIENT_SCALE * dtc;

      // Continuous: spectrum -> many small continuous impulses across the mesh.
      const chaosJitter = 1 + macroChaos * 1.5;
      for (let b = 0; b < BAND_COUNT; b++) {
        const idx = bandIdx[b];
        velCur[idx] += audio.spectrum[b] * MICRO_SCALE * chaosJitter * dtc;
      }

      // Trigger: kick fires a localized downward impulse near a random
      // interior node, which the spring lattice propagates over subsequent
      // frames (structural, not a flash).
      if (audio.kick) {
        kickI = MARGIN + Math.floor(Math.random() * (N - 2 * MARGIN));
        kickJ = MARGIN + Math.floor(Math.random() * (N - 2 * MARGIN));
        for (let dj = -KICK_RADIUS; dj <= KICK_RADIUS; dj++) {
          for (let di = -KICK_RADIUS; di <= KICK_RADIUS; di++) {
            const i = kickI + di,
              j = kickJ + dj;
            if (i < 0 || i >= N || j < 0 || j >= N) continue;
            const d2 = di * di + dj * dj;
            if (d2 > KICK_RADIUS * KICK_RADIUS + 0.01) continue;
            const falloff = Math.exp(-d2 * 0.6);
            velCur[j * N + i] -= KICK_IMPULSE * falloff;
          }
        }
      }

      // Mass-spring integration (semi-implicit Euler): each node pulls toward
      // its four neighbours' height; missing neighbours (rim) count as a fixed
      // virtual 0, anchoring the trampoline frame and self-correcting drift.
      for (let j = 0; j < N; j++) {
        const rowBase = j * N;
        for (let i = 0; i < N; i++) {
          const idx = rowBase + i;
          const hC = height[idx];
          const hL = i > 0 ? height[idx - 1] : 0;
          const hR = i < N - 1 ? height[idx + 1] : 0;
          const hD = j > 0 ? height[idx - N] : 0;
          const hU = j < N - 1 ? height[idx + N] : 0;
          const force = k * (hL + hR + hD + hU - 4 * hC) - damping * velCur[idx];
          let nv = velCur[idx] + force * dtc;
          if (nv > VEL_CLAMP) nv = VEL_CLAMP;
          else if (nv < -VEL_CLAMP) nv = -VEL_CLAMP;
          velNext[idx] = nv;
        }
      }
      for (let idx = 0; idx < count; idx++) {
        let h = height[idx] + velNext[idx] * dtc;
        h *= HEIGHT_DECAY;
        if (h > HEIGHT_CLAMP) h = HEIGHT_CLAMP;
        else if (h < -HEIGHT_CLAMP) h = -HEIGHT_CLAMP;
        height[idx] = h;
      }
      const tmp = velCur;
      velCur = velNext;
      velNext = tmp;

      // Normals via central differences, then project every node to screen
      // space once (shared by up to 4 adjacent quads).
      const aspect = rw / Math.max(rh, 1e-4);
      for (let j = 0; j < N; j++) {
        const rowBase = j * N;
        const gy = 1 - (2 * j) / (N - 1); // j=0 far, j=N-1 near (painter's order)
        const s = 1 / (1 + (gy * 0.5 + 0.5) * PERSP);
        for (let i = 0; i < N; i++) {
          const idx = rowBase + i;
          const hL = i > 0 ? height[idx - 1] : height[idx];
          const hR = i < N - 1 ? height[idx + 1] : height[idx];
          const hD = j > 0 ? height[idx - N] : height[idx];
          const hU = j < N - 1 ? height[idx + N] : height[idx];
          normX[idx] = hL - hR;
          normY[idx] = hD - hU;

          const gx = -1 + (2 * i) / (N - 1);
          const h = height[idx];
          screenX[idx] = (gx * X_SCALE * s) / aspect;
          screenY[idx] = OFFSET_Y + gy * Y_SCALE * s - h * VIS_H * s;

          const di = i - kickI,
            dj = j - kickJ;
          glowArr[idx] = Math.exp(-(di * di + dj * dj) * 0.05);
        }
      }

      // Rebuild the filled triangle mesh (draw order j ascending = far-to-near,
      // a correct painter's sort with no depth buffer since gy alone drives depth).
      let vi = 0;
      for (let j = 0; j < CELLS; j++) {
        for (let i = 0; i < CELLS; i++) {
          const a = j * N + i;
          const b = a + 1;
          const c = a + N;
          const d = c + 1;
          // two triangles: (a,b,c) and (c,b,d)
          const idxs = [a, b, c, c, b, d];
          for (let n = 0; n < 6; n++) {
            const idx = idxs[n];
            vbuf[vi++] = screenX[idx];
            vbuf[vi++] = screenY[idx];
            vbuf[vi++] = height[idx];
            vbuf[vi++] = normX[idx];
            vbuf[vi++] = normY[idx];
            vbuf[vi++] = glowArr[idx];
          }
        }
      }

      post.bind();
      gl.clearColor(0.008, 0.014, 0.03, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vbuf);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_energy, macroEnergy);
      gl.uniform1f(u.u_hue, macroHue);
      gl.uniform1f(u.u_seed, macroSeed);
      gl.drawArrays(gl.TRIANGLES, 0, vertCount);

      post.draw(rw, rh, {
        bloom: 0.55 + audio.level * 0.25 + macroEnergy * 0.3,
        exposure: 1.02 + audio.kickPulse * 0.12,
        aberration: 0.0006 + audio.change * 0.001,
        grain: 0.03,
        vignette: 1.1,
        flash: 0,
        threshold: 0.75,
        time: t,
      });
    },
  };
}
