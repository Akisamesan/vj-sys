// 89 SPECTROGRAM — a scrolling waterfall of the live spectrum. Each frame writes the
// newest column on the right and the whole history scrolls left, so you literally see
// the music's recent past as a heatmap. The centroid shifts the colour map and kicks
// brighten the leading edge. Feedback ping-pong scroll.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const COLS = 600;
const ROWS = 300;

const SCROLL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_prev; uniform vec2 u_px; uniform float u_spectrum[${BAND_COUNT}];
in vec2 v_uv; out vec4 o;
float specAt(float y){
  float f = y*float(${BAND_COUNT - 1});
  int i0 = int(floor(f)); int i1 = min(i0+1, ${BAND_COUNT - 1});
  return mix(u_spectrum[i0], u_spectrum[i1], fract(f));
}
void main(){
  if(v_uv.x < 1.0 - u_px.x){
    o = texture(u_prev, v_uv + vec2(u_px.x, 0.0));   // scroll left
  } else {
    o = vec4(specAt(v_uv.y), 0.0, 0.0, 1.0);          // newest column
  }
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_hist; uniform vec2 u_res; uniform float u_centroid, u_beat;
in vec2 v_uv; out vec4 o;
void main(){
  float e = texture(u_hist, v_uv).r;
  float v = pow(clamp(e,0.0,1.2), 0.8);
  // heatmap palette
  vec3 col = palette(0.15 + v*0.7 + u_centroid*0.2, vec3(0.5,0.4,0.4), vec3(0.5,0.5,0.5), vec3(1.0,1.0,1.0), vec3(0.0,0.15,0.3));
  col *= smoothstep(0.0, 0.15, v);
  // leading edge glow on the right
  col += vec3(0.7,0.9,1.0) * smoothstep(0.985,1.0,v_uv.x) * u_beat;
  // subtle grid
  col *= 0.92 + 0.08*step(0.5, fract(v_uv.y*float(${BAND_COUNT})));
  vec2 d=v_uv-0.5; col*=1.0-dot(d,d)*0.4;
  o = vec4(pow(col, vec3(0.85)), 1.0);
}`;

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export function createSpectrogram(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const scroll = program(gl, FULLSCREEN_VS, SCROLL_FS);
  const disp = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uS: Uniforms = uniforms(gl, scroll);
  const uD: Uniforms = uniforms(gl, disp);
  const spec = new Float32Array(BAND_COUNT);
  let rw = 1,
    rh = 1;

  function rt(): RT {
    const tex = texture(gl, COLS, ROWS, {
      internal: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
      filter: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    });
    return { tex, fbo: framebuffer(gl, tex) };
  }
  let a = rt();
  let b = rt();
  for (const r of [a, b]) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.3, audio.spectrum[i] * 1.7);
      gl.disable(gl.BLEND);

      // scroll a -> b
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
      gl.viewport(0, 0, COLS, ROWS);
      gl.useProgram(scroll);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform1i(uS.u_prev, 0);
      gl.uniform2f(uS.u_px, 1 / COLS, 1 / ROWS);
      gl.uniform1fv(uS.u_spectrum, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [a, b] = [b, a];

      // display
      ctx.bindOutput();
      gl.useProgram(disp);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform1i(uD.u_hist, 0);
      gl.uniform2f(uD.u_res, rw, rh);
      gl.uniform1f(uD.u_centroid, audio.centroid);
      gl.uniform1f(uD.u_beat, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      void t;
    },
  };
}
