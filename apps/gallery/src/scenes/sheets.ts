// 74 SHEETS — a handful of translucent 3D cloth-like meshes drifting and rippling
// through space. Each sheet is a triangulated grid whose vertices are displaced by
// domain noise (evaluated in the vertex shader, analytic finite-difference normals)
// so it undulates like flowing fabric; kicks drop a point impulse that spreads as a
// decaying ring wave across every sheet at once (same trick as waves.ts, but done
// analytically per-vertex instead of a GPGPU ping-pong, since a handful of sheets at
// modest grid resolution is cheap to evaluate directly). One shared grid VAO is
// reused for all sheets — only the per-draw uniforms (spectrum band, tilt, stacking
// offset, hue) change between them. Sheets are alpha-blended and sorted back-to-front
// each frame (no depth buffer on this context) for a layered, translucent look; both
// triangle faces are lit (gl_FrontFacing) so the fabric reads as thin, not solid.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";
import { BAND_COUNT } from "../engine/audio.ts";

const NUM_SHEETS = 4;
const GRID_X = 44;
const GRID_Y = 26;
const MAX_IMPULSES = 8;
const SPACING = 0.5;
const FD_EPS = 0.045;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec2 a_pos;

uniform float u_time;
uniform float u_amp, u_freqMul, u_timeMul, u_sheetIndex, u_seedMacro;
uniform float u_tiltX, u_tiltY;
uniform vec3 u_offset;
uniform float u_yaw, u_pitch;
uniform vec2 u_camPan;
uniform float u_camDist, u_scale, u_aspect;
uniform vec4 u_impulses[${MAX_IMPULSES}];

out vec3 v_normal;
out float v_height;
out float v_glow;
out float v_hueT;

float turbulence(vec2 p){
  vec3 q = vec3(p*u_freqMul + u_seedMacro*29.0, u_time*u_timeMul + u_sheetIndex*7.3);
  float n1 = snoise(q);
  float n2 = snoise(q*2.1 + 5.0) * 0.5;
  return (n1 + n2) * u_amp;
}

float ripple(vec2 p, out float glow){
  float h = 0.0;
  glow = 0.0;
  for (int i = 0; i < ${MAX_IMPULSES}; i++){
    vec4 im = u_impulses[i];
    float age = u_time - im.z;
    if (age < 0.0 || age > 3.0) continue;
    float d = distance(p, im.xy);
    float env = exp(-age*1.6) * smoothstep(0.0, 0.12, age) * exp(-d*1.4);
    h += im.w * env * sin(d*13.0 - age*7.0);
    glow += im.w * env * exp(-d*d*10.0);
  }
  return h;
}

float heightAt(vec2 p, out float glow){
  return turbulence(p) + ripple(p, glow);
}

