// 24 GYROID — camera flies forward through an endless TPMS gyroid lattice.
// Bass pumps cell density, level drives flight speed, highs thin the walls,
// centroid tints the iridescent palette, kicks flash the surface. Raymarch
// through HDR PostFX for bloom + aberration + vignette.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_fly, u_scale, u_thick, u_centroid, u_kick, u_level, u_high, u_sway;
out vec4 o;

float gyroid(vec3 p, float scale, float thick){
  p *= scale;
  return abs(dot(sin(p), cos(p.zxy))) / scale - thick;
}

float de(vec3 p){
  float g = gyroid(p, u_scale, u_thick);
  g = max(g, -gyroid(p, u_scale*2.03, u_thick*0.5) - 0.03);
  return g * 0.6;
}

vec3 calcNormal(vec3 p){
  vec2 e = vec2(0.002, 0.0);
  return normalize(vec3(
    de(p+e.xyy)-de(p-e.xyy),
    de(p+e.yxy)-de(p-e.yxy),
    de(p+e.yyx)-de(p-e.yyx)));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;

  // forward-flying camera with gentle sinusoidal sway
  vec3 ro = vec3(sin(u_sway)*0.3, cos(u_sway*0.71)*0.2, u_fly);
  vec3 fw = normalize(vec3(sin(u_sway)*0.08, cos(u_sway*0.71)*0.05, 1.0));
  vec3 rt = normalize(cross(vec3(0.0,1.0,0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x*rt + uv.y*up);

  float t = 0.001;
  float hit = -1.0;
  for(int i=0;i<90;i++){
    vec3 p = ro + rd*t;
    float d = de(p);
    if(d < 0.0006){ hit = t; break; }
    t += max(d, 0.001);
    if(t > 12.0) break;
  }

  // background: deep dark with slight blue tint
  vec3 col = vec3(0.01, 0.01, 0.03);

  if(hit > 0.0){
    vec3 p = ro + rd*hit;
    vec3 nrm = calcNormal(p);

    // iridescent palette seeded by world depth + centroid + slow drift
    float hue = p.z*0.1 + u_centroid*1.2 + u_time*0.015;
    vec3 base = palette(hue,
      vec3(0.5,0.5,0.5),
      vec3(0.5,0.5,0.5),
      vec3(1.0,0.9,0.8),
      vec3(0.05,0.25,0.55));

    vec3 sun = normalize(vec3(0.5, 0.7, -0.3));
    float diff = clamp(dot(nrm, sun), 0.0, 1.0);
    float fill = clamp(dot(nrm, -sun)*0.3 + 0.3, 0.0, 1.0);
    float fres = pow(clamp(1.0 - dot(nrm, -rd), 0.0, 1.0), 3.0);

    col = base * (0.12 + diff*0.75 + fill*0.15);
    col += base * fres * (0.5 + u_high*0.6);         // iridescent rim brightens on highs
    col += vec3(0.8,0.9,1.0) * u_kick * fres * 0.9;  // kick flashes glassy rim

    // distance fog fades to deep background
    float fog = 1.0 - exp(-hit * 0.08);
    col = mix(col, vec3(0.01,0.01,0.03), fog);
  }

  col *= 1.0 + u_level*0.15 + u_kick*0.2;
  o = vec4(col, 1.0);
}`;

export function createGyroid(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let fly = 0;
  let sway = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // level drives fly speed; accumulate forward travel like tunnel.ts
      const speed = 0.3 + audio.level * 1.8;
      fly += dt * speed;
      sway += dt * 0.22;

      // bass → scale 1.4..3.0 (denser lattice on bass punch)
      const scale = 1.4 + audio.bass * 1.6;
      // high → thick 0.08..0.26 (sharper, thinner walls on highs; clamped safe)
      const thick = Math.max(0.08, 0.26 - audio.high * 0.18);

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_fly, fly);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_thick, thick);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_sway, sway);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.9 + audio.level * 0.5,
        exposure: 1.1 + audio.kickPulse * 0.2,
        aberration: 0.0008 + audio.change * 0.003,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.45,
        threshold: 0.6,
        time: t,
      });
    },
  };
}
