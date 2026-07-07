// 67 FIRE — a buoyant flame plume: a velocity field and a temperature field are
// ping-ponged through semi-Lagrangian advection, buoyancy (upward force
// proportional to temperature) and vorticity confinement (re-injects the swirl
// lost to numerical damping, since there is no pressure projection here — a
// deliberate simplification: stylised fire reads fine without incompressibility,
// and skipping the Jacobi solve keeps this comfortably under the frame budget).
// The base is fed by several audio-distributed heat columns plus a constant
// ember floor so the coals never go fully dark, and every kick punches a local
// burst that floats up on its own over the following frames.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const NCOL = 8;
const MAX_SPEED = 7.0;
const MAX_TEMP = 6.0;

const ADVECT_VEL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_vel; uniform float u_dt, u_diss, u_aspect;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 vel = texture(u_vel, v_uv).xy;
  vec2 coord = v_uv - u_dt * vel * vec2(1.0/u_aspect, 1.0);
  vec2 v = texture(u_vel, coord).xy;
  o = vec4(v * u_diss, 0.0, 1.0);
}`;

const CURL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_vel; uniform vec2 u_px;
in vec2 v_uv; out vec4 o;
void main(){
  float vyR = texture(u_vel, v_uv + vec2(u_px.x,0)).y;
  float vyL = texture(u_vel, v_uv - vec2(u_px.x,0)).y;
  float vxT = texture(u_vel, v_uv + vec2(0,u_px.y)).x;
  float vxB = texture(u_vel, v_uv - vec2(0,u_px.y)).x;
  float w = 0.5*((vyR - vyL) - (vxT - vxB));
  o = vec4(w, 0.0, 0.0, 1.0);
}`;

