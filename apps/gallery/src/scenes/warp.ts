// 05 WARP — a hyperspace starfield. Thousands of stars stream past the camera; on
// each kick the field punches into warp and stars stretch into long radial streaks.
// Club-ready and punchy. Attributeless GL_LINES (head/tail per star), additive
// through PostFX for the glow. Bass sets cruise speed, centroid tints the field.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const STARS = 20000;
const RANGE = 4.0;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform float u_travel, u_streak, u_aspect, u_centroid, u_time;
out vec3 v_col;
void main(){
  int star = gl_VertexID / 2;
  int tail = gl_VertexID % 2;
  vec3 h = hash31(float(star)*1.7 + 3.1);
  vec2 xy = (h.xy*2.0-1.0) * 1.4;
  float zphase = h.z * ${RANGE.toFixed(1)};
  float z = mod(zphase - u_travel, ${RANGE.toFixed(1)});
  z += float(tail) * u_streak;                  // tail sits further away
  z = max(z, 0.06);
  vec2 p = xy / z;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = 2.0;
  float bright = clamp(0.35/z, 0.0, 2.5) * (1.0 - float(tail)*0.7);
  float hue = h.x*0.3 + u_centroid*0.6 + u_time*0.02;
  vec3 col = palette(hue, vec3(0.6,0.7,0.9), vec3(0.4,0.3,0.3), vec3(1.0), vec3(0.0,0.2,0.5));
  v_col = col * bright;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

export function createWarp(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri);
  const vao = gl.createVertexArray()!;
  let rw = 1,
    rh = 1;
  let travel = 0;
  let streak = 0.02;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const speed = 0.6 + audio.bass * 2.4 + audio.level * 1.0;
      travel += dt * speed;
      const targetStreak = 0.02 + audio.kickPulse * 0.9 + audio.bass * 0.2;
      streak += (targetStreak - streak) * (1 - Math.exp(-dt * 10));

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_travel, travel);
      gl.uniform1f(u.u_streak, streak);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_time, t);
      gl.drawArrays(gl.LINES, 0, STARS * 2);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.0 + audio.level * 0.6,
        exposure: 1.1 + audio.kickPulse * 0.3,
        aberration: 0.0012 + audio.change * 0.003,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.6,
        threshold: 0.5,
        time: t,
      });
    },
  };
}
