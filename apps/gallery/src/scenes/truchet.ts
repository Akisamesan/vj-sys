// 33 TRUCHET — a flowing Truchet weave. Each grid cell randomly places two quarter-arcs
// so the lines knit into an endless maze of interlocking loops. Bands set the line
// glow and width, the field slowly scrolls and rotates, the centroid colours it and
// kicks flip a wave of cells. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_scale, u_width, u_glow, u_centroid, u_beat, u_flip, u_seed;
out vec4 o;

float arc(vec2 p, vec2 c, float w){
  float d = abs(length(p - c) - 0.5);
  return smoothstep(w, w*0.3, d);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  // seed macro: pan to another region of the infinite weave + tilt the rotation
  // (u_seed=0 → the unmodulated image, continuous so a drift reads as scrolling)
  float a = u_time*0.05 + u_seed*1.1;
  uv = mat2(cos(a),-sin(a),sin(a),cos(a))*uv;
  uv = uv*u_scale + vec2(u_time*0.1 + u_seed*53.0, u_seed*31.0);

  vec2 g = floor(uv);
  vec2 f = fract(uv);
  float r = hash11(dot(g, vec2(7.0,131.0)));
  // beat flips a moving diagonal band of cells
  float flip = step(0.5, fract(r + u_flip*step(abs(g.x+g.y - u_time*4.0), 3.0)));
  if(flip > 0.5) f.x = 1.0 - f.x;

  float w = u_width;
  float line = arc(f, vec2(0.0,0.0), w) + arc(f, vec2(1.0,1.0), w);
  line = clamp(line, 0.0, 1.0);

  float hue = r*0.3 + u_centroid*0.4 + length(g)*0.02 + u_time*0.02 + u_seed*0.4;
  vec3 col = palette(hue, vec3(0.5),vec3(0.5),vec3(1.0,1.0,1.0),vec3(0.0,0.33,0.66));
  vec3 c = col * line * (0.5 + u_glow);
  c += col * line * line * u_glow * 1.5;          // inner glow
  c *= 1.0 + u_beat*0.4;
  vec2 d=(gl_FragCoord.xy-0.5*u_res)/u_res.y; c *= 1.0 - dot(d,d)*0.2;
  o = vec4(pow(max(c,0.0), vec3(0.85)), 1.0);
}`;

export function createTruchet(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let flip = 0;
  let seed = 0;

  return {
    macros: {
      seed: (v) => {
        seed = v;
      },
    },
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      flip += ((audio.kick ? 1 : 0) - flip) * (1 - Math.exp(-dt * (audio.kick ? 30 : 3)));
      const scale = 5.0 + Math.sin(t * 0.08) * 1.5 + audio.bass * 1.5;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_width, 0.08 + audio.high * 0.14);
      gl.uniform1f(u.u_glow, 0.3 + audio.level * 1.2);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_flip, flip);
      gl.uniform1f(u.u_seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
