// 47 SPHEREFIELD — a grid of point-sprite pseudo-spheres forms a spectrum terrain.
// Each column reads one log-spaced band: its energy lifts the whole column into a
// ridge, bass raises the entire field's base level, and a kick sends a circular
// shockwave rippling outward from the field's centre, briefly lifting whatever
// lattice points it passes through. Centroid turns the palette hue. GL_POINTS with
// fake-sphere shading (gl_PointCoord normal + light) through HDR PostFX bloom.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import { perspective, lookAt, multiply } from "../engine/math.ts";
import type { Vec3 } from "../engine/math.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const COLS = 24;
const ROWS = 15;
const N = COLS * ROWS;
const EXTENT_X = 3.4;
const EXTENT_Z = 4.2;
const NEAR_Z = 1.2;
const MID_Z = -(NEAR_Z + EXTENT_Z * 0.5);
const RIPPLE_SLOTS = 4;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec2 a_grid; // (colN, rowN) 0..1, CPU-generated fixed grid
uniform mat4 u_vp;
uniform float u_spectrum[${BAND_COUNT}];
uniform float u_time, u_bass, u_centroid;
uniform float u_rippleAge[${RIPPLE_SLOTS}];
uniform vec2 u_rippleCenter;
out vec3 v_col;
out float v_h;

void main(){
  float colN = a_grid.x;
  float rowN = a_grid.y;

  int band = int(floor(colN * float(${BAND_COUNT})));
  band = min(band, ${BAND_COUNT - 1});

  float x = (colN - 0.5) * ${(2 * EXTENT_X).toFixed(2)};
  float z = -(${NEAR_Z.toFixed(2)} + rowN * ${EXTENT_Z.toFixed(2)});

  // idle terrain relief so the field never goes flat/black in silence
  float idle = 0.14 + 0.05 * sin(colN * 12.566 + rowN * 6.283 + u_time * 0.22);
  // column = band -> ridge height (the spectrum-terrain read)
  float spec = pow(u_spectrum[band], 0.85) * 1.9;
  // bass -> whole-field base uplift (row-uniform, independent of band)
  float bassLift = u_bass * 0.55;
  // small per-point organic jitter so ridges read as a sphere field, not flat bars
  float jitter = snoise(vec3(colN * 3.0, rowN * 3.0, u_time * 0.05 + 37.0)) * 0.05;

  // kick -> circular shockwave travelling outward from the field centre
  vec2 p = vec2(x, z);
  float d = distance(p, u_rippleCenter);
  float ripple = 0.0;
  for (int i = 0; i < ${RIPPLE_SLOTS}; i++){
    float age = u_rippleAge[i];
    if (age < 2.5){
      float radius = age * 3.0;
      float ring = exp(-pow(d - radius, 2.0) * 2.2);
      float env = exp(-age * 1.5);
      ripple += ring * env;
    }
  }

  float h = idle + spec + bassLift + jitter + ripple * 1.1;
  v_h = h;

  gl_Position = u_vp * vec4(x, h, z, 1.0);

  float hue = colN * 0.55 + u_centroid * 0.55 + u_time * 0.015;
  vec3 base = palette(hue, vec3(0.55,0.5,0.55), vec3(0.45,0.45,0.4), vec3(1.0,0.9,0.95), vec3(0.0,0.15,0.35));
  float hb = clamp(h, 0.0, 2.0);
  float bright = 0.3 + hb * 0.5;
  v_col = base * bright * 1.0; // explicit gain, but modest: adjacent points sit close together

  float sizePx = mix(11.0, 6.0, rowN) + hb * 2.6;
  gl_PointSize = clamp(sizePx, 5.0, 14.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col;
in float v_h;
out vec4 o;
void main(){
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  // shrink the drawn disc well inside the point sprite's footprint so neighbouring
  // spheres never touch even when gl_PointSize gets close to the grid spacing
  if (r2 > 0.4) discard;
  float zc = sqrt(1.0 - r2);
  vec3 n = normalize(vec3(d, zc));
  vec3 lightDir = normalize(vec3(0.5, 0.7, 0.6));
  float diff = max(dot(n, lightDir), 0.0);
  float rim = pow(1.0 - zc, 2.0) * 0.45;
  float shade = 0.22 + diff * 0.85 + rim;
  vec3 col = v_col * shade;
  o = vec4(col, 1.0);
}`;

export function createSpherefield(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // Fixed grid, pre-generated once on the CPU: (colN, rowN) in 0..1 per point.
  const grid = new Float32Array(N * 2);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const i = row * COLS + col;
      grid[i * 2] = (col + 0.5) / COLS;
      grid[i * 2 + 1] = (row + 0.5) / ROWS;
    }
  }
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const spec = new Float32Array(BAND_COUNT);
  const rippleAge = new Float32Array(RIPPLE_SLOTS).fill(99);
  let rippleCursor = 0;
  let rw = 1,
    rh = 1;
  let camPhase = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.6, audio.spectrum[i] * 1.7);

      for (let i = 0; i < RIPPLE_SLOTS; i++) rippleAge[i] += dt;
      if (audio.kick) {
        rippleAge[rippleCursor] = 0;
        rippleCursor = (rippleCursor + 1) % RIPPLE_SLOTS;
      }

      camPhase += dt * 0.07;
      const eye: Vec3 = [
        Math.sin(camPhase) * 0.9,
        5.6 + Math.sin(t * 0.13) * 0.35 + audio.bass * 0.5,
        4.6 - audio.level * 0.5,
      ];
      const proj = perspective((50 * Math.PI) / 180, rw / rh, 0.1, 40);
      const view = lookAt(eye, [0, 0.2, MID_Z], [0, 1, 0]);
      const vp = multiply(proj, view);

      post.bind();
      gl.clearColor(0.02, 0.02, 0.035, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniformMatrix4fv(u.u_vp, false, vp);
      gl.uniform1fv(u.u_spectrum, spec);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1fv(u.u_rippleAge, rippleAge);
      gl.uniform2f(u.u_rippleCenter, 0, MID_Z);
      gl.drawArrays(gl.POINTS, 0, N);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.4 + audio.level * 0.25,
        exposure: 1.05 + audio.kickPulse * 0.15,
        aberration: 0.001 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.15,
        flash: audio.kickPulse * 0.15,
        threshold: 0.62,
        time: t,
      });
    },
  };
}
