// 06 FLUID — a real Stable-Fluids solver (semi-Lagrangian advection + Jacobi pressure
// projection) pushing coloured dye. Emitters at the base feed the smoke; band energy
// swirls it and every kick punches a bright vortex of dye. Organic, painterly motion
// that no parametric trick matches.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const JACOBI = 22;

const ADVECT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_vel, u_src; uniform vec2 u_px; uniform float u_dt, u_diss, u_aspect;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 vel = texture(u_vel, v_uv).xy;
  vec2 coord = v_uv - u_dt * vel * vec2(1.0/u_aspect, 1.0);
  o = texture(u_src, coord) * u_diss;
}`;

const DIVERGENCE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_vel; uniform vec2 u_px;
in vec2 v_uv; out vec4 o;
void main(){
  float L = texture(u_vel, v_uv - vec2(u_px.x,0)).x;
  float R = texture(u_vel, v_uv + vec2(u_px.x,0)).x;
  float B = texture(u_vel, v_uv - vec2(0,u_px.y)).y;
  float T = texture(u_vel, v_uv + vec2(0,u_px.y)).y;
  float div = 0.5*((R - L) + (T - B));
  o = vec4(div, 0.0, 0.0, 1.0);
}`;

const JACOBI_FS = `#version 300 es
precision highp float;
uniform sampler2D u_prs, u_div; uniform vec2 u_px;
in vec2 v_uv; out vec4 o;
void main(){
  float L = texture(u_prs, v_uv - vec2(u_px.x,0)).x;
  float R = texture(u_prs, v_uv + vec2(u_px.x,0)).x;
  float B = texture(u_prs, v_uv - vec2(0,u_px.y)).x;
  float T = texture(u_prs, v_uv + vec2(0,u_px.y)).x;
  float d = texture(u_div, v_uv).x;
  o = vec4((L+R+B+T - d) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRAD_FS = `#version 300 es