const FORCE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_vel, u_curl, u_temp; uniform vec2 u_px;
uniform float u_dt, u_buoy, u_vortEps, u_maxSpeed;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 v = texture(u_vel, v_uv).xy;
  float wC = texture(u_curl, v_uv).x;
  float wR = abs(texture(u_curl, v_uv + vec2(u_px.x,0)).x);
  float wL = abs(texture(u_curl, v_uv - vec2(u_px.x,0)).x);
  float wT = abs(texture(u_curl, v_uv + vec2(0,u_px.y)).x);
  float wB = abs(texture(u_curl, v_uv - vec2(0,u_px.y)).x);
  vec2 grad = vec2(wR - wL, wT - wB);
  vec2 n = grad / (length(grad) + 1e-5);
  vec2 vort = u_vortEps * vec2(n.y, -n.x) * wC;
  float temp = texture(u_temp, v_uv).x;
  vec2 buoy = vec2(0.0, 1.0) * temp * u_buoy;
  v += (vort + buoy) * u_dt;
  float sp = length(v);
  v *= min(1.0, u_maxSpeed / max(sp, 1e-4));
  o = vec4(v, 0.0, 1.0);
}`;

const TEMP_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_vel, u_temp;
uniform float u_dt, u_decay, u_aspect, u_time, u_ember, u_bassInj, u_maxTemp;
uniform float u_col[${NCOL}];
uniform vec2 u_kickPos; uniform float u_kickAmt;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 vel = texture(u_vel, v_uv).xy;
  vec2 coord = v_uv - u_dt * vel * vec2(1.0/u_aspect, 1.0);
  float t = texture(u_temp, coord).x * u_decay;

  // base heat: a bottom band, spatially distributed by the spectrum-driven
  // column profile, plus a constant ember floor so silence never goes black.
  float yMask = smoothstep(0.20, 0.0, v_uv.y);
  float fx = clamp(v_uv.x, 0.0, 0.999) * ${NCOL.toFixed(1)};
  int i0 = int(floor(fx));
  int i1 = min(i0 + 1, ${NCOL - 1});
  float colAmt = mix(u_col[i0], u_col[i1], fract(fx));
  float flicker = snoise(vec3(v_uv.x*10.0, 0.0, u_time*0.8))*0.5 + 0.5;
  float src = (u_ember + u_bassInj*colAmt*(0.6+0.4*colAmt)) * (0.7 + 0.6*flicker);
  t += src * yMask * u_dt;

  // kick burst: a localised gaussian that rides the decaying kick pulse and
  // floats up naturally through the velocity field on later frames.
  vec2 kd = (v_uv - u_kickPos) * vec2(u_aspect, 1.0);
  float kg = exp(-dot(kd,kd)/0.02);
  t += kg * u_kickAmt * u_dt * 18.0;

  o = vec4(min(max(t,0.0), u_maxTemp), 0.0, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_temp, u_curl;
uniform float u_time, u_centroid, u_high;
in vec2 v_uv; out vec4 o;
vec3 blackbody(float x){
  vec3 c = vec3(0.015, 0.015, 0.02);
  c = mix(c, vec3(0.28, 0.03, 0.01), smoothstep(0.05, 0.30, x));
  c = mix(c, vec3(0.85, 0.16, 0.02), smoothstep(0.25, 0.55, x));
  c = mix(c, vec3(1.0, 0.55, 0.08), smoothstep(0.50, 0.80, x));
  c = mix(c, vec3(1.0, 0.92, 0.6), smoothstep(0.75, 1.05, x));
  return c;
}
void main(){
  float t = texture(u_temp, v_uv).x;
  float xn = t / (0.7 + t);
  xn *= 0.85 + u_centroid * 0.35;
  vec3 col = blackbody(clamp(xn, 0.0, 1.15));

  float vort = abs(texture(u_curl, v_uv).x);
  float spark = smoothstep(0.6, 2.2, vort) * clamp(u_high, 0.0, 1.0);
  float flick = snoise(vec3(v_uv*46.0, u_time*2.2))*0.5 + 0.5;
  col = mix(col, vec3(1.0, 0.82, 0.55), spark*flick*0.3);

  vec2 d = v_uv - 0.5;
  col *= 1.0 - dot(d,d)*0.55;
  o = vec4(pow(max(col, 0.0), vec3(0.92)), 1.0);
}`;

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export function createFire(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const pAdvectVel = program(gl, FULLSCREEN_VS, ADVECT_VEL_FS);
  const pCurl = program(gl, FULLSCREEN_VS, CURL_FS);
  const pForce = program(gl, FULLSCREEN_VS, FORCE_FS);
  const pTemp = program(gl, FULLSCREEN_VS, TEMP_FS);
  const pDisp = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uAV: Uniforms = uniforms(gl, pAdvectVel);
  const uC: Uniforms = uniforms(gl, pCurl);
  const uF: Uniforms = uniforms(gl, pForce);
  const uT: Uniforms = uniforms(gl, pTemp);
  const uD: Uniforms = uniforms(gl, pDisp);

  let sw = 1,
    sh = 1;
  let velA: RT, velB: RT, tempA: RT, tempB: RT, curl: RT;

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
    tempA = rt(sw, sh);
    tempB = rt(sw, sh);
    curl = rt(sw, sh);
    for (const r of [velA, velB, tempA, tempB, curl]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  function pass(p: WebGLProgram, target: RT): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, sw, sh);
    gl.useProgram(p);
    gl.bindVertexArray(tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const colProfile = new Float32Array(NCOL);
  let kickX = 0.5;
  const kickY = 0.1;

  return {
    resize(w, h) {
      sw = Math.max(8, w >> 1);
      sh = Math.max(8, h >> 1);
      alloc();
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 0.033);
      gl.disable(gl.BLEND);
      const pxx = 1 / sw,
        pxy = 1 / sh;
      const aspect = sw / sh;

      if (audio.kick) kickX = 0.15 + Math.random() * 0.7;
      const kickAmt = audio.kickPulse;

      const bandsPer = Math.floor(audio.spectrum.length / NCOL) || 1;
      for (let i = 0; i < NCOL; i++) {
        let s = 0;
        for (let j = 0; j < bandsPer; j++) s += audio.spectrum[i * bandsPer + j] ?? 0;
        colProfile[i] = s / bandsPer;
      }

      const velDecay = Math.exp(-fdt * 0.6);
      const tempDecay = Math.exp(-fdt * 0.6);
      const buoy = 3.0 + audio.level * 4.5;
      const vortEps = 0.04 + audio.high * 0.1;
      const bassInj = audio.bass * 2.4;
      const ember = 0.2;

      // 1) advect velocity through itself
      gl.useProgram(pAdvectVel);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uAV.u_vel, 0);
      gl.uniform1f(uAV.u_dt, fdt);
      gl.uniform1f(uAV.u_diss, velDecay);
      gl.uniform1f(uAV.u_aspect, aspect);
      pass(pAdvectVel, velB);
      [velA, velB] = [velB, velA];

      // 2) vorticity scalar from the fresh velocity field
      gl.useProgram(pCurl);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uC.u_vel, 0);
      gl.uniform2f(uC.u_px, pxx, pxy);
      pass(pCurl, curl);

      // 3) buoyancy (from temperature) + vorticity confinement -> velocity
      gl.useProgram(pForce);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uF.u_vel, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, curl.tex);
      gl.uniform1i(uF.u_curl, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, tempA.tex);
      gl.uniform1i(uF.u_temp, 2);
      gl.uniform2f(uF.u_px, pxx, pxy);
      gl.uniform1f(uF.u_dt, fdt);
      gl.uniform1f(uF.u_buoy, buoy);
      gl.uniform1f(uF.u_vortEps, vortEps);
      gl.uniform1f(uF.u_maxSpeed, MAX_SPEED);
      pass(pForce, velB);
      [velA, velB] = [velB, velA];

      // 4) advect temperature + inject heat sources
      gl.useProgram(pTemp);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, velA.tex);
      gl.uniform1i(uT.u_vel, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tempA.tex);
      gl.uniform1i(uT.u_temp, 1);
      gl.uniform1f(uT.u_dt, fdt);
      gl.uniform1f(uT.u_decay, tempDecay);
      gl.uniform1f(uT.u_aspect, aspect);
      gl.uniform1f(uT.u_time, t);
      gl.uniform1f(uT.u_ember, ember);
      gl.uniform1f(uT.u_bassInj, bassInj);
      gl.uniform1f(uT.u_maxTemp, MAX_TEMP);
      gl.uniform1fv(uT.u_col, colProfile);
      gl.uniform2f(uT.u_kickPos, kickX, kickY);
      gl.uniform1f(uT.u_kickAmt, kickAmt);
      pass(pTemp, tempB);
      [tempA, tempB] = [tempB, tempA];

      // 5) display: temperature -> black-body colour
      ctx.bindOutput();
      gl.useProgram(pDisp);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tempA.tex);
      gl.uniform1i(uD.u_temp, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, curl.tex);
      gl.uniform1i(uD.u_curl, 1);
      gl.uniform1f(uD.u_time, t);
      gl.uniform1f(uD.u_centroid, audio.centroid);
      gl.uniform1f(uD.u_high, audio.high);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
