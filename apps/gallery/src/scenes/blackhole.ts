// 98 BLACKHOLE — a gravitationally lensed black hole. Photon paths are integrated a
// few dozen steps per pixel under a simplified Schwarzschild-like pull (acceleration
// toward the singularity ∝ 1/r²), bending the background starfield and an accretion
// disk crossing the disk plane. The disk glows with Keplerian doppler beaming (warm on
// the receding side, cool/white on the approaching side), a thin photon ring traces the
// critical radius, and a slow orbiting camera drifts around the whole scene.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2  u_res;
uniform float u_time, u_angle, u_bass, u_centroid, u_high, u_kick, u_lensK;
uniform float u_pulse0, u_pulse1, u_pulse2;
out vec4 o;

const float RS   = 1.0;
const float RPH  = 1.5;
const float RIN  = 2.0;
const float ROUT = 7.0;
const float FAR  = 40.0;

float outerFade(float r){ return 1.0 - smoothstep(ROUT - 1.2, ROUT, r); }

vec3 starField(vec3 d){
  vec3 p = d * 95.0;
  vec3 c = floor(p);
  vec3 f = p - c - 0.5;
  vec3 rnd = hash31(dot(c, vec3(12.9898, 78.233, 37.719)));
  float on = step(0.978, rnd.x);
  vec3 off = (rnd - 0.5) * 0.8;
  vec3 df = f - off;
  float core = exp(-dot(df, df) * 70.0) * on;
  float tw = 0.55 + 0.55 * rnd.y;
  vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.95, 0.85), rnd.z);
  return tint * core * tw;
}

vec3 background(vec3 d){
  vec3 stars = starField(d);
  float neb = snoise(d * 1.6 + 4.0) * 0.5 + 0.5;
  vec3 nebCol = mix(vec3(0.015, 0.012, 0.03), vec3(0.05, 0.03, 0.07), neb);
  return stars + nebCol * 0.5;
}

