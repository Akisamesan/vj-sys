// 52 OSCILLOSCOPE — a CRT vectorscope. The live audio waveform is wrapped into a glowing
// phosphor ring (radius = signal), so you watch the actual sound trace itself out;
// bass swells the ring, level brightens the beam and the centroid tints the phosphor.
// Waveform uploaded to a data texture and drawn as an additive line loop through bloom.

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
uniform sampler2D u_wave; uniform float u_aspect, u_base, u_amp, u_centroid;
out vec3 v_col;
void main(){
  int i = gl_VertexID;
  float n = float(${WAVE_SIZE});
  float w = texelFetch(u_wave, ivec2(i,0), 0).r;
  float a = float(i)/n * 6.28318;
  float r = u_base + w*u_amp;
  vec2 p = vec2(cos(a), sin(a)) * r;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  v_col = palette(0.33 + u_centroid*0.4 + abs(w)*0.3, vec3(0.4,0.6,0.5), vec3(0.3,0.4,0.3), vec3(1.0), vec3(0.0,0.3,0.6)) * (0.4 + abs(w)*2.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// faint grid + ghost behind the trace
const BG_FS = `#version 300 es
precision highp float;
uniform vec2 u_res; in vec2 v_uv; out vec4 o;
void main(){
  vec2 p = v_uv*2.0-1.0;
  float ring = smoothstep(0.004,0.0,abs(length(p)-0.5));
  float cross = smoothstep(0.003,0.0,min(abs(p.x),abs(p.y)));
  vec3 c = vec3(0.02,0.05,0.04) + vec3(0.0,0.12,0.08)*ring + vec3(0.0,0.06,0.04)*cross;
  o = vec4(c, 1.0);
}`;

const FULLSCREEN_VS = `#version 300 es
layout(location=0) in vec2 a; out vec2 v_uv;
void main(){ v_uv=a*0.5+0.5; gl_Position=vec4(a,0.,1.); }`;

export function createOscilloscope(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const bg = program(gl, FULLSCREEN_VS, BG_FS);
  const u: Uniforms = uniforms(gl, prog);
  const uB: Uniforms = uniforms(gl, bg);
  const post = new PostFX(gl, tri);
  const vao = gl.createVertexArray()!;
  const waveTex = texture(gl, WAVE_SIZE, 1, {
    internal: gl.R32F,
    format: gl.RED,
    type: gl.FLOAT,
    filter: gl.NEAREST,
    wrap: gl.CLAMP_TO_EDGE,
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
      // background grid
      gl.useProgram(bg);
      gl.bindVertexArray(tri);
      gl.uniform2f(uB.u_res, rw, rh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // trace
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.uniform1i(u.u_wave, 0);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_base, 0.45 + audio.bass * 0.18);
      gl.uniform1f(u.u_amp, 0.22 + audio.level * 0.3);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.drawArrays(gl.LINE_LOOP, 0, WAVE_SIZE);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.2 + audio.level * 0.6,
        exposure: 1.1,
        aberration: 0.0008,
        grain: 0.05,
        vignette: 1.25,
        flash: audio.kickPulse * 0.3,
        threshold: 0.4,
        time: t,
      });
    },
  };
}
