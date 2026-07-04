// 14 BZ — Belousov-Zhabotinsky chemical oscillator (FitzHugh-Nagumo excitable
// medium). A broken excited/refractory front, once seeded, curls in on itself
// into a self-sustaining spiral wave that keeps rotating on its own — the
// medium is excitable, not spontaneously oscillating, so motion always traces
// back to a real seed rather than screen-wide flicker. Bass widens/quickens
// the front (diffusion + forcing), highs shorten the recovery time so spirals
// wind tighter, a kick drops a fresh broken-front seed at a random spot, and
// centroid slowly rotates the red/yellow/blue chemical hue. GPGPU ping-pong on
// the same 512^2 grid + 8-neighbour stencil as 02 REACTION, but a different
// (excitable spiral, not Turing-spot) reaction term so the two read distinctly.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 512;
const STEPS = 12;

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state; uniform vec2 u_px;
uniform float u_diff, u_iext, u_eps, u_inject; uniform vec2 u_seed, u_flip;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 s = texture(u_state, v_uv).xy;
  vec2 lap = vec2(0.0);
  lap += texture(u_state, v_uv+vec2(u_px.x,0)).xy;
  lap += texture(u_state, v_uv-vec2(u_px.x,0)).xy;
  lap += texture(u_state, v_uv+vec2(0,u_px.y)).xy;
  lap += texture(u_state, v_uv-vec2(0,u_px.y)).xy;
  lap += 0.5*texture(u_state, v_uv+u_px).xy;
  lap += 0.5*texture(u_state, v_uv-u_px).xy;
  lap += 0.5*texture(u_state, v_uv+vec2(u_px.x,-u_px.y)).xy;
  lap += 0.5*texture(u_state, v_uv+vec2(-u_px.x,u_px.y)).xy;
  lap -= 6.0*s;

  float U = s.x, V = s.y;
  // FitzHugh-Nagumo excitable medium: fast cubic activator U, slow linear
  // inhibitor V (nullcline shape a=0.7, b=0.8 baked in — only the timescale
  // and forcing are audio-driven so the medium stays excitable rather than
  // spontaneously self-oscillating without a seed).
  float react = U - (U*U*U)/3.0 - V + u_iext;
  float recover = u_eps*(U + 0.7 - 0.8*V);
  float dU = 0.12*u_diff*lap.x + 0.045*react;
  float dV = 0.018*u_diff*lap.y + 0.045*recover;
  U = clamp(U + dU, -1.6, 1.6);
  V = clamp(V + dV, -1.6, 1.6);

  // Kick injection: a broken excited/refractory quadrant (classic spiral-wave
  // seed) dropped at a random spot. u_flip randomises which quadrant is which
  // so successive seeds don't all curl the same handedness. u_inject=0 keeps
  // the frame identical to no injection at all.
  vec2 rel = v_uv - u_seed;
  rel -= floor(rel + 0.5);
  rel *= u_flip;
  if (abs(rel.x) < 0.15 && abs(rel.y) < 0.15) {
    if (rel.x < 0.0) U = mix(U, 1.1, u_inject);
    if (rel.x < 0.0 && rel.y < 0.0) V = mix(V, 0.55, u_inject);
  }

  o = vec4(U, V, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state; uniform vec2 u_res; uniform float u_time, u_centroid, u_beat;
in vec2 v_uv; out vec4 o;

// Chemical 3-phase gradient: blue (reduced) -> red -> yellow (oxidised) -> blue.
vec3 triColor(float x){
  vec3 cBlue   = vec3(0.12, 0.28, 0.85);
  vec3 cRed    = vec3(0.95, 0.16, 0.12);
  vec3 cYellow = vec3(1.00, 0.86, 0.28);
  float p = fract(x);
  if (p < 1.0/3.0) return mix(cBlue, cRed, p*3.0);
  if (p < 2.0/3.0) return mix(cRed, cYellow, (p-1.0/3.0)*3.0);
  return mix(cYellow, cBlue, (p-2.0/3.0)*3.0);
}

void main(){
  // cover-fit the square sim onto the screen
  vec2 uv = v_uv;
  float ar = u_res.x/u_res.y;
  if (ar > 1.0) uv = vec2((uv.x-0.5)/ar+0.5, uv.y); else uv = vec2(uv.x, (uv.y-0.5)*ar+0.5);
  vec2 st = texture(u_state, uv).xy;
  float U = st.x, V = st.y;
  float uu = clamp(U*0.5+0.5, 0.0, 1.0);

  float phase = uu*1.4 + V*0.15 + u_centroid*0.6 + u_time*0.01;
  vec3 col = triColor(phase);
  col *= 0.4 + 0.6*smoothstep(-0.25, 0.55, U);

  float edge = length(vec2(dFdx(U), dFdy(U)))*22.0;
  col += vec3(1.0, 0.95, 0.85)*edge*0.55;
  col *= 1.0 + u_beat*0.18;

  vec2 d = v_uv-0.5; col *= 1.0 - dot(d,d)*0.7;
  o = vec4(pow(max(col,0.0), vec3(0.85)), 1.0);
}`;

export function createBz(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const upProg = program(gl, FULLSCREEN_VS, UPDATE_FS);
  const dispProg = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uU: Uniforms = uniforms(gl, upProg);
  const uD: Uniforms = uniforms(gl, dispProg);

  const opts = {
    internal: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
    filter: gl.LINEAR,
    wrap: gl.REPEAT,
  };
  let texA = texture(gl, N, N, opts);
  let texB = texture(gl, N, N, opts);
  let fboA = framebuffer(gl, texA);
  let fboB = framebuffer(gl, texB);

  const REST_U = -1.0;
  const REST_V = -0.6;

  // Drop a broken excited(U)/refractory(V) quadrant centred at (cx,cy): the
  // classic spiral-wave nucleation trick — the free ends of the broken front
  // curl inward as the wave expands, spinning up a rotating spiral pair.
  function dropSpiralSeed(data: Float32Array, cx: number, cy: number, box: number): void {
    const flipx = Math.random() < 0.5 ? 1 : -1;
    const flipy = Math.random() < 0.5 ? 1 : -1;
    for (let y = -box; y <= box; y++)
      for (let x = -box; x <= box; x++) {
        const rx = x * flipx,
          ry = y * flipy;
        const px = (((cx + x) % N) + N) % N,
          py = (((cy + y) % N) + N) % N;
        const idx = (py * N + px) * 4;
        if (rx < 0) data[idx] = 1.1;
        if (rx < 0 && ry < 0) data[idx + 1] = 0.55;
      }
  }

  function seed(): void {
    const data = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      data[i * 4] = REST_U;
      data[i * 4 + 1] = REST_V;
      data[i * 4 + 3] = 1;
    }
    const spirals = 3;
    for (let sIdx = 0; sIdx < spirals; sIdx++) {
      const cx = (Math.random() * N) | 0,
        cy = (Math.random() * N) | 0,
        box = 55 + ((Math.random() * 35) | 0);
      dropSpiralSeed(data, cx, cy, box);
    }
    for (const t of [texA, texB]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, data);
    }
  }
  seed();

  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    key(k) {
      if (k === "r") {
        seed();
        return true;
      }
      return false;
    },
    frame(t, _dt, audio: AudioEngine) {
      // Audio -> excitable-medium regime. bass widens/speeds the front
      // (diffusion + a small forcing bump); high shortens recovery so spirals
      // wind tighter and finer.
      const diff = 0.85 + audio.bass * 0.85;
      const iext = audio.bass * 0.06;
      const eps = 0.05 + audio.high * 0.11;
      const inject = audio.kick ? 0.9 : 0;
      const sx = Math.random(),
        sy = Math.random();
      const flipx = Math.random() < 0.5 ? 1 : -1;
      const flipy = Math.random() < 0.5 ? 1 : -1;

      gl.disable(gl.BLEND);
      gl.useProgram(upProg);
      gl.bindVertexArray(tri);
      gl.uniform2f(uU.u_px, 1 / N, 1 / N);
      gl.uniform1f(uU.u_diff, diff);
      gl.uniform1f(uU.u_iext, iext);
      gl.uniform1f(uU.u_eps, eps);
      gl.uniform2f(uU.u_flip, flipx, flipy);
      for (let s = 0; s < STEPS; s++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.viewport(0, 0, N, N);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texA);
        gl.uniform1i(uU.u_state, 0);
        gl.uniform1f(uU.u_inject, s === 0 ? inject : 0);
        gl.uniform2f(uU.u_seed, sx, sy);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        [texA, texB] = [texB, texA];
        [fboA, fboB] = [fboB, fboA];
      }

      ctx.bindOutput();
      gl.useProgram(dispProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uD.u_state, 0);
      gl.uniform2f(uD.u_res, rw, rh);
      gl.uniform1f(uD.u_time, t);
      gl.uniform1f(uD.u_centroid, audio.centroid);
      gl.uniform1f(uD.u_beat, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
