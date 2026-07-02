// 78 ATTRACTOR — a Lorenz strange attractor as a living point cloud. Thousands of
// particles ride the chaotic flow, tracing the butterfly; bass widens the wings (the
// ρ parameter), level spins the view, and the centroid colours the cloud. CPU-
// integrated, uploaded each frame, drawn additively through HDR PostFX.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 14000;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec3 a_pos;
uniform float u_angle, u_tilt, u_aspect, u_centroid, u_scale;
out vec3 v_col;
void main(){
  vec3 p = a_pos;
  float ca=cos(u_angle), sa=sin(u_angle);
  p = vec3(ca*p.x + sa*p.z, p.y, -sa*p.x + ca*p.z);   // yaw
  float ct=cos(u_tilt), si=sin(u_tilt);
  p = vec3(p.x, ct*p.y - si*p.z, si*p.y + ct*p.z);     // pitch
  vec2 sc = p.xy * u_scale;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  float depth = 0.5 + p.z*0.5;
  gl_PointSize = clamp(2.5 - p.z*0.6, 1.0, 4.0);
  float hue = u_centroid*0.5 + depth*0.4 + 0.05;
  v_col = palette(hue, vec3(0.5,0.5,0.6), vec3(0.5,0.5,0.4), vec3(1.0), vec3(0.0,0.2,0.45)) * (0.25 + depth*0.5);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

export function createAttractor(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const pos = new Float32Array(N * 3); // world (Lorenz) coords
  const buf = new Float32Array(N * 3); // scaled/centered for upload

  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 20;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 20;
    pos[i * 3 + 2] = 20 + (Math.random() - 0.5) * 20;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;
  let angle = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const sigma = 10,
        beta = 2.667;
      const rho = 28 + audio.bass * 16;
      const h = 0.005;
      const steps = 3;
      for (let i = 0; i < N; i++) {
        let x = pos[i * 3],
          y = pos[i * 3 + 1],
          z = pos[i * 3 + 2];
        for (let s = 0; s < steps; s++) {
          const dx = sigma * (y - x);
          const dy = x * (rho - z) - y;
          const dz = x * y - beta * z;
          x += dx * h;
          y += dy * h;
          z += dz * h;
        }
        pos[i * 3] = x;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = z;
        buf[i * 3] = x * 0.03;
        buf[i * 3 + 1] = (z - 25) * 0.03;
        buf[i * 3 + 2] = y * 0.03;
      }

      angle += dt * (0.15 + audio.level * 0.5);

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_tilt, 0.3 + Math.sin(t * 0.1) * 0.2);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_scale, 1.5);
      gl.drawArrays(gl.POINTS, 0, N);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.0 + audio.level * 0.5,
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
