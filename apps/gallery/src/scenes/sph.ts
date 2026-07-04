// 11 SPH — droplets of liquid metal (mercury-like) that merge and split under
// surface tension. CPU O(N^2) short-range forces (an always-active hard-core
// repulsion plus a mid-range cohesive shell) integrate ~120 points; their
// positions stream each frame into a Nx1 RGBA32F data texture, and a single
// fragment pass sums an inverse-square metaball field from it, building a
// bump-mapped surface normal from the field's own analytic gradient for a
// chrome/mercury highlight (no raymarch — a distinct look from 23 METABALLS).
// bass thickens the surface tension (more cohesive), level lowers viscosity
// (faster, smoother glide), kick blows the pool apart in a radial impulse that
// tension then pulls back together, centroid tints the silver palette.

import { program, uniforms, texture, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 120;
const R_MIN = 0.07; // hard-core radius: always-repulsive inside this
const R_COH = 0.24; // cohesion cutoff: no force felt past this
const AMBIENT = 0.5; // ambient drift so the pool stays alive in silence
const MARGIN = 0.86; // container size as a fraction of the visible half-extent

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_pos;
uniform vec2 u_res;
uniform float u_aspect, u_time, u_centroid, u_kickPulse, u_level;
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);

  float field = 0.0;
  vec2 grad = vec2(0.0);
  for (int i = 0; i < ${N}; i++){
    vec4 pd = texelFetch(u_pos, ivec2(i, 0), 0);
    vec2 dp = p - pd.xy;
    float d2 = dot(dp, dp) + 0.0011;
    float r2 = pd.z * pd.z;
    field += r2 / d2;
    grad += -2.0 * r2 * dp / (d2 * d2);
  }

  float surf = smoothstep(0.7, 1.3, field);

  // Bump-map style normal from the field's own analytic gradient (no raymarch).
  // Tilt is clamped so the highlight stays rounded instead of razor-edge-on.
  vec2 g = grad * 0.03;
  float glen = length(g);
  if (glen > 1.3) g *= 1.3 / glen;
  vec3 nrm = normalize(vec3(-g, 1.0));

  vec3 lightDir = normalize(vec3(0.45, 0.65, 0.7));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 halfDir = normalize(lightDir + viewDir);
  float diff = clamp(dot(nrm, lightDir), 0.0, 1.0);
  float spec = pow(clamp(dot(nrm, halfDir), 0.0, 1.0), 22.0 + u_level * 40.0);
  float rim = pow(1.0 - clamp(nrm.z, 0.0, 1.0), 3.0);
  float sparkle = max(snoise(vec3(p * 6.0, u_time * 0.15)), 0.0);
  spec *= 1.0 + sparkle * 0.7;

  // Chrome/mercury: grey-silver base, a whisper of hue riding the centroid.
  vec3 tint = palette(0.5 + u_centroid * 0.6,
    vec3(0.56, 0.57, 0.60), vec3(0.14, 0.12, 0.16),
    vec3(1.0, 1.0, 1.0), vec3(0.0, 0.12, 0.3));

  vec3 metal = tint * (0.2 + diff * 0.55);
  metal += tint * rim * 0.5;
  metal += vec3(1.0) * spec * (0.85 + u_kickPulse * 0.6);

  vec3 bg = vec3(0.02, 0.021, 0.026) * (1.0 - length(uv - 0.5) * 0.6);
  vec3 col = mix(bg, metal, surf);
  col *= 1.0 + u_kickPulse * 0.12;

  o = vec4(pow(max(col, 0.0), vec3(0.9)), 1.0);
}`;

// GLSL smoothstep, mirrored on the CPU to shape the cohesion shell.
function smooth01(x: number, a: number, b: number): number {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

export function createSph(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const vx = new Float32Array(N);
  const vy = new Float32Array(N);
  const buf = new Float32Array(N * 4);

  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.3;
    px[i] = Math.cos(a) * r;
    py[i] = Math.sin(a) * r;
    vx[i] = (Math.random() - 0.5) * 0.15;
    vy[i] = (Math.random() - 0.5) * 0.15;
    buf[i * 4 + 2] = 0.038 + Math.random() * 0.022; // per-droplet radius
    buf[i * 4 + 3] = 1;
  }

  const posTex = texture(gl, N, 1, { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT }, buf);

  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);
      const aspect = rw / rh;
      const boundY = 0.5 * MARGIN;
      const boundX = boundY * aspect;

      const tension = 0.6 + audio.bass * 3.2; // bass -> surface-tension strength
      const dampRate = 3.4 - audio.level * 2.6; // level -> lower viscosity
      const dampFactor = Math.exp(-fdt * dampRate);
      const maxSpeed = 1.1 + audio.level * 1.8;

      // kick -> radial impulse: the pool splits, then tension pulls it back.
      if (audio.kick) {
        let cx = 0,
          cy = 0;
        for (let i = 0; i < N; i++) {
          cx += px[i];
          cy += py[i];
        }
        cx /= N;
        cy /= N;
        for (let i = 0; i < N; i++) {
          const dx = px[i] - cx,
            dy = py[i] - cy;
          const ang = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.7;
          const imp = 1.1 + Math.random() * 0.9;
          vx[i] += Math.cos(ang) * imp;
          vy[i] += Math.sin(ang) * imp;
        }
      }

      for (let i = 0; i < N; i++) {
        let fx = 0,
          fy = 0;
        const ix = px[i],
          iy = py[i];
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const dx = px[j] - ix,
            dy = py[j] - iy;
          const d2 = dx * dx + dy * dy;
          if (d2 > R_COH * R_COH) continue;
          const d = Math.sqrt(d2) + 1e-4;
          const nx = dx / d,
            ny = dy / d;
          // short-range: always-repulsive, dominates as d -> 0 (keeps a hard core)
          const rep = 0.012 / (d2 + 0.0004);
          fx -= nx * rep;
          fy -= ny * rep;
          // mid-range: cohesive shell (surface tension), peaks near 0.42*R_COH
          const shell = smooth01(d, R_MIN, R_COH * 0.42) * (1 - smooth01(d, R_COH * 0.42, R_COH));
          fx += nx * shell * tension;
          fy += ny * shell * tension;
        }
        // ambient drift keeps the pool alive even in silence (deterministic in t)
        fx += Math.sin(t * 0.33 + i * 1.7) * AMBIENT;
        fy += Math.cos(t * 0.27 + i * 2.3) * AMBIENT;

        let nvx = (vx[i] + fx * fdt) * dampFactor;
        let nvy = (vy[i] + fy * fdt) * dampFactor;
        const sp = Math.hypot(nvx, nvy);
        if (sp > maxSpeed) {
          const k = maxSpeed / sp;
          nvx *= k;
          nvy *= k;
        }
        vx[i] = nvx;
        vy[i] = nvy;

        let nx2 = ix + nvx * fdt;
        let ny2 = iy + nvy * fdt;
        if (nx2 > boundX) {
          nx2 = boundX;
          vx[i] = -Math.abs(vx[i]) * 0.5;
        } else if (nx2 < -boundX) {
          nx2 = -boundX;
          vx[i] = Math.abs(vx[i]) * 0.5;
        }
        if (ny2 > boundY) {
          ny2 = boundY;
          vy[i] = -Math.abs(vy[i]) * 0.5;
        } else if (ny2 < -boundY) {
          ny2 = -boundY;
          vy[i] = Math.abs(vy[i]) * 0.5;
        }
        px[i] = nx2;
        py[i] = ny2;
        buf[i * 4] = nx2;
        buf[i * 4 + 1] = ny2;
      }

      gl.bindTexture(gl.TEXTURE_2D, posTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, 1, gl.RGBA, gl.FLOAT, buf);

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, posTex);
      gl.uniform1i(u.u_pos, 0);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_aspect, aspect);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.85 + audio.level * 0.4,
        exposure: 1.05 + audio.kickPulse * 0.2,
        aberration: 0.0006 + audio.change * 0.002,
        grain: 0.03,
        vignette: 1.1,
        flash: audio.kickPulse * 0.25,
        threshold: 0.65,
        time: t,
      });
    },
  };
}
