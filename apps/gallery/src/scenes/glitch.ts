// 51 GLITCH — a datamosh feedback field. The previous frame is fed back with block
// displacement and channel shift, while spectrum bars inject fresh colour. Snares and
// kicks tear the image into shifted blocks, split the channels and drop scanlines.
// Feedback ping-pong gives the smeared, decaying datamosh look.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_prev; uniform vec2 u_res;
uniform float u_time, u_glitch, u_decay, u_centroid, u_beat, u_shift;
uniform float u_spectrum[${BAND_COUNT}];
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;

  // block displacement of the feedback
  float blocks = 24.0;
  vec2 b = floor(uv*blocks);
  float r = hash11(b.x*7.0 + b.y*13.0 + floor(u_time*8.0));
  float on = step(1.0 - u_glitch, r);
  vec2 disp = vec2((hash11(b.y+floor(u_time*10.0))-0.5)*0.3, 0.0) * on;
  vec2 puv = uv + disp;

  // channel-split sample of previous frame
  float s = u_shift*(0.4+u_beat);
  vec3 prev;
  prev.r = texture(u_prev, puv + vec2(s,0)).r;
  prev.g = texture(u_prev, puv).g;
  prev.b = texture(u_prev, puv - vec2(s,0)).b;
  prev *= u_decay;

  // inject spectrum bars from the bottom
  float col = uv.x;
  int band = int(col*float(${BAND_COUNT}));
  float e = u_spectrum[clamp(band,0,${BAND_COUNT - 1})];
  float bar = step(uv.y, e*0.9) * step(0.0, e-0.02);
  vec3 barCol = palette(col*0.8 + u_centroid*0.4 + u_time*0.05, vec3(0.5),vec3(0.5),vec3(1.0),vec3(0.0,0.33,0.66));
  vec3 src = barCol * bar * 0.6;

  vec3 c = prev + src;
  c = clamp(c, 0.0, 1.5);

  // occasional full-block invert + scanlines
  if(on > 0.5 && r > 1.0 - u_glitch*0.4) c = 1.0 - c;
  c *= 0.85 + 0.15*sin(uv.y*u_res.y*1.5);

  o = vec4(c, 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src; in vec2 v_uv; out vec4 o;
void main(){ o = texture(u_src, v_uv); }`;

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export function createGlitch(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const copy = program(gl, FULLSCREEN_VS, COPY_FS);
  const u: Uniforms = uniforms(gl, prog);
  const uC: Uniforms = uniforms(gl, copy);
  const spec = new Float32Array(BAND_COUNT);
  let rw = 1,
    rh = 1;
  let a: RT, b: RT;

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

  let glitch = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      a = rt(w, h);
      b = rt(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.2, audio.spectrum[i] * 1.6);
      const target = (audio.kick ? 0.7 : 0) + (audio.snare ? 0.5 : 0) + audio.change * 0.2;
      glitch += (target - glitch) * (1 - Math.exp(-dt * (target > glitch ? 30 : 4)));

      gl.disable(gl.BLEND);
      // render feedback into b
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
      gl.viewport(0, 0, rw, rh);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform1i(u.u_prev, 0);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_glitch, Math.min(0.9, glitch));
      gl.uniform1f(u.u_decay, 0.92 + audio.level * 0.05);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_shift, 0.002 + glitch * 0.02);
      gl.uniform1fv(u.u_spectrum, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // copy b -> screen
      ctx.bindOutput();
      gl.useProgram(copy);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.uniform1i(uC.u_src, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      [a, b] = [b, a];
    },
  };
}
