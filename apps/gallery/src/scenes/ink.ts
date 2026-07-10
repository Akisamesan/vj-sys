// 66 INK — ink dropped into still water, curling and diffusing. A lightweight
// cousin of 06 FLUID: no pressure projection, just an analytic curl-noise
// velocity field (perpendicular to the gradient of a drifting potential field,
// so it stays divergence-free without a Jacobi solve) advecting a dye texture.
// Kicks stamp fresh ink drops; bass swells the vortices; level pushes the
// current; high smudges the edges; centroid walks the ink hue through
// magenta/cyan/yellow. Ping-pong GPGPU, single dye texture.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

// Advect + a touch of neighbour-blur diffusion + decay, all in one pass.
// Velocity is analytic: v = perp(grad(potential(p,t))) — a 2D curl of a
// scalar noise potential, divergence-free without any solver.
const ADVECT_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_src;
uniform vec2 u_px;
uniform float u_time, u_dt, u_aspect;
uniform float u_curlFreq, u_curlAmp, u_advect, u_diffuse, u_decay;
in vec2 v_uv; out vec4 o;

vec2 curlVel(vec2 p){
  float e = 0.08;
  float n1 = snoise(vec3(p + vec2(0.0, e), u_time*0.08));
  float n2 = snoise(vec3(p - vec2(0.0, e), u_time*0.08));
  float n3 = snoise(vec3(p + vec2(e, 0.0), u_time*0.08));
  float n4 = snoise(vec3(p - vec2(e, 0.0), u_time*0.08));
  float dPy = (n1 - n2) / (2.0*e);
  float dPx = (n3 - n4) / (2.0*e);
  return vec2(dPy, -dPx); // perpendicular to the gradient -> divergence-free
}

