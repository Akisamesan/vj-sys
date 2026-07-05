// 43 SUPERSHAPE — Gielis superformula surface (sphere <-> star/flower) drawn as a
// rotating neon wireframe. A lat/long grid is generated once on the CPU; the vertex
// shader evaluates the superformula radius separately for longitude and latitude
// (the standard way to build a 3D "supershape" from the 2D formula) and composites
// them into a spherical position each frame, so the mesh itself never needs to be
// rebuilt — only a couple of uniforms move.
//
// Edges are NOT drawn with gl.LINES: headless SwiftShader (the QA renderer) does
// not honour gl.lineWidth, so a 1px wireframe reads as near-invisible sub-pixel
// coverage there even though it looks fine on a real GPU (SCENES.md's documented
// LOW_VIS(細線系) pitfall). Instead each edge is expanded into a real quad in the
// vertex shader: every quad vertex carries both of its edge's endpoints (self +
// other) plus a side flag, re-evaluates the superformula for both ends, derives
// the on-screen tangent/normal from their projected positions, and offsets by a
// fixed pixel-scale half-width — the same normal-offset-quad technique used by
// ribbons.ts / verlet.ts, just done per-edge instead of per-ribbon-segment.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec2 a_self;
layout(location=1) in vec2 a_other;
layout(location=2) in float a_side;
uniform float u_yaw, u_pitch, u_scale, u_aspect, u_centroid, u_beat, u_m, u_n1, u_halfw;
out vec3 v_col;

// Gielis superformula: r(ang) for a given symmetry order m and exponents n1..n3.
// Bounded so an extreme n1 (near-zero) cannot blow the radius up to Inf/NaN.
float superformula(float ang, float m, float n1, float n2, float n3){
  float t = m * ang * 0.25;
  float a = pow(abs(cos(t)) + 1e-6, n2);
  float b = pow(abs(sin(t)) + 1e-6, n3);
  float r = pow(a + b, -1.0 / n1);
  return clamp(r, 0.15, 1.65);
}

// Longitude/latitude (theta,phi) -> rotated 3D position (pre-perspective).
vec3 shapePos(vec2 uv){
  float theta = uv.x;
  float phi = uv.y;
  const float M2 = 6.0; // latitude symmetry kept fixed; only longitude morphs with audio
  const float N2 = 1.7;
  const float N3 = 1.7;
  float r1 = superformula(theta, u_m, u_n1, N2, N3);
  float r2 = superformula(phi, M2, u_n1, N2, N3);
  float cp = cos(phi), sp = sin(phi);
  vec3 p = vec3(r1 * cos(theta) * r2 * cp, r1 * sin(theta) * r2 * cp, r2 * sp);
  float cy = cos(u_yaw), sy = sin(u_yaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  float cpit = cos(u_pitch), spit = sin(u_pitch);
  p = vec3(p.x, cpit*p.y - spit*p.z, spit*p.y + cpit*p.z);
  return p;
}

// Perspective-project to an isotropic (not yet aspect-corrected) NDC-ish plane so
// a screen-space normal computed here stays a true perpendicular; aspect is only
// applied to x at the very end, after the width offset.
vec2 projectPreAspect(vec3 p){
  float persp = 1.0 / (2.6 - p.z * 0.4);
  return p.xy * u_scale * persp;
}

void main(){
  vec3 pSelf = shapePos(a_self);
  vec3 pOther = shapePos(a_other);
  vec2 aSelf = projectPreAspect(pSelf);
  vec2 aOther = projectPreAspect(pOther);

  vec2 dir = aOther - aSelf;
  float len = length(dir);
  vec2 tangent = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-tangent.y, tangent.x);

  vec2 sc = aSelf + normal * u_halfw * a_side;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);

  float depth = 0.5 + pSelf.z * 0.4;
  v_col = palette(u_centroid*0.5 + depth*0.3, vec3(0.5),vec3(0.5),vec3(1.0,1.0,1.0),vec3(0.0,0.33,0.66))
        * (0.4 + depth*0.58) * (1.0 + u_beat);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Latitude/longitude grid resolution. Kept modest (64x32) — the shape morph lives
// entirely in uniforms, so this only needs to be dense enough to read as a smooth
// surface, not recomputed per frame.
const NU = 64;
const NV = 32;

// Continuous parameter ranges the audio drives (never rounded to integers, so the
// shape morphs rather than snapping between discrete forms).
const N1_ROUND = 7.0; // silence / low bass: rounder, closer to a sphere
const N1_SPIKE = 0.4; // loud bass: pulled into sharp spikes/star arms
const M_MIN = 2.0; // low spectrum energy: simple lobed blob
const M_MAX = 9.0; // high spectrum energy: dense flower/gear symmetry
const SPECTRUM_LO = 9;
const SPECTRUM_HI = 15;

