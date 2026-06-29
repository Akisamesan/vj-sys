// 16 SLIME — a Physarum (slime-mould) simulation. ~100k agents sense and deposit a
// pheromone trail that diffuses and decays, self-organising into living transport
// networks. Bass drives speed and deposit, highs widen the sensor angle, kicks scatter
// the colony and the centroid tints the trail. GPGPU: agents in a float texture, trail
// in a feedback texture.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms, TexOpts } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const AG = 320; // 320^2 = 102,400 agents
const TR = 1024;

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_pos, u_trail;
uniform float u_dt, u_time, u_speed, u_sensAng, u_sensDist, u_turn, u_scatter;
in vec2 v_uv; out vec4 o;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float sense(vec2 p, float a){
  vec2 s = p + vec2(cos(a),sin(a))*u_sensDist;
  return texture(u_trail, fract(s)).r;
}
void main(){
  vec4 d = texture(u_pos, v_uv);
  vec2 p = d.xy; float ang = d.z, sd = d.w;
  float F = sense(p, ang);
  float L = sense(p, ang+u_sensAng);
  float R = sense(p, ang-u_sensAng);
  float rnd = hash(v_uv + fract(u_time*0.731));
  float ts = u_turn*u_dt*60.0;
  if(F>L && F>R){}
  else if(F<L && F<R){ ang += (rnd-0.5)*2.0*ts; }
  else if(L>R){ ang += ts*(0.7+0.6*rnd); }
  else { ang -= ts*(0.7+0.6*rnd); }
  if(rnd < u_scatter) ang = (rnd*7.13+sd)*6.28318;
  p += vec2(cos(ang),sin(ang))*u_speed*u_dt;
  p = fract(p);
  o = vec4(p, ang, sd);
}`;

const DEPOSIT_VS = `#version 300 es
uniform sampler2D u_pos;
out float v_sd;
void main(){
  ivec2 ts = textureSize(u_pos, 0);
  ivec2 c = ivec2(gl_VertexID % ts.x, gl_VertexID / ts.x);
  vec4 d = texelFetch(u_pos, c, 0);
  v_sd = d.w;
  gl_Position = vec4(d.xy*2.0-1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;
const DEPOSIT_FS = `#version 300 es
precision highp float;
uniform float u_dep; in float v_sd; out vec4 o;
void main(){ o = vec4(u_dep, u_dep*v_sd, 0.0, 1.0); }`;

const DIFFUSE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_trail; uniform float u_decay, u_diff; uniform vec2 u_px;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 c = texture(u_trail, v_uv).rg;
  vec2 s = vec2(0.0);
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++)
    s += texture(u_trail, v_uv + vec2(float(i),float(j))*u_px).rg;
  s /= 9.0;
  o = vec4(mix(c,s,u_diff)*u_decay, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_trail; uniform float u_gain, u_beat, u_time, u_centroid;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 tr = texture(u_trail, v_uv).rg;
  float v = tr.r*u_gain;
  float hueVar = tr.g/max(tr.r,1e-4);
  v = pow(clamp(v,0.0,4.0),0.8);
  vec3 col = palette(v*0.5 + hueVar*0.25 + u_centroid*0.4 + u_time*0.01,
    vec3(0.5),vec3(0.5),vec3(1.0,1.0,1.0),vec3(0.0,0.33,0.55)) * smoothstep(0.0,0.9,v);
  col += vec3(0.9,1.0,0.85)*pow(clamp(v-1.1,0.0,3.0),2.0)*0.25;
  col *= 1.0 + u_beat*0.18;
  vec2 d = v_uv-0.5; col *= 1.0 - dot(d,d)*0.7;
  o = vec4(pow(col, vec3(0.9)), 1.0);
}`;

interface State {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export function createSlime(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const update = program(gl, FULLSCREEN_VS, UPDATE_FS);
  const deposit = program(gl, DEPOSIT_VS, DEPOSIT_FS);
  const diffuse = program(gl, FULLSCREEN_VS, DIFFUSE_FS);
  const display = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uU: Uniforms = uniforms(gl, update);
  const uDep: Uniforms = uniforms(gl, deposit);
  const uDif: Uniforms = uniforms(gl, diffuse);
  const uDis: Uniforms = uniforms(gl, display);
  const emptyVAO = gl.createVertexArray()!;

  const posOpt: TexOpts = {
    internal: gl.RGBA32F,
    format: gl.RGBA,
    type: gl.FLOAT,
    filter: gl.NEAREST,
    wrap: gl.CLAMP_TO_EDGE,
  };
  const trOpt: TexOpts = {
    internal: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
    filter: gl.LINEAR,
    wrap: gl.REPEAT,
  };
  let posA: State, posB: State, trA: State, trB: State;

  function mk(side: number, opt: TexOpts): State {
    const tex = texture(gl, side, side, opt);
    return { tex, fbo: framebuffer(gl, tex) };
  }

  function seed(): void {
    posA = mk(AG, posOpt);
    posB = mk(AG, posOpt);
    trA = mk(TR, trOpt);
    trB = mk(TR, trOpt);
    const d = new Float32Array(AG * AG * 4);
    for (let i = 0; i < AG * AG; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.12 + Math.random() * 0.22;
      d[i * 4] = 0.5 + Math.cos(a) * r;
      d[i * 4 + 1] = 0.5 + Math.sin(a) * r;
      d[i * 4 + 2] = a + Math.PI * (Math.random() < 0.5 ? 0 : 1);
      d[i * 4 + 3] = Math.random();
    }
    gl.bindTexture(gl.TEXTURE_2D, posA.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, AG, AG, gl.RGBA, gl.FLOAT, d);
    for (const s of [trA, trB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }
  seed();

  let rw = 1,
    rh = 1;
  let scatter = 0;

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
      const fdt = Math.min(dt, 0.033);
      if (audio.kick) scatter = 0.1 + audio.change * 0.25;
      scatter *= Math.exp(-fdt * 9);
      const speed = (0.05 + audio.bass * 0.22) * (0.6 + audio.change * 0.8);
      const sensAng = 0.35 + audio.high * 1.1;
      const dep = 0.1 + audio.bass * 0.3;

      gl.disable(gl.BLEND);

      // 1) update agents -> posB
      gl.bindFramebuffer(gl.FRAMEBUFFER, posB.fbo);
      gl.viewport(0, 0, AG, AG);
      gl.useProgram(update);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, posA.tex);
      gl.uniform1i(uU.u_pos, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, trA.tex);
      gl.uniform1i(uU.u_trail, 1);
      gl.uniform1f(uU.u_dt, fdt);
      gl.uniform1f(uU.u_time, t);
      gl.uniform1f(uU.u_speed, speed);
      gl.uniform1f(uU.u_sensAng, sensAng);
      gl.uniform1f(uU.u_sensDist, 9 / TR);
      gl.uniform1f(uU.u_turn, 0.3);
      gl.uniform1f(uU.u_scatter, scatter);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [posA, posB] = [posB, posA];

      // 2) deposit additive points into trA
      gl.bindFramebuffer(gl.FRAMEBUFFER, trA.fbo);
      gl.viewport(0, 0, TR, TR);
      gl.useProgram(deposit);
      gl.bindVertexArray(emptyVAO);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, posA.tex);
      gl.uniform1i(uDep.u_pos, 0);
      gl.uniform1f(uDep.u_dep, dep);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.POINTS, 0, AG * AG);
      gl.disable(gl.BLEND);

      // 3) diffuse + decay trA -> trB
      gl.bindFramebuffer(gl.FRAMEBUFFER, trB.fbo);
      gl.viewport(0, 0, TR, TR);
      gl.useProgram(diffuse);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, trA.tex);
      gl.uniform1i(uDif.u_trail, 0);
      gl.uniform1f(uDif.u_decay, 0.96);
      gl.uniform1f(uDif.u_diff, 0.5);
      gl.uniform2f(uDif.u_px, 1 / TR, 1 / TR);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [trA, trB] = [trB, trA];

      // 4) display
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, rw, rh);
      gl.useProgram(display);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, trA.tex);
      gl.uniform1i(uDis.u_trail, 0);
      gl.uniform1f(uDis.u_gain, 1.4);
      gl.uniform1f(uDis.u_beat, audio.kickPulse);
      gl.uniform1f(uDis.u_time, t);
      gl.uniform1f(uDis.u_centroid, audio.centroid);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
