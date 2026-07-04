// 17 WAVES — a discrete wave-equation pond (GPGPU ping-pong, à la reaction.ts).
// Each texel stores h (current height, R) and h_prev (previous height, G); the update
// pass integrates h_new = 2h - h_prev + c²·∇²h - damping·(h-h_prev), the classic
// leapfrog finite-difference wave equation. Kicks drop a point impulse that spreads
// and interferes with older ripples; bass tunes propagation speed/persistence. A
// gentle always-on drip keeps the pond alive even in silence. Display reconstructs a
// normal from the height field (central differences) for simple Blinn-Phong shading;
// level adds a low-amplitude display-only swell, high sharpens the specular highlight.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 256;
// Hard CFL safety cap for the 5-point leapfrog stencil (dx = 1 texel): stable for
// r <= 0.5, kept well under that so a stalled frame's larger dt never diverges.
const ALPHA_MAX = 0.22;

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state; uniform vec2 u_px;
uniform float u_alpha, u_damping, u_inject, u_radius; uniform vec2 u_seed;
in vec2 v_uv; out vec4 o;
void main(){
  vec2 s = texture(u_state, v_uv).rg;
  float h = s.x, hPrev = s.y;
  float hL = texture(u_state, v_uv-vec2(u_px.x,0.0)).r;
  float hR = texture(u_state, v_uv+vec2(u_px.x,0.0)).r;
  float hD = texture(u_state, v_uv-vec2(0.0,u_px.y)).r;
  float hU = texture(u_state, v_uv+vec2(0.0,u_px.y)).r;
  float lap = hL + hR + hD + hU - 4.0*h;
  float hNew = 2.0*h - hPrev + u_alpha*lap - u_damping*(h - hPrev);
  float d = distance(v_uv, u_seed);
  hNew += u_inject * smoothstep(u_radius, 0.0, d);
  // Slow DC bleed-off: the always-on drip only ever adds positive height, so
  // without this the mean pond level creeps upward over many seconds and the
  // colour mapping below saturates to one flat bright shade (no ripple detail
  // left to see). Negligible per-frame, keeps the field mean near zero.
  hNew *= 0.9985;
  hNew = clamp(hNew, -2.0, 2.0);
  o = vec4(hNew, h, 0.0, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state; uniform vec2 u_res, u_simRes;
uniform float u_time, u_level, u_high, u_kickPulse;
in vec2 v_uv; out vec4 o;

// Display-only low-amplitude swell (never fed back into the sim): a slow sine
// superposition that breathes the whole pond with level.
float swell(vec2 uv, float t){
  return sin(uv.x*3.1 + t*0.6) + sin(uv.y*2.3 - t*0.42 + 1.3);
}

void main(){
  // cover-fit the square sim onto the screen
  vec2 uv = v_uv;
  float ar = u_res.x/u_res.y;
  if(ar>1.0) uv = vec2((uv.x-0.5)/ar+0.5, uv.y); else uv = vec2(uv.x,(uv.y-0.5)*ar+0.5);

  vec2 e = 1.0/u_simRes;
  float sw = 0.05*u_level;
  float h  = texture(u_state, uv).r                    + swell(uv, u_time)*sw;
  float hL = texture(u_state, uv-vec2(e.x,0.0)).r      + swell(uv-vec2(e.x,0.0), u_time)*sw;
  float hR = texture(u_state, uv+vec2(e.x,0.0)).r      + swell(uv+vec2(e.x,0.0), u_time)*sw;
  float hD = texture(u_state, uv-vec2(0.0,e.y)).r      + swell(uv-vec2(0.0,e.y), u_time)*sw;
  float hU = texture(u_state, uv+vec2(0.0,e.y)).r      + swell(uv+vec2(0.0,e.y), u_time)*sw;

  float steep = 10.0;
  vec3 normal = normalize(vec3((hL-hR)*steep, (hD-hU)*steep, 1.0));
  vec3 lightDir = normalize(vec3(0.35, 0.55, 0.75));
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  float diff = max(dot(normal, lightDir), 0.0);
  vec3 halfV = normalize(lightDir + viewDir);
  float shininess = mix(10.0, 90.0, clamp(u_high, 0.0, 1.0));
  float spec = pow(max(dot(normal, halfV), 0.0), shininess);

  vec3 deep = vec3(0.03, 0.05, 0.22);    // indigo depths
  vec3 shallow = vec3(0.08, 0.42, 0.55); // cyan shallows
  // A gentler slope than a raw height readout: real wave heights routinely
  // exceed +-0.3, which at a steep slope clips almost the whole pond to one
  // flat colour and leaves no ripple detail visible (only the specular rings
  // read). This keeps a visible gradient across the field's natural range.
  float mixv = clamp(h*0.9 + 0.5, 0.0, 1.0);
  vec3 water = mix(deep, shallow, mixv);

  vec3 col = water * (0.35 + 0.65*diff);
  col += vec3(1.0) * spec * (0.7 + 0.5*u_high);
  col *= 1.0 + u_kickPulse*0.22;

  vec2 d2 = v_uv - 0.5;
  col *= 1.0 - dot(d2,d2)*0.4;
  o = vec4(pow(max(col, 0.0), vec3(0.85)), 1.0);
}`;

export function createWaves(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const upProg = program(gl, FULLSCREEN_VS, UPDATE_FS);
  const dispProg = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uU: Uniforms = uniforms(gl, upProg);
  const uD: Uniforms = uniforms(gl, dispProg);

  const opts = {
    internal: gl.RG16F,
    format: gl.RG,
    type: gl.HALF_FLOAT,
    filter: gl.NEAREST,
    wrap: gl.CLAMP_TO_EDGE,
  };
  let texA = texture(gl, N, N, opts);
  let texB = texture(gl, N, N, opts);
  let fboA = framebuffer(gl, texA);
  let fboB = framebuffer(gl, texB);

  // A few soft initial bumps (h = h_prev so the pond starts at rest, no launch transient).
  function seed(): void {
    const data = new Float32Array(N * N * 2);
    for (let s = 0; s < 5; s++) {
      const cx = Math.random() * N;
      const cy = Math.random() * N;
      const r = 18 + Math.random() * 34;
      const amp = 0.2 + Math.random() * 0.25;
      const x0 = Math.max(0, Math.floor(cx - r));
      const x1 = Math.min(N - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r));
      const y1 = Math.min(N - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx,
            dy = y - cy;
          const d = Math.sqrt(dx * dx + dy * dy) / r;
          if (d > 1) continue;
          const bump = amp * Math.cos((d * Math.PI) / 2);
          const i = (y * N + x) * 2;
          data[i] += bump;
          data[i + 1] += bump;
        }
      }
    }
    for (const t of [texA, texB]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RG, gl.FLOAT, data);
    }
  }
  seed();

  let rw = 1,
    rh = 1;

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
      // bass -> propagation speed (c) and persistence (lower damping = travels
      // farther/longer). dt is clamped so a stalled frame can't spike c*dt past the
      // CFL bound; alpha is hard-clamped again as a second safety net.
      const dtc = Math.min(Math.max(dt, 0), 1 / 20);
      const c = 22 + audio.bass * 7;
      const alpha = Math.min((c * dtc) ** 2, ALPHA_MAX);
      const damping = 0.05 - audio.bass * 0.035;

      // A slow, always-on drip keeps the pond alive in silence (autonomous motion;
      // audio is seasoning, not the only mover). Kicks briefly take over that frame's
      // injection with a sharper, larger, randomly placed impulse.
      const driftX = 0.5 + 0.32 * Math.sin(t * 0.13);
      const driftY = 0.5 + 0.32 * Math.cos(t * 0.089 + 1.7);
      let sx = driftX,
        sy = driftY,
        inject = 0.012,
        radius = 0.1;
      if (audio.kick) {
        sx = Math.random();
        sy = Math.random();
        inject = 0.75;
        radius = 0.035;
      }

      gl.disable(gl.BLEND);
      gl.useProgram(upProg);
      gl.bindVertexArray(tri);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.viewport(0, 0, N, N);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uU.u_state, 0);
      gl.uniform2f(uU.u_px, 1 / N, 1 / N);
      gl.uniform1f(uU.u_alpha, alpha);
      gl.uniform1f(uU.u_damping, damping);
      gl.uniform1f(uU.u_inject, inject);
      gl.uniform1f(uU.u_radius, radius);
      gl.uniform2f(uU.u_seed, sx, sy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [texA, texB] = [texB, texA];
      [fboA, fboB] = [fboB, fboA];

      ctx.bindOutput();
      gl.useProgram(dispProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uD.u_state, 0);
      gl.uniform2f(uD.u_res, rw, rh);
      gl.uniform2f(uD.u_simRes, N, N);
      gl.uniform1f(uD.u_time, t);
      gl.uniform1f(uD.u_level, audio.level);
      gl.uniform1f(uD.u_high, audio.high);
      gl.uniform1f(uD.u_kickPulse, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