// Disk emission at a plane crossing point cp (world space, y≈0), polar coords (r, phi).
vec3 diskEmit(float r, float phi, vec3 cp, vec3 ro){
  float rn = clamp((r - RIN) / (ROUT - RIN), 0.0, 1.0);
  float steadyMask = smoothstep(RIN - 0.05, RIN + 0.35, r) * outerFade(r);
  float pulseMask = smoothstep(RPH * 0.82, RPH * 0.82 + 0.2, r) * outerFade(r);

  float radial = pow(1.0 - rn, 1.7);
  float innerHot = 1.0 - smoothstep(0.0, 0.16, rn);
  float filN = 0.5 + 0.5 * snoise(vec3(cos(phi) * r * 0.85, sin(phi) * r * 0.85, u_time * 0.05 + phi * 0.2));
  float filament = pow(filN, 1.0 + u_high * 3.2);

  // Keplerian prograde tangent at this point; doppler-beam brighter/cooler on the
  // approaching (toward-camera) side, dimmer/warmer on the receding side.
  vec3 tangent = normalize(vec3(-sin(phi), 0.0, cos(phi)));
  vec3 toCam = normalize(ro - cp);
  float dopp = clamp(dot(tangent, toCam), -1.0, 1.0);
  float colorTemp = clamp(0.5 + dopp * 0.42 + (u_centroid - 0.35) * 0.55, 0.0, 1.0);
  vec3 warm = vec3(1.0, 0.42, 0.12);
  vec3 cool = vec3(0.55, 0.72, 1.0);
  vec3 base = mix(warm, cool, colorTemp);
  float beam = 0.65 + 0.75 * max(dopp, 0.0);

  float bulge = 0.55 + u_bass * 0.85;
  float steady = (radial * 0.55 + innerHot * (0.5 + u_bass * 0.9) + filament * 0.4) * bulge * beam * steadyMask;

  // Kick-triggered wave racing from the inner edge down toward the photon ring.
  float pulseW = 3.4 + u_high * 2.6;
  float p0 = exp(-pow((r - u_pulse0) * pulseW, 2.0));
  float p1 = exp(-pow((r - u_pulse1) * pulseW, 2.0));
  float p2 = exp(-pow((r - u_pulse2) * pulseW, 2.0));
  float pulseGlow = (p0 + p1 + p2) * pulseMask * (1.1 + u_kick * 0.6);

  return base * steady * 1.9 + vec3(1.0, 0.92, 0.8) * pulseGlow * 1.4;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;

  float orbitR = 9.5;
  vec3 ro = vec3(sin(u_angle) * orbitR, 2.0 + sin(u_time * 0.07) * 0.4, cos(u_angle) * orbitR);
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x * rt + uv.y * up);

  vec3 pos = ro;
  vec3 dir = rd;
  float minR = 1e6;
  bool absorbed = false;
  vec3 diskGlow = vec3(0.0);

  for(int i = 0; i < 72; i++){
    float r2 = dot(pos, pos);
    float r = sqrt(r2);
    minR = min(minR, r);
    if(r < RS){ absorbed = true; break; }
    if(r > FAR) break;

    // Adaptive step: fine near the hole for stable bending, coarse far away so
    // rays that miss entirely still reach the background within the step budget.
    float stp = clamp(r * 0.14, 0.035, 0.9);
    vec3 accel = -u_lensK * pos / (r2 * r + 1e-4); // magnitude ∝ 1/r², toward center
    vec3 newDir = normalize(dir + accel * stp);
    vec3 prevPos = pos;
    pos += newDir * stp;
    dir = newDir;

    // Disk-plane (y≈0) crossing: linear-interpolate the exact crossing point and
    // light it up. A single ray can cross twice (front pass + lensed far-side pass),
    // which is exactly what paints the halo above/below the silhouette.
    if(sign(prevPos.y) != sign(pos.y)){
      float tc = prevPos.y / (prevPos.y - pos.y);
      vec3 cp = mix(prevPos, pos, tc);
      float cr = length(cp.xz);
      if(cr > RPH * 0.8 && cr < ROUT + 1.5){
        float phi = atan(cp.z, cp.x);
        diskGlow += diskEmit(cr, phi, cp, ro);
      }
    }
  }

  vec3 col = vec3(0.0);
  if(!absorbed) col += background(dir);
  col += diskGlow;

  // Photon ring: rays whose closest approach lands near the critical radius glow
  // brightly, tracing a thin ring around the shadow silhouette either way.
  float ringSharp = 9.0 + u_high * 26.0;
  float ring = exp(-pow((minR - RPH) * ringSharp, 2.0));
  vec3 ringColor = mix(vec3(1.0, 0.82, 0.55), vec3(0.65, 0.82, 1.0), clamp(u_centroid, 0.0, 1.0));
  col += ringColor * ring * (0.9 + u_kick * 0.5) * 1.6;

  o = vec4(col, 1.0);
}`;

interface Pulse {
  r: number;
  active: boolean;
}

const RIN = 2.0;
const RPH = 1.5;
const PULSE_SPEED = 1.1;
const PULSE_STOP = RPH * 0.85;

export function createBlackhole(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let angle = 0;
  let bassBreath = 0;
  const pulses: Pulse[] = [
    { r: 0, active: false },
    { r: 0, active: false },
    { r: 0, active: false },
  ];
  let pIdx = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // bass breathes both the disk pulsation (inner-edge brightness) and lens strength
      bassBreath += (audio.bass - bassBreath) * (1 - Math.exp(-dt * 0.8));
      // level sets the (slow) camera orbital speed
      angle += dt * (0.05 + audio.level * 0.1);

      if (audio.kick) {
        pulses[pIdx] = { r: RIN, active: true };
        pIdx = (pIdx + 1) % pulses.length;
      }
      for (const p of pulses) {
        if (!p.active) continue;
        p.r -= dt * PULSE_SPEED;
        if (p.r < PULSE_STOP) p.active = false;
      }

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_bass, bassBreath);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_lensK, 2.05 + bassBreath * 0.55);
      gl.uniform1f(u.u_pulse0, pulses[0].active ? pulses[0].r : -999.0);
      gl.uniform1f(u.u_pulse1, pulses[1].active ? pulses[1].r : -999.0);
      gl.uniform1f(u.u_pulse2, pulses[2].active ? pulses[2].r : -999.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.8 + audio.level * 0.35,
        exposure: 1.05 + audio.kickPulse * 0.1,
        aberration: 0.0009 + audio.change * 0.002,
        grain: 0.035,
        vignette: 1.25,
        flash: audio.kickPulse * 0.15,
        threshold: 0.65,
        time: t,
      });
    },
  };
}
