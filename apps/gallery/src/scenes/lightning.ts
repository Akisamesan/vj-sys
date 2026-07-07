// 69 LIGHTNING — a branching bolt tears through a storm sky. A phrase-length
// envelope charges the clouds with a slow inner glow; kicks discharge it into a
// fresh procedural strike (fBm-jagged trunk + hashed sub-branches + twigs) that
// flashes and fades to residual afterglow. Pure fragment (SDF polylines, no
// raymarch). The pacing between charge and discharge is the point — not a
// strobe on every beat.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_charge, u_glow, u_flash, u_seed, u_bass, u_high, u_centroid, u_level;
out vec4 o;

const int TRUNK_N = 8;
const int BR_COUNT = 5;
const int BR_SEG = 4;
const int TWIG_N = 2;

float sdSegment(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// One control point of the main trunk: a deterministic jagged path (hash+sway)
// from top to bottom of frame. Same (i, seed) always gives the same point, so
// the whole bolt is a pure function of u_seed (reseeded once per discharge).
vec2 trunkPt(float i, float seed){
  float yy = 1.35 - i * (2.7 / float(TRUNK_N));
  float xOff = (hash11(seed * 2.03 + 5.0) - 0.5) * 1.2;
  float sway = sin(i * 0.85 + seed * 1.7) * 0.22;
  float kink = (hash11(seed * 4.13 + i * 7.91) - 0.5) * 0.5;
  float fine = (hash11(seed * 9.77 + i * 17.3 + 3.0) - 0.5) * 0.2;
  return vec2(xOff + sway + kink + fine, yy);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.4;

  // --- storm sky: always-present fBm cloud texture (BLACK guard) ---
  vec2 cp = p * 0.55 + vec2(u_seed * 3.1, u_time * 0.05);
  float clouds = 0.0;
  {
    float amp = 0.55, freq = 1.0;
    for (int i = 0; i < 4; i++) {
      clouds += amp * snoise(vec3(cp * freq, u_time * 0.035 + float(i) * 3.7));
      freq *= 2.02;
      amp *= 0.52;
    }
  }
  clouds = clamp(clouds * 0.5 + 0.5, 0.0, 1.0);

  float topness = clamp(uv.y, 0.0, 1.0);
  vec3 skyDeep = vec3(0.015, 0.02, 0.045);
  vec3 skyCloud = vec3(0.06, 0.075, 0.13);
  vec3 col = mix(skyDeep, skyCloud, clouds * (0.45 + 0.55 * topness));
  // level: constant faint sky flicker — continuous base motion, never a hard cut
  col *= 1.0 + 0.06 * u_level * sin(u_time * 1.3 + clouds * 4.0);

  // --- charge glow: broad soft wash anchored near where the next strike lands ---
  float glowCX = (hash11(u_seed * 2.03 + 5.0) - 0.5) * 1.2;
  vec2 gd = vec2((p.x - glowCX) * 0.8, max(0.0, 1.15 - p.y));
  float ambient = exp(-dot(gd, gd) * 0.9) * (0.18 + 0.55 * u_charge + 0.35 * u_level);
  vec3 chargeCol = vec3(0.30, 0.40, 0.60);
  col += chargeCol * ambient * (0.7 + 0.3 * clouds);

  // --- main trunk: fBm-warped jagged polyline SDF, glow via exp(-d^2 k) ---
  float kTrunk = mix(80.0, 34.0, clamp(u_bass, 0.0, 1.0));
  float trunkD = 1e9;
  vec2 prevP = trunkPt(0.0, u_seed);
  for (int i = 1; i <= TRUNK_N; i++) {
    vec2 curP = trunkPt(float(i), u_seed);
    vec2 sh = vec2(sin(u_time * 9.0 + float(i) * 2.1 + u_seed * 6.0),
                    cos(u_time * 7.0 + float(i) * 1.7 + u_seed * 6.0)) * 0.012 * u_glow;
    vec2 curS = curP + sh;
    trunkD = min(trunkD, sdSegment(p, prevP, curS));
    prevP = curS;
  }
  float trunkGlow = exp(-trunkD * trunkD * kTrunk);

  // --- branches (density from bass) + twigs (sharpness/count from high) ---
  // Each branch derives its own hash sub-seed from u_seed, and each twig derives
  // its sub-seed from the branch's — a recursive hash tree combined via min/sum.
  float kBranch = 120.0;
  float kTwig = mix(300.0, 150.0, clamp(u_high, 0.0, 1.0));
  float bassCount = 0.5 + clamp(u_bass, 0.0, 1.0) * (float(BR_COUNT) - 0.5);
  float highCount = 0.5 + clamp(u_high, 0.0, 1.0) * (float(TWIG_N) - 0.5);
  float branchGlow = 0.0;
  float twigGlow = 0.0;
  for (int b = 0; b < BR_COUNT; b++) {
    float fb = float(b);
    float boltOn = smoothstep(-0.15, 0.15, bassCount - fb);
    if (boltOn > 0.001) {
      float bs = u_seed * 17.3 + fb * 53.7 + 9.0;
      float attachI = 1.0 + hash11(bs * 1.1) * float(TRUNK_N - 2);
      vec2 origin = trunkPt(attachI, u_seed);
      float side = hash11(bs * 2.7) < 0.5 ? -1.0 : 1.0;
      float ang = side * (0.35 + 0.55 * hash11(bs * 3.3));
      float segLen = 0.16 + 0.09 * hash11(bs * 4.4);
      vec2 bp0 = origin;
      float bd = 1e9;
      for (int j = 0; j < BR_SEG; j++) {
        float fj = float(j + 1);
        vec2 bp1 = bp0 + vec2(ang * segLen, -segLen * (0.75 + 0.25 * hash11(bs * 5.0 + fj)));
        bp1.x += (hash11(bs * 6.0 + fj * 3.0) - 0.5) * 0.14;
        bd = min(bd, sdSegment(p, bp0, bp1));

        for (int w = 0; w < TWIG_N; w++) {
          float fw = float(w);
          float wActive = smoothstep(-0.15, 0.15, highCount - fw);
          if (wActive > 0.001) {
            float ws = bs * 3.7 + fj * 11.0 + fw * 29.0;
            float wside = hash11(ws * 1.3) < 0.5 ? -1.0 : 1.0;
            float wang = wside * (0.5 + 0.5 * hash11(ws * 2.1));
            float wlen = 0.07 + 0.05 * hash11(ws * 3.3);
            vec2 wp1 = bp1 + vec2(wang * wlen, -wlen * 0.85);
            float wd = sdSegment(p, bp1, wp1);
            twigGlow += exp(-wd * wd * kTwig) * wActive * boltOn;
          }
        }
        bp0 = bp1;
      }
      branchGlow += exp(-bd * bd * kBranch) * boltOn;
    }
  }

  float boltRaw = trunkGlow * 1.0 + branchGlow * 0.85 + twigGlow * 0.6;
  // glow = slow custom afterglow envelope (residual light), flash = fast kickPulse punch
  float boltEnv = clamp(u_glow, 0.0, 1.0) + clamp(u_flash, 0.0, 1.0) * 0.5;
  float boltI = boltRaw * boltEnv;

  float hueT = 0.62 + clamp(u_centroid, 0.0, 1.0) * 0.18;
  vec3 boltBase = palette(hueT, vec3(0.7, 0.72, 0.8), vec3(0.3, 0.28, 0.35), vec3(1.0, 1.0, 1.0), vec3(0.15, 0.25, 0.5));
  vec3 boltCol = boltBase * boltI * 1.5;
  float core = clamp(boltI * 0.55, 0.0, 1.0);
  boltCol = mix(boltCol, vec3(1.0, 0.98, 1.0), core * 0.5); // whiten the hottest core via mix, never raw +=
  col += boltCol;

  // weak whole-sky flash right after a strike — mix-based so it can't blow out
  col = mix(col, vec3(0.6, 0.68, 0.82), clamp(u_flash, 0.0, 1.0) * 0.05);

  vec2 vd = uv - 0.5;
  col *= 1.0 - dot(vd, vd) * 0.25;

  o = vec4(pow(max(col, 0.0), vec3(0.85)), 1.0);
}`;

export function createLightning(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;
  // Discharge state lives here, not in the shader: a slow phrase-length charge
  // envelope builds ambient glow, and kick discharges it into a freshly reseeded
  // bolt with its own slower-decaying afterglow envelope.
  let seed = Math.random();
  let charge = 0.2;
  let glow = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      charge = Math.min(1, charge + (0.06 + audio.level * 0.5) * dt);
      glow *= Math.exp(-dt * 2.6);
      if (audio.kick) {
        seed = Math.random();
        glow = 1;
        charge *= 0.15;
      }

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_charge, charge);
      gl.uniform1f(u.u_glow, glow);
      gl.uniform1f(u.u_flash, audio.kickPulse);
      gl.uniform1f(u.u_seed, seed);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_level, audio.level);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