precision highp float;
uniform sampler2D u_prs, u_vel; uniform vec2 u_px;
in vec2 v_uv; out vec4 o;
void main(){
  float L = texture(u_prs, v_uv - vec2(u_px.x,0)).x;
  float R = texture(u_prs, v_uv + vec2(u_px.x,0)).x;
  float B = texture(u_prs, v_uv - vec2(0,u_px.y)).x;
  float T = texture(u_prs, v_uv + vec2(0,u_px.y)).x;
  vec2 v = texture(u_vel, v_uv).xy;
  v -= 0.5*vec2(R-L, T-B);
  o = vec4(v, 0.0, 1.0);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_target; uniform vec2 u_point; uniform vec3 u_value;
uniform float u_radius, u_aspect;
in vec2 v_uv; out vec4 o;
void main(){
  vec3 base = texture(u_target, v_uv).xyz;
  vec2 d = (v_uv - u_point) * vec2(u_aspect, 1.0);
  float f = exp(-dot(d,d)/u_radius);
  o = vec4(base + f*u_value, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_dye; uniform float u_beat;
in vec2 v_uv; out vec4 o;
vec3 aces(vec3 x){ float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0); }
void main(){
  vec3 c = texture(u_dye, v_uv).rgb;
  c *= 1.0 + u_beat*0.3;
  c = aces(c*1.2);
  vec2 d=v_uv-0.5; c*=1.0-dot(d,d)*0.6;
  o = vec4(pow(c, vec3(0.9)), 1.0);
}`;

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export function createFluid(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const pAdvect = program(gl, FULLSCREEN_VS, ADVECT_FS);
  const pDiv = program(gl, FULLSCREEN_VS, DIVERGENCE_FS);
  const pJacobi = program(gl, FULLSCREEN_VS, JACOBI_FS);
  const pGrad = program(gl, FULLSCREEN_VS, GRAD_FS);
  const pSplat = program(gl, FULLSCREEN_VS, SPLAT_FS);
  const pDisp = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uA: Uniforms = uniforms(gl, pAdvect);
  const uDv: Uniforms = uniforms(gl, pDiv);
  const uJ: Uniforms = uniforms(gl, pJacobi);
  const uG: Uniforms = uniforms(gl, pGrad);
  const uS: Uniforms = uniforms(gl, pSplat);
  const uDp: Uniforms = uniforms(gl, pDisp);

  let sw = 1,
    sh = 1,
    rw = 1,
    rh = 1;
  let velA: RT, velB: RT, dyeA: RT, dyeB: RT, div: RT, prsA: RT, prsB: RT;

  function rt(w: number, h: number): RT {
    const tex = texture(gl, w, h, {
      internal: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
      filter: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    });
    return { tex, fbo: framebuffer(gl, tex) };
  }
  function alloc(): void {
    velA = rt(sw, sh);
    velB = rt(sw, sh);
    dyeA = rt(sw, sh);
    dyeB = rt(sw, sh);
    div = rt(sw, sh);
    prsA = rt(sw, sh);
    prsB = rt(sw, sh);
    for (const r of [velA, velB, dyeA, dyeB, prsA, prsB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  const px = (): [number, number] => [1 / sw, 1 / sh];
  const aspect = (): number => sw / sh;

  function pass(p: WebGLProgram, target: RT): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(p);
    gl.bindVertexArray(tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // render src.tex + gaussian -> dst (caller swaps the ping-pong)
  function doSplat(
    srcTex: WebGLTexture,
    dst: RT,
    x: number,
    y: number,
    val: [number, number, number],
    radius: number,
  ): void {
    gl.useProgram(pSplat);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(uS.u_target, 0);
    gl.uniform2f(uS.u_point, x, y);
    gl.uniform3f(uS.u_value, val[0], val[1], val[2]);
    gl.uniform1f(uS.u_radius, radius);
    gl.uniform1f(uS.u_aspect, aspect());
    pass(pSplat, dst);
  }
  const hueCol = (h: number, amp: number): [number, number, number] => [
    (0.5 + 0.5 * Math.cos(6.28 * h)) * amp,
    (0.5 + 0.5 * Math.cos(6.28 * (h + 0.33))) * amp,
    (0.5 + 0.5 * Math.cos(6.28 * (h + 0.66))) * amp,
  ];

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      sw = Math.max(8, w >> 1);
      sh = Math.max(8, h >> 1);
      alloc();
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);
      gl.disable(gl.BLEND);
      const [pxx, pxy] = px();

      // 1) advect velocity
      gl.useProgram(pAdvect);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uA.u_vel, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uA.u_src, 1);
      gl.uniform2f(uA.u_px, pxx, pxy);
      gl.uniform1f(uA.u_dt, fdt);
      gl.uniform1f(uA.u_diss, 0.998);
      gl.uniform1f(uA.u_aspect, aspect());
      pass(pAdvect, velB);
      [velA, velB] = [velB, velA];

      // 2) emitters + audio forces
      const emitVel = (x: number, y: number, vx: number, vy: number, r: number): void => {
        doSplat(velA.tex, velB, x, y, [vx, vy, 0], r);
        [velA, velB] = [velB, velA];
      };
      const emitDye = (x: number, y: number, col: [number, number, number], r: number): void => {
        doSplat(dyeA.tex, dyeB, x, y, col, r);
        [dyeA, dyeB] = [dyeB, dyeA];
      };
      const bands = [audio.bass, audio.mid, audio.high];
      [0.3, 0.5, 0.7].forEach((x, i) => {
        const s = 1.4 + bands[i] * 6.5;
        emitVel(x, 0.05, (Math.random() - 0.5) * 0.6, s, 0.0016);
        emitDye(x, 0.05, hueCol(audio.centroid + i * 0.2, 0.8 + bands[i] * 1.4), 0.0024);
      });
      if (audio.kick) {
        const kx = 0.25 + Math.random() * 0.5;
        const ky = 0.3 + Math.random() * 0.5;
        const ang = Math.random() * 6.28;
        emitVel(kx, ky, Math.cos(ang) * 9.0, Math.sin(ang) * 9.0, 0.006);
        emitDye(kx, ky, hueCol(audio.centroid + Math.random() * 0.3, 1.9), 0.008);
      }

      // 3) projection: divergence -> jacobi pressure -> subtract gradient
      gl.useProgram(pDiv);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uDv.u_vel, 0);
      gl.uniform2f(uDv.u_px, pxx, pxy);
      pass(pDiv, div);

      gl.bindFramebuffer(gl.FRAMEBUFFER, prsA.fbo);
      gl.viewport(0, 0, sw, sh);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pJacobi);
      gl.uniform2f(uJ.u_px, pxx, pxy);
      for (let i = 0; i < JACOBI; i++) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, prsA.tex);
        gl.uniform1i(uJ.u_prs, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, div.tex);
        gl.uniform1i(uJ.u_div, 1);
        pass(pJacobi, prsB);
        [prsA, prsB] = [prsB, prsA];
      }

      gl.useProgram(pGrad);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, prsA.tex);
      gl.uniform1i(uG.u_prs, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uG.u_vel, 1);
      gl.uniform2f(uG.u_px, pxx, pxy);
      pass(pGrad, velB);
      [velA, velB] = [velB, velA];

      // 4) advect dye
      gl.useProgram(pAdvect);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uA.u_vel, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dyeA.tex);
      gl.uniform1i(uA.u_src, 1);
      gl.uniform2f(uA.u_px, pxx, pxy);
      gl.uniform1f(uA.u_dt, fdt);
      gl.uniform1f(uA.u_diss, 0.991);
      gl.uniform1f(uA.u_aspect, aspect());
      pass(pAdvect, dyeB);
      [dyeA, dyeB] = [dyeB, dyeA];

      // 5) display
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, rw, rh);
      gl.useProgram(pDisp);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dyeA.tex);
      gl.uniform1i(uDp.u_dye, 0);
      gl.uniform1f(uDp.u_beat, audio.kickPulse);
      gl.bindVertexArray(tri);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      void t;
    },
  };
}
