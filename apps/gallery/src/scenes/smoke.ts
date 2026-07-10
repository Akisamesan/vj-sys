// 68 SMOKE — buoyant smoke rising from a source band at the bottom of the screen.
// Lightweight GPGPU: a density/temperature field is advected by an *analytic*
// velocity (no pressure projection) built from "hotter rises faster" buoyancy
// plus curl-noise turbulence, then re-injected at the base every frame. A
// pressure-free cousin of 06 FLUID / 66 INK, tuned for a soft, drifting plume
// instead of a swirling dye pour.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

// Density in .r, temperature in .g. Velocity is derived analytically per pixel
// from the temperature field + curl noise, so there is no separate velocity
// texture and no Jacobi pressure solve — a deliberately cheap approximation.
const UPDATE_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_state;
uniform vec2 u_px;
uniform float u_dt, u_time, u_aspect;
uniform float u_buoy, u_curlScale, u_curlAmt;
uniform float u_dissD, u_dissT;
uniform float u_emit, u_emitBand;
uniform float u_puffX, u_puffY, u_puffAmt, u_puffR;
in vec2 v_uv;
out vec4 o;

void main(){
  vec2 local = texture(u_state, v_uv).rg;

  // Analytic velocity: buoyancy scales with local temperature (hot rises
  // faster) plus a divergence-free curl-noise turbulence field.
  vec3 domain = vec3(v_uv.x * u_aspect * u_curlScale, v_uv.y * u_curlScale - u_time * 0.06, u_time * 0.17);
  vec3 curl = curlNoise(domain, u_time);
  vec2 vel = curl.xy * u_curlAmt + vec2(0.0, u_buoy * (0.22 + 0.9 * local.y));

  // Semi-Lagrangian backtrace + a soft 4-tap blur for gentle diffusion.
  vec2 coord = v_uv - u_dt * vel * vec2(1.0 / u_aspect, 1.0);
  vec2 s0 = texture(u_state, coord).rg;
  vec2 sL = texture(u_state, coord - vec2(u_px.x, 0.0)).rg;
  vec2 sR = texture(u_state, coord + vec2(u_px.x, 0.0)).rg;
  vec2 sB = texture(u_state, coord - vec2(0.0, u_px.y)).rg;
  vec2 sT = texture(u_state, coord + vec2(0.0, u_px.y)).rg;
  vec2 blurred = (s0 * 4.0 + sL + sR + sB + sT) / 8.0;
  vec2 st = mix(s0, blurred, 0.3);
  st *= vec2(u_dissD, u_dissT);

  // Emitter band near the bottom edge: continuous, with organic horizontal
  // breakup from noise so it reads as several small plumes, not a solid bar.
  float shape = exp(-pow(v_uv.y / u_emitBand, 2.0));
  float mod_ = 0.5 + 0.5 * snoise(vec3(v_uv.x * 5.0, u_time * 0.45, 1.7));
  float amt = u_emit * shape * mod_;
  st.x += amt;
  st.y += amt * 1.5;

  // Kick puff: a single decaying local blob injected at a fresh random spot.
  vec2 dp = vec2((v_uv.x - u_puffX) * u_aspect, v_uv.y - u_puffY);
  float puff = exp(-dot(dp, dp) / u_puffR) * u_puffAmt;
  st.x += puff * 1.4;
  st.y += puff * 2.0;

  st = clamp(st, 0.0, 1.0);
  o = vec4(st, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform float u_centroid, u_beat;
in vec2 v_uv;
out vec4 o;
void main(){
  vec2 st = texture(u_state, v_uv).rg;
  float v = pow(clamp(st.x, 0.0, 1.0), 0.85);

  // Monochrome grey-white base, nudged warm/cool by the spectral centroid.
  vec3 base = vec3(0.72, 0.75, 0.80);
  vec3 warm = vec3(0.22, 0.05, -0.16);
  vec3 tint = clamp(base + warm * (u_centroid - 0.5) * 2.0, 0.0, 1.1);
  vec3 col = tint * v;

  // Faint hot-core lift where temperature is highest, near the source.
  col += vec3(0.10, 0.08, 0.04) * smoothstep(0.55, 1.0, st.y) * 0.5;

  // Structural, not flashy: a gentle global lift on the kick envelope.
  col *= 1.0 + u_beat * 0.1;

  vec2 d = v_uv - 0.5;
  col *= 1.0 - dot(d, d) * 0.3;

  vec3 bg = vec3(0.02, 0.022, 0.03);
  vec3 outc = clamp(bg + col, 0.0, 0.92);
  o = vec4(pow(outc, vec3(0.92)), 1.0);
}`;

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

const MAX_DIM = 288;

export function createSmoke(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const pUpdate = program(gl, FULLSCREEN_VS, UPDATE_FS);
  const pDisplay = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uU: Uniforms = uniforms(gl, pUpdate);
  const uD: Uniforms = uniforms(gl, pDisplay);

  let sw = 1,
    sh = 1;
  let stateA: RT, stateB: RT;

  function rt(w: number, h: number): RT {
    const tex = texture(gl, w, h, {
      internal: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
      filter: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    });
    return { tex, fbo: framebuffer(gl, tex) };
  }

  function alloc(): void {
    stateA = rt(sw, sh);
    stateB = rt(sw, sh);
    for (const r of [stateA, stateB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  const aspect = (): number => sw / sh;

  // Kick puff target: a fresh random spot near the base picked on each kick,
  // the JS-side envelope (audio.kickPulse) fades it back out — no per-frame
  // random re-seeding, so the trigger reads as one discrete "puff".
  let puffX = 0.5,
    puffY = 0.05;

  return {
    resize(w, h) {
      sw = Math.max(8, Math.min(MAX_DIM, w >> 1));
      sh = Math.max(8, Math.min(MAX_DIM, h >> 1));
      alloc();
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);

      if (audio.kick) {
        puffX = 0.12 + Math.random() * 0.76;
        puffY = 0.03 + Math.random() * 0.05;
      }

      const buoy = 0.11 + audio.bass * 0.5; // bass -> rise speed
      const curlScale = 2.0 + audio.high * 4.5; // high -> turbulence frequency
      const curlAmt = 0.04 + audio.high * 0.2; // high -> turbulence strength
      const emit = 0.012 + audio.level * 0.1; // level -> emission volume

      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, stateB.fbo);
      gl.viewport(0, 0, sw, sh);
      gl.useProgram(pUpdate);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, stateA.tex);
      gl.uniform1i(uU.u_state, 0);
      gl.uniform2f(uU.u_px, 1 / sw, 1 / sh);
      gl.uniform1f(uU.u_dt, fdt);
      gl.uniform1f(uU.u_time, t);
      gl.uniform1f(uU.u_aspect, aspect());
      gl.uniform1f(uU.u_buoy, buoy);
      gl.uniform1f(uU.u_curlScale, curlScale);
      gl.uniform1f(uU.u_curlAmt, curlAmt);
      gl.uniform1f(uU.u_dissD, 0.988);
      gl.uniform1f(uU.u_dissT, 0.95);
      gl.uniform1f(uU.u_emit, emit);
      gl.uniform1f(uU.u_emitBand, 0.11);
      gl.uniform1f(uU.u_puffX, puffX);
      gl.uniform1f(uU.u_puffY, puffY);
      gl.uniform1f(uU.u_puffAmt, audio.kickPulse);
      gl.uniform1f(uU.u_puffR, 0.006);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [stateA, stateB] = [stateB, stateA];

      ctx.bindOutput();
      gl.useProgram(pDisplay);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, stateA.tex);
      gl.uniform1i(uD.u_state, 0);
      gl.uniform1f(uD.u_centroid, audio.centroid);
      gl.uniform1f(uD.u_beat, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
