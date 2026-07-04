// 13 LIFE — a Larger-than-Life cellular automaton, kept continuous (Lenia-style)
// rather than binary so it grows and dissolves smoothly instead of flickering.
// Each step blurs a wide neighbourhood (radius ~4 texels) and nudges every cell's
// state toward "alive" when local density sits near a target and away otherwise.
// Kicks seed a fresh colony at a random spot; bass nudges the density target so the
// pattern breathes denser/sparser; level sets how many steps run per frame; the
// live palette hue follows the spectral centroid.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 320; // sim resolution (square)
const BLOBS = 70; // initial colonies (most random seeds die off before stabilising, so start with plenty)

// Pass 1: horizontal Gaussian-ish sum of the state field (radius 4 texels ~= the
// "larger than life" neighbourhood called for in the brief).
const HBLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state; uniform vec2 u_px;
in vec2 v_uv; out vec4 o;
void main(){
  float sum = 0.0, wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float w = exp(-float(i*i) / 8.0);
    sum += texture(u_state, v_uv + vec2(u_px.x*float(i), 0.0)).r * w;
    wsum += w;
  }
  o = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

// Pass 2: vertical half of the blur (completing the neighbourhood average m),
// then the continuous growth rule: cells drift toward "alive" when m sits near
// u_mu and decay otherwise. Kick injects a soft new colony on step 0 only.
const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_hblur; uniform sampler2D u_self; uniform vec2 u_px;
uniform float u_mu, u_sigma, u_dt, u_inject; uniform vec2 u_seed;
in vec2 v_uv; out vec4 o;
void main(){
  float sum = 0.0, wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float w = exp(-float(i*i) / 8.0);
    sum += texture(u_hblur, v_uv + vec2(0.0, u_px.y*float(i))).r * w;
    wsum += w;
  }
  float m = sum / wsum;
  float old = texture(u_self, v_uv).r;
  float g = 2.0*exp(-((m-u_mu)*(m-u_mu))/(2.0*u_sigma*u_sigma)) - 1.0;
  float next = old + u_dt * g;
  float d = distance(v_uv, u_seed);
  next += u_inject * smoothstep(0.07, 0.0, d);
  o = vec4(clamp(next, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_state; uniform vec2 u_res; uniform float u_time, u_centroid;
in vec2 v_uv; out vec4 o;
void main(){
  // cover-fit the square sim onto the screen
  vec2 uv = v_uv;
  float ar = u_res.x/u_res.y;
  if (ar > 1.0) uv = vec2((uv.x-0.5)/ar+0.5, uv.y); else uv = vec2(uv.x, (uv.y-0.5)*ar+0.5);

  float a = texture(u_state, uv).r;
  float edge = length(vec2(dFdx(a), dFdy(a))) * 30.0;
  float shaped = smoothstep(0.08, 0.55, a);

  float hue = 0.52 + u_centroid*0.55 + u_time*0.012;
  vec3 glow = palette(hue, vec3(0.55,0.5,0.5), vec3(0.45,0.5,0.5), vec3(1.0), vec3(0.0,0.33,0.67));

  vec3 bg = vec3(0.02, 0.017, 0.035); // never truly black, even in silence
  vec3 col = bg + glow * shaped;
  col += vec3(0.85,0.95,1.0) * edge * shaped * 0.5; // bright colony membranes
  vec2 dd = v_uv - 0.5; col *= 1.0 - dot(dd,dd)*0.55;
  o = vec4(pow(max(col, 0.0), vec3(0.9)), 1.0);
}`;

export function createLife(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const hProg = program(gl, FULLSCREEN_VS, HBLUR_FS);
  const vProg = program(gl, FULLSCREEN_VS, UPDATE_FS);
  const dispProg = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uH: Uniforms = uniforms(gl, hProg);
  const uV: Uniforms = uniforms(gl, vProg);
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
  const texH = texture(gl, N, N, opts);
  let fboA = framebuffer(gl, texA);
  let fboB = framebuffer(gl, texB);
  const fboH = framebuffer(gl, texH);

  function seed(): void {
    const data = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) data[i * 4 + 3] = 1;
    for (let s = 0; s < BLOBS; s++) {
      const cx = (Math.random() * N) | 0,
        cy = (Math.random() * N) | 0,
        r = 5 + Math.random() * 9;
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++) {
          const px = (cx + x + N) % N,
            py = (cy + y + N) % N;
          if (x * x + y * y < r * r) data[(py * N + px) * 4] = 0.9;
        }
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
      const mu = 0.16 + audio.bass * 0.05; // density target, nudged by bass
      const sigma = 0.032;
      const steps = 1 + Math.round(Math.min(1, Math.max(0, audio.level)) * 2); // 1..3
      const inject = audio.kick ? 0.9 : 0;
      const sx = Math.random(),
        sy = Math.random();

      gl.disable(gl.BLEND);
      gl.bindVertexArray(tri);
      for (let s = 0; s < steps; s++) {
        gl.useProgram(hProg);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboH);
        gl.viewport(0, 0, N, N);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texA);
        gl.uniform1i(uH.u_state, 0);
        gl.uniform2f(uH.u_px, 1 / N, 1 / N);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.useProgram(vProg);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.viewport(0, 0, N, N);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texH);
        gl.uniform1i(uV.u_hblur, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, texA);
        gl.uniform1i(uV.u_self, 1);
        gl.uniform2f(uV.u_px, 1 / N, 1 / N);
        gl.uniform1f(uV.u_mu, mu);
        gl.uniform1f(uV.u_sigma, sigma);
        gl.uniform1f(uV.u_dt, 0.12);
        gl.uniform1f(uV.u_inject, s === 0 ? inject : 0);
        gl.uniform2f(uV.u_seed, sx, sy);
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
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
