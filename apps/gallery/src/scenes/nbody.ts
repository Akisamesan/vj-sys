// 08 NBODY — a gravitating star swarm. ~200 point masses pull each other through a
// softened inverse-square law (Newtonian gravity, Plummer-softened at close range);
// a spinning disk of stars clumps into knots, spirals inward and drifts apart again.
// Bass sets the gravitational constant (heavy bass = fast collapse, quiet bass = lazy
// orbits), level caps cruising speed and gently dollies/yaws the camera, centroid
// tints the palette from deep space navy through magenta to gold, and each kick flings
// a random local cluster outward — gravity then reels it back in over the following
// bars. CPU O(N^2) integration, additive points through HDR PostFX.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 320;
const EPS2 = 0.14 * 0.14; // Plummer softening: caps the force at close encounters
const CENTER_PULL = 0.008; // gentle harmonic leash so a kick burst can't escape for good

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec3 a_pos;
layout(location=1) in float a_mass;
uniform float u_yaw, u_aspect, u_centroid, u_camDist;
out vec3 v_col;
void main(){
  vec3 p = a_pos;
  float cy=cos(u_yaw), sy=sin(u_yaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  const float ct = 0.6, st = 0.8; // fixed ~53deg tilt: near-overhead view of the disk
  p = vec3(p.x, ct*p.y - st*p.z, st*p.y + ct*p.z);
  float persp = 1.0/(u_camDist - p.z*0.5);
  vec2 sc = p.xy * persp * 2.3;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  float depth = 0.5 + p.z*0.15;
  gl_PointSize = clamp(persp*(30.0 + a_mass*16.0), 4.0, 16.0);
  float hue = 0.05 + u_centroid*0.5 + depth*0.12 + a_mass*0.02;
  v_col = palette(hue, vec3(0.55,0.55,0.55), vec3(0.55,0.55,0.55), vec3(0.51,0.46,0.37), vec3(0.68,0.44,0.80))
        * (0.85 + depth*0.55) * (0.95 + min(a_mass,3.0)*0.25) * 2.1;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){
  vec2 d = gl_PointCoord-0.5;
  float r2 = dot(d,d);
  if (r2 > 0.25) discard;
  float a = smoothstep(0.25, 0.0, r2);
  o = vec4(v_col*a, 1.0);
}`;

export function createNbody(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;

  const px = new Float32Array(N * 3);
  const vx = new Float32Array(N * 3);
  const mass = new Float32Array(N);
  const buf = new Float32Array(N * 4); // x,y,z,mass

  // Seed a thin spinning disk (solid-body-ish rotation) so mutual gravity has
  // angular momentum to work with: it clumps and spirals instead of just collapsing.
  for (let i = 0; i < N; i++) {
    const r = 0.25 + Math.random() * 1.45;
    const theta = Math.random() * Math.PI * 2;
    const y = (Math.random() - 0.5) * 0.45;
    px[i * 3] = Math.cos(theta) * r;
    px[i * 3 + 1] = y;
    px[i * 3 + 2] = Math.sin(theta) * r;
    const spin = 0.22 + r * 0.2;
    vx[i * 3] = -Math.sin(theta) * spin + (Math.random() - 0.5) * 0.05;
    vx[i * 3 + 1] = (Math.random() - 0.5) * 0.04;
    vx[i * 3 + 2] = Math.cos(theta) * spin + (Math.random() - 0.5) * 0.05;
    // A few heavier cores anchor local clusters; the rest are ordinary stars.
    mass[i] = i < 4 ? 3.2 + Math.random() * 2.2 : 0.6 + Math.random() * 1.0;
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
      const G = 0.02 + audio.bass * 0.34;
      const maxSpeed = 0.55 + audio.level * 1.5;

      // Kick: pick a random star, fling everything within a small radius of it
      // outward. Gravity + the soft speed cap below reel the cluster back in.
      if (audio.kick) {
        const c = (Math.random() * N) | 0;
        const ex = px[c * 3],
          ey = px[c * 3 + 1],
          ez = px[c * 3 + 2];
        const R = 0.5 + Math.random() * 0.35;
        const K = 2.0 + Math.random() * 1.0;
        for (let j = 0; j < N; j++) {
          const dx = px[j * 3] - ex,
            dy = px[j * 3 + 1] - ey,
            dz = px[j * 3 + 2] - ez;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < R * R) {
            const d = Math.sqrt(d2) + 1e-4;
            const falloff = 1 - d / R;
            const invd = (K * falloff) / d;
            vx[j * 3] += dx * invd;
            vx[j * 3 + 1] += dy * invd;
            vx[j * 3 + 2] += dz * invd;
          }
        }
      }

      for (let i = 0; i < N; i++) {
        const ix = px[i * 3],
          iy = px[i * 3 + 1],
          iz = px[i * 3 + 2];
        let ax = 0,
          ay = 0,
          az = 0;
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const dx = px[j * 3] - ix,
            dy = px[j * 3 + 1] - iy,
            dz = px[j * 3 + 2] - iz;
          const d2 = dx * dx + dy * dy + dz * dz;
          // Softened gravity: a = G*m_j*(dx,dy,dz)/(d^2+eps^2)^1.5, i.e. direction
          // (dx,dy,dz)/d scaled by magnitude G*m_j/(d^2+eps^2).
          const invd3 = (G * mass[j]) / Math.pow(d2 + EPS2, 1.5);
          ax += dx * invd3;
          ay += dy * invd3;
          az += dz * invd3;
        }
        ax -= ix * CENTER_PULL;
        ay -= iy * CENTER_PULL;
        az -= iz * CENTER_PULL;

        let vxi = vx[i * 3] + ax * fdt,
          vyi = vx[i * 3 + 1] + ay * fdt,
          vzi = vx[i * 3 + 2] + az * fdt;

        // Soft speed cap: excess above maxSpeed decays exponentially rather than
        // snapping instantly, so a kick burst visibly expands before it settles.
        const sp = Math.hypot(vxi, vyi, vzi);
        if (sp > maxSpeed) {
          const relax = Math.exp(-fdt * 2.2);
          const target = maxSpeed + (sp - maxSpeed) * relax;
          const k = target / sp;
          vxi *= k;
          vyi *= k;
          vzi *= k;
        }
        vx[i * 3] = vxi;
        vx[i * 3 + 1] = vyi;
        vx[i * 3 + 2] = vzi;

        const nx = ix + vxi * fdt,
          ny = iy + vyi * fdt,
          nz = iz + vzi * fdt;
        px[i * 3] = nx;
        px[i * 3 + 1] = ny;
        px[i * 3 + 2] = nz;
        buf[i * 4] = nx;
        buf[i * 4 + 1] = ny;
        buf[i * 4 + 2] = nz;
        buf[i * 4 + 3] = mass[i];
      }

      yaw += fdt * (0.05 + audio.level * 0.12);
      const camDist = 4.2 - audio.level * 0.6;

      post.bind();
      gl.clearColor(0.01, 0.012, 0.03, 1);
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
      gl.uniform1f(u.u_camDist, camDist);
      gl.drawArrays(gl.POINTS, 0, N);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.0 + audio.bass * 0.35 + audio.level * 0.2,
        exposure: 1.1 + audio.kickPulse * 0.12,
        aberration: 0.001 + audio.change * 0.002,
        grain: 0.035,
        vignette: 1.2,
        flash: audio.kickPulse * 0.15,
        // high (sharpness): brighter highs raise the threshold so only the
        // hottest cores bloom, reading crisper; quiet highs let more glow.
        threshold: 0.22 + audio.high * 0.3,
        time: t,
      });
    },
  };
}