void main(){
  vec2 p = (v_uv - 0.5) * vec2(u_aspect, 1.0) * u_curlFreq;
  vec2 vel = curlVel(p) * u_curlAmp;
  vec2 coord = v_uv - u_dt * u_advect * vel * vec2(1.0/u_aspect, 1.0);
  vec3 adv = texture(u_src, coord).rgb;
  vec3 blur =
    texture(u_src, coord + vec2(u_px.x, 0.0)).rgb +
    texture(u_src, coord - vec2(u_px.x, 0.0)).rgb +
    texture(u_src, coord + vec2(0.0, u_px.y)).rgb +
    texture(u_src, coord - vec2(0.0, u_px.y)).rgb;
  blur *= 0.25;
  vec3 col = mix(adv, blur, u_diffuse) * u_decay;
  o = vec4(col, 1.0);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_point;
uniform vec3 u_color;
uniform float u_radius, u_aspect;
in vec2 v_uv; out vec4 o;
void main(){
  vec3 base = texture(u_src, v_uv).rgb;
  vec2 d = (v_uv - u_point) * vec2(u_aspect, 1.0);
  float g = exp(-dot(d,d)/u_radius);
  o = vec4(base + u_color*g, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_dye;
uniform float u_beat;
in vec2 v_uv; out vec4 o;
void main(){
  vec3 dye = texture(u_dye, v_uv).rgb;
  vec2 d = v_uv - 0.5;
  float r = length(d);
  vec3 deep = vec3(0.014, 0.045, 0.105);
  vec3 shallow = vec3(0.03, 0.09, 0.19);
  vec3 bg = mix(shallow, deep, smoothstep(0.05, 0.75, r));
  vec3 col = bg + dye * (1.0 + u_beat*0.15);
  col = col / (1.0 + col*0.6); // soft roll-off, no hard clip / no flash
  o = vec4(pow(clamp(col, 0.0, 1.0), vec3(0.92)), 1.0);
}`;

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export function createInk(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const pAdvect = program(gl, FULLSCREEN_VS, ADVECT_FS);
  const pSplat = program(gl, FULLSCREEN_VS, SPLAT_FS);
  const pDisplay = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uA: Uniforms = uniforms(gl, pAdvect);
  const uS: Uniforms = uniforms(gl, pSplat);
  const uD: Uniforms = uniforms(gl, pDisplay);

  let sw = 1,
    sh = 1;
  let dyeA: RT, dyeB: RT;

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

  const aspect = (): number => sw / sh;

  function pass(p: WebGLProgram, target: RT): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(p);
    gl.bindVertexArray(tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Ink palette: magenta -> cyan -> yellow, cycled by hue (centroid-driven).
  function inkColor(hue: number, amp: number): [number, number, number] {
    const stops: [number, number, number][] = [
      [1.0, 0.12, 0.82],
      [0.08, 0.82, 1.0],
      [1.0, 0.85, 0.12],
    ];
    const h = hue - Math.floor(hue);
    const seg = h * 3;
    const i = Math.floor(seg) % 3;
    const f = seg - Math.floor(seg);
    const c0 = stops[i];
    const c1 = stops[(i + 1) % 3];
    return [
      (c0[0] + (c1[0] - c0[0]) * f) * amp,
      (c0[1] + (c1[1] - c0[1]) * f) * amp,
      (c0[2] + (c1[2] - c0[2]) * f) * amp,
    ];
  }

  function doSplat(x: number, y: number, col: [number, number, number], radius: number): void {
    gl.useProgram(pSplat);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dyeA.tex);
    gl.uniform1i(uS.u_src, 0);
    gl.uniform2f(uS.u_point, x, y);
    gl.uniform3f(uS.u_color, col[0], col[1], col[2]);
    gl.uniform1f(uS.u_radius, radius);
    gl.uniform1f(uS.u_aspect, aspect());
    pass(pSplat, dyeB);
    [dyeA, dyeB] = [dyeB, dyeA];
  }

  function alloc(): void {
    dyeA = rt(sw, sh);
    dyeB = rt(sw, sh);
    for (const r of [dyeA, dyeB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    // A few drops already dissolving so the scene reads immediately, before
    // the first kick lands.
    for (let i = 0; i < 4; i++) {
      const x = 0.28 + Math.random() * 0.44;
      const y = 0.28 + Math.random() * 0.44;
      doSplat(x, y, inkColor(i / 4 + Math.random() * 0.1, 1.5), 0.01);
    }
  }

  return {
    resize(w, h) {
      sw = Math.max(8, w >> 1);
      sh = Math.max(8, h >> 1);
      alloc();
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);
      gl.disable(gl.BLEND);

      // kick: structural trigger -> a fresh ink drop at a random spot
      if (audio.kick) {
        const x = 0.12 + Math.random() * 0.76;
        const y = 0.12 + Math.random() * 0.76;
        const hue = audio.centroid + Math.random() * 0.15;
        doSplat(x, y, inkColor(hue, 1.7 + audio.bass * 0.6), 0.012);
      }

      // bass -> vortex scale + strength; level -> advection speed; high -> diffusion
      const curlFreq = 2.3 - audio.bass * 1.5; // more bass = bigger eddies
      const curlAmp = 0.6 + audio.bass * 2.0; // more bass = stronger swirl
      const advect = 0.15 + audio.level * 0.55;
      const diffuse = 0.06 + audio.high * 0.24;

      gl.useProgram(pAdvect);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dyeA.tex);
      gl.uniform1i(uA.u_src, 0);
      gl.uniform2f(uA.u_px, 1 / sw, 1 / sh);
      gl.uniform1f(uA.u_time, t);
      gl.uniform1f(uA.u_dt, fdt);
      gl.uniform1f(uA.u_aspect, aspect());
      gl.uniform1f(uA.u_curlFreq, curlFreq);
      gl.uniform1f(uA.u_curlAmp, curlAmp);
      gl.uniform1f(uA.u_advect, advect);
      gl.uniform1f(uA.u_diffuse, diffuse);
      gl.uniform1f(uA.u_decay, 0.9945);
      pass(pAdvect, dyeB);
      [dyeA, dyeB] = [dyeB, dyeA];

      ctx.bindOutput();
      gl.useProgram(pDisplay);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dyeA.tex);
      gl.uniform1i(uD.u_dye, 0);
      gl.uniform1f(uD.u_beat, audio.kickPulse);
      gl.bindVertexArray(tri);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
