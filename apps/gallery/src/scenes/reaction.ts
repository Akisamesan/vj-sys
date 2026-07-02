// 02 REACTION — Gray-Scott reaction-diffusion. Living Turing patterns (spots,
// stripes, mazes) grow and dissolve on a fixed grid. Bass/centroid push the feed
// and kill rates across pattern regimes; kicks inject fresh seeds; novelty repaints.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 512;
const STEPS = 12;

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state; uniform vec2 u_px;
uniform float u_feed, u_kill, u_inject; uniform vec2 u_seed;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 s = texture(u_state, v_uv).xy;
  vec2 lap = vec2(0.0);
  lap += texture(u_state, v_uv+vec2(u_px.x,0)).xy;
  lap += texture(u_state, v_uv-vec2(u_px.x,0)).xy;
  lap += texture(u_state, v_uv+vec2(0,u_px.y)).xy;
  lap += texture(u_state, v_uv-vec2(0,u_px.y)).xy;
  lap += 0.5*texture(u_state, v_uv+u_px).xy;
  lap += 0.5*texture(u_state, v_uv-u_px).xy;
  lap += 0.5*texture(u_state, v_uv+vec2(u_px.x,-u_px.y)).xy;
  lap += 0.5*texture(u_state, v_uv+vec2(-u_px.x,u_px.y)).xy;
  lap -= 6.0*s;
  float u=s.x, v=s.y;
  float uvv = u*v*v;
  float du = 0.16*lap.x - uvv + u_feed*(1.0-u);
  float dv = 0.08*lap.y + uvv - (u_feed+u_kill)*v;
  u += du; v += dv;
  // inject a soft blob of v on beats
  float d = distance(v_uv, u_seed);
  v += u_inject * smoothstep(0.06, 0.0, d);
  o = vec4(clamp(u,0.0,1.0), clamp(v,0.0,1.0), 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_state; uniform vec2 u_res, u_simRes; uniform float u_time, u_beat;
uniform vec3 u_pa, u_pb, u_pc, u_pd;
in vec2 v_uv; out vec4 o;
void main(){
  // cover-fit the square sim onto the screen
  vec2 uv = v_uv;
  float ar = u_res.x/u_res.y;
  if(ar>1.0) uv = vec2((uv.x-0.5)/ar+0.5, uv.y); else uv = vec2(uv.x,(uv.y-0.5)*ar+0.5);
  vec2 st = texture(u_state, uv).xy;
  float v = st.y;
  float edge = length(vec2(dFdx(v), dFdy(v)))*40.0;
  vec3 col = palette(v*1.6 + u_time*0.02, u_pa,u_pb,u_pc,u_pd);
  col *= smoothstep(0.0,0.25,v);
  col += vec3(0.9,1.0,0.95)*edge*0.6;        // bright membranes
  col *= 1.0 + u_beat*0.3;
  vec2 d=v_uv-0.5; col*=1.0-dot(d,d)*0.8;
  o = vec4(pow(col,vec3(0.85)), 1.0);
}`;

const PALETTES: [number, number, number][][] = [
  [
    [0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5],
    [1.0, 1.0, 1.0],
    [0.0, 0.1, 0.2],
  ],
  [
    [0.5, 0.4, 0.3],
    [0.5, 0.5, 0.4],
    [1.0, 1.0, 0.5],
    [0.8, 0.9, 0.3],
  ],
  [
    [0.3, 0.5, 0.6],
    [0.4, 0.4, 0.5],
    [1.0, 1.0, 1.0],
    [0.5, 0.6, 0.8],
  ],
  [
    [0.6, 0.3, 0.4],
    [0.5, 0.4, 0.4],
    [1.0, 0.8, 0.6],
    [0.1, 0.3, 0.6],
  ],
];

export function createReaction(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const upProg = program(gl, FULLSCREEN_VS, UPDATE_FS);
  const dispProg = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uU: Uniforms = uniforms(gl, upProg);
  const uD: Uniforms = uniforms(gl, dispProg);

  const opts = {
    internal: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
    filter: gl.LINEAR,
    wrap: gl.REPEAT,
  };
  let texA = texture(gl, N, N, opts);
  let texB = texture(gl, N, N, opts);
  let fboA = framebuffer(gl, texA);
  let fboB = framebuffer(gl, texB);

  function seed(): void {
    const data = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      data[i * 4] = 1;
      data[i * 4 + 1] = 0;
      data[i * 4 + 3] = 1;
    }
    for (let s = 0; s < 40; s++) {
      const cx = (Math.random() * N) | 0,
        cy = (Math.random() * N) | 0,
        r = 6 + Math.random() * 10;
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++) {
          const px = (cx + x + N) % N,
            py = (cy + y + N) % N;
          if (x * x + y * y < r * r) data[(py * N + px) * 4 + 1] = 1;
        }
    }
    for (const t of [texA, texB]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.FLOAT, data);
    }
  }
  seed();

  let rw = 1,
    rh = 1;
  let pal = 0;
  let lastSwitch = 0;
  const cur = PALETTES[0].map((c) => [...c]) as [number, number, number][];

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    key(k) {
      if (k === "r") {
        seed();
        return true;
      }
      return false;
    },
    frame(t, dt, audio: AudioEngine) {
      if (audio.novelty > 2.2 && t - lastSwitch > 4) {
        pal = (pal + 1) % PALETTES.length;
        lastSwitch = t;
      }
      const tgt = PALETTES[pal];
      const lk = 1 - Math.exp(-dt * 2);
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 3; j++) cur[i][j] += (tgt[i][j] - cur[i][j]) * lk;

      // Audio -> feed/kill regime. Map within the interesting Gray-Scott band.
      const feed = 0.022 + audio.bass * 0.045 + audio.centroid * 0.02;
      const kill = 0.051 + audio.high * 0.012 + audio.mid * 0.006;
      const inject = audio.kick ? 0.9 : 0;
      const sx = Math.random(),
        sy = Math.random();

      gl.disable(gl.BLEND);
      gl.useProgram(upProg);
      gl.bindVertexArray(tri);
      gl.uniform2f(uU.u_px, 1 / N, 1 / N);
      gl.uniform1f(uU.u_feed, feed);
      gl.uniform1f(uU.u_kill, kill);
      for (let s = 0; s < STEPS; s++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.viewport(0, 0, N, N);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texA);
        gl.uniform1i(uU.u_state, 0);
        gl.uniform1f(uU.u_inject, s === 0 ? inject : 0);
        gl.uniform2f(uU.u_seed, sx, sy);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        [texA, texB] = [texB, texA];
        [fboA, fboB] = [fboB, fboA];
      }

      ctx.bindOutput();
      gl.useProgram(dispProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uD.u_state, 0);
      gl.uniform2f(uD.u_res, rw, rh);
      gl.uniform2f(uD.u_simRes, N, N);
      gl.uniform1f(uD.u_time, t);
      gl.uniform1f(uD.u_beat, audio.kickPulse);
      gl.uniform3fv(uD.u_pa, cur[0]);
      gl.uniform3fv(uD.u_pb, cur[1]);
      gl.uniform3fv(uD.u_pc, cur[2]);
      gl.uniform3fv(uD.u_pd, cur[3]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
