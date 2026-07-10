// 79 ROSSLER — a Rössler strange attractor (dx=-y-z, dy=x+a·y, dz=b+z·(x-c),
// a=b=0.2, c=5.7) as a swarm of RK4-integrated particles. Unlike 78 ATTRACTOR's
// symmetric Lorenz wings or 80 CLIFFORD's flat lace, Rössler's orbit is a single
// thin ribbon that spirals outward in a near-planar disc and then folds sharply
// over itself once it crosses the c threshold — the view here tilts the fold
// toward the camera and lets a fading feedback trail draw out that ribbon as a
// continuous streak rather than a static point cloud. Deep-space purple/cyan,
// additive points, restrained HDR bloom.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 900; // resident particles — "several hundred to a thousand" per spec
const SUBSTEPS = 4; // RK4 sub-steps integrated per frame
const RESPAWN_FRACTION = 8; // kick respawns roughly N/RESPAWN_FRACTION particles

// Classic Rössler parameters. Bass drifts a/b/c a little around this anchor —
// enough to breathe the shape without leaving the bounded chaotic regime.
const A_BASE = 0.2,
  A_AMP = 0.035;
const B_BASE = 0.2,
  B_AMP = 0.035;
const C_BASE = 5.7,
  C_AMP = 0.6;

// Rough attractor extent (a=b=0.2, c=5.7): x∈[-9,10], y∈[-11,8], z∈[0,23].
// Used to center/scale world coords into a roughly unit-ish cloud.
const CX = 0.5,
  CY = -1.5,
  CZ = 11.0;
const WORLD_SCALE = 0.088;

// A blown-up particle is recycled rather than left to poison the buffer with
// NaN/Infinity if a larger audio-driven h ever destabilises one RK4 step.
const BLOWUP_RADIUS = 80;

