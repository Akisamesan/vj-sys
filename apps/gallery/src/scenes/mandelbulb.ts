// 20 MANDELBULB — the classic 3D fractal, raymarched with a distance estimator. The
// power exponent breathes with the bass so the bulb blooms and folds, an orbiting
// camera circles it, the centroid drives the iridescent shading and kicks flash the
// surface. Fragment raymarch through HDR PostFX.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_power, u_angle, u_centroid, u_beat, u_level;
out vec4 o;

float de(vec3 p, out float trap){
  vec3 z = p;
  float dr = 1.0;
  float r = 0.0;
  trap = 1e10;
  for(int i=0;i<7;i++){
    r = length(z);
    if(r > 2.0) break;
    float theta = acos(clamp(z.z/r,-1.0,1.0));
    float phi = atan(z.y, z.x);
    dr = pow(r, u_power-1.0)*u_power*dr + 1.0;
    float zr = pow(r, u_power);
    theta *= u_power; phi *= u_power;
    z = zr*vec3(sin(theta)*cos(phi), sin(theta)*sin(phi), cos(theta)) + p;
    trap = min(trap, r);
  }
  return 0.5*log(r)*r/dr;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  float ca=cos(u_angle), sa=sin(u_angle);
  vec3 ro = vec3(sa*2.6, 0.4, ca*2.6);
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0,1,0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x*rt + uv.y*up);

  float t = 0.0; float trap = 0.0; float hit = -1.0;
  for(int i=0;i<90;i++){
    vec3 p = ro + rd*t;
    float d = de(p, trap);
    if(d < 0.0008){ hit = t; break; }
    t += d;
    if(t > 6.0) break;
  }

  vec3 col = vec3(0.02,0.02,0.04) + vec3(0.02,0.03,0.06)*(1.0-length(uv));
  if(hit > 0.0){
    vec3 p = ro + rd*hit;
    float tr;
    vec2 e = vec2(0.001,0.0);
    vec3 nrm = normalize(vec3(
      de(p+e.xyy,tr)-de(p-e.xyy,tr),
      de(p+e.yxy,tr)-de(p-e.yxy,tr),
      de(p+e.yyx,tr)-de(p-e.yyx,tr)));
    vec3 sun = normalize(vec3(0.6,0.7,0.4));
    float diff = clamp(dot(nrm,sun),0.0,1.0);
    float ao = 1.0 - float(0); // cheap
    vec3 base = palette(trap*1.5 + u_centroid*0.4 + u_time*0.02, vec3(0.5),vec3(0.5),vec3(1.0,0.9,0.8),vec3(0.0,0.2,0.45));
    col = base*(0.15 + diff*0.9) + base*pow(trap,2.0)*0.4;
    col += vec3(0.7,0.85,1.0)*u_beat*pow(clamp(dot(nrm,-rd),0.0,1.0),2.0)*0.6;
    float fog = 1.0-exp(-hit*0.3); col = mix(col, vec3(0.02,0.02,0.04), fog*0.5);
    col *= ao;
  }
  col *= 1.0 + u_beat*0.2 + u_level*0.1;
  o = vec4(col, 1.0);
}`;

export function createMandelbulb(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let angle = 0;
  let power = 8;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      angle += dt * (0.1 + audio.level * 0.3);
      power +=
        (6.0 + audio.bass * 6.0 + Math.sin(t * 0.2) * 1.5 - power) * (1 - Math.exp(-dt * 1.5));

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_power, power);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.7 + audio.level * 0.4,
        exposure: 1.15 + audio.kickPulse * 0.2,
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