void main(){
  vec2 p2 = a_pos;
  float gC, gX, gY;
  float hC = heightAt(p2, gC);
  float hX = heightAt(p2 + vec2(${FD_EPS}, 0.0), gX);
  float hY = heightAt(p2 + vec2(0.0, ${FD_EPS}), gY);

  vec3 normal = normalize(vec3(-(hX-hC)/${FD_EPS}, -(hY-hC)/${FD_EPS}, 1.0));
  vec3 p = vec3(p2, hC);

  float ctx=cos(u_tiltX), stx=sin(u_tiltX);
  p = vec3(p.x, ctx*p.y - stx*p.z, stx*p.y + ctx*p.z);
  normal = vec3(normal.x, ctx*normal.y - stx*normal.z, stx*normal.y + ctx*normal.z);
  float cty=cos(u_tiltY), sty=sin(u_tiltY);
  p = vec3(cty*p.x + sty*p.z, p.y, -sty*p.x + cty*p.z);
  normal = vec3(cty*normal.x + sty*normal.z, normal.y, -sty*normal.x + cty*normal.z);

  p += u_offset;

  float cy=cos(u_yaw), sy=sin(u_yaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  normal = vec3(cy*normal.x + sy*normal.z, normal.y, -sy*normal.x + cy*normal.z);
  float cp=cos(u_pitch), sp=sin(u_pitch);
  p = vec3(p.x, cp*p.y - sp*p.z, sp*p.y + cp*p.z);
  normal = vec3(normal.x, cp*normal.y - sp*normal.z, sp*normal.y + cp*normal.z);

  p.x += u_camPan.x;
  p.y += u_camPan.y;

  float persp = 1.0/(u_camDist - p.z);
  vec2 sc = p.xy * u_scale * persp;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);

  v_normal = normal;
  v_height = hC;
  v_glow = gC;
  v_hueT = u_sheetIndex;
}`;

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
in vec3 v_normal;
in float v_height;
in float v_glow;
in float v_hueT;
uniform float u_centroid, u_hueMacro, u_kickPulse;
out vec4 o;

void main(){
  vec3 n = normalize(v_normal);
  if (!gl_FrontFacing) n = -n;
  vec3 lightDir = normalize(vec3(0.4, 0.6, 0.7));
  float diff = max(dot(n, lightDir), 0.0);
  float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.0);

  float hue = fract(0.5 + v_hueT*0.11 + u_centroid*0.3 + u_hueMacro);
  float t = 0.42 + 0.5*hue; // biased into cyan..violet
  vec3 base = palette(t, vec3(0.55,0.55,0.6), vec3(0.45,0.45,0.4), vec3(1.0,1.0,1.0), vec3(0.0,0.15,0.35));

  vec3 col = base * (0.32 + 0.75*diff) + base*rim*0.35;

  float stripe = abs(fract(v_height*5.0 + 0.5) - 0.5) * 2.0;
  float lineGlow = smoothstep(0.14, 0.0, stripe) * 0.4;
  col = mix(col, vec3(1.0), lineGlow*0.5);

  col = mix(col, vec3(1.0), clamp(v_glow*1.6, 0.0, 0.6));
  col *= 1.0 + u_kickPulse*0.12;

  if (!gl_FrontFacing) col *= 0.55;

  o = vec4(col, 0.9);
}`;