const FADE_FS = `#version 300 es
precision highp float;
out vec4 o;
void main(){ o = vec4(0.0, 0.0, 0.0, 1.0); }`;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec3 a_pos;
uniform float u_angle, u_tilt, u_aspect, u_centroid, u_scale, u_high;
out vec3 v_col;
void main(){
  vec3 p = a_pos;
  float ca=cos(u_angle), sa=sin(u_angle);
  p = vec3(ca*p.x + sa*p.z, p.y, -sa*p.x + ca*p.z);   // yaw
  float ct=cos(u_tilt), si=sin(u_tilt);
  p = vec3(p.x, ct*p.y - si*p.z, si*p.y + ct*p.z);     // pitch, tilts the fold into view
  vec2 sc = p.xy * u_scale;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  float depth = 0.5 + p.z*0.5;
  gl_PointSize = clamp(3.0 - u_high*1.1 - depth*0.6, 1.3, 3.4);
  float hue = fract(u_centroid*0.6 + depth*0.35 + 0.62);
  vec3 col = palette(hue, vec3(0.5,0.45,0.6), vec3(0.5,0.5,0.4), vec3(1.0,0.9,1.1), vec3(0.7,0.4,0.15));
  float envelope = (0.55 + depth*0.55) * (1.7 + u_high*1.1); // explicit brightness — additive points read thin otherwise
  v_col = col * envelope;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float m = smoothstep(0.5, 0.0, length(d)); // soft round splat, avoids hard square edges
  o = vec4(v_col * m, 1.0);
}`;

export function createRossler(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const fadeProg = program(gl, FULLSCREEN_VS, FADE_FS);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const pz = new Float32Array(N);
  const buf = new Float32Array(N * 3); // scaled/centered upload buffer

  function seedParticle(i: number): void {
    px[i] = (Math.random() - 0.5) * 6;
    py[i] = (Math.random() - 0.5) * 6;
    pz[i] = Math.random() * 4;
  }
  for (let i = 0; i < N; i++) seedParticle(i);

  // Warm up so frame 1 already shows the settled ribbon instead of a transient
  // ball of points converging onto the attractor.
  {
    const a = A_BASE,
      b = B_BASE,
      c = C_BASE,
      h = 0.02;
    for (let s = 0; s < 220; s++) {
      for (let i = 0; i < N; i++) {
        const x = px[i],
          y = py[i],
          z = pz[i];
        const k1x = -y - z,
          k1y = x + a * y,
          k1z = b + z * (x - c);
        const x2 = x + (h / 2) * k1x,
          y2 = y + (h / 2) * k1y,
          z2 = z + (h / 2) * k1z;
        const k2x = -y2 - z2,
          k2y = x2 + a * y2,
          k2z = b + z2 * (x2 - c);
        const x3 = x + (h / 2) * k2x,
          y3 = y + (h / 2) * k2y,
          z3 = z + (h / 2) * k2z;
        const k3x = -y3 - z3,
          k3y = x3 + a * y3,
          k3z = b + z3 * (x3 - c);
        const x4 = x + h * k3x,
          y4 = y + h * k3y,
          z4 = z + h * k3z;
        const k4x = -y4 - z4,
          k4y = x4 + a * y4,
          k4z = b + z4 * (x4 - c);
        px[i] = x + (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
        py[i] = y + (h / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
        pz[i] = z + (h / 6) * (k1z + 2 * k2z + 2 * k3z + k4z);
      }
    }
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;
  let angle = 0.6;
  let aF = A_BASE,
    bF = B_BASE,
    cF = C_BASE;
  let needsClear = true;
  let respawnCursor = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
      needsClear = true; // fresh HDR target after realloc — clear before first fade/draw
    },
    frame(t, dt, audio: AudioEngine) {
      // bass -> a,b,c: slow continuous breathing of the attractor's shape, own
      // low-pass on top of the engine smoothing so it reads as drift not pump.
      const kSlow = 1 - Math.exp(-dt * 0.6);
      aF += (A_BASE + (audio.bass - 0.5) * A_AMP - aF) * kSlow;
      bF += (B_BASE + (audio.bass - 0.5) * B_AMP - bF) * kSlow;
      cF += (C_BASE + (audio.bass - 0.5) * C_AMP - cF) * kSlow;

      // level -> integration time step (how fast the orbit advances).
      const h = 0.008 + audio.level * 0.014;

      // kick -> respawn a rolling slice of particles to fresh random initial
      // conditions, refreshing the trail with new arcs (structural trigger,
      // no flash).
      if (audio.kick > 0) {
        const count = Math.ceil(N / RESPAWN_FRACTION);
        for (let n = 0; n < count; n++) {
          seedParticle(respawnCursor);
          respawnCursor = (respawnCursor + 1) % N;
        }
      }

      for (let i = 0; i < N; i++) {
        let x = px[i],
          y = py[i],
          z = pz[i];
        for (let s = 0; s < SUBSTEPS; s++) {
          const k1x = -y - z,
            k1y = x + aF * y,
            k1z = bF + z * (x - cF);
          const x2 = x + (h / 2) * k1x,
            y2 = y + (h / 2) * k1y,
            z2 = z + (h / 2) * k1z;
          const k2x = -y2 - z2,
            k2y = x2 + aF * y2,
            k2z = bF + z2 * (x2 - cF);
          const x3 = x + (h / 2) * k2x,
            y3 = y + (h / 2) * k2y,
            z3 = z + (h / 2) * k2z;
          const k3x = -y3 - z3,
            k3y = x3 + aF * y3,
            k3z = bF + z3 * (x3 - cF);
          const x4 = x + h * k3x,
            y4 = y + h * k3y,
            z4 = z + h * k3z;
          const k4x = -y4 - z4,
            k4y = x4 + aF * y4,
            k4z = bF + z4 * (x4 - cF);
          x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
          y += (h / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
          z += (h / 6) * (k1z + 2 * k2z + 2 * k3z + k4z);
        }
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(z) ||
          x * x + y * y + z * z > BLOWUP_RADIUS * BLOWUP_RADIUS
        ) {
          seedParticle(i);
          x = px[i];
          y = py[i];
          z = pz[i];
        } else {
          px[i] = x;
          py[i] = y;
          pz[i] = z;
        }
        // World -> a compositional remap: x stays horizontal, z (the fold
        // height) becomes screen-vertical so the ribbon's flip reads clearly,
        // y becomes depth for the slow rotation to reveal.
        buf[i * 3] = (x - CX) * WORLD_SCALE;
        buf[i * 3 + 1] = (z - CZ) * WORLD_SCALE;
        buf[i * 3 + 2] = (y - CY) * WORLD_SCALE;
      }

      angle += dt * 0.11;
      const tilt = 0.95 + Math.sin(t * 0.07) * 0.18;

      post.bind();
      if (needsClear) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        needsClear = false;
      }

      // high -> trail length: fade slower (longer streaks) as high-frequency
      // energy rises, faster (crisper, shorter) in quiet passages.
      const fadeRate = 2.0 - audio.high * 1.3;
      const decay = Math.exp(-dt * fadeRate);
      gl.enable(gl.BLEND);
      gl.blendColor(decay, decay, decay, decay);
      gl.blendFunc(gl.ZERO, gl.CONSTANT_COLOR);
      gl.useProgram(fadeProg);
      gl.bindVertexArray(tri);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_tilt, tilt);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_scale, 1.35);
      gl.uniform1f(u.u_high, audio.high);
      gl.drawArrays(gl.POINTS, 0, N);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.9 + audio.level * 0.4,
        exposure: 1.08 + audio.kickPulse * 0.2,
        aberration: 0.0009 + audio.change * 0.0018,
        grain: 0.035,
        vignette: 1.15,
        flash: audio.kickPulse * 0.15,
        threshold: 0.55,
        time: t,
      });
    },
  };
}
