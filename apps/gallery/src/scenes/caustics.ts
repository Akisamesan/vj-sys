// 36 CAUSTICS — light dancing on a pool floor. Layered animated cellular noise forms a
// bright caustic web that ripples and breathes; level speeds the flow, bass deepens the
// water colour, highs sharpen the filaments and kicks send a ripple through. Pure
// fragment (an iterated voronoi-distance caustic).

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_speed, u_sharp, u_centroid, u_bass, u_beat;
out vec4 o;

// caustic web: domain-warped noise, bright where two ridges cross (robust, no Inf)
float caustic(vec2 p){
  float t = u_time*u_speed;
  vec2 q = p + 0.7*vec2(snoise(vec3(p*1.2, t*0.2)), snoise(vec3(p*1.2+11.0, t*0.2)));
  float n1 = snoise(vec3(q*1.6, t*0.3));
  float n2 = snoise(vec3(q*3.1+5.0, -t*0.27));
  float web = (1.0 - abs(n1)) * (1.0 - abs(n2));
  return pow(clamp(web, 0.0, 1.0), 4.0 + u_sharp*5.0);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_res.x/u_res.y, 1.0) * 6.0;
  float c = caustic(p);
  c += caustic(p*1.4 + 10.0) * 0.5;            // second layer
  c *= 1.0 + u_beat*0.6;

  vec3 water = palette(0.55 + u_centroid*0.2, vec3(0.1,0.3,0.4), vec3(0.1,0.2,0.3), vec3(1.0), vec3(0.2,0.4,0.5));
  vec3 col = water * (0.15 + u_bass*0.2);
  col += vec3(0.7,0.95,1.0) * c * 1.4;
  col += water * c * 0.4;
  // depth shimmer + vignette
  col *= 0.9 + 0.1*sin(uv.y*40.0 + u_time);
  vec2 d=uv-0.5; col *= 1.0 - dot(d,d)*0.5;
  o = vec4(pow(max(col,0.0), vec3(0.85)), 1.0);
}`;

export function createCaustics(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_speed, 0.6 + audio.level * 1.4);
      gl.uniform1f(u.u_sharp, audio.high * 0.8);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
