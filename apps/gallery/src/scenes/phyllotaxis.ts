// 38 PHYLLOTAXIS — sunflower seed-head. 4 000 golden-angle points placed on a 2-D
// spiral; each ring maps to a spectrum band so the head blooms and breathes with the
// music. Divergence wobbles on transitions to shimmering re-arrangement of spiral arms.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 4000;
const GOLDEN = 2.39996323; // 137.507° in radians

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform float u_divergence, u_yaw, u_scale, u_aspect;
uniform float u_centroid, u_bass, u_high, u_kickPulse, u_time;
uniform float u_spec[24];
out vec3 v_col;

void main() {
  float i    = float(gl_VertexID);
  float n    = float(${N});

  // --- phyllotaxis placement (normalised to -1..1) ---
  float ang      = i * u_divergence;
  float rad_norm = sqrt(i / max(n - 1.0, 1.0));   // 0..1
  vec2  p        = vec2(cos(ang), sin(ang)) * rad_norm;

  // slow 2-D rotation driven by centroid
  float cy = cos(u_yaw), sy = sin(u_yaw);
  p = vec2(cy * p.x - sy * p.y, sy * p.x + cy * p.y);

  // head breathes with bass + kick radial expansion
  float gs = u_scale * (0.86 + u_bass * 0.22 + u_kickPulse * 0.14);
  p *= gs;
  p.x /= u_aspect;

  gl_Position = vec4(p, 0.0, 1.0);

  // --- spectrum band from radius ring ---
  int   band    = int(clamp(rad_norm * 24.0, 0.0, 23.0));
  float bandVal = u_spec[band];

  // sparkle: high-freq energy randomly brightens seeds
  float sparkle = hash11(i * 0.1373 + u_time * 7.31) * u_high;

  // point size: band energy + bass floor + sparkle
  gl_PointSize = clamp(1.0 + bandVal * 5.0 + u_bass * 2.0 + sparkle * 3.0, 1.0, 8.0);

  // colour: cosine palette keyed on ring + centroid hue shift
  float hue    = float(band) / 24.0 + u_centroid * 0.55;
  float bright = 0.28 + bandVal * 1.3 + sparkle * 0.9 + u_kickPulse * 0.45;
  v_col = palette(hue,
    vec3(0.5, 0.5, 0.5),
    vec3(0.5, 0.5, 0.5),
    vec3(1.0, 1.0, 1.0),
    vec3(0.0, 0.33, 0.66)
  ) * bright;
}`;

const FS = `#version 300 es
precision highp float;
in  vec3 v_col;
out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  o = vec4(v_col * a, 1.0);
}`;

export function createPhyllotaxis(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri);
  const emptyVAO = gl.createVertexArray()!;

  let rw = 1,
    rh = 1;
  let yaw = 0;
  let wobble = 0; // eased additive offset on u_divergence

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },

    frame(t, dt, audio: AudioEngine) {
      // slow rotation — centroid nudges the speed
      yaw += dt * (0.04 + audio.centroid * 0.14);

      // divergence wobble: novelty spikes above 1 on musical transitions;
      // scale to ±0.01 rad maximum so the spiral reorganises but stays intact
      const wobbleTarget = Math.max(-0.01, Math.min(0.01, (audio.novelty - 1.0) * 0.006));
      wobble += (wobbleTarget - wobble) * (1 - Math.exp(-dt * 2.5));
      const div = GOLDEN + wobble;

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.uniform1f(u.u_divergence, div);
      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_scale, 0.88);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1f(u.u_time, t);
      gl.uniform1fv(u.u_spec, audio.spectrum);

      gl.bindVertexArray(emptyVAO);
      gl.drawArrays(gl.POINTS, 0, N);
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
