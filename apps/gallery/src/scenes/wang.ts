// 82 WANG — Wang tiles: a non-periodic network of flowing curves. The screen is
// diced into a square grid; every grid *edge* (not cell) gets one hash-derived
// crossing point, shared by construction between the two cells that border it,
// so curves always thread continuously from cell to cell with no dangling ends.
// Each cell then picks one of three ways to pair its four edge crossings
// (straight-ish, or arcing round one of two opposite corners) — an aperiodic
// Wang-style tiling with guaranteed edge-matching. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_scale, u_scrollX, u_scrollY, u_salt, u_flip;
uniform float u_centroid, u_high, u_kickPulse, u_seed;
out vec4 o;

// edge hashes: horizontal edges keyed by (column, row-line), vertical edges by
// (column-line, row) — both cells sharing an edge evaluate the *same* input,
// so the crossing point on that edge always agrees between neighbours.
float hEdge(vec2 c){ return hash11(dot(c, vec2(127.1, 311.7)) + 13.0); }
float vEdge(vec2 c){ return hash11(dot(c, vec2(269.5, 183.3)) + 47.0); }

float sdSegment(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// distance to a quadratic bezier, approximated by a short polyline.
float bezierDist(vec2 p, vec2 p0, vec2 c, vec2 p1){
  const int N = 8;
  float d = 1e9;
  vec2 prev = p0;
  for(int i = 1; i <= N; i++){
    float s = float(i) / float(N);
    vec2 pt = mix(mix(p0, c, s), mix(c, p1, s), s);
    d = min(d, sdSegment(p, prev, pt));
    prev = pt;
  }
  return d;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  uv = uv * u_scale + vec2(u_scrollX + u_seed * 53.0, u_scrollY + u_seed * 31.0);

  vec2 g = floor(uv);
  vec2 f = fract(uv);

  float tN = mix(0.15, 0.85, hEdge(vec2(g.x, g.y + 1.0)));
  float tS = mix(0.15, 0.85, hEdge(vec2(g.x, g.y)));
  float tE = mix(0.15, 0.85, vEdge(vec2(g.x + 1.0, g.y)));
  float tW = mix(0.15, 0.85, vEdge(vec2(g.x, g.y)));

  vec2 pN = vec2(tN, 1.0);
  vec2 pS = vec2(tS, 0.0);
  vec2 pE = vec2(1.0, tE);
  vec2 pW = vec2(0.0, tW);

  // kick: a travelling band re-rolls the *pairing choice* only (never the edge
  // crossings above), so the network re-routes locally without ever tearing.
  float band = step(abs(g.x + g.y - u_time * 4.0), 2.5);
  float rr = hash11(dot(g, vec2(37.1, 91.7)) + u_salt * u_flip * band * 19.0);
  float sel = floor(rr * 3.0);

  float d;
  if(sel < 0.5){
    d = bezierDist(f, pS, vec2(mix(tS, tN, 0.5), 0.5), pN);
    d = min(d, bezierDist(f, pW, vec2(0.5, mix(tW, tE, 0.5)), pE));
  } else if(sel < 1.5){
    d = bezierDist(f, pN, vec2(1.0, 1.0), pE);
    d = min(d, bezierDist(f, pS, vec2(0.0, 0.0), pW));
  } else {
    d = bezierDist(f, pN, vec2(0.0, 1.0), pW);
    d = min(d, bezierDist(f, pS, vec2(1.0, 0.0), pE));
  }

  float w = 0.045 + u_high * 0.05;
  float soft = mix(0.6, 0.18, u_high);
  float line = smoothstep(w, w * soft, d);

  float hue = u_seed * 0.4 + u_centroid * 0.65 + length(g) * 0.015 + u_time * 0.01;
  vec3 col = palette(hue, vec3(0.5), vec3(0.45), vec3(1.0), vec3(0.0, 0.33, 0.67));

  vec3 c = col * line * 0.55;
  c += col * line * line * 0.7;
  c *= 1.0 + u_kickPulse * 0.18;
  vec2 vgn = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  c *= 1.0 - dot(vgn, vgn) * 0.15;
  o = vec4(pow(max(c, 0.0), vec3(0.9)), 1.0);
}`;

export function createWang(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  let scrollX = 0,
    scrollY = 0;
  let salt = 0;
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
      // level -> continuous scroll speed (integrated, not t*speed, so a
      // changing level never jumps the field).
      scrollX += dt * (0.04 + audio.level * 0.35);
      scrollY += dt * (0.02 + audio.level * 0.18);
      // kick -> structural reconfiguration: bump the salt once per onset and
      // let a fast-attack/slow-decay envelope gate a travelling re-route band.
      if (audio.kick) salt += 1.0;
      flip += ((audio.kick ? 1 : 0) - flip) * (1 - Math.exp(-dt * (audio.kick ? 30 : 3)));
      // bass -> grid density (higher bass = finer cells).
      const scale = 6.0 + audio.bass * 7.0;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_scrollX, scrollX);
      gl.uniform1f(u.u_scrollY, scrollY);
      gl.uniform1f(u.u_salt, salt);
      gl.uniform1f(u.u_flip, flip);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1f(u.u_seed, seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
