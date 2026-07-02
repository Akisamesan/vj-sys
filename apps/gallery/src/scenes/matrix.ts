// 50 MATRIX — falling glyph rain. A column grid of pseudo-glyphs streams downward;
// each column has a bright head and a fading trail. Bands set the fall speed and
// density, the centroid tints the rain, and kicks spawn bright bursts down random
// columns. Pure fragment (glyphs are procedural 5×5 dot patterns).

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_speed, u_cols, u_centroid, u_beat, u_density;
out vec4 o;

// procedural 5x5 glyph: returns 0/1 for a sub-cell, varying per (cell,id)
float glyph(vec2 p, float id){
  vec2 g = floor(p*5.0);
  float r = hash11(dot(g, vec2(7.0, 13.0)) + id*3.7);
  return step(0.45, r);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float cols = u_cols;
  float col = floor(uv.x * cols);
  float aspect = u_res.x/u_res.y;
  float rows = cols / aspect;            // keep cells square-ish
  vec2 cell = vec2(fract(uv.x*cols), fract(uv.y*rows));
  float row = floor(uv.y * rows);

  float ch = hash11(col*1.3);
  float speed = u_speed * (0.6 + ch*0.9);
  float head = fract(u_time*speed*0.08 + ch);     // 0..1 head position (from top)
  float headRow = (1.0 - head) * rows;
  float dist = headRow - row;                       // rows below the head
  float trail = exp(-max(dist,0.0)*0.12) * step(-0.5, dist);
  float glow = trail;
  // glyph changes over time
  float gid = floor(u_time*6.0 + row*0.7 + col*2.0);
  float g = glyph(cell, gid + col*11.0);

  // beat bursts: some columns flash fully lit
  float burst = step(0.97, hash11(floor(col + floor(u_time*2.0)*53.0))) * u_beat;

  float lit = g * (glow + burst*0.8);
  // head is white, trail tinted
  vec3 tint = palette(0.33 + u_centroid*0.4, vec3(0.4,0.6,0.5), vec3(0.3,0.5,0.4), vec3(1.0), vec3(0.0,0.2,0.4));
  vec3 col3 = tint * lit;
  col3 += vec3(0.8,1.0,0.9) * g * smoothstep(0.0,1.0,trail) * step(dist, 0.6) * step(-0.6, dist); // bright head
  // density gate: dim some columns
  col3 *= step(hash11(col*4.1), u_density);
  o = vec4(col3, 1.0);
}`;

export function createMatrix(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_speed, 1.0 + audio.bass * 3.0 + audio.level * 1.5);
      gl.uniform1f(u.u_cols, 64.0);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_density, 0.55 + audio.level * 0.4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
