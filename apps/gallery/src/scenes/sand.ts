// 18 SAND — a falling, settling dune. Rather than a true cellular automaton
// (sequential, hard to keep cheap), the pile is approximated as a 1D height
// field: a Float32Array of column heights, updated on the CPU each frame and
// uploaded to a Nx1 data texture (texSubImage2D, same pattern as reaction.ts's
// seeding), then painted by a single fragment pass (caustics.ts-style): below
// the column height is sand, above is night sky.
//
// Three band walkers (bass/mid/high) each wander inside their own third of the
// columns and deposit a soft kernel of sand at their position — energy in that
// band controls how much. An O(width) repose-angle relaxation pass moves excess
// height to the lower neighbour wherever the local slope exceeds a threshold;
// columns spill off the two screen edges (a sink) so the pile self-regulates
// instead of growing without bound. On every kick a fresh random column window
// gets its repose threshold temporarily lowered (scaled by the decaying
// kickPulse), so the next relaxation passes cascade there — a visible, located
// avalanche instead of a global flash. level sets how many relaxation passes
// run per frame (the pile's "settle speed"); centroid drifts the warm
// yellow-ocher -> orange palette.

import { program, uniforms, texture, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const WIDTH = 384;
const BAND_SIZE = WIDTH / 3;
const MAX_HEIGHT = 0.86;
const BASE_REPOSE = 0.035;
const KICK_REPOSE_DROP = 0.028;
const DEPOSIT_RATE = 1.1;
const WANDER_SPEED = 50; // columns/sec

const KERNEL_R = 5;
const KERNEL_SIGMA = 2.0;
const KERNEL: number[] = (() => {
  const w: number[] = [];
  let sum = 0;
  for (let d = -KERNEL_R; d <= KERNEL_R; d++) {
    const v = Math.exp(-(d * d) / (2 * KERNEL_SIGMA * KERNEL_SIGMA));
    w.push(v);
    sum += v;
  }
  return w.map((v) => v / sum);
})();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function seedHeights(h: Float32Array): void {
  // A tall, jagged initial range (not a low bump) so the dune reads clearly
  // from frame 0 instead of needing many seconds of deposits to build up.
  for (let x = 0; x < WIDTH; x++) {
    const n =
      Math.sin(x * 0.021) * 0.16 +
      Math.sin(x * 0.057 + 1.4) * 0.09 +
      Math.sin(x * 0.14 + 3.1) * 0.05;
    h[x] = clamp(0.34 + n + (Math.random() - 0.5) * 0.03, 0.08, MAX_HEIGHT);
  }
}

function depositBand(h: Float32Array, centerCol: number, amount: number): void {
  if (amount <= 0) return;
  const c = Math.round(centerCol);
  for (let i = 0; i < KERNEL.length; i++) {
    const x = c + i - KERNEL_R;
    if (x < 0 || x >= WIDTH) continue;
    h[x] = Math.min(MAX_HEIGHT, h[x] + amount * KERNEL[i]);
  }
}

// Smoothstep falloff: 1 at the window centre, 0 at its edge.
function windowWeight(dist: number, half: number): number {
  const x = clamp(dist / Math.max(half, 1e-4), 0, 1);
  return 1 - x * x * (3 - 2 * x);
}

function reposeThreshold(
  col: number,
  kickPulse: number,
  winCenter: number,
  winHalf: number,
): number {
  const w = windowWeight(Math.abs(col - winCenter), winHalf);
  return BASE_REPOSE - KICK_REPOSE_DROP * kickPulse * w;
}

function avalanchePass(
  h: Float32Array,
  kickPulse: number,
  winCenter: number,
  winHalf: number,
): void {
  const settle = 0.5;
  for (let x = 0; x < WIDTH - 1; x++) {
    const th = reposeThreshold(x + 0.5, kickPulse, winCenter, winHalf);
    const diff = h[x] - h[x + 1];
    if (diff > th) {
      const move = (diff - th) * settle;
      h[x] -= move;
      h[x + 1] += move;
    } else if (-diff > th) {
      const move = -diff - th;
      const m = move * settle;
      h[x + 1] -= m;
      h[x] += m;
    }
  }
  // Edge sink: sand piled past a modest threshold at the boundary columns
  // spills off-screen, bounding total mass (self-organised criticality).
  const edgeTh = BASE_REPOSE * 0.6;
  if (h[0] > edgeTh) h[0] -= (h[0] - edgeTh) * 0.4;
  if (h[WIDTH - 1] > edgeTh) h[WIDTH - 1] -= (h[WIDTH - 1] - edgeTh) * 0.4;
}

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_height;
uniform vec2 u_res;
uniform float u_time, u_centroid, u_kickPulse, u_winCenter, u_winHalf;
in vec2 v_uv;
out vec4 o;

float smoothWin(float d, float half_){
  float x = clamp(d / max(half_, 1e-4), 0.0, 1.0);
  return 1.0 - x*x*(3.0-2.0*x);
}

void main(){
  float h = texture(u_height, vec2(v_uv.x, 0.5)).r;
  float y = v_uv.y;

  // Night backdrop with sparse twinkling stars — kept alive even in silence.
  vec3 bg = mix(vec3(0.015,0.018,0.03), vec3(0.05,0.03,0.045), y);
  float starN = hash11(floor(v_uv.x*220.0)*3.1 + floor(y*130.0)*91.7);
  float star = step(0.9935, starN) * (0.5 + 0.5*sin(u_time*1.6 + starN*50.0));
  bg += vec3(0.5,0.55,0.6) * star;

  float inSand = step(y, h);
  float depth = h > 1e-4 ? clamp(y/h, 0.0, 1.0) : 0.0;
  float grain = hash11(floor(v_uv.x*u_res.x)*0.037 + floor(y*u_res.y)*4.113 + 7.0);

  float hueT = 0.06 + depth*0.10 + u_centroid*0.16;
  vec3 sandCol = palette(hueT, vec3(0.62,0.42,0.22), vec3(0.32,0.22,0.10), vec3(1.0,0.95,0.6), vec3(0.0,0.05,0.12));
  sandCol *= 0.65 + depth*0.55 + (grain-0.5)*0.3;

  // Bright crest rim where the surface sits (wide enough to read as a visible
  // band, not a hairline, so the dune has real internal contrast/coverage).
  float rim = exp(-abs(h-y)*28.0);
  sandCol += vec3(1.0,0.82,0.45) * rim * 0.7;

  // Localised warm glow marking the current avalanche window (structural, not a flash).
  float dCenter = abs(v_uv.x - u_winCenter);
  float win = smoothWin(dCenter, u_winHalf) * u_kickPulse;
  sandCol += vec3(1.0,0.55,0.25) * win * inSand * 0.4;

  vec3 col = mix(bg, sandCol, inSand);
  vec2 d = v_uv - 0.5;
  col *= 1.0 - dot(d,d)*0.25;
  o = vec4(pow(max(col,0.0), vec3(0.92)), 1.0);
}`;

export function createSand(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const u: Uniforms = uniforms(gl, prog);

  const heightTex = texture(gl, WIDTH, 1, {
    internal: gl.R16F,
    format: gl.RED,
    type: gl.HALF_FLOAT,
    filter: gl.LINEAR,
    wrap: gl.CLAMP_TO_EDGE,
  });

  const heights = new Float32Array(WIDTH);
  seedHeights(heights);

  const walkerPos = [BAND_SIZE * 0.5, BAND_SIZE * 1.5, BAND_SIZE * 2.5];
  let winCenter = WIDTH * 0.5;
  let winHalf = WIDTH * 0.15;

  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      if (audio.kick) {
        winCenter = Math.random() * WIDTH;
        winHalf = WIDTH * (0.08 + Math.random() * 0.17);
      }

      const energies = [audio.bass, audio.mid, audio.high];
      for (let b = 0; b < 3; b++) {
        const lo = b * BAND_SIZE + 6;
        const hi = b * BAND_SIZE + BAND_SIZE - 7;
        walkerPos[b] = clamp(walkerPos[b] + (Math.random() * 2 - 1) * WANDER_SPEED * dt, lo, hi);
        const amount = energies[b] * DEPOSIT_RATE * dt;
        depositBand(heights, walkerPos[b], amount);
      }

      // level -> settle speed (relaxation passes/frame), stochastically rounded
      // so the average rate scales continuously with the smoothed level value.
      const passesF = 1 + audio.level * 4;
      const passesInt = Math.floor(passesF);
      const frac = passesF - passesInt;
      const passes = passesInt + (Math.random() < frac ? 1 : 0);
      for (let p = 0; p < passes; p++) avalanchePass(heights, audio.kickPulse, winCenter, winHalf);

      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WIDTH, 1, gl.RED, gl.FLOAT, heights);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      gl.uniform1i(u.u_height, 0);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1f(u.u_winCenter, winCenter / WIDTH);
      gl.uniform1f(u.u_winHalf, winHalf / WIDTH);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
