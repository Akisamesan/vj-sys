// 04 TUNNEL — an endless neon tunnel rush. Inverse-radius tunnel mapping gives the
// infinite-depth illusion; a procedural grid forms glowing walls. Bass drives flight
// speed, kicks launch light rings that race toward you, centroid shifts the neon hue.
// Renders through the shared HDR PostFX for bloom.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_z, u_bass, u_high, u_centroid, u_twist;
uniform float u_ring0, u_ring1, u_ring2;
out vec4 o;

float grid(vec2 uv, float gx, float gy){
  vec2 g = abs(fract(uv*vec2(gx,gy))-0.5);
  float l = min(g.x, g.y);
  return smoothstep(0.06, 0.0, l);
}
float ringGlow(float v, float pos){
  return exp(-pow((v-pos)*6.0, 2.0));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  a += u_twist / (r+0.3);                       // swirl deeper in
  float depth = 1.0/(r+0.05);
  float v = depth*0.5 + u_z;                     // travels with flight
  float u = a/6.28318;

  // tunnel wall: procedural neon grid + flowing stripes
  float walls = grid(vec2(u*8.0, v), 1.0, 1.0);
  float stripes = 0.5+0.5*cos(v*12.0 - u_time*3.0 + u*6.28318);
  float n = snoise(vec3(u*6.0, v*2.0, u_time*0.1))*0.5+0.5;

  float hue = u + v*0.05 + u_centroid*0.6 + u_time*0.02;
  vec3 neon = palette(hue, vec3(0.5), vec3(0.5), vec3(1.0,1.0,1.0), vec3(0.0,0.33,0.66));

  vec3 col = vec3(0.0);
  col += neon * walls * (0.6 + u_high*1.5);
  col += neon * stripes * 0.25 * (0.4 + u_bass);
  col += neon * n * 0.12;

  // racing light rings
  col += vec3(1.0,0.95,0.9) * ringGlow(v, u_ring0) * 1.5;
  col += vec3(0.7,0.9,1.0) * ringGlow(v, u_ring1) * 1.2;
  col += vec3(1.0,0.8,0.95) * ringGlow(v, u_ring2) * 1.2;

  // depth fog: far (small r) fades to black core
  float fog = smoothstep(0.0, 0.5, r);
  col *= fog;
  col += neon * 0.4 * (1.0-fog) * u_bass;        // bright vanishing point on bass

  o = vec4(col, 1.0);
}`;

interface Ring {
  v: number;
  active: boolean;
}

export function createTunnel(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let z = 0;
  let twist = 0;
  const rings: Ring[] = [
    { v: 0, active: false },
    { v: 0, active: false },
    { v: 0, active: false },
  ];
  let rIdx = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const speed = 0.4 + audio.bass * 2.2 + audio.level * 0.8;
      z += dt * speed;
      twist += dt * (audio.change * 1.2 + 0.1) * (audio.mid + 0.2);
      if (audio.kick) {
        rings[rIdx] = { v: z + 6, active: true };
        rIdx = (rIdx + 1) % rings.length;
      }
      for (const ring of rings) if (ring.active) ring.v -= dt * (speed + 3);

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_z, z);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_twist, twist);
      gl.uniform1f(u.u_ring0, rings[0].active ? rings[0].v : -999);
      gl.uniform1f(u.u_ring1, rings[1].active ? rings[1].v : -999);
      gl.uniform1f(u.u_ring2, rings[2].active ? rings[2].v : -999);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.9 + audio.level * 0.5,
        exposure: 1.0 + audio.kickPulse * 0.2,
        aberration: 0.001 + audio.change * 0.003,
        grain: 0.04,
        vignette: 1.1,
        flash: audio.kickPulse * 0.5,
        threshold: 0.6,
        time: t,
      });
    },
  };
}
