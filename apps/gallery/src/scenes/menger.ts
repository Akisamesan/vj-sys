// 21 MENGER — Menger sponge raymarched with a folding distance estimator, slowly
// rotating with an orbiting camera; recursion detail and fold breathe with the music
// for an infinite-zoom feel. Fragment raymarch through HDR PostFX.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2  u_res;
uniform float u_time, u_angle, u_yaw, u_pitch, u_centroid, u_beat, u_level, u_bass, u_high;
out vec4 o;

float sdBox(vec3 p, vec3 b){ vec3 d=abs(p)-b; return length(max(d,0.0))+min(max(d.x,max(d.y,d.z)),0.0); }

vec3 rotY(vec3 p, float a){ float c=cos(a),s=sin(a); return vec3(c*p.x+s*p.z, p.y, -s*p.x+c*p.z); }
vec3 rotX(vec3 p, float a){ float c=cos(a),s=sin(a); return vec3(p.x, c*p.y-s*p.z, s*p.y+c*p.z); }

float mengerDE(vec3 p){
  // bass gently animates the fold offset for living recursion
  float fo = u_bass * 0.05;
  float d = sdBox(p, vec3(1.0));
  float s = 1.0;
  for(int m=0; m<5; m++){
    vec3 a = mod(p*s, 2.0+fo) - (1.0+fo*0.5);
    s *= 3.0;
    vec3 r = abs(1.0 - 3.0*abs(a));
    float c = (min(min(max(r.x,r.y), max(r.y,r.z)), max(r.z,r.x)) - 1.0) / s;
    d = max(d, c);
  }
  return d;
}

float scene(vec3 p){
  return mengerDE(rotX(rotY(p, u_yaw), u_pitch));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res) / u_res.y;

  // bass breathes the orbit inward (zoom toward sponge)
  float orbitR = 3.5 - u_bass * 0.55;
  vec3 ro = vec3(sin(u_angle)*orbitR, 0.45 + sin(u_time*0.11)*0.25, cos(u_angle)*orbitR);
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0.0,1.0,0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x*rt + uv.y*up);

  float t = 0.0; float hit = -1.0;
  for(int i=0; i<90; i++){
    float d = scene(ro + rd*t);
    if(d < 0.001){ hit = t; break; }
    t += d * 0.65;
    if(t > 12.0) break;
  }

  vec3 bg = vec3(0.01, 0.01, 0.02);
  vec3 col = bg;

  if(hit > 0.0){
    vec3 p = ro + rd*hit;

    // Normal via DE gradient
    vec2 e = vec2(0.001, 0.0);
    vec3 nrm = normalize(vec3(
      scene(p+e.xyy)-scene(p-e.xyy),
      scene(p+e.yxy)-scene(p-e.yxy),
      scene(p+e.yyx)-scene(p-e.yyx)
    ));

    // Orbit-trap-ish colour seed from sponge local space
    vec3 rp = rotX(rotY(p, u_yaw), u_pitch);
    float trap = fract(
      length(rp)*0.7
      + (sin(rp.x*2.1)+sin(rp.y*1.7))*0.25
      + u_centroid*0.35
      + u_time*0.012
    );

    vec3 base = palette(trap,
      vec3(0.5, 0.5, 0.5),
      vec3(0.5, 0.5, 0.5),
      vec3(1.0, 0.8, 0.6),
      vec3(0.0, 0.15, 0.4)
    );

    // Lambert (sun + fill)
    vec3 sun = normalize(vec3(0.6, 0.8, 0.3));
    float diff = max(dot(nrm, sun), 0.0);
    float fill = max(dot(nrm, normalize(vec3(-0.3,-0.2,-0.6))), 0.0) * 0.2;

    // Specular — tightness driven by u_high
    vec3 ref = reflect(-sun, nrm);
    float shininess = 8.0 + u_high * 40.0;
    float spec = pow(max(dot(ref, -rd), 0.0), shininess) * (0.2 + u_high * 0.5);

    col = base*(0.1 + diff*0.85 + fill) + vec3(0.85, 0.95, 1.0)*spec;

    // Kick flash: fresnel-like surface brightening
    float fres = pow(max(1.0 - dot(nrm, -rd), 0.0), 3.0);
    col += vec3(0.7, 0.85, 1.0) * u_beat * fres * 0.9;

    // Distance fog
    float fog = 1.0 - exp(-hit * 0.14);
    col = mix(col, bg, fog * 0.65);
  }

  col *= 1.0 + u_beat*0.15 + u_level*0.08;
  o = vec4(col, 1.0);
}`;

export function createMenger(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri);
  let rw = 1,
    rh = 1;
  let angle = 0;
  let yaw = 0;
  let pitch = 0;
  let bassPulse = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const speed = 0.08 + audio.level * 0.25;
      angle += dt * speed;
      yaw += dt * (0.15 + audio.level * 0.2);
      pitch += dt * (0.07 + audio.level * 0.1);
      bassPulse += (audio.bass - bassPulse) * (1 - Math.exp(-dt * 2.5));

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_pitch, pitch);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_bass, bassPulse);
      gl.uniform1f(u.u_high, audio.high);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.7 + audio.level * 0.4,
        exposure: 1.1 + audio.kickPulse * 0.2,
        aberration: 0.0008 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.35,
        threshold: 0.6,
        time: t,
      });
    },
  };
}
