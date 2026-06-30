// 37 INTERFERENCE — ripple-tank: N circular wave sources emit concentric waves whose
// superposition forms moving moiré interference fringes. Sources orbit slowly and get
// jolted on kicks. Pure fragment scene.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 6;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2  u_res;
uniform float u_time, u_speed, u_freq, u_high, u_centroid;
uniform float u_ringT, u_kickPulse;
uniform vec2  u_src[6];
uniform float u_phase[6];
uniform float u_amp[6];
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  // aspect-correct UV, same coordinate space as source positions
  vec2 p = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0) * 3.0;

  float field = 0.0;
  for (int i = 0; i < 6; i++) {
    float d = length(p - u_src[i]);
    d = max(d, 1e-4);
    float wave = cos(d * u_freq - u_time * u_speed + u_phase[i]) / (1.0 + d * 0.6);
    field += wave * u_amp[i];
  }
  field /= 6.0;

  // Kick ring: expanding concentric pulse from origin
  if (u_kickPulse > 0.01) {
    float dc = max(length(p), 1e-4);
    float ringWave = cos(dc * u_freq - u_ringT) * exp(-dc * 0.5);
    field += ringWave * u_kickPulse * 0.35;
  }

  // Map field (-1..1) to colour
  float t01 = field * 0.5 + 0.5;
  float hue = t01 + u_centroid * 0.45;
  vec3 col = palette(hue,
    vec3(0.5, 0.5, 0.5),
    vec3(0.5, 0.5, 0.5),
    vec3(1.0, 1.0, 1.0),
    vec3(0.0, 0.33, 0.67)
  );

  // Sharp fringe highlights where |field| is near 0 (dark nodes → bright lines)
  float sharpness = 2.5 + u_high * 9.0;
  float fringe = smoothstep(1.0, 0.0, abs(field) * sharpness);
  fringe = fringe * fringe;
  col += vec3(fringe * 0.65);

  // Vignette
  vec2 vig = uv - 0.5;
  col *= 1.0 - dot(vig, vig) * 1.3;

  // Gamma
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.88)), 1.0);
}`;

export function createInterference(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;

  // Static random-ish phases per source (golden-angle spread)
  const phase = new Float32Array(N);
  for (let i = 0; i < N; i++) phase[i] = (i * 2.3999) % (Math.PI * 2);

  // Orbit parameters: radius, initial angle, angular speed
  const orbitR = new Float32Array([0.55, 0.85, 1.05, 0.65, 0.95, 0.4]);
  const orbitOff = new Float32Array(N);
  const orbitSpd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    orbitOff[i] = (i / N) * Math.PI * 2;
    orbitSpd[i] = 0.06 + (i % 3) * 0.035;
  }

  // Per-source jitter (x,y) that spikes on kick then decays
  const jitter = new Float32Array(N * 2);
  const srcPos = new Float32Array(N * 2);
  const amp = new Float32Array(N);

  // Kick ring state
  let ringT = 100.0; // start large so ring is invisible until first kick
  let kickRingPulse = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // Fresh kick: jolt source positions + spawn new ring
      if (audio.kick) {
        for (let i = 0; i < N; i++) {
          jitter[i * 2] += (Math.random() - 0.5) * 0.38;
          jitter[i * 2 + 1] += (Math.random() - 0.5) * 0.38;
        }
        ringT = 0;
        kickRingPulse = 1;
      }

      // Decay jitter and ring pulse
      const jDecay = Math.exp(-dt * 3.5);
      for (let i = 0; i < N * 2; i++) jitter[i] *= jDecay;
      kickRingPulse *= Math.exp(-dt * 2.5);
      ringT += dt * 7.0;

      // Build animated source positions: orbit + jitter
      for (let i = 0; i < N; i++) {
        const angle = orbitOff[i] + t * orbitSpd[i];
        srcPos[i * 2] = Math.cos(angle) * orbitR[i] + jitter[i * 2];
        srcPos[i * 2 + 1] = Math.sin(angle) * orbitR[i] + jitter[i * 2 + 1];
      }

      // Per-source amplitude: sample a few spectrum bands so each source pulses with music
      const spec = audio.spectrum;
      for (let i = 0; i < N; i++) {
        const band = Math.min(23, 3 + i * 3);
        amp[i] = 0.45 + spec[band] * 1.6;
      }

      // Audio → uniform mappings
      const freq = 8.0 + audio.bass * 18.0; // bass → ring density (tighter = more rings)
      const speed = 0.7 + audio.level * 2.8; // level → propagation speed

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, rw, rh);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);

      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_speed, speed);
      gl.uniform1f(u.u_freq, freq);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_ringT, ringT);
      gl.uniform1f(u.u_kickPulse, kickRingPulse);
      gl.uniform2fv(u.u_src, srcPos);
      gl.uniform1fv(u.u_phase, phase);
      gl.uniform1fv(u.u_amp, amp);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
