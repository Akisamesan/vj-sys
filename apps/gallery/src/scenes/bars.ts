// 40 BARS — a 3D spectrum-bar city. Each frequency band is a tall billboard bar on
// a ring; its height is that band's live energy. An orbiting camera and a mirrored
// floor reflection make it read as a luminous equaliser cityscape. Direct, legible
// audio. Renders through HDR PostFX.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import { perspective, lookAt, multiply } from "../engine/math.ts";
import type { Vec3 } from "../engine/math.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform mat4 u_vp; uniform vec3 u_right; uniform float u_time, u_mirror, u_centroid;
uniform float u_spectrum[${BAND_COUNT}];
out vec3 v_col; out float v_y;
const vec2 CORN[6] = vec2[6](vec2(0.,0.),vec2(1.,0.),vec2(1.,1.),vec2(0.,0.),vec2(1.,1.),vec2(0.,1.));
void main(){
  int band = gl_VertexID / 6;
  int c = gl_VertexID % 6;
  vec2 q = CORN[c];
  float bn = float(band)/float(${BAND_COUNT});
  float ang = bn * 6.28318;
  float R = 3.2;
  vec3 base = vec3(cos(ang)*R, 0.0, sin(ang)*R);
  float h = pow(u_spectrum[band], 0.8) * 4.5 + 0.05;
  float bw = 0.16;
  float yy = q.y * h;
  vec3 pos = base + u_right*(q.x-0.5)*bw;
  pos.y = u_mirror > 0.5 ? -yy : yy;
  gl_Position = u_vp * vec4(pos, 1.0);
  vec3 col = palette(bn*0.8 + u_centroid*0.4 + u_time*0.02, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0,0.33,0.66));
  float e = u_spectrum[band];
  v_col = col * (0.15 + e*1.8) * (u_mirror > 0.5 ? 0.25 : 1.0);
  v_y = q.y;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col; in float v_y; out vec4 o;
void main(){
  // brighter toward the tip
  vec3 c = v_col * (0.5 + v_y*0.9);
  o = vec4(c, 1.0);
}`;

export function createBars(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri);
  const vao = gl.createVertexArray()!;
  const spec = new Float32Array(BAND_COUNT);
  let rw = 1,
    rh = 1;
  let ang = 0;

  function drawBars(): void {
    gl.drawArrays(gl.TRIANGLES, 0, BAND_COUNT * 6);
  }

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.4, audio.spectrum[i] * 1.7);
      ang += dt * (0.18 + audio.level * 0.3);
      const elev = 1.6 + Math.sin(t * 0.15) * 0.8 + audio.bass * 0.6;
      const dist = 8.5 - audio.bass * 1.5;
      const eye: Vec3 = [Math.cos(ang) * dist, elev, Math.sin(ang) * dist];
      const proj = perspective((52 * Math.PI) / 180, rw / rh, 0.1, 60);
      const view = lookAt(eye, [0, 1.0, 0], [0, 1, 0]);
      const vp = multiply(proj, view);
      // camera right (for billboarding) — horizontal component of cross(up, forward)
      const fwd: Vec3 = [-eye[0], 1.0 - eye[1], -eye[2]];
      const right: Vec3 = [fwd[2], 0, -fwd[0]];
      const rl = Math.hypot(right[0], right[2]) || 1;
      right[0] /= rl;
      right[2] /= rl;

      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniformMatrix4fv(u.u_vp, false, vp);
      gl.uniform3f(u.u_right, right[0], right[1], right[2]);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1fv(u.u_spectrum, spec);
      gl.uniform1f(u.u_mirror, 1);
      drawBars();
      gl.uniform1f(u.u_mirror, 0);
      drawBars();
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 0.9 + audio.level * 0.5,
        exposure: 1.05 + audio.kickPulse * 0.25,
        aberration: 0.001 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.15,
        flash: audio.kickPulse * 0.4,
        threshold: 0.6,
        time: t,
      });
    },
  };
}