const STRIDE = 5; // selfTheta, selfPhi, otherTheta, otherPhi, side

function buildMesh(): { verts: Float32Array; idx: Uint16Array } {
  const cols = NU + 1;
  const rows = NV + 1;
  const gridTheta = new Float32Array(cols * rows);
  const gridPhi = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const phi = -Math.PI / 2 + (j / NV) * Math.PI;
    for (let i = 0; i < cols; i++) {
      const theta = (i / NU) * Math.PI * 2;
      const k = j * cols + i;
      gridTheta[k] = theta;
      gridPhi[k] = phi;
    }
  }
  const edges: number[] = [];
  // longitude-direction segments (walk around each latitude ring)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < NU; i++) {
      edges.push(j * cols + i, j * cols + i + 1);
    }
  }
  // latitude-direction segments (walk pole to pole along each meridian)
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < NV; j++) {
      edges.push(j * cols + i, (j + 1) * cols + i);
    }
  }

  const numEdges = edges.length / 2;
  const verts = new Float32Array(numEdges * 4 * STRIDE);
  const idx = new Uint16Array(numEdges * 6);
  let vi = 0;
  let ii = 0;
  for (let e = 0; e < numEdges; e++) {
    const a = edges[e * 2];
    const b = edges[e * 2 + 1];
    const ta = gridTheta[a],
      pa = gridPhi[a];
    const tb = gridTheta[b],
      pb = gridPhi[b];
    const base = e * 4;
    // v0: self=a other=b side=+1 | v1: self=a other=b side=-1
    // v2: self=b other=a side=+1 | v3: self=b other=a side=-1
    verts[vi++] = ta;
    verts[vi++] = pa;
    verts[vi++] = tb;
    verts[vi++] = pb;
    verts[vi++] = 1;
    verts[vi++] = ta;
    verts[vi++] = pa;
    verts[vi++] = tb;
    verts[vi++] = pb;
    verts[vi++] = -1;
    verts[vi++] = tb;
    verts[vi++] = pb;
    verts[vi++] = ta;
    verts[vi++] = pa;
    verts[vi++] = 1;
    verts[vi++] = tb;
    verts[vi++] = pb;
    verts[vi++] = ta;
    verts[vi++] = pa;
    verts[vi++] = -1;
    idx[ii++] = base;
    idx[ii++] = base + 1;
    idx[ii++] = base + 2;
    idx[ii++] = base + 2;
    idx[ii++] = base + 1;
    idx[ii++] = base + 3;
  }
  return { verts, idx };
}

export function createSupershape(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  const mesh = buildMesh();
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  const ebo = gl.createBuffer()!;
  const stride = STRIDE * 4;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const indexCount = mesh.idx.length;

  let rw = 1,
    rh = 1;
  let yaw = 0,
    pitch = 0;
  let shapeBass = 0; // slow-follow of audio.bass -> n1
  let shapeM = M_MIN; // slow-follow of a spectrum slice -> m (longitude petals)

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // bass and the chosen spectrum slice both drift slowly into their targets so
      // the morph reads as continuous breathing, never a per-frame jitter.
      shapeBass += (audio.bass - shapeBass) * (1 - Math.exp(-dt * 0.9));
      let bandSum = 0;
      for (let i = SPECTRUM_LO; i <= SPECTRUM_HI; i++) bandSum += audio.spectrum[i];
      const bandAvg = bandSum / (SPECTRUM_HI - SPECTRUM_LO + 1);
      shapeM += (M_MIN + bandAvg * (M_MAX - M_MIN) - shapeM) * (1 - Math.exp(-dt * 1.3));

      const n1 = N1_ROUND + (N1_SPIKE - N1_ROUND) * shapeBass;

      yaw += dt * (0.14 + audio.level * 0.5);
      pitch += dt * 0.08;

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_pitch, pitch);
      gl.uniform1f(u.u_scale, 0.74);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse * 0.4);
      gl.uniform1f(u.u_m, shapeM);
      gl.uniform1f(u.u_n1, n1);
      gl.uniform1f(u.u_halfw, 0.011 + audio.level * 0.003);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.7 + audio.level * 0.28,
        exposure: 0.92 + audio.kickPulse * 0.18,
        aberration: 0.001 + audio.change * 0.002,
        grain: 0.035,
        vignette: 1.15,
        flash: audio.kickPulse * 0.22,
        threshold: 0.62,
        time: t,
      });
    },
  };
}
