// 25 CLOUDS — volumetric clouds at altitude. A raymarched fBm density slab is lit by
// a single sun with Beer–Lambert shadowing; bass thickens the coverage, the centroid
// tints the sky and sun, and kicks flash lightning inside the cloud. Cinematic and
// atmospheric. Fragment raymarch through HDR PostFX.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_z, u_cover, u_centroid, u_flash;
out vec4 o;

float fbm(vec3 p){
  float a=0.5, s=0.0;
  for(int i=0;i<5;i++){ s += a*snoise(p); p = p*2.02 + 1.7; a *= 0.5; }
  return s;
}
float density(vec3 p){
  float base = fbm(p*0.6 + vec3(0.0, 0.0, u_z));
  float thr = 0.55 - u_cover;        // higher coverage -> lower threshold -> more cloud
  return clamp((base - thr) * 1.7, 0.0, 1.0);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  vec3 ro = vec3(0.0, 0.0, 0.0);
  vec3 rd = normalize(vec3(uv, 1.2));
  vec3 sun = normalize(vec3(0.6, 0.5, 0.4));

  vec3 skyTop = palette(0.6+u_centroid*0.3, vec3(0.4,0.45,0.55), vec3(0.3,0.3,0.35), vec3(1.0), vec3(0.1,0.2,0.4));
  vec3 sky = mix(vec3(0.5,0.6,0.75), skyTop*0.8, smoothstep(-0.1,0.6,rd.y));
  sky += vec3(1.0,0.9,0.7)*pow(max(dot(rd,sun),0.0), 8.0)*0.5;

  // march a slab between two planes
  float t = 1.0;
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for(int i=0;i<48;i++){
    vec3 p = ro + rd*t;
    if(p.y > 2.2 || trans < 0.02){ break; }
    float dn = density(p);
    if(dn > 0.01){
      // light: short march toward sun
      float ld = 0.0;
      for(int j=1;j<=4;j++){ ld += density(p + sun*float(j)*0.25); }
      float shade = exp(-ld*0.4);
      vec3 sunCol = palette(u_centroid*0.3, vec3(1.0,0.9,0.8), vec3(0.0,0.1,0.2), vec3(1.0), vec3(0.0,0.1,0.2));
      vec3 col = mix(vec3(0.25,0.28,0.34), sunCol, shade);
      col += u_flash * vec3(0.8,0.9,1.0) * dn * 3.0;        // lightning
      float a = dn*0.6;
      acc += trans * a * col;
      trans *= 1.0 - a;
    }
    t += 0.08 + t*0.01;
    if(t > 14.0) break;
  }
  vec3 col = sky*trans + acc;
  o = vec4(col, 1.0);
}`;

export function createClouds(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let z = 0;
  let flash = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      z += dt * (0.3 + audio.level * 1.2);
      flash *= Math.exp(-dt * 4);
      if (audio.kick) flash = Math.min(1, flash + 0.7);
      const cover = 0.0 + audio.bass * 0.5 + audio.level * 0.25;

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_z, z);
      gl.uniform1f(u.u_cover, cover);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_flash, flash);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.6 + audio.level * 0.4 + flash * 0.6,
        exposure: 1.05,
        aberration: 0.0006 + audio.change * 0.0015,
        grain: 0.035,
        vignette: 1.15,
        flash: flash * 0.4,
        threshold: 0.7,
        time: t,
      });
    },
  };
}
