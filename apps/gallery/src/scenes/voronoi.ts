// 32 VORONOI — an animated cellular shatter. Feature points drift through a grid;
// each cell takes a flat colour with a glowing edge, like cracked stained glass.
// Level drives the drift, highs sharpen the edges, and kicks crack the whole field
// (cells jolt apart and the hue rotates). Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_scale, u_drift, u_edge, u_crack, u_hue, u_beat;
out vec4 o;

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  uv *= u_scale;
  vec2 g = floor(uv);
  vec2 f = fract(uv);
  float d1 = 8.0, d2 = 8.0;
  vec2 cellId = vec2(0.0);
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 cell = vec2(float(i), float(j));
    vec2 rnd = hash31(dot(g+cell, vec2(1.0,57.0))).xy;
    // animated point + beat crack pushes points outward from cell center
    vec2 p = cell + 0.5 + 0.45*sin(u_time*u_drift + 6.2831*rnd);
    p += (rnd-0.5) * u_crack;
    float d = length(p - f);
    if(d < d1){ d2 = d1; d1 = d; cellId = g+cell; }
    else if(d < d2){ d2 = d; }
  }
  float border = smoothstep(0.0, u_edge, d2 - d1);   // distance to cell boundary
  vec3 rc = hash31(dot(cellId, vec2(12.9, 7.1)) + 1.0);
  float hue = rc.x + u_hue;
  vec3 col = palette(hue, vec3(0.5), vec3(0.5), vec3(1.0,1.0,1.0), vec3(0.0,0.33,0.66));
  col *= 0.25 + rc.y*0.5;
  // glowing edges
  vec3 edge = vec3(0.8,0.95,1.0) * (1.0 - border) * (0.6 + u_beat);
  col = col * (0.3 + border*0.9) + edge;
  col *= 1.0 + u_beat*0.3;
  vec2 dd = (gl_FragCoord.xy-0.5*u_res)/u_res.y; col *= 1.0 - dot(dd,dd)*0.15;
  o = vec4(pow(max(col,0.0), vec3(0.85)), 1.0);
}`;

export function createVoronoi(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let crack = 0;
  let hue = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      crack += ((audio.kick ? 0.5 : 0) - crack) * (1 - Math.exp(-dt * (audio.kick ? 40 : 6)));
      hue += dt * (0.02 + audio.change * 0.2) + (audio.kick ? 0.05 : 0);
      const scale = 5.0 + Math.sin(t * 0.1) * 1.5 + audio.bass * 2.0;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_drift, 0.4 + audio.level * 1.6);
      gl.uniform1f(u.u_edge, 0.06 + audio.high * 0.14);
      gl.uniform1f(u.u_crack, crack);
      gl.uniform1f(u.u_hue, hue);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
