// 99 WORMHOLE — flying through a chain of periodic wormhole throats. Reuses
// 04 TUNNEL's cheap inverse-radius mapping (no raymarch loop, stays well
// under the SLOW budget) but modulates the tunnel radius by distance to the
// nearest throat along the travel axis (a periodic triangle wave), pinching
// the wall grid and swirling the angle strongly only near each throat —
// the "gravitational lensing" read as a warp that intensifies and relaxes
// as each neck is approached and passed, rather than 41 TORUS-style static
// swirl or 98 BLACKHOLE's disk lensing. bass sets flight speed and throat
// pinch depth, kick launches a pulse ring down the tunnel (structural, no
// flash), centroid drifts the wall hue, high sharpens the wall grid/swirl.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_z, u_bass, u_high, u_centroid, u_level, u_pinch;
uniform float u_ring0, u_ring1, u_ring2;
out vec4 o;

const float PERIOD = 5.0;

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

  float depth = 1.0/(r+0.05);
  float v = depth*0.5 + u_z;

  // Distance (along the travel axis) to the nearest periodic throat centre.
  float throatDist = abs(mod(v - PERIOD*0.5, PERIOD) - PERIOD*0.5);
  float near = 1.0 - smoothstep(0.0, PERIOD*0.42, throatDist);

  // Swirl intensifies only close to a throat — the lensing read.
  a += (0.4 + u_high*0.8) * u_pinch * near*near / (throatDist*4.0 + 0.2);
  // Wall radius pinches inward approaching the throat, flares just past it.
  float pinchAmt = 1.0 - u_pinch*0.55*near;

  float u = a/6.28318;
  float rr = r * pinchAmt;
  float depth2 = 1.0/(rr+0.05);
  float v2 = depth2*0.5 + u_z;

  float walls = grid(vec2(u*8.0, v2), 1.0, 1.0 + near*3.0);
  float stripes = 0.5+0.5*cos(v2*12.0 - u_time*3.0 + u*6.28318);
  float n = snoise(vec3(u*6.0, v2*2.0, u_time*0.1))*0.5+0.5;

  float hue = u + v2*0.04 + u_centroid*0.6 + u_time*0.02;
  vec3 neon = palette(hue, vec3(0.5), vec3(0.5), vec3(0.55,0.6,1.0), vec3(0.5,0.2,0.0));

  vec3 col = vec3(0.0);
  col += neon * walls * (0.55 + u_high*1.3);
  col += neon * stripes * 0.22 * (0.4 + u_bass);
  col += neon * n * 0.10;

  // Throat crossing: a soft ring brightens the neck itself (mix-based, no blowout).
  vec3 throatGlow = vec3(0.9, 0.95, 1.0) * near * near * 0.5;
  col = mix(col, col + throatGlow, near);

  // Kick-launched pulse rings racing down the tunnel.
  col += vec3(1.0,0.95,0.9) * ringGlow(v2, u_ring0) * 1.3;
  col += vec3(0.7,0.85,1.0) * ringGlow(v2, u_ring1) * 1.1;
  col += vec3(0.9,0.8,1.0) * ringGlow(v2, u_ring2) * 1.1;

  float fog = smoothstep(0.0, 0.5, rr);
  col *= fog;
  col += neon * 0.35 * (1.0-fog) * (0.3 + u_bass);

  col *= 0.75 + u_level * 0.35;
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.92)), 1.0);
}`;

interface Ring {
  v: number;
  active: boolean;
}

export function createWormhole(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let z = 0;
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
    },
    frame(t, dt, audio: AudioEngine) {
      // bass (continuous): flight speed toward/through successive throats.
      const speed = 0.5 + audio.bass * 1.8 + audio.level * 0.6;
      z += dt * speed;

      // kick (trigger): launch a pulse ring racing down the tunnel — a
      // structural readout of the beat, not a screen flash.
      if (audio.kick) {
        rings[rIdx] = { v: z + 6, active: true };
        rIdx = (rIdx + 1) % rings.length;
      }
      for (const ring of rings) if (ring.active) ring.v -= dt * (speed + 3);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_z, z);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_level, audio.level);
      // bass (continuous): how deep each throat pinches the tunnel wall.
      gl.uniform1f(u.u_pinch, 0.5 + audio.bass * 0.5);
      gl.uniform1f(u.u_ring0, rings[0].active ? rings[0].v : -999);
      gl.uniform1f(u.u_ring1, rings[1].active ? rings[1].v : -999);
      gl.uniform1f(u.u_ring2, rings[2].active ? rings[2].v : -999);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
