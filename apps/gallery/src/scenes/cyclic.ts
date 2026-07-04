// 15 CYCLIC — cyclic cellular automaton. Each cell holds one of STATES discrete
// hue-steps and advances to the next step once enough Moore-neighbours already
// sit there; the result is a self-organising field of spiralling colour bands.
// GPGPU ping-pong (see reaction.ts): a discrete-state field instead of a
// continuous concentration field.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 384;
const STATES = 8;

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state; uniform vec2 u_px;
uniform float u_states, u_threshold, u_seedOn, u_seedR; uniform vec2 u_seedPos;
in vec2 v_uv; out vec4 o;

float nbrMatch(vec2 uv, float nxt){
  float ns = texture(u_state, uv).r;
  return 1.0 - step(0.5, abs(ns - nxt));
}

void main(){
  float s = texture(u_state, v_uv).r;
  float nxt = mod(s + 1.0, u_states);
  float cnt = 0.0;
  cnt += nbrMatch(v_uv + vec2(u_px.x, 0.0), nxt);
  cnt += nbrMatch(v_uv - vec2(u_px.x, 0.0), nxt);
  cnt += nbrMatch(v_uv + vec2(0.0, u_px.y), nxt);
  cnt += nbrMatch(v_uv - vec2(0.0, u_px.y), nxt);
  cnt += nbrMatch(v_uv + u_px, nxt);
  cnt += nbrMatch(v_uv - u_px, nxt);
  cnt += nbrMatch(v_uv + vec2(u_px.x, -u_px.y), nxt);
  cnt += nbrMatch(v_uv + vec2(-u_px.x, u_px.y), nxt);

  float ns = cnt >= u_threshold ? nxt : s;

  // kick: force a random patch to advance one step, seeding a fresh wavefront
  float d = distance(v_uv, u_seedPos);
  if (u_seedOn > 0.5 && d < u_seedR) ns = nxt;

  o = vec4(ns, 0.0, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_state; uniform vec2 u_res; uniform float u_states, u_hueOffset;
uniform float u_kickPulse; uniform vec2 u_seedPos;
in vec2 v_uv; out vec4 o;
void main(){
  // cover-fit the square sim onto the screen
  vec2 uv = v_uv;
  float ar = u_res.x/u_res.y;
  if(ar>1.0) uv = vec2((uv.x-0.5)/ar+0.5, uv.y); else uv = vec2(uv.x,(uv.y-0.5)*ar+0.5);

  float s = texture(u_state, uv).r;
  float v = s / u_states;
  float hue = v + u_hueOffset;
  vec3 col = palette(hue, vec3(0.5,0.5,0.5), vec3(0.5,0.5,0.5), vec3(1.0,1.0,1.0), vec3(0.0,0.333,0.667));

  // cell-boundary rim where neighbouring cells sit in different states. A busy
  // field has boundaries almost everywhere, so this must stay subtle (additive
  // near-white here would wash the whole frame out rather than pick out edges).
  float edge = clamp(length(vec2(dFdx(v), dFdy(v))) * 8.0, 0.0, 1.0);
  col = mix(col, col*1.5 + vec3(0.06), edge*0.4);

  // Kick: a soft, localised bloom over the freshly-seeded patch so the trigger
  // reads clearly against the busy field instead of being lost in it.
  float dKick = distance(uv, u_seedPos);
  col += vec3(1.0,0.95,0.85) * u_kickPulse * exp(-dKick*dKick*140.0) * 0.9;

  vec2 dd = v_uv - 0.5; col *= 1.0 - dot(dd,dd)*0.5;
  o = vec4(pow(max(col,0.0), vec3(0.85)), 1.0);
}`;

export function createCyclic(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const upProg = program(gl, FULLSCREEN_VS, UPDATE_FS);
  const dispProg = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uU: Uniforms = uniforms(gl, upProg);
  const uD: Uniforms = uniforms(gl, dispProg);

  const opts = {
    internal: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
    filter: gl.NEAREST,
    wrap: gl.REPEAT,
  };
  let texA = texture(gl, N, N, opts);
  let texB = texture(gl, N, N, opts);
  let fboA = framebuffer(gl, texA);
  let fboB = framebuffer(gl, texB);

  // Cyclic CA coarsens from per-texel random noise as roughly sqrt(generations):
  // on a 384x384 grid that needs far more warm-up than is practical to run
  // synchronously at scene start. Instead the initial condition is already
  // coarse (a low-resolution random grid, nearest-upsampled into blocks), so
  // the CA's rotation rule immediately has real domains to animate and erode
  // into organic, moving boundaries rather than having to invent them from noise.
  const COARSE = 20;
  function seed(): void {
    const blockStates = new Float32Array(COARSE * COARSE);
    for (let i = 0; i < blockStates.length; i++) blockStates[i] = Math.floor(Math.random() * STATES);

    const data = new Float32Array(N * N * 4);
    for (let y = 0; y < N; y++) {
      const by = Math.min(COARSE - 1, Math.floor((y / N) * COARSE));
      for (let x = 0; x < N; x++) {
        const bx = Math.min(COARSE - 1, Math.floor((x / N) * COARSE));
        const i = y * N + x;
        data[i * 4] = blockStates[by * COARSE + bx];
        data[i * 4 + 3] = 1;
      }
    }
    for (const t of [texA, texB]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, data);
    }
  }

  // Cyclic CA coarsens from pure random noise as roughly sqrt(generations): a
  // 384x384 field needs thousands of generations, not hundreds, before domains
  // grow large enough to read as organised bands rather than fine static. A
  // lower threshold nucleates larger domains faster during this one-time
  // warm-up than the audio-driven range (1.5-4.0) used during playback.
  function warmup(): void {
    gl.disable(gl.BLEND);
    gl.useProgram(upProg);
    gl.bindVertexArray(tri);
    gl.uniform2f(uU.u_px, 1 / N, 1 / N);
    gl.uniform1f(uU.u_states, STATES);
    gl.uniform1f(uU.u_threshold, 3);
    gl.uniform1f(uU.u_seedOn, 0);
    gl.uniform2f(uU.u_seedPos, 0.5, 0.5);
    gl.uniform1f(uU.u_seedR, 0);
    for (let s = 0; s < 3000; s++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.viewport(0, 0, N, N);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uU.u_state, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [texA, texB] = [texB, texA];
      [fboA, fboB] = [fboB, fboA];
    }
  }
  seed();
  warmup();

  let rw = 1,
    rh = 1;
  let lastSeedX = 0.5,
    lastSeedY = 0.5;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    key(k) {
      if (k === "r") {
        seed();
        warmup();
        return true;
      }
      return false;
    },
    frame(_t, dt, audio: AudioEngine) {
      // level -> generations advanced this frame (frame-rate normalised to 60fps)
      const rateBase = 2 + audio.level * 6;
      let nSteps = Math.round(rateBase * dt * 60);
      if (nSteps < 1) nSteps = 1;
      if (nSteps > 10) nSteps = 10;

      // bass -> agreement threshold (how many of the 8 neighbours must already
      // hold the next hue-step before a cell follows): looser = rougher, more
      // turbulent bands; stricter = cleaner, slower-forming spirals.
      const threshold = 2.2 + audio.bass * 1.6;

      const doSeed = audio.kick > 0.5;
      const sx = Math.random(),
        sy = Math.random();
      const sr = 0.05 + Math.random() * 0.05;
      if (doSeed) {
        lastSeedX = sx;
        lastSeedY = sy;
      }

      gl.disable(gl.BLEND);
      gl.useProgram(upProg);
      gl.bindVertexArray(tri);
      gl.uniform2f(uU.u_px, 1 / N, 1 / N);
      gl.uniform1f(uU.u_states, STATES);
      gl.uniform1f(uU.u_threshold, threshold);
      gl.uniform2f(uU.u_seedPos, sx, sy);
      gl.uniform1f(uU.u_seedR, sr);
      for (let s = 0; s < nSteps; s++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.viewport(0, 0, N, N);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texA);
        gl.uniform1i(uU.u_state, 0);
        gl.uniform1f(uU.u_seedOn, s === 0 && doSeed ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        [texA, texB] = [texB, texA];
        [fboA, fboB] = [fboB, fboA];
      }

      ctx.bindOutput();
      gl.useProgram(dispProg);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uD.u_state, 0);
      gl.uniform2f(uD.u_res, rw, rh);
      gl.uniform1f(uD.u_states, STATES);
      // centroid -> whole-palette hue offset
      gl.uniform1f(uD.u_hueOffset, audio.centroid);
      gl.uniform1f(uD.u_kickPulse, audio.kickPulse);
      gl.uniform2f(uD.u_seedPos, lastSeedX, lastSeedY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
