// 07 BOIDS — a 3D murmuration. Classic Reynolds flocking (separation, alignment,
// cohesion) on a few hundred agents; bass quickens the flight, highs tighten the
// turns, kicks scatter the flock and the centroid colours it. An orbiting camera shows
// the swarm in depth. CPU-integrated, additive points through HDR PostFX.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 600;
const BOUND = 3.2;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec3 a_pos;
layout(location=1) in float a_spd;
uniform float u_yaw, u_aspect, u_centroid;
out vec3 v_col;
void main(){
  vec3 p = a_pos;
  float cy=cos(u_yaw), sy=sin(u_yaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  p = vec3(p.x, 0.92*p.y - 0.15*p.z, 0.15*p.y + 0.92*p.z);  // slight tilt
  float persp = 1.0/(5.0 - p.z*0.6);
  vec2 sc = p.xy * persp * 2.4;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  float depth = 0.5 + p.z*0.15;
  gl_PointSize = clamp(persp*34.0, 2.0, 7.0);
  v_col = palette(u_centroid*0.5 + a_spd*0.6 + 0.05, vec3(0.5,0.5,0.6), vec3(0.5,0.5,0.4), vec3(1.0), vec3(0.0,0.2,0.45)) * (0.4 + depth);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){
  vec2 d = gl_PointCoord-0.5; if(dot(d,d)>0.25) discard;
  o = vec4(v_col, 1.0);
}`;

export function createBoids(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const px = new Float32Array(N * 3);
  const vx = new Float32Array(N * 3);
  const buf = new Float32Array(N * 4); // x,y,z,speed

  for (let i = 0; i < N; i++) {
    px[i * 3] = (Math.random() - 0.5) * 4;
    px[i * 3 + 1] = (Math.random() - 0.5) * 4;
    px[i * 3 + 2] = (Math.random() - 0.5) * 4;
    vx[i * 3] = Math.random() - 0.5;
    vx[i * 3 + 1] = Math.random() - 0.5;
    vx[i * 3 + 2] = Math.random() - 0.5;
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;
  let yaw = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);
      const maxSpeed = 0.9 + audio.bass * 1.8;
      const align = 0.07 + audio.high * 0.06;
      const cohese = 0.035;
      const separate = 0.07 + (audio.kick ? 0.25 : 0);
      const perceive = 1.5;
      const p2 = perceive * perceive;

      for (let i = 0; i < N; i++) {
        let ax = 0,
          ay = 0,
          az = 0; // alignment
        let cx = 0,
          cy = 0,
          cz = 0; // cohesion
        let sx = 0,
          sy = 0,
          sz = 0; // separation
        let count = 0;
        const ix = px[i * 3],
          iy = px[i * 3 + 1],
          iz = px[i * 3 + 2];
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const dx = px[j * 3] - ix,
            dy = px[j * 3 + 1] - iy,
            dz = px[j * 3 + 2] - iz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < p2) {
            ax += vx[j * 3];
            ay += vx[j * 3 + 1];
            az += vx[j * 3 + 2];
            cx += px[j * 3];
            cy += px[j * 3 + 1];
            cz += px[j * 3 + 2];
            const inv = 1 / (d2 + 0.001);
            sx -= dx * inv;
            sy -= dy * inv;
            sz -= dz * inv;
            count++;
          }
        }
        let vxi = vx[i * 3],
          vyi = vx[i * 3 + 1],
          vzi = vx[i * 3 + 2];
        if (count > 0) {
          vxi += (ax / count - vxi) * align + (cx / count - ix) * cohese + sx * separate;
          vyi += (ay / count - vyi) * align + (cy / count - iy) * cohese + sy * separate;
          vzi += (az / count - vzi) * align + (cz / count - iz) * cohese + sz * separate;
        }
        // gentle pull to center to stay in frame
        vxi -= ix * 0.006;
        vyi -= iy * 0.006;
        vzi -= iz * 0.006;
        let sp = Math.hypot(vxi, vyi, vzi);
        if (sp > maxSpeed) {
          const k = maxSpeed / sp;
          vxi *= k;
          vyi *= k;
          vzi *= k;
          sp = maxSpeed;
        }
        vx[i * 3] = vxi;
        vx[i * 3 + 1] = vyi;
        vx[i * 3 + 2] = vzi;
        let nx = ix + vxi * fdt * 2.0,
          ny = iy + vyi * fdt * 2.0,
          nz = iz + vzi * fdt * 2.0;
        // soft wrap at bounds
        if (nx > BOUND) nx -= 2 * BOUND;
        else if (nx < -BOUND) nx += 2 * BOUND;
        if (ny > BOUND) ny -= 2 * BOUND;
        else if (ny < -BOUND) ny += 2 * BOUND;
        if (nz > BOUND) nz -= 2 * BOUND;
        else if (nz < -BOUND) nz += 2 * BOUND;
        px[i * 3] = nx;
        px[i * 3 + 1] = ny;
        px[i * 3 + 2] = nz;
        buf[i * 4] = nx;
        buf[i * 4 + 1] = ny;
        buf[i * 4 + 2] = nz;
        buf[i * 4 + 3] = sp / maxSpeed;
      }

      yaw += fdt * (0.15 + audio.level * 0.4);

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.drawArrays(gl.POINTS, 0, N);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.9 + audio.level * 0.5,
        exposure: 1.1 + audio.kickPulse * 0.25,
        aberration: 0.001 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.4,
        threshold: 0.55,
        time: t,
      });
    },
  };
}
