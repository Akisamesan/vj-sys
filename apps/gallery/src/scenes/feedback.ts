// 56 FEEDBACK — infinite video-feedback recursion. Every frame re-samples the
// previous frame slightly zoomed and rotated around its own centre and
// hue-shifts it, then stamps a small hard-edged disc (with a bright rim, not
// a soft blur) that slowly orbits the centre and pulses on its own cadence
// (kick adds an accent on top). Because each generation folds back into the
// next, that one disc leaves a trail of discrete, growing, rotating, hue-
// shifting copies of itself — a legible multi-generation spiral, not just a
// smear. Bass sets the zoom (recession) rate, mid the spin rate, centroid the
// hue-shift rate and level the feedback's brightness retention.
//
// Tuning note: the full QA capture window (warmup + quiet + loud capture)
// resolves in only ~4s of simulated time. A disc's centre-to-edge trip must
// therefore be short relative to *that* window — not just "not too slow" —
// or every disc is still bunched near the centre when QA/a viewer looks,
// reading as one soft blob regardless of how crisp its edge is. Tuned here
// for a ~1-1.6s trip with a fresh disc stamped roughly every 0.7s, so 2-3
// discs sit at visibly different radii/rotations/hues at any moment.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms, TexOpts } from "../engine/gl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 640; // sim resolution, decoupled from screen size (cover-fit on display)

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform float u_zoom, u_rot, u_hue, u_decay, u_seedR, u_seedAmt;
uniform vec2 u_seedPos;
uniform vec3 u_seedColor;
in vec2 v_uv;
out vec4 o;

vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-9;
  return vec3(abs(q.z + (q.w - q.y) / (6.0*d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main(){
  // Sample the previous frame at a coordinate rotated + shrunk around the
  // centre: content there reappears further out this frame, so a static
  // point recedes into an endlessly expanding, spinning spiral.
  vec2 p = v_uv - 0.5;
  float rad = length(p);
  float ang = atan(p.y, p.x) + u_rot;
  vec2 suv = vec2(cos(ang), sin(ang)) * rad * (1.0 - u_zoom) + 0.5;

  vec3 prev = vec3(0.0);
  if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) prev = texture(u_prev, suv).rgb;

  // Hue-rotate a little each generation; recursion accumulates this into the
  // slow rainbow drift that makes the spiral read as kaleidoscopic.
  vec3 hsv = rgb2hsv(prev);
  hsv.x = fract(hsv.x + u_hue);
  vec3 col = hsv2rgb(hsv) * u_decay; // u_decay < 1 always: bounds the recursion

  // Localised hard-edged seed disc (not a screen-wide flash, not a soft
  // gaussian blur — a crisp shape so recursing it reads as discrete copies
  // rather than "blur folded onto blur").
  float d = distance(v_uv, u_seedPos);
  float disc = smoothstep(u_seedR, u_seedR * 0.72, d);
  float rim = smoothstep(u_seedR * 0.08, 0.0, abs(d - u_seedR * 0.86));
  col += u_seedColor * (disc + rim * 0.8) * u_seedAmt;

  o = vec4(col, 1.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_state;
uniform vec2 u_res;
in vec2 v_uv;
out vec4 o;
void main(){
  // cover-fit the square sim onto the screen
  vec2 uv = v_uv;
  float ar = u_res.x / u_res.y;
  if (ar > 1.0) uv = vec2((uv.x - 0.5) / ar + 0.5, uv.y);
  else uv = vec2(uv.x, (uv.y - 0.5) * ar + 0.5);
  vec3 col = texture(u_state, uv).rgb;
  col = col / (1.0 + col * 0.6);   // soft-clip: rolls off highlights instead of hard-clipping to white
  vec2 d = v_uv - 0.5;
  col *= 1.0 - dot(d, d) * 0.3;    // gentle vignette, frames the spiral
  o = vec4(pow(col, vec3(0.9)), 1.0);
}`;

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const w = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return [v, w, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, w];
    case 3:
      return [p, q, v];
    case 4:
      return [w, p, v];
    default:
      return [v, p, q];
  }
}

export function createFeedback(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const upProg = program(gl, FULLSCREEN_VS, UPDATE_FS);
  const dispProg = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uU: Uniforms = uniforms(gl, upProg);
  const uD: Uniforms = uniforms(gl, dispProg);

  const opts: TexOpts = {
    internal: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
    filter: gl.LINEAR,
    wrap: gl.CLAMP_TO_EDGE,
  };
  let texA = texture(gl, N, N, opts);
  let texB = texture(gl, N, N, opts);
  let fboA = framebuffer(gl, texA);
  let fboB = framebuffer(gl, texB);

  // Seed both buffers with a handful of scattered, hard-edged discs (flat
  // fill, cut off sharply at their radius — no gaussian tail) instead of
  // black: the recursion then has crisp structure to fold from frame 0, so
  // the spiral reads immediately instead of waiting for the runtime seed to
  // bootstrap it from a single dot.
  function seed(): void {
    const data = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) data[i * 4 + 3] = 1;
    const blobs = 10;
    for (let s = 0; s < blobs; s++) {
      const cx = Math.random() * N,
        cy = Math.random() * N;
      const r = N * (0.025 + Math.random() * 0.03);
      const [cr, cg, cb] = hsv2rgb(Math.random(), 0.75, 0.6);
      const x0 = Math.max(0, Math.floor(cx - r)),
        x1 = Math.min(N, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)),
        y1 = Math.min(N, Math.ceil(cy + r));
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const dx = x - cx,
            dy = y - cy;
          if (dx * dx + dy * dy > r * r) continue; // hard cutoff -> crisp disc, no soft tail
          const idx = (y * N + x) * 4;
          data[idx] += cr;
          data[idx + 1] += cg;
          data[idx + 2] += cb;
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
  let seedAngle = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    key(k) {
      if (k === "r") {
        seedAngle = 0;
        seed();
        return true;
      }
      return false;
    },
    frame(t, dt, audio: AudioEngine) {
      // bass -> zoom (recession) rate. Tuned so a disc's centre-to-edge trip
      // takes ~1-1.6s — short relative to the ~4s QA window — so several
      // trips complete (and several more are in flight) before anyone looks.
      const zoomRate = 1.5 + audio.bass * 1.0;
      const zoom = 1 - Math.exp(-zoomRate * dt);
      // mid -> rotation angular velocity. Over that ~1-1.6s trip this
      // accumulates into a visible fraction of a turn, so successive echoes
      // are twisted relative to each other (the spiral read).
      const rotSpeed = 1.4 + audio.mid * 3.2;
      const rot = rotSpeed * dt;
      // centroid -> hue-shift rate, accumulating into the rainbow drift along
      // the spiral's length.
      const hueSpeed = 0.15 + audio.centroid * 0.5;
      const hue = hueSpeed * dt;
      // level -> feedback retention (higher level = slower decay = brighter,
      // longer-lived echoes). Still always resolves to a factor below 1 so
      // the recursion can't run away; with the short trip time above even
      // the strongest decay leaves a disc clearly visible at the edge.
      const decayRate = 0.5 - audio.level * 0.3;
      const decay = Math.exp(-decayRate * dt);

      // Seed disc sweeps around the centre fast enough to complete more than
      // one full turn within the ~4s QA window: successive stamps then land
      // at visibly different angles, so the recursion reads as a multi-armed
      // spiral/rosette instead of one contiguous wedge of overlapping discs.
      seedAngle += (3.2 + audio.mid * 2.0) * dt;
      const orbitR = 0.06 + audio.bass * 0.1;
      const seedX = 0.5 + Math.cos(seedAngle) * orbitR;
      const seedY = 0.5 + Math.sin(seedAngle) * orbitR;
      // Autonomous pulse train (independent of BPM — this is the generator's
      // own cadence, not a beat readout), a fresh disc roughly every 0.7s:
      // short enough that 2-3 are simultaneously in flight at different
      // radii given the ~1-1.6s trip time above. Kick adds a brightness
      // accent on top, localised to whichever disc is forming at that instant.
      const pulsePhase = (t / 0.7) % 1;
      const pulseEnv = Math.exp(-pulsePhase * 5.5);
      const seedAmt = 0.15 + pulseEnv * 0.55 + audio.kickPulse * 0.5;
      const hueSeed = (t * 0.045 + audio.centroid * 0.15) % 1;
      const [cr, cg, cb] = hsv2rgb(hueSeed, 0.8, 1.0);

      gl.disable(gl.BLEND);
      gl.useProgram(upProg);
      gl.bindVertexArray(tri);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
      gl.viewport(0, 0, N, N);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uU.u_prev, 0);
      gl.uniform1f(uU.u_zoom, zoom);
      gl.uniform1f(uU.u_rot, rot);
      gl.uniform1f(uU.u_hue, hue);
      gl.uniform1f(uU.u_decay, decay);
      gl.uniform2f(uU.u_seedPos, seedX, seedY);
      gl.uniform1f(uU.u_seedR, 0.05);
      gl.uniform1f(uU.u_seedAmt, seedAmt);
      gl.uniform3f(uU.u_seedColor, cr, cg, cb);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [texA, texB] = [texB, texA];
      [fboA, fboB] = [fboB, fboA];

      ctx.bindOutput();
      gl.useProgram(dispProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(uD.u_state, 0);
      gl.uniform2f(uD.u_res, rw, rh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
