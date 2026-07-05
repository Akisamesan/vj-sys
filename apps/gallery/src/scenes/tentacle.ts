// 48 TENTACLE — a bouquet of eight capsule-chain tentacles raymarched from a
// shared base, undulating with the music. Each joint's bend is a sine wave
// keyed on joint index / time / an audio-driven phase, and the whole chain is
// fused with smooth-min (per-tentacle joints, then across tentacles). Bass
// deepens the sway amplitude, level speeds the phase's wave-propagation along
// the limb, highs sharpen the tip's tremor, kicks drive a structural
// contract-then-extend spring impulse (no flash/strobe), centroid rotates the
// palette from fleshy tones to bioluminescent glow. Fragment raymarch through
// HDR PostFX.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_angle, u_bass, u_level, u_high, u_centroid, u_wave, u_lenScale, u_kickPulse;
out vec4 o;

const int NT = 8;
const int NJ = 5;

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0-h);
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r){
  vec3 pa = p-a, ba = b-a;
  float h = clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0);
  return length(pa - ba*h) - r;
}

// Fixed per-tentacle frame: root anchor, growth direction, and a side basis
// for the bend offset. Deterministic in the tentacle index so the whole
// bouquet stays stable frame to frame.
void tentacleBasis(float fi, out vec3 root, out vec3 tanv, out vec3 sideA, out vec3 sideB, out float lenBase){
  float ang = fi*0.7854 + 0.35*sin(u_time*0.045 + fi*1.3);
  vec3 outward = vec3(cos(ang), 0.0, sin(ang));
  float ringR = 0.55 + 0.15*sin(fi*1.7 + 2.0);
  root = outward*ringR + vec3(0.0, -0.55, 0.0);
  vec3 upv = vec3(0.0, 1.0, 0.0);
  tanv = normalize(upv*0.72 + outward*0.58);
  sideA = normalize(cross(tanv, upv));
  sideB = cross(tanv, sideA);
  lenBase = 1.3 + 0.35*sin(fi*2.3 + 1.0);
}

// Per-joint bend offset in the tentacle's local (sideA, sideB) plane. segT is
// 0 at the root and 1 at the tip; jIdx is the joint index (for phase
// variety). u_wave is the audio-phase-driven traveling wave, u_bass sets
// sway amplitude, u_high sharpens the tip's frequency more than the root's.
vec3 jointBend(float fi, float segT, float jIdx){
  float freqTip = mix(1.3, 4.8, u_high);
  float freq = mix(1.3, freqTip, segT*segT);
  float phase = u_wave*2.1 - segT*3.3 + fi*1.65;
  float amp = (0.09 + u_bass*0.52) * segT;
  float bx = sin(phase*freq + jIdx*0.85) * amp;
  float bz = cos(phase*freq*0.83 + jIdx*0.85 + fi*1.35) * amp * 0.7;
  return vec3(bx, 0.0, bz);
}

float de(vec3 p){
  vec3 boundC = vec3(0.0, 0.0, 0.0);
  float dBound = length(p - boundC) - 3.4;
  if(dBound > 0.0) return dBound;

  float d = 1e9;
  for(int i=0;i<NT;i++){
    float fi = float(i);
    vec3 root, tanv, sideA, sideB; float lenBase;
    tentacleBasis(fi, root, tanv, sideA, sideB, lenBase);
    float lenTot = lenBase * u_lenScale;

    vec3 prevJ = root;
    float dTent = 1e9;
    for(int j=0;j<NJ;j++){
      float jf = float(j+1);
      float segT = jf/float(NJ);
      vec3 base = root + tanv*lenTot*segT;
      vec3 bend = jointBend(fi, segT, jf);
      vec3 nextJ = base + sideA*bend.x + sideB*bend.z;

      float rBase = mix(0.11, 0.035, float(j)/float(NJ));
      float rNext = mix(0.11, 0.035, segT);
      float r = (rBase+rNext)*0.5 * (1.0 + (1.0-u_lenScale)*0.4);

      float dCap = sdCapsule(p, prevJ, nextJ, r);
      dTent = smin(dTent, dCap, 0.05);
      prevJ = nextJ;
    }
    d = smin(d, dTent, 0.09);
  }
  return d;
}

