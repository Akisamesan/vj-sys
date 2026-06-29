// 30 MANDELBROT — a living Julia set. The Julia constant c traces an audio-driven path
// so the fractal continuously morphs between dust, spirals and dendrites; level drives
// a slow breathing zoom, the centroid rotates the palette and kicks bump the detail.
// Smooth (continuous) iteration colouring. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform vec2 u_c; uniform float u_zoom, u_time, u_centroid, u_beat, u_iter;
out vec4 o;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  uv *= u_zoom;
  // gentle rotation
  float a = u_time*0.03;
  uv = mat2(cos(a),-sin(a),sin(a),cos(a)) * uv;
  vec2 z = uv;
  float m = 0.0;
  float it = 0.0;
  const float MAX = 220.0;
  for(float i=0.0;i<MAX;i+=1.0){
    if(i > u_iter) break;
    z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + u_c;
    m = dot(z,z);
    if(m > 64.0){ it = i; break; }
    it = i;
  }
  // smooth iteration count
  float sn = it - log2(log2(max(m,1.0001))) + 4.0;
  float v = sn / u_iter;
  vec3 col;
  if(m <= 64.0){
    col = vec3(0.02,0.02,0.05);   // inside
  } else {
    col = palette(v*1.4 + u_centroid*0.4 + u_time*0.02, vec3(0.5),vec3(0.5),vec3(1.0,1.0,1.0),vec3(0.0,0.33,0.66));
    col *= 0.3 + 0.9*v;
    col += vec3(0.6,0.8,1.0)*smoothstep(0.0,0.04,v)*u_beat*0.5;
  }
  vec2 d=(gl_FragCoord.xy-0.5*u_res)/u_res.y; col*=1.0-dot(d,d)*0.15;
  o = vec4(pow(max(col,0.0),vec3(0.85)),1.0);
}`;

export function createMandelbrot(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let zoom = 1.4;
  let cx = -0.4,
    cy = 0.6;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // c traces a slow loop near the boundary, nudged by audio
      const tx = 0.7885 * Math.cos(t * 0.12 + audio.bass * 1.5);
      const ty = 0.7885 * Math.sin(t * 0.1 + audio.mid * 1.5);
      cx += (tx - cx) * (1 - Math.exp(-dt * 1.5));
      cy += (ty - cy) * (1 - Math.exp(-dt * 1.5));
      const targetZoom = 1.5 - audio.level * 0.6 + Math.sin(t * 0.07) * 0.4;
      zoom += (targetZoom - zoom) * (1 - Math.exp(-dt * 1.2));

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, rw, rh);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform2f(u.u_c, cx, cy);
      gl.uniform1f(u.u_zoom, zoom);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_iter, 120.0 + audio.high * 90.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
