// 03 MOIRE — a kaleidoscopic polar field: mirrored segments, interfering rings and
// a truchet-ish weave. Crisp, geometric, hypnotic. Bands drive segment count and
// rotation, bass zooms, kicks invert and flash. Pure fragment, no simulation.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_seg, u_rot, u_zoom, u_bass, u_high, u_beat, u_invert, u_centroid;
out vec4 o;

float ring(float r, float f, float ph){ return 0.5+0.5*cos(r*f - ph); }

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  uv *= u_zoom;
  float a = atan(uv.y, uv.x) + u_rot;
  float r = length(uv);
  // kaleidoscope fold
  float seg = u_seg;
  a = mod(a, 6.28318/seg);
  a = abs(a - 3.14159/seg);
  vec2 p = vec2(cos(a), sin(a)) * r;

  // interfering rings + angular weave
  float rings = ring(r, 26.0 + u_high*40.0, u_time*1.5);
  float weave = ring(p.x*18.0, 1.0, u_time) * ring(p.y*18.0, 1.0, -u_time*1.3);
  float n = snoise(vec3(p*3.0, u_time*0.2));
  float m = rings*0.6 + weave*0.5 + n*0.4;
  m = abs(fract(m*2.0)*2.0-1.0);              // moiré banding
  m = pow(m, 1.5 + u_bass*2.0);

  vec3 pa=vec3(0.5), pb=vec3(0.5);
  vec3 pc=vec3(1.0,0.8,0.6), pd=vec3(0.0,0.33,0.66)+u_centroid;
  vec3 col = palette(m + r*0.3 + u_time*0.03, pa, pb, pc, pd);
  col *= 0.35 + m*1.1;
  col += vec3(0.6,0.8,1.0) * smoothstep(0.9,1.0,m) * (0.5+u_high);
  col = mix(col, 1.0-col, u_invert);
  col *= 1.0 + u_beat*0.4;
  col *= 1.0 - r*0.35;                          // soft falloff
  o = vec4(pow(max(col,0.0), vec3(0.85)), 1.0);
}`;

export function createMoire(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let rot = 0;
  let seg = 6;
  let invert = 0;
  let lastInv = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      rot += dt * (0.1 + audio.bass * 0.8 + audio.change * 0.4);
      const targetSeg = 4 + Math.round(audio.mid * 10 + audio.centroid * 6) * 2;
      seg += (targetSeg - seg) * (1 - Math.exp(-dt * 2));
      if (audio.kick && t - lastInv > 0.4) {
        invert = invert > 0.5 ? 0 : 1;
        lastInv = t;
      }
      const zoom = 1.0 + 0.5 * Math.sin(t * 0.2) - audio.bass * 0.25;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_seg, seg);
      gl.uniform1f(u.u_rot, rot);
      gl.uniform1f(u.u_zoom, zoom);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_invert, invert);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
