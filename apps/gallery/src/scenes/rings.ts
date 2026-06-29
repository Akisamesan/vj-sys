// 95 RINGS — concentric beat rings + a radial equaliser. The spectrum wraps around the
// circle (angle → frequency) so loud bands bulge outward, steady ripple rings breathe
// with the music, and every kick launches a bright shockwave ring that expands to the
// edge. Centroid drives the hue. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const MAXR = 8;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_centroid, u_bass, u_high;
uniform float u_spectrum[${BAND_COUNT}];
uniform float u_rings[${MAXR}];
out vec4 o;
void main(){
  vec2 p = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  float r = length(p);
  float ang = atan(p.y, p.x);
  float bf = (ang/6.28318 + 0.5) * float(${BAND_COUNT});
  int bi = int(bf) % ${BAND_COUNT};
  float e = u_spectrum[bi];

  // radial equaliser: bulge radius per band
  float edge = 0.35 + e*0.35;
  float eq = smoothstep(edge+0.02, edge, r) * smoothstep(0.0, 0.05, r);

  // breathing ripple rings
  float ripple = 0.5 + 0.5*sin(r*40.0 - u_time*3.0 + e*6.0);
  ripple *= smoothstep(0.9, 0.2, r);

  // expanding kick shockwaves
  float shock = 0.0;
  for(int i=0;i<${MAXR};i++){
    float R = u_rings[i];
    if(R > 0.0) shock += exp(-pow((r-R)*16.0,2.0)) * (1.0 - R*0.7);
  }

  float v = eq*0.8 + ripple*(0.2+e*0.6);
  vec3 col = palette(bf/float(${BAND_COUNT}) + u_centroid*0.3 + u_time*0.02, vec3(0.5),vec3(0.5),vec3(1.0),vec3(0.0,0.33,0.66));
  col *= 0.2 + v*1.3;
  col += vec3(0.8,0.95,1.0) * shock * 1.5;
  col += vec3(1.0) * smoothstep(0.04,0.0,r) * (0.5+u_bass);   // core
  col *= 1.0 - r*0.3;
  o = vec4(pow(max(col,0.0), vec3(0.85)), 1.0);
}`;

export function createRings(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const spec = new Float32Array(BAND_COUNT);
  const rings = new Float32Array(MAXR); // radius of each active shockwave (0 = inactive)
  let idx = 0;
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.3, audio.spectrum[i] * 1.7);
      if (audio.kick) {
        rings[idx] = 0.05;
        idx = (idx + 1) % MAXR;
      }
      for (let i = 0; i < MAXR; i++) {
        if (rings[i] > 0) {
          rings[i] += dt * (0.9 + audio.level * 0.6);
          if (rings[i] > 1.4) rings[i] = 0;
        }
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, rw, rh);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1fv(u.u_spectrum, spec);
      gl.uniform1fv(u.u_rings, rings);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
