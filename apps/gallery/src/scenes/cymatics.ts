// 94 CYMATICS — a Chladni vibrating plate. Standing-wave modes (m,n) interfere; sand
// gathers on the nodal lines where the plate is still, drawing shifting symmetric
// figures. Bands drive the mode numbers so the pattern reconfigures with the music,
// kicks ring the plate brighter and the centroid tints the sand. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_m, u_n, u_m2, u_n2, u_centroid, u_beat;
out vec4 o;

float chladni(vec2 p, float m, float n){
  return cos(m*3.14159*p.x)*cos(n*3.14159*p.y) - cos(n*3.14159*p.x)*cos(m*3.14159*p.y);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  // square plate centered
  float ar = u_res.x/u_res.y;
  vec2 p = uv;
  if(ar>1.0) p.x = (uv.x-0.5)*ar+0.5;

  float w = chladni(p, u_m, u_n) + 0.6*chladni(p, u_m2, u_n2);
  float nodal = smoothstep(0.06, 0.0, abs(w));   // sand on nodal lines
  float sand = pow(nodal, 1.5);

  vec3 plate = vec3(0.03,0.03,0.05);
  vec3 sandCol = palette(0.1 + u_centroid*0.3 + abs(w)*0.2, vec3(0.6,0.55,0.45), vec3(0.3,0.3,0.3), vec3(1.0), vec3(0.0,0.1,0.2));
  vec3 col = mix(plate, sandCol, sand);
  col += sandCol * sand * (0.4 + u_beat*0.8);
  // antinode shimmer
  col += vec3(0.1,0.2,0.4) * smoothstep(0.8,1.0,abs(w)) * (0.2+u_beat);
  vec2 d=uv-0.5; col *= 1.0 - dot(d,d)*0.4;
  o = vec4(pow(max(col,0.0), vec3(0.85)), 1.0);
}`;

export function createCymatics(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let m = 3,
    n = 4,
    m2 = 5,
    n2 = 2;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // modes drift toward audio-driven targets (integer-ish for clean figures)
      const tm = 2 + Math.round(audio.bass * 8);
      const tn = 2 + Math.round(audio.mid * 9);
      const tm2 = 2 + Math.round(audio.high * 7);
      const tn2 = 2 + Math.round(audio.centroid * 8);
      const k = 1 - Math.exp(-dt * 1.5);
      m += (tm - m) * k;
      n += (tn - n) * k;
      m2 += (tm2 - m2) * k;
      n2 += (tn2 - n2) * k;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_m, m);
      gl.uniform1f(u.u_n, n);
      gl.uniform1f(u.u_m2, m2);
      gl.uniform1f(u.u_n2, n2);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
