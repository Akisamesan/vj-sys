// 64 NEONSIGN — a bank of neon tubes that light up one by one instead of flashing on
// the beat. Each tube is a procedural zigzag polyline rendered as a 2D SDF (capsule
// chain) with an exp(-d*k) glow, mixed rather than added so overlapping tubes never
// blow out to white. The beat is told through *structure*: every kick advances a
// point-lighting sequence — the next dark tube ignites and stays lit — and once the
// whole bank has lit up, the next kick blacks it out and re-ignites from the first
// tube. bass widens the glow radius and tube thickness (continuous), level drives a
// low-frequency, hash-based flicker/jitter typical of failing neon (continuous),
// centroid slowly rotates the palette through pink/cyan/amber (phase), and the
// 24-band spectrum is mapped one band per tube to allocate per-tube brightness.
// A small kick-synced local glow at the freshly lit tube (recipe: exp(-d^2*k)*pulse)
// keeps the trigger legible without any full-screen flash. Pure fragment, 1 pass.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const NUM_TUBES = 6;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
#define NUM_TUBES ${NUM_TUBES}
#define SEG 5
uniform vec2 u_res;
uniform float u_time, u_bass, u_level, u_centroid, u_seed, u_kickPulse, u_curIdx;
uniform float u_spec[24];
uniform float u_litT[NUM_TUBES];
out vec4 o;

float sdSegment(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// deterministic per-tube layout parameters (shape, not colour)
float tubeParam(float ti, float salt){
  return hash11(ti * 12.9898 + salt * 78.233 + 4.0);
}

// pink <-> cyan <-> amber neon rotation
vec3 neonColor(float hu){
  vec3 pink  = vec3(1.00, 0.20, 0.60);
  vec3 cyan  = vec3(0.18, 0.90, 1.00);
  vec3 amber = vec3(1.00, 0.60, 0.12);
  float seg = fract(hu) * 3.0;
  float f = fract(seg);
  vec3 c0 = pink, c1 = cyan;
  if (seg >= 1.0 && seg < 2.0) { c0 = cyan; c1 = amber; }
  else if (seg >= 2.0) { c0 = amber; c1 = pink; }
  return mix(c0, c1, smoothstep(0.0, 1.0, f));
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / max(u_res.y, 1e-4);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 6.0;
  float xw = aspect * 3.0 - 0.35;

  // bass (continuous): wider glow radius + thicker tube core
  float glowK = mix(15.0, 6.5, clamp(u_bass, 0.0, 1.0));
  float coreW = 0.026 + u_bass * 0.03;

  // dark backdrop with a faint animated texture so silence never reads pure black
  vec3 col = vec3(0.014, 0.011, 0.028);
  float bgN = snoise(vec3(p * 0.22, u_time * 0.035 + u_seed * 5.0));
  col += vec3(0.028, 0.02, 0.045) * (0.5 + 0.5 * bgN);

  for (int i = 0; i < NUM_TUBES; i++) {
    float ti = float(i);
    float bandY = mix(-2.15, 2.15, (ti + 0.5) / float(NUM_TUBES));
    float amp = 0.16 + tubeParam(ti, 1.0) * 0.34;
    float freq = 0.5 + tubeParam(ti, 2.0) * 0.9;
    float phase = tubeParam(ti, 3.0) * 6.2831 + u_seed * 4.0 + u_time * (0.05 + 0.02 * ti);

    // distance to the tube's zigzag polyline (SEG points -> SEG-1 capsule segments)
    float d = 1e5;
    vec2 prev = vec2(-xw, bandY + amp * sin(freq * -xw + phase));
    for (int j = 1; j < SEG; j++) {
      float fx = float(j) / float(SEG - 1);
      float x = mix(-xw, xw, fx);
      float y = bandY + amp * sin(freq * x + phase);
      vec2 pt = vec2(x, y);
      d = min(d, sdSegment(p, prev, pt));
      prev = pt;
    }

    // kick-driven sequence state: how long since this tube was ignited
    float litTime = u_litT[i];
    float onAmt = litTime > -500.0 ? (1.0 - exp(-(u_time - litTime) * 3.5)) : 0.0;
    float amb = 0.12; // unlit tubes still trace a faint outline (reads as "the sign")
    float lvl = amb + onAmt * (1.0 - amb);

    // level (continuous): low-frequency, irregular, deterministic hash flicker
    float bucket = floor(u_time * 5.0);
    float fh = hash11(ti * 7.13 + bucket * 0.913);
    float dip = step(0.82, fh) * (0.35 + 0.65 * hash11(ti * 3.7 + bucket * 2.1));
    lvl *= 1.0 - dip * clamp(u_level * 1.4, 0.0, 1.0);

    // spectrum (24 bands -> NUM_TUBES): per-tube brightness allocation
    int bandIdx = int(clamp(ti / float(NUM_TUBES) * 24.0, 0.0, 23.0));
    float bandE = max(0.0, u_spec[bandIdx]);
    lvl *= 0.5 + bandE * 1.2;

    // small kick-synced accent on the tube that just lit, so the trigger reads
    // clearly even when the rest of the field is busy (no full-screen flash)
    float accent = (abs(ti - u_curIdx) < 0.5) ? u_kickPulse : 0.0;
    lvl *= 1.0 + accent * 1.6;

    // centroid (phase): slow hue rotation across pink/cyan/amber
    float hu = u_centroid * 0.9 + ti * 0.11 + u_seed * 0.3;
    vec3 tubeCol = neonColor(hu);

    float core = 1.0 - smoothstep(coreW * 0.4, coreW, d);
    col = mix(col, col + tubeCol * 1.25, core * clamp(lvl, 0.0, 1.4) * 0.8);

    float glow = exp(-d * glowK) * lvl;
    col += tubeCol * glow * 0.5;

    float spark = exp(-d * d * 3.0) * accent;
    col = mix(col, col + tubeCol * 1.4, clamp(spark, 0.0, 1.0));
  }

  vec2 dv = uv - 0.5;
  col *= 1.0 - dot(dv, dv) * 0.55;

  // soft compressive tonemap: keeps overlapping glow from blowing out to white
  col = col / (1.0 + col * 0.6);
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.9)), 1.0);
}`;

export function createNeonsign(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const litT = new Float32Array(NUM_TUBES).fill(-1000);
  let rw = 1,
    rh = 1;
  let seed = 0;
  let seqPos = 0;
  let curIdx = -1;

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
    frame(t, _dt, audio: AudioEngine) {
      // kick = structural trigger: advance the point-lighting sequence by one tube;
      // once the whole bank is lit, the next kick blacks it out and re-ignites
      if (audio.kick) {
        if (seqPos >= NUM_TUBES) {
          litT.fill(-1000);
          seqPos = 0;
        }
        litT[seqPos] = t;
        curIdx = seqPos;
        seqPos++;
      }

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_seed, seed);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1f(u.u_curIdx, curIdx);
      gl.uniform1fv(u.u_spec, audio.spectrum);
      gl.uniform1fv(u.u_litT, litT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