function buildGrid(
  gx: number,
  gy: number,
): { positions: Float32Array; indices: Uint16Array; indexCount: number } {
  const positions = new Float32Array(gx * gy * 2);
  let vi = 0;
  for (let j = 0; j < gy; j++) {
    const y = (j / (gy - 1)) * 2 - 1;
    for (let i = 0; i < gx; i++) {
      const x = (i / (gx - 1)) * 2 - 1;
      positions[vi++] = x;
      positions[vi++] = y;
    }
  }
  const indices = new Uint16Array((gx - 1) * (gy - 1) * 6);
  let ii = 0;
  for (let j = 0; j < gy - 1; j++) {
    for (let i = 0; i < gx - 1; i++) {
      const a = j * gx + i;
      const b = a + 1;
      const c = a + gx;
      const d = c + 1;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }
  return { positions, indices, indexCount: indices.length };
}

export function createSheets(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const grid = buildGrid(GRID_X, GRID_Y);
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const ibo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, grid.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  const bandsPerSheet = Math.floor(BAND_COUNT / NUM_SHEETS);

  // Impulse ring buffer: (x, y, t0, amp) per slot. t0 starts far in the past so
  // unused slots never contribute (age >> lifetime cutoff in the shader).
  const impBuf = new Float32Array(MAX_IMPULSES * 4);
  for (let i = 0; i < MAX_IMPULSES; i++) impBuf[i * 4 + 2] = -999;
  let impCursor = 0;

  let seedMacro = 0;
  let energyMacro = 0;
  let hueMacro = 0;

  let rw = 1;
  let rh = 1;
  let yaw = 0;
  let pitch = 0;

  const order = [0, 1, 2, 3];

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    macros: {
      seed: (v) => {
        seedMacro = v;
      },
      energy: (v) => {
        energyMacro = v;
      },
      hue: (v) => {
        hueMacro = v;
      },
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(Math.max(dt, 0), 1 / 20);

      // level -> camera orbit/pan speed (continuous, autonomous even in silence).
      yaw += fdt * (0.06 + audio.level * 0.22);
      const pitchTarget = Math.sin(t * 0.07) * 0.16;
      pitch += (pitchTarget - pitch) * (1 - Math.exp(-fdt * 2));
      const panDrive = 0.35 + audio.level * 0.9;
      const camPanX = Math.sin(t * 0.05) * 0.22 * panDrive;
      const camPanY = Math.cos(t * 0.043 + 1.1) * 0.14 * panDrive;
      const camDist = 3.0 - audio.level * 0.3;

      // kick -> inject a ripple impulse shared by every sheet (structural trigger,
      // not a flash: it propagates and decays over ~2s, visible via v_glow + normal
      // shading rather than any full-screen brightness pop).
      if (audio.kick) {
        impCursor = (impCursor + 1) % MAX_IMPULSES;
        const base = impCursor * 4;
        impBuf[base] = (Math.random() * 2 - 1) * 0.8;
        impBuf[base + 1] = (Math.random() * 2 - 1) * 0.8;
        impBuf[base + 2] = t;
        impBuf[base + 3] = 0.32 + audio.bass * 0.45;
      }

      // sort sheets back-to-front by their rotated depth so the alpha-blended
      // stack (no depth buffer on this context) layers correctly as the camera
      // orbits.
      const cy = Math.cos(yaw);
      const cp = Math.cos(pitch);
      const depth = new Float32Array(NUM_SHEETS);
      for (let i = 0; i < NUM_SHEETS; i++) {
        const baseZ = (i - (NUM_SHEETS - 1) / 2) * SPACING;
        depth[i] = cp * cy * baseZ;
      }
      order.sort((a, b) => depth[a] - depth[b]);

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_pitch, pitch);
      gl.uniform2f(u.u_camPan, camPanX, camPanY);
      gl.uniform1f(u.u_camDist, camDist);
      gl.uniform1f(u.u_scale, 2.0);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform4fv(u.u_impulses, impBuf);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_hueMacro, hueMacro);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1f(u.u_seedMacro, seedMacro);

      for (let oi = 0; oi < NUM_SHEETS; oi++) {
        const i = order[oi];
        const bandStart = i * bandsPerSheet;
        const bandEnd = i === NUM_SHEETS - 1 ? BAND_COUNT : bandStart + bandsPerSheet;
        let bandAmp = 0;
        for (let b = bandStart; b < bandEnd; b++) bandAmp += audio.spectrum[b];
        bandAmp /= Math.max(1, bandEnd - bandStart);

        // bass (continuous) drives overall undulation amplitude; each sheet's own
        // spectrum band drives its own displacement frequency/amplitude on top.
        const amp = (0.1 + bandAmp * 0.5) * (0.5 + audio.bass * 1.0) * (1 + energyMacro * 1.5);
        const freqMul = 1.0 + i * 0.22 + bandAmp * 1.1;
        const timeMul = 0.12 + bandAmp * 0.35;

        const bobX = Math.cos(t * 0.13 + i * 2.1) * 0.05;
        const bobY = Math.sin(t * 0.17 + i * 1.7) * 0.06;
        const baseZ = (i - (NUM_SHEETS - 1) / 2) * SPACING;
        const tiltX = Math.sin(t * 0.11 + i * 1.3) * 0.25;
        const tiltY = Math.cos(t * 0.09 + i * 0.7) * 0.3;

        gl.uniform1f(u.u_amp, amp);
        gl.uniform1f(u.u_freqMul, freqMul);
        gl.uniform1f(u.u_timeMul, timeMul);
        gl.uniform1f(u.u_sheetIndex, i);
        gl.uniform1f(u.u_tiltX, tiltX);
        gl.uniform1f(u.u_tiltY, tiltY);
        gl.uniform3f(u.u_offset, bobX, bobY, baseZ);

        gl.drawElements(gl.TRIANGLES, grid.indexCount, gl.UNSIGNED_SHORT, 0);
      }

      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.85 + audio.level * 0.45,
        exposure: 1.05 + audio.kickPulse * 0.15,
        aberration: 0.001 + audio.change * 0.0015,
        grain: 0.03,
        vignette: 1.15,
        flash: audio.kickPulse * 0.18,
        threshold: 0.58,
        time: t,
      });
    },
  };
}
