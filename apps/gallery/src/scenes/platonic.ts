// 44 PLATONIC — rotating wireframe Platonic solids. A neon cage (tetra → cube → octa →
// icosa) turns in space; level spins it, bass pumps its scale, kicks flash the edges and
// novelty swaps to the next solid. Edges drawn as additive GL_LINES through HDR PostFX.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
layout(location=0) in vec3 a_pos;
uniform float u_yaw, u_pitch, u_scale, u_aspect, u_centroid, u_beat;
out vec3 v_col;
void main(){
  vec3 p = a_pos;
  float cy=cos(u_yaw), sy=sin(u_yaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  float cp=cos(u_pitch), sp=sin(u_pitch);
  p = vec3(p.x, cp*p.y - sp*p.z, sp*p.y + cp*p.z);
  float persp = 1.0/(2.6 - p.z*0.4);
  vec2 sc = p.xy * u_scale * persp;
  sc.x /= u_aspect;
  gl_Position = vec4(sc, 0.0, 1.0);
  float depth = 0.5 + p.z*0.4;
  v_col = palette(u_centroid*0.5 + depth*0.3, vec3(0.5),vec3(0.5),vec3(1.0,1.0,1.0),vec3(0.0,0.33,0.66)) * (0.4 + depth*0.7) * (1.0 + u_beat);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

const PHI = 1.61803399;
const SOLIDS: number[][] = [
  // tetrahedron
  [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
  // cube
  [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
  // octahedron
  [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1],
  // icosahedron
  [
    0,
    1,
    PHI,
    0,
    1,
    -PHI,
    0,
    -1,
    PHI,
    0,
    -1,
    -PHI,
    1,
    PHI,
    0,
    1,
    -PHI,
    0,
    -1,
    PHI,
    0,
    -1,
    -PHI,
    0,
    PHI,
    0,
    1,
    PHI,
    0,
    -1,
    -PHI,
    0,
    1,
    -PHI,
    0,
    -1,
  ],
];

// build an additive line buffer: connect every vertex pair at the (minimal) edge length
function edgeBuffer(verts: number[]): Float32Array {
  const n = verts.length / 3;
  let min = Infinity;
  const dist = (a: number, b: number): number => {
    const dx = verts[a * 3] - verts[b * 3];
    const dy = verts[a * 3 + 1] - verts[b * 3 + 1];
    const dz = verts[a * 3 + 2] - verts[b * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = dist(i, j);
      if (d > 1e-4 && d < min) min = d;
    }
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(dist(i, j) - min) < 1e-3) {
        out.push(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
        out.push(verts[j * 3], verts[j * 3 + 1], verts[j * 3 + 2]);
      }
    }
  return new Float32Array(out);
}

export function createPlatonic(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri);

  const buffers = SOLIDS.map((v) => {
    const data = edgeBuffer(v);
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, count: data.length / 3 };
  });

  let rw = 1,
    rh = 1;
  let yaw = 0,
    pitch = 0;
  let idx = 3;
  let scale = 0.5;
  let lastSwitch = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      if (audio.novelty > 2.2 && t - lastSwitch > 3) {
        idx = (idx + 1) % buffers.length;
        lastSwitch = t;
      }
      yaw += dt * (0.2 + audio.level * 0.8);
      pitch += dt * 0.15;
      scale += (0.42 + audio.bass * 0.25 - scale) * (1 - Math.exp(-dt * 6));

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_pitch, pitch);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      const bset = buffers[idx];
      gl.bindVertexArray(bset.vao);
      gl.drawArrays(gl.LINES, 0, bset.count);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.1 + audio.level * 0.5,
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