vec3 calcNormal(vec3 p){
  const float e = 0.0015;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy*de(p+k.xyy*e) +
    k.yyx*de(p+k.yyx*e) +
    k.yxy*de(p+k.yxy*e) +
    k.xxx*de(p+k.xxx*e));
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  float ca = cos(u_angle), sa = sin(u_angle);
  vec3 ro = vec3(sa*4.2, 0.4, ca*4.2);
  vec3 target = vec3(0.0, 0.05, 0.0);
  vec3 fw = normalize(target - ro);
  vec3 rt = normalize(cross(vec3(0.0,1.0,0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x*rt + uv.y*up);

  float tRay = 0.001;
  float hit = -1.0;
  for(int i=0;i<68;i++){
    vec3 p = ro + rd*tRay;
    float d = de(p);
    if(d < 0.0016){ hit = tRay; break; }
    tRay += max(d, 0.0025);
    if(tRay > 13.0) break;
  }

  // Background: deep organic dark, faint radial falloff (never pure black).
  vec3 col = vec3(0.014, 0.018, 0.03) + vec3(0.01, 0.014, 0.02)*(1.0 - length(uv));

  if(hit > 0.0){
    vec3 p = ro + rd*hit;
    vec3 nrm = calcNormal(p);

    vec3 sun = normalize(vec3(0.5, 0.8, 0.35));
    float diff = clamp(dot(nrm, sun), 0.0, 1.0);
    float fill = clamp(dot(nrm, -sun)*0.35 + 0.55, 0.0, 1.0);
    float ndotv = clamp(dot(nrm, -rd), 0.0, 1.0);
    float fres = pow(1.0 - ndotv, 3.2);
    vec3 hvec = normalize(sun - rd);
    float spec = pow(clamp(dot(nrm, hvec), 0.0, 1.0), 30.0);

    // Palette: flesh tones at low centroid, bioluminescent glow at high.
    float pSeed = length(p - vec3(0.0, -0.3, 0.0))*0.55 + u_centroid*0.9 + u_time*0.015;
    vec3 base = palette(pSeed,
      vec3(0.5, 0.42, 0.4),
      vec3(0.42, 0.34, 0.36),
      vec3(1.0, 0.9, 0.85),
      vec3(0.02 + u_centroid*0.5, 0.12 + u_centroid*0.35, 0.32 + u_centroid*0.45));

    col  = base * (0.14*fill + diff*0.82);
    col += base * spec * 0.4;
    col += vec3(0.55, 0.85, 0.75) * fres * (0.45 + u_level*0.35);
    // Smooth decay-driven bioluminescent accent on kick (envelope, not a flash).
    col += base * fres * u_kickPulse * 0.3;

    float fog = 1.0 - exp(-hit*0.15);
    col = mix(col, vec3(0.014, 0.018, 0.03), fog*0.55);
  }

  col *= 1.0 + u_level*0.12;
  o = vec4(col, 1.0);
}`;

export function createTentacle(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let angle = 0;
  let wave = 0;

  // Contract-then-extend impulse: an underdamped spring on the tentacle
  // length scale. A kick knocks the velocity down (contraction), the spring
  // pulls it back through 1.0 (overshoot = extension) and settles — a
  // structural response, not a flash.
  let lenScale = 1;
  let lenVel = 0;
  const SPRING_K = 46;
  const SPRING_C = 8.4;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },

    frame(t, dt, audio: AudioEngine) {
      angle += dt * (0.05 + audio.level * 0.09);
      // Baseline drift keeps the wave propagating even in silence (BLACK/STATIC).
      wave += dt * (0.55 + audio.level * 2.3);

      if (audio.kick) lenVel -= 3.6;
      const acc = -SPRING_K * (lenScale - 1) - SPRING_C * lenVel;
      lenVel += acc * dt;
      lenScale += lenVel * dt;
      if (lenScale < 0.55) {
        lenScale = 0.55;
        lenVel = Math.max(lenVel, 0);
      } else if (lenScale > 1.4) {
        lenScale = 1.4;
        lenVel = Math.min(lenVel, 0);
      }

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_wave, wave);
      gl.uniform1f(u.u_lenScale, lenScale);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.85 + audio.level * 0.4,
        exposure: 1.1 + audio.kickPulse * 0.15,
        aberration: 0.0007 + audio.change * 0.003,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.22,
        threshold: 0.62,
        time: t,
      });
    },
  };
}
