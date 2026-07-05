// 53 SCOPE_XY — a stereo-style X-Y Lissajous scope. Where 52 OSCILLOSCOPE wraps the
// waveform around a polar phosphor ring, this plots it in true X-Y: x = wave[i],
// y = a delayed tap of the same buffer (a poor-man's stereo pair from one channel).
// The delay is a subtle audio-reactive fraction, so the curve breathes open and
// closed with the bass instead of ever being a fixed Lissajous figure. A faint
// procedural carrier keeps the trace open (never a single collapsed dot) when the
// input is quiet. Thickness/bloom technique lifted straight from oscilloscope.ts:
// additive blending + a strong per-vertex intensity multiplier through HDR bloom,
// no geometry thickening needed.

import { program, uniforms, texture } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import { WAVE_SIZE } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_wave;
uniform float u_aspect, u_delay, u_amp, u_idleAmp, u_idleFreq, u_time, u_centroid, u_glow;
out vec3 v_col;
void main(){
  int i = gl_VertexID;
  float n = float(${WAVE_SIZE});
  float fi = float(i) / n;
  float fd = fract(fi + u_delay / n);

  float wx = texture(u_wave, vec2(fi, 0.5)).r;
  float wy = texture(u_wave, vec2(fd, 0.5)).r;

  // Idle carrier: a small always-on rotating figure so the scope never collapses
  // to a single point when the input is silent (BLACK / LOW_VIS guard).
  float ph  = 6.28318 * u_idleFreq * fi + u_time * 0.16;
  float phd = 6.28318 * u_idleFreq * fd + u_time * 0.16;
  float ix = wx + u_idleAmp * sin(ph);
  float iy = wy + u_idleAmp * sin(phd);

  vec2 p = vec2(ix, iy) * u_amp;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);

  float m = clamp(length(vec2(wx, wy)), 0.0, 1.4);
  vec3 col = palette(0.33 + u_centroid * 0.4 + m * 0.25,
    vec3(0.4, 0.6, 0.5), vec3(0.3, 0.4, 0.3), vec3(1.0), vec3(0.0, 0.3, 0.6));
  v_col = col * (0.65 + m * 1.8 + u_glow);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Faint graticule behind the trace (CRT XY-scope divisions + center cross).
const BG_FS = `#version 300 es
precision highp float;
uniform vec2 u_res; in vec2 v_uv; out vec4 o;
void main(){
  vec2 p = v_uv * 2.0 - 1.0;
  vec2 g = abs(fract(p * 4.0) - 0.5);
  float grid = smoothstep(0.46, 0.5, max(g.x, g.y));
  float cross = smoothstep(0.006, 0.0, min(abs(p.x), abs(p.y)));
  vec3 c = vec3(0.015, 0.045, 0.035) + vec3(0.0, 0.05, 0.035) * grid + vec3(0.0, 0.09, 0.06) * cross;
  o = vec4(c, 1.0);
}`;

const FULLSCREEN_VS = `#version 300 es
layout(location=0) in vec2 a; out vec2 v_uv;
void main(){ v_uv=a*0.5+0.5; gl_Position=vec4(a,0.,1.); }`;

export function createScopeXY(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const bg = program(gl, FULLSCREEN_VS, BG_FS);
  const u: Uniforms = uniforms(gl, prog);
  const uB: Uniforms = uniforms(gl, bg);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  const vao = gl.createVertexArray()!;
  const waveTex = texture(gl, WAVE_SIZE, 1, {
    internal: gl.R32F,
    format: gl.RED,
    type: gl.FLOAT,
    filter: gl.LINEAR,
    wrap: gl.REPEAT,
  });
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, _dt, audio: AudioEngine) {
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WAVE_SIZE, 1, gl.RED, gl.FLOAT, audio.wave);

      post.bind();
      gl.disable(gl.BLEND);
      // graticule background
      gl.useProgram(bg);
      gl.bindVertexArray(tri);
      gl.uniform2f(uB.u_res, rw, rh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Lissajous trace
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.uniform1i(u.u_wave, 0);
      gl.uniform1f(u.u_aspect, rw / rh);
      // bass opens/closes the delayed tap (Lissajous bulge), never below a base offset
      gl.uniform1f(u.u_delay, 22.0 + audio.bass * 42.0);
      gl.uniform1f(u.u_amp, 0.66 + audio.level * 0.16);
      gl.uniform1f(u.u_idleAmp, 0.17);
      gl.uniform1f(u.u_idleFreq, 3.0);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_glow, audio.kickPulse * 0.9);
      gl.drawArrays(gl.LINE_STRIP, 0, WAVE_SIZE);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.15 + audio.level * 0.55 + audio.kickPulse * 0.35,
        exposure: 1.1,
        aberration: 0.0008,
        grain: 0.05,
        vignette: 1.25,
        flash: audio.kickPulse * 0.25,
        threshold: 0.4,
        time: t,
      });
    },
  };
}
