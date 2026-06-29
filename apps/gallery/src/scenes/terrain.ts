// 22 TERRAIN — a low flight over endless ridges. A raymarched fBm heightfield scrolls
// toward the camera; bass lifts the mountains, the spectrum ripples their amplitude,
// the centroid shifts the sky/sun palette and kicks pulse a glow along the ridgelines.
// Cinematic vista. Fragment raymarch through HDR PostFX.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_z, u_amp, u_centroid, u_beat, u_glow;
out vec4 o;

float fbm(vec2 p){
  float a = 0.5, s = 0.0;
  for(int i=0;i<5;i++){ s += a*snoise(vec3(p, 0.0)); p *= 2.03; a *= 0.5; }
  return s;
}
float height(vec2 p){
  return (fbm(p*0.25) + 0.5*fbm(p*0.5+3.1)) * u_amp;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  vec3 ro = vec3(0.0, 2.6, u_z);
  vec3 rd = normalize(vec3(uv.x, uv.y*0.7 - 0.18, 1.0));

  float t = 0.4;
  float hit = -1.0;
  for(int i=0;i<110;i++){
    vec3 p = ro + rd*t;
    float h = height(p.xz);
    float d = p.y - h;
    if(d < 0.02){ hit = t; break; }
    t += max(0.04, d*0.4);
    if(t > 60.0) break;
  }

  vec3 sky = mix(vec3(0.02,0.03,0.06), palette(0.6+u_centroid*0.3, vec3(0.5),vec3(0.5),vec3(1.0),vec3(0.1,0.2,0.4))*0.5,
                 smoothstep(-0.2,0.5,rd.y));
  vec3 col = sky;

  if(hit > 0.0){
    vec3 p = ro + rd*hit;
    vec2 e = vec2(0.06, 0.0);
    float hL = height(p.xz - e.xy), hR = height(p.xz + e.xy);
    float hD = height(p.xz - e.yx), hU = height(p.xz + e.yx);
    vec3 n = normalize(vec3(hL-hR, 2.0*e.x, hD-hU));
    vec3 sun = normalize(vec3(0.5, 0.7, -0.4));
    float diff = clamp(dot(n, sun), 0.0, 1.0);
    float alt = clamp(p.y*0.25+0.3, 0.0, 1.0);
    vec3 base = palette(alt*0.5 + u_centroid*0.3, vec3(0.5,0.45,0.4), vec3(0.45,0.4,0.4), vec3(1.0,0.9,0.8), vec3(0.1,0.25,0.45));
    col = base * (0.18 + diff*0.9);
    // glowing ridgelines on the beat
    float ridge = smoothstep(0.6, 1.0, 1.0 - abs(n.y));
    col += palette(u_centroid, vec3(0.5),vec3(0.5),vec3(1.0),vec3(0.0,0.33,0.66)) * ridge * u_glow * 1.5;
    float fog = 1.0 - exp(-hit*0.05);
    col = mix(col, sky, fog);
  }
  col *= 1.0 + u_beat*0.2;
  o = vec4(col, 1.0);
}`;

export function createTerrain(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri);
  let rw = 1,
    rh = 1;
  let z = 0;
  let amp = 1.6;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      z += dt * (2.0 + audio.bass * 5.0 + audio.level * 2.0);
      amp += (1.4 + audio.bass * 2.2 + audio.level * 0.8 - amp) * (1 - Math.exp(-dt * 2));

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_z, z);
      gl.uniform1f(u.u_amp, amp);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_glow, 0.15 + audio.kickPulse * 0.8);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.7 + audio.level * 0.4,
        exposure: 1.1 + audio.kickPulse * 0.2,
        aberration: 0.0008 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.3,
        threshold: 0.65,
        time: t,
      });
    },
  };
}
