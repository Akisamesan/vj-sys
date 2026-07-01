// 42 LISSAJOUS — 3D parametric Lissajous knot. Integer-ish frequency ratios shift with
// mid-range energy, continuously re-weaving the glowing neon curve into new closed knots.
// Bass breathes the scale; kicks flash; high adds shimmer; bloom neonifies the trace.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 2000;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform float u_fx, u_fy, u_fz;
uniform float u_px, u_py, u_pz;
uniform float u_yaw, u_pitch, u_scale;
uniform float u_aspect, u_centroid, u_kick, u_bass, u_high, u_time;
out vec3 v_col;
void main(){
  float s = float(gl_VertexID) / float(${N - 1}) * 6.28318530718;
  float x = sin(u_fx * s + u_px);
  float y = sin(u_fy * s + u_py);
  float z = sin(u_fz * s + u_pz);
  // subtle high-frequency shimmer along the radial direction
  vec3 p = vec3(x, y, z);
  float plen = length(p);
  float shimmer = u_high * 0.04 * sin(s * 31.0 + u_time * 3.7);
  if(plen > 0.001) p += shimmer * (p / plen);
  // yaw rotation
  float cy = cos(u_yaw), sy = sin(u_yaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  // pitch rotation
  float cp = cos(u_pitch), sp = sin(u_pitch);
  p = vec3(p.x, cp*p.y - sp*p.z, sp*p.y + cp*p.z);
  // perspective projection (matches platonic.ts)
  float persp = 1.0 / (2.6 - p.z * 0.4);
  vec2 sc = p.xy * u_scale * (1.0 + u_bass * 0.15) * persp;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  // colour: hue from parameter position + centroid, brightness from depth + kick + bass
  float depth = 0.5 + p.z * 0.4;
  float hue = u_centroid * 0.6 + (s / 6.28318) * 0.4;
  vec3 col = palette(hue,
    vec3(0.5), vec3(0.5),
    vec3(1.0, 0.9, 0.8),
    vec3(0.0, 0.33, 0.66));
  col *= (0.45 + depth * 0.65) * (1.0 + u_kick * 1.2) * (0.8 + u_bass * 0.5);
  v_col = col;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Integer options for Lissajous frequency ratios (2..5 guarantees closed knots)
const FREQ_OPTS = [2, 3, 4, 5] as const;

export function createLissajous(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri);

  // Empty VAO — geometry is fully procedural via gl_VertexID
  const vao = gl.createVertexArray()!;

  let rw = 1,
    rh = 1;
  let yaw = 0,
    pitch = 0;
  let scale = 0.42;

  // Current (eased) and target frequency ratios
  let fx = 2,
    fy = 3,
    fz = 4;
  let fxT = 2,
    fyT = 3,
    fzT = 4;

  // Animated phase offsets give the knot a slow drift even without audio
  let px = 0,
    py = 0.5,
    pz = 1.2;

  let lastFreqChange = -10;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },

    frame(t, dt, audio: AudioEngine) {
      // Smooth-ease current frequencies toward their targets (slow morph, no jitter)
      const fk = 1 - Math.exp(-dt * 1.5);
      fx += (fxT - fx) * fk;
      fy += (fyT - fy) * fk;
      fz += (fzT - fz) * fk;

      // Pick new frequency targets when mid energy is notable or a snare hits
      if ((audio.mid > 0.32 || audio.snarePulse > 0.45) && t - lastFreqChange > 4) {
        // Derive targets from spectrum bands so they vary with the music
        const iX = Math.floor(Math.max(0, Math.min(0.9999, audio.spectrum[3])) * 4);
        const iY = Math.floor(Math.max(0, Math.min(0.9999, audio.spectrum[9])) * 4);
        const iZ = Math.floor(Math.max(0, Math.min(0.9999, audio.spectrum[15])) * 4);
        fxT = FREQ_OPTS[iX];
        fyT = FREQ_OPTS[iY];
        fzT = FREQ_OPTS[iZ];
        // Prevent degenerate flat curves from consecutive equal frequencies
        if (fxT === fyT) fyT = FREQ_OPTS[(iY + 1) % 4];
        if (fyT === fzT) fzT = FREQ_OPTS[(iZ + 2) % 4];
        lastFreqChange = t;
      }

      // Animate phase offsets for gentle continuous drift
      px += dt * 0.11;
      py += dt * 0.07;
      pz += dt * 0.09;

      // Rotation speed driven by overall level
      const rotSpeed = 0.18 + audio.level * 0.7;
      yaw += dt * rotSpeed;
      pitch += dt * 0.13;

      // Scale breathes with bass
      scale += (0.42 + audio.bass * 0.22 - scale) * (1 - Math.exp(-dt * 5));

      // --- Render ---
      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.uniform1f(u.u_fx, fx);
      gl.uniform1f(u.u_fy, fy);
      gl.uniform1f(u.u_fz, fz);
      gl.uniform1f(u.u_px, px);
      gl.uniform1f(u.u_py, py);
      gl.uniform1f(u.u_pz, pz);
      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_pitch, pitch);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_time, t);

      gl.bindVertexArray(vao);
      gl.drawArrays(gl.LINE_STRIP, 0, N);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.1 + audio.level * 0.5,
        exposure: 1.1 + audio.kickPulse * 0.3,
        aberration: 0.001 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.4,
        threshold: 0.5,
        time: t,
      });
    },
  };
}
