// 35 DOMAINWARP — Inigo-Quilez-style iterated fBm domain warping. Two rounds of
// warp fold a marble / liquid-nebula field through itself so patterns never repeat;
// cosine-palette colouring with secondary hue from warp vectors reveals swirl structure.
// level speeds the flow; bass deepens turbulence; change shifts the field origin;
// centroid shifts palette hue; high sharpens filaments; kickPulse blooms brightness.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res, u_shift;
uniform float u_time, u_speed, u_warp, u_centroid, u_high, u_beat;
out vec4 o;

// fBm: 5-octave sum of simplex noise, z-animated as time.
// Rotation matrix folds each octave into a new orientation (IQ pattern).
float fbm(vec2 p, float t){
  float a=0.5, f=0.0;
  mat2 R=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<5;i++){
    f+=a*snoise(vec3(p, t*0.15));
    p=R*p;
    a*=0.5;
  }
  return f;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_res.x/u_res.y, 1.0) * 3.0;
  float t = u_time * u_speed;
  p += u_shift;

  // IQ double-warp: q warps into r, r warps the final value v.
  vec2 q = vec2(fbm(p + vec2(0.0, 0.0), t),
                fbm(p + vec2(5.2, 1.3), t));
  vec2 r = vec2(fbm(p + u_warp*q + vec2(1.7, 9.2), t),
                fbm(p + u_warp*q + vec2(8.3, 2.8), t));
  float v = fbm(p + u_warp*r, t);

  // Remap v (-1..1 range) to 0..1 for colour.
  float vn = clamp(v*0.5 + 0.5, 0.0, 1.0);

  // Two palette samples; blend by secondary warp magnitude so swirl structure shows.
  float hue1 = vn + u_centroid * 0.35;
  float hue2 = hue1 + length(r) * 0.22 + 0.28;
  vec3 col1 = palette(hue1,
    vec3(0.5, 0.5, 0.5),
    vec3(0.5, 0.5, 0.5),
    vec3(1.0, 0.9, 0.8),
    vec3(0.0, 0.15, 0.3));
  vec3 col2 = palette(hue2,
    vec3(0.4, 0.3, 0.5),
    vec3(0.5, 0.4, 0.4),
    vec3(0.9, 1.0, 0.8),
    vec3(0.4, 0.25, 0.1));
  float blend = clamp(length(r) * 0.55, 0.0, 1.0);
  vec3 col = mix(col1, col2, blend);

  // Filament contrast: high audio sharpens the power curve; bright ridges where v peaks.
  float sharp = 1.4 + u_high * 4.0;
  float filament = pow(clamp(vn, 0.0, 1.0), sharp);
  col = mix(col * 0.35, col, filament) + vec3(filament * 0.45);

  // kickPulse brightness bloom.
  col *= 1.0 + u_beat * 0.75;

  // Vignette.
  vec2 d = uv - 0.5;
  col *= 1.0 - dot(d, d) * 0.55;

  // Gamma.
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.88)), 1.0);
}`;

export function createDomainwarp(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  // Accumulated field-origin shift; drifts faster on musical change.
  let sx = 0,
    sy = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // Drift direction is time-varying; magnitude scales with audio.change.
      const speed = audio.change * 0.22;
      sx += Math.sin(t * 0.11 + audio.novelty * 1.1) * speed * dt;
      sy += Math.cos(t * 0.09 + audio.novelty * 0.7) * speed * dt;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform2f(u.u_shift, sx, sy);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_speed, 0.4 + audio.level * 1.2);
      gl.uniform1f(u.u_warp, 0.8 + audio.bass * 1.8);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
