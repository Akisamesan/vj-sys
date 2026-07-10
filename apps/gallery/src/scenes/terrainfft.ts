// 91 TERRAIN_FFT — the spectrum's recent history rendered as an oncoming ridged
// landscape. A ring buffer of the last 48 spectrum frames feeds a triangulated
// XZ grid (band = X, time = Z); every new frame writes a fresh ridge line at the
// far edge and the whole field creeps toward the camera as older ridges age
// forward. Unlike 22 TERRAIN (raymarched noise), the terrain shape here IS the
// music's spectrogram, literally extruded into geometry. Solid triangles + depth
// test through HDR PostFX (no GL_LINES).

import { program, uniforms, texture } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import { perspective, lookAt, multiply } from "../engine/math.ts";
import type { Vec3 } from "../engine/math.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

// Depth of the ring buffer (how many past spectrum frames form the landscape).
const HIST = 48;
const CELL_Z = 0.42;
const NEAR_Z = 2.0;
const WIDTH = 6.4;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec2 a_grid; // (band, age) integer grid coords as floats
uniform sampler2D u_heights;
uniform mat4 u_vp;
uniform float u_scrollFrac, u_heightScale, u_centroid;
uniform int u_writePtr;
out vec3 v_col;
out float v_fog;

float heightAt(int band, int age){
  int row = (u_writePtr - age + ${HIST} * 4) % ${HIST};
  return texelFetch(u_heights, ivec2(band, row), 0).r;
}

void main(){
  int col = int(a_grid.x);
  int age = int(a_grid.y);
  float h = heightAt(col, age);
  float hL = heightAt(max(col - 1, 0), age);
  float hR = heightAt(min(col + 1, ${BAND_COUNT - 1}), age);
  float hF = heightAt(col, min(age + 1, ${HIST - 1}));
  float hB = heightAt(col, max(age - 1, 0));
  float slope = abs(hR - hL) + abs(hF - hB);

  float bn = a_grid.x / float(${BAND_COUNT - 1});
  float x = (bn - 0.5) * ${WIDTH.toFixed(2)};
  float dist = ${NEAR_Z.toFixed(2)} + (float(${HIST - 1}) - a_grid.y - u_scrollFrac) * ${CELL_Z.toFixed(2)};
  float y = h * u_heightScale;
  gl_Position = u_vp * vec4(x, y, -dist, 1.0);

  float hc = min(h, 1.4);
  vec3 base = palette(0.62 - hc * 0.55 + u_centroid * 0.28, vec3(0.5,0.48,0.45), vec3(0.5,0.45,0.42), vec3(1.0,0.85,0.6), vec3(0.0,0.12,0.3));
  float glow = smoothstep(0.03, 0.55, slope);
  v_col = base * (0.42 + hc * 1.25) + vec3(0.9,0.95,1.0) * glow * 0.6;
  v_fog = clamp(dist / 22.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; in float v_fog; out vec4 o;
void main(){
  vec3 fogCol = vec3(0.02, 0.03, 0.07);
  vec3 c = mix(v_col, fogCol, v_fog * 0.6);
  o = vec4(c, 1.0);
}`;

function buildGrid(gl: WebGL2RenderingContext): { vao: WebGLVertexArrayObject; count: number } {
  const verts = new Float32Array(BAND_COUNT * HIST * 2);
  let vi = 0;
  for (let row = 0; row < HIST; row++) {
    for (let col = 0; col < BAND_COUNT; col++) {
      verts[vi++] = col;
      verts[vi++] = row;
    }
  }
  const idx = new Uint16Array((BAND_COUNT - 1) * (HIST - 1) * 6);
  let ii = 0;
  for (let row = 0; row < HIST - 1; row++) {
    for (let col = 0; col < BAND_COUNT - 1; col++) {
      const i0 = row * BAND_COUNT + col;
      const i1 = i0 + 1;
      const i2 = i0 + BAND_COUNT;
      const i3 = i2 + 1;
      idx[ii++] = i0;
      idx[ii++] = i2;
      idx[ii++] = i1;
      idx[ii++] = i1;
      idx[ii++] = i2;
      idx[ii++] = i3;
    }
  }
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const ebo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: idx.length };
}

export function createTerrainFft(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  const grid = buildGrid(gl);
  const depthRb = gl.createRenderbuffer()!;

  const heightTex = texture(gl, BAND_COUNT, HIST, {
    internal: gl.R32F,
    format: gl.RED,
    type: gl.FLOAT,
    filter: gl.NEAREST,
    wrap: gl.CLAMP_TO_EDGE,
  });

  const rowBuf = new Float32Array(BAND_COUNT);
  let writePtr = 0;
  let scrollAccum = 0;

  function writeRow(row: number, audio: AudioEngine | null, kickBump: number): void {
    for (let i = 0; i < BAND_COUNT; i++) {
      const s = audio
        ? Math.min(1.35, audio.spectrum[i] * 1.55)
        : 0.05 + 0.04 * Math.sin(row * 0.3 + i * 0.5);
      const bump = kickBump * Math.exp(-Math.pow((i - 3) / 6, 2)) * 0.9;
      rowBuf[i] = s + bump;
    }
    gl.bindTexture(gl.TEXTURE_2D, heightTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, BAND_COUNT, 1, gl.RED, gl.FLOAT, rowBuf);
  }

  // Seed the whole buffer with a mild rolling pattern so silence never renders a
  // perfectly flat / empty plane.
  for (let row = 0; row < HIST; row++) writeRow(row, null, 0);

  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // level -> scroll speed (rows/sec); always creeping forward even in silence.
      const rowsPerSec = 3.0 + audio.level * 9.0;
      scrollAccum += dt * rowsPerSec;
      while (scrollAccum >= 1) {
        scrollAccum -= 1;
        writePtr = (writePtr + 1) % HIST;
        // kick -> a temporary elevation pulse baked into the freshest ridge line.
        writeRow(writePtr, audio, audio.kickPulse);
      }

      const sway = Math.sin(t * 0.11) * 0.9;
      const eye: Vec3 = [sway, 1.6 + Math.sin(t * 0.17) * 0.15 + audio.bass * 0.25, 1.6];
      const center: Vec3 = [sway * 0.4, 0.9, -12];
      const proj = perspective((50 * Math.PI) / 180, rw / rh, 0.1, 40);
      const view = lookAt(eye, center, [0, 1, 0]);
      const vp = multiply(proj, view);

      post.bind();
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.clearColor(0.02, 0.03, 0.07, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.useProgram(prog);
      gl.bindVertexArray(grid.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      gl.uniform1i(u.u_heights, 0);
      gl.uniformMatrix4fv(u.u_vp, false, vp);
      gl.uniform1f(u.u_scrollFrac, scrollAccum);
      // bass -> overall vertical scale / exaggeration of the whole landscape.
      gl.uniform1f(u.u_heightScale, 1.1 + audio.bass * 1.35);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1i(u.u_writePtr, writePtr);
      gl.drawElements(gl.TRIANGLES, grid.count, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.DEPTH_TEST);

      post.draw(rw, rh, {
        bloom: 0.75 + audio.level * 0.45,
        exposure: 1.05 + audio.kickPulse * 0.18,
        aberration: 0.001 + audio.change * 0.0018,
        grain: 0.035,
        vignette: 1.1,
        flash: audio.kickPulse * 0.12,
        threshold: 0.62,
        time: t,
      });
    },
  };
}
