// 87 CIRCUIT — a PCB whose traces get drawn on by the music. Each grid cell picks a
// deterministic Manhattan wiring glyph (straight/corner/T/cross, all routed through
// the cell centre so bends stay right-angled); a slow evolving noise front decides how
// much of the board is "powered" (bass), the spectrum lights up vertical screen bands,
// and glowing data pulses run along the traces (level sets their speed/count). Kicks
// ignite a fresh wiring block plus a local via flash — never a full-screen strobe.
// Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res, u_block;
uniform float u_time, u_bass, u_level, u_high, u_centroid, u_seed, u_kick, u_blockAge;
uniform float u_spec[24];
out vec4 o;

const float GRID = 9.0;

float seg(vec2 p, vec2 a, vec2 b, float w, float soft){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float d = length(pa - ba * h);
  return smoothstep(w, w * soft, d);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  // seed macro: pan to another patch of the infinite board (u_seed=0 -> unmodulated,
  // continuous so a drift reads as the camera sliding, never a cut).
  vec2 suv = uv * GRID + vec2(u_seed * 53.0, u_seed * 31.0);
  vec2 g = floor(suv);
  vec2 f = fract(suv);

  float r  = hash11(dot(g, vec2(127.1, 74.7)) + u_seed * 17.0);
  float r2 = hash11(dot(g, vec2(269.5, 183.3)) + 11.0);
  int vi = int(floor(r * 8.0));

  vec2 N = vec2(0.5, 0.0), S = vec2(0.5, 1.0), E = vec2(1.0, 0.5), W = vec2(0.0, 0.5), C = vec2(0.5, 0.5);
  float armN = 0.0, armS = 0.0, armE = 0.0, armW = 0.0;
  if (vi == 0)      { armN = 1.0; armS = 1.0; }
  else if (vi == 1) { armE = 1.0; armW = 1.0; }
  else if (vi == 2) { armN = 1.0; armE = 1.0; }
  else if (vi == 3) { armE = 1.0; armS = 1.0; }
  else if (vi == 4) { armS = 1.0; armW = 1.0; }
  else if (vi == 5) { armW = 1.0; armN = 1.0; }
  else if (vi == 6) { armN = 1.0; armE = 1.0; armS = 1.0; }
  else              { armN = 1.0; armE = 1.0; armS = 1.0; armW = 1.0; }

  // high sharpens & thins the traces (finer filigree at brighter top end).
  float wid  = mix(0.10, 0.056, clamp(u_high, 0.0, 1.0));
  float soft = mix(0.6, 0.25, clamp(u_high, 0.0, 1.0));

  float segN = armN * seg(f, N, C, wid, soft);
  float segS = armS * seg(f, S, C, wid, soft);
  float segE = armE * seg(f, E, C, wid, soft);
  float segW = armW * seg(f, W, C, wid, soft);
  float trace = max(max(segN, segS), max(segE, segW));

  bool hasVia = vi >= 6 || r2 < 0.18;
  float viaR = hasVia ? (vi >= 6 ? 0.16 : 0.12) : 0.001;
  float via = smoothstep(viaR, viaR * 0.5, length(f - C)) * (hasVia ? 1.0 : 0.0);

  // Slowly evolving lit-front: bass raises the fraction of the board that is "powered".
  // Keeps drifting via u_time even in silence, so the base copper pattern never freezes.
  float nz = snoise(vec3(g * 0.14, u_time * 0.06 + u_seed * 4.0));
  float thresh = mix(0.7, -0.65, clamp(u_bass, 0.0, 1.0));
  float baseLit = smoothstep(thresh + 0.18, thresh - 0.18, nz);

  // Spectrum embedded spatially: screen column -> band energy.
  vec2 scr = gl_FragCoord.xy / u_res;
  int bandIdx = int(clamp(scr.x * 24.0, 0.0, 23.0));
  float bandE = max(0.0, u_spec[bandIdx]);
  float bandLit = smoothstep(0.12, 0.85, bandE);

  // Kick: a new wiring block ignites near u_block and unrolls outward, then fades.
  vec2 gd = g - u_block;
  float manh = abs(gd.x) + abs(gd.y);
  float spreadR = u_blockAge * 9.0;
  float blockLit = smoothstep(spreadR + 1.3, spreadR - 1.3, manh) * exp(-u_blockAge * 2.1);

  float lit = clamp(baseLit * 0.55 + bandLit * 0.45 + blockLit, 0.0, 1.2);

  // Data pulses flowing along the traces. Phase rides the continuous pre-cell world
  // coordinate so a pulse glides seamlessly from cell to cell along aligned arms.
  float pCount = 3.0 + clamp(u_level, 0.0, 1.0) * 10.0;
  float pSpeed = 0.8 + clamp(u_level, 0.0, 1.0) * 3.2;
  float pv = pow(max(0.0, sin(suv.y * pCount - u_time * pSpeed)), 10.0);
  float ph = pow(max(0.0, sin(suv.x * pCount - u_time * pSpeed * 0.86)), 10.0);
  float pulse = pv * max(segN, segS) + ph * max(segE, segW);

  vec3 cyan  = vec3(0.25, 0.95, 1.0);
  vec3 amber = vec3(1.0, 0.72, 0.22);
  // centroid: board glow leans green-cyan when dark, cyan/amber when bright.
  vec3 litHue = mix(cyan, amber, smoothstep(0.28, 0.72, u_centroid));

  vec3 unlitTrace = vec3(0.035, 0.30, 0.11);
  vec3 traceCol = mix(unlitTrace, litHue * 1.35, lit);
  traceCol += litHue * pulse * (0.4 + 0.6 * lit);

  vec3 gold = vec3(1.0, 0.85, 0.45);
  vec3 padCol = mix(gold * 0.45, gold * 1.4, lit);
  padCol += gold * u_kick * smoothstep(2.4, 0.0, manh) * 1.5; // local via flash, never full-screen

  vec3 substrate = vec3(0.026, 0.05, 0.03);
  float edge = 1.0 - smoothstep(0.0, 0.022, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
  substrate += vec3(0.01, 0.018, 0.012) * edge; // faint silkscreen grid, keeps the base always visible

  vec3 col = mix(substrate, traceCol, trace);
  col = mix(col, padCol, via);

  col *= 1.0 - dot(uv, uv) * 0.3;
  o = vec4(pow(max(col, 0.0), vec3(0.85)), 1.0);
}`;

export function createCircuit(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const spec = new Float32Array(24);
  let rw = 1,
    rh = 1;
  let seed = 0;
  let blockX = 0,
    blockY = 0;
  let blockAge = 5;

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
      if (audio.kick) {
        blockX = (Math.random() - 0.5) * 20;
        blockY = (Math.random() - 0.5) * 12;
        blockAge = 0;
      }
      blockAge += dt;
      for (let i = 0; i < 24; i++) spec[i] = Math.min(1.2, audio.spectrum[i] * 1.6);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_seed, seed);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_blockAge, blockAge);
      gl.uniform2f(u.u_block, blockX, blockY);
      gl.uniform1fv(u.u_spec, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
