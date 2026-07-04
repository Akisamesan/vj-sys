// 12 MAGNET — iron filings combing themselves along a shifting dipole field. Each of
// 2–4 magnets is modelled as a north/south monopole pair (the classic Gilbert bar-magnet
// approximation): summing their inverse-square fields gives the familiar curved field
// pattern. ~550 short grains sit at fixed jittered positions and only rotate in place to
// the local field direction — bass strengthens the field (sharper, brighter alignment),
// level lets the magnets drift on slow independent orbits, kicks are a structural trigger
// (flip one magnet's polarity, or every few bars reshuffle the whole layout) and high
// reins in the per-grain alignment noise (crisp when bright, ragged when dull). Primitive
// GL_LINES with position/orientation recomputed on the CPU each frame, through HDR PostFX.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 560; // grains (line segments), kept well under the 600 cap
const HALF_LEN = 0.026; // half-length of a grain, in the -1..1 world space
const POLE_SEP = 0.11; // half-separation between a magnet's N/S monopoles
const FIELD_EPS = 0.006; // softens the 1/r^3 falloff so poles don't blow up
const HALF_W = 1.7; // grain field half-extent (x, before /aspect)
const HALF_H = 1.0; // grain field half-extent (y)
const RECONFIG_COOLDOWN = 4.0; // seconds; keeps full reshuffles phrase-scale, not per-hit
const FLIP_COOLDOWN = 0.6;

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in float a_glow;
uniform float u_aspect;
out float v_glow;
void main(){
  vec2 p = a_pos;
  p.x /= u_aspect;
  gl_Position = vec4(p, 0.0, 1.0);
  v_glow = a_glow;
}`;

const FS = `#version 300 es
precision highp float;
in float v_glow; out vec4 o;
void main(){
  // steel-grey filing, always visible; a blue-white glow rides on top where the
  // local field is strong so brightness itself reads as field strength.
  vec3 iron = vec3(0.20, 0.21, 0.23);
  vec3 field = vec3(0.35, 0.55, 1.0) * pow(clamp(v_glow, 0.0, 1.0), 1.5) * 2.4;
  o = vec4(iron + field, 1.0);
}`;

interface Magnet {
  angle: number; // dipole orientation
  spin: number; // rad/s, its own slow rotation
  polarity: number; // +1 / -1, flips on kick
  strength: number;
  orbitR: number;
  orbitPhase: number;
  orbitSpeed: number; // rad/s baseline, boosted by level
}

function randMagnet(): Magnet {
  return {
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.3,
    polarity: Math.random() < 0.5 ? 1 : -1,
    strength: 0.7 + Math.random() * 0.6,
    orbitR: 0.22 + Math.random() * 0.32,
    orbitPhase: Math.random() * Math.PI * 2,
    orbitSpeed: 0.04 + Math.random() * 0.05,
  };
}

export function createMagnet(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const buf = new Float32Array(N * 2 * 3); // 2 verts/grain, (x,y,glow) each

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
  gl.bindVertexArray(null);

  // Grain layout: a jittered grid spanning the whole frame so the field reads across
  // the entire image, not just near the magnets. Positions never move — only the
  // orientation (and thus the drawn segment) is recomputed each frame.
  const gx = new Float32Array(N);
  const gy = new Float32Array(N);
  const jitter = new Float32Array(N); // per-grain phase for the alignment-noise wobble
  const vib = new Float32Array(N); // per-grain phase for a subtle idle vibration
  {
    const cols = Math.max(1, Math.round(Math.sqrt((N * HALF_W) / HALF_H)));
    const rows = Math.ceil(N / cols);
    let i = 0;
    for (let r = 0; r < rows && i < N; r++) {
      for (let c = 0; c < cols && i < N; c++) {
        const cellW = (2 * HALF_W) / cols;
        const cellH = (2 * HALF_H) / rows;
        gx[i] = -HALF_W + (c + 0.5) * cellW + (Math.random() - 0.5) * cellW * 0.9;
        gy[i] = -HALF_H + (r + 0.5) * cellH + (Math.random() - 0.5) * cellH * 0.9;
        jitter[i] = Math.random() * Math.PI * 2;
        vib[i] = Math.random() * Math.PI * 2;
        i++;
      }
    }
  }

  let magnets: Magnet[] = [randMagnet(), randMagnet(), randMagnet()];
  let lastReconfig = -RECONFIG_COOLDOWN;
  let lastFlip = -FLIP_COOLDOWN;

  let rw = 1,
    rh = 1;

  // Scratch pole arrays, sized for the max 4 magnets (8 poles) up front.
  const poleX = new Float32Array(8);
  const poleY = new Float32Array(8);
  const poleQ = new Float32Array(8);

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);

      // Kick: a structural trigger only — reshuffle the whole layout (phrase-scale,
      // gated) or flip one magnet's polarity. Never a per-hit flash or zoom.
      if (audio.kick) {
        if (t - lastReconfig > RECONFIG_COOLDOWN && Math.random() < 0.5) {
          const count = 2 + Math.floor(Math.random() * 3); // 2..4
          magnets = Array.from({ length: count }, () => randMagnet());
          lastReconfig = t;
        } else if (t - lastFlip > FLIP_COOLDOWN) {
          const m = magnets[(Math.random() * magnets.length) | 0];
          if (m) m.polarity *= -1;
          lastFlip = t;
        }
      }

      const orbitBoost = audio.level * 0.5; // level: gentle group drift/rotation
      const strengthMul = 0.6 + audio.bass * 1.4; // bass: field density/sharpness
      const noiseAmt = 0.9 * (1 - audio.high); // high: suppresses alignment noise

      let poleCount = 0;
      for (const m of magnets) {
        m.orbitPhase += fdt * (m.orbitSpeed + orbitBoost);
        m.angle += fdt * m.spin;
        const cx = Math.cos(m.orbitPhase) * m.orbitR;
        const cy = Math.sin(m.orbitPhase * 0.85) * m.orbitR;
        const dx = Math.cos(m.angle) * POLE_SEP;
        const dy = Math.sin(m.angle) * POLE_SEP;
        const q = m.strength * m.polarity * strengthMul;
        poleX[poleCount] = cx + dx;
        poleY[poleCount] = cy + dy;
        poleQ[poleCount] = q;
        poleCount++;
        poleX[poleCount] = cx - dx;
        poleY[poleCount] = cy - dy;
        poleQ[poleCount] = -q;
        poleCount++;
      }

      for (let i = 0; i < N; i++) {
        const px = gx[i];
        const py = gy[i];
        let fx = 0;
        let fy = 0;
        for (let p = 0; p < poleCount; p++) {
          const dx = px - poleX[p];
          const dy = py - poleY[p];
          const r2 = dx * dx + dy * dy + FIELD_EPS;
          const inv = poleQ[p] / (r2 * Math.sqrt(r2));
          fx += dx * inv;
          fy += dy * inv;
        }
        const mag = Math.hypot(fx, fy);
        let ang = mag > 1e-5 ? Math.atan2(fy, fx) : jitter[i];
        ang += Math.sin(jitter[i] + t * 0.6) * noiseAmt * 0.5; // ragged when high is low
        ang += Math.sin(vib[i] + t * 3.1) * 0.03; // small idle life, always present
        const glow = 1 - Math.exp(-mag * 0.6);

        const hx = Math.cos(ang) * HALF_LEN;
        const hy = Math.sin(ang) * HALF_LEN;
        const b = i * 6;
        buf[b] = px - hx;
        buf[b + 1] = py - hy;
        buf[b + 2] = glow;
        buf[b + 3] = px + hx;
        buf[b + 4] = py + hy;
        buf[b + 5] = glow;
      }

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.drawArrays(gl.LINES, 0, N * 2);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.0 + audio.bass * 0.6,
        exposure: 1.05 + audio.kickPulse * 0.2,
        aberration: 0.001 + audio.change * 0.0015,
        grain: 0.04,
        vignette: 1.1,
        flash: 0,
        threshold: 0.5,
        time: t,
      });
    },
  };
}
