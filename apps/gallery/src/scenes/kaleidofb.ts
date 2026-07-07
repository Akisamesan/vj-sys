// 65 KALEIDO_FB — video-feedback kaleidoscope. The seed is NOT a central dot but
// an off-centre ring of N crisp geometric petals (one per mirror wedge). Each
// frame the previous frame is dihedral-folded, spun a little and magnified
// *outward*, so every petal ring leaves a trail of concentric, rotating,
// mirror-symmetric echoes that march from the seed ring out to the edges — a
// kaleidoscope flower blooming across the whole frame, not a sun with spokes.
//
// Why off-centre matters: a kaleidoscope fold maps every output pixel into one
// wedge, so a *centred* bright shape (radius 0..R) unfolds into radial streaks
// (the "spokes" failure). A shape sitting at a nonzero radius r0 instead unfolds
// into N compact petals arranged in a ring — the flower read. The centre is
// deliberately left dark and the feedback magnifies outward, so light never
// piles up at the middle (WHITE guard) and the structure fills the frame.
//
// The dihedral fold + expand + spin is applied to the *sampling coordinate*
// only; it never adds energy, it just chooses which previous-frame texel each
// output pixel reads. Bounded, as in feedback.ts, by decay<1 plus a localised
// seed injection (soft-clipped on display).

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Uniforms, TexOpts } from "../engine/gl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 640; // sim resolution, decoupled from screen size (cover-fit on display)
const N_OPTIONS = [6, 8, 12]; // symmetry regimes the piece reshuffles between

const UPDATE_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_prev;
uniform float u_zoom, u_rot, u_decay, u_n, u_sharp, u_huePhase;
uniform float u_r0, u_ringW, u_petFrac, u_seedAngle, u_seedAmt;
in vec2 v_uv;
out vec4 o;

const float TAU = 6.28318530718;

void main(){
  vec2 p = v_uv - 0.5;
  float r = length(p);
  float th = atan(p.y, p.x);
  float seg = TAU / u_n;

  // ---- feedback sample: dihedral-fold the angle, spin, magnify OUTWARD ----
  // fold: every angle maps into one wedge, mirrored at its edges. Sampling at
  // a radius *below* the pixel's own radius makes last frame's content reappear
  // further out this frame, so rings march from the seed toward the edges.
  float fa = mod(th, seg);
  fa = abs(fa - seg * 0.5);                 // folded angle, mirror-symmetric
  float sang = fa + u_rot;                  // spin
  float srad = r * (1.0 - u_zoom);          // magnify outward
  vec2 suv = 0.5 + srad * vec2(cos(sang), sin(sang));

  vec3 prev = vec3(0.0);
  if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) prev = texture(u_prev, suv).rgb;

  // Decay always < 1: bounds the recursion so it can never saturate to white
  // and, with the steady seed injection below, never freezes to a still frame.
  vec3 col = prev * u_decay;

  // Seed glow colour cycles hue with the spectral centroid (dark backdrop,
  // rotating bright accent -- COMMON_GLSL's palette).
  vec3 seedColor = palette(u_huePhase, vec3(0.55,0.5,0.6), vec3(0.45,0.5,0.45),
                           vec3(1.0,1.0,1.0), vec3(0.0,0.33,0.67)) * 1.35;

  // ---- seed: N-fold rosette of crisp petals sitting OFF-CENTRE at radius r0 ----
  // pa is 0 at each wedge centre and grows to the seams, so a petal lives in the
  // middle of every wedge -> N petals in a ring (mirror-symmetric). Two concentric
  // rings (r0 and 0.6*r0) give the flower radial depth toward the centre without
  // ever lighting the exact middle.
  float pa = mod(th - u_seedAngle, seg);
  pa = abs(pa - seg * 0.5);
  float petW = seg * u_petFrac;
  float wedge = smoothstep(petW, petW * 0.55, pa);           // crisp petal near wedge centre
  float band1 = smoothstep(u_ringW, u_ringW * 0.55, abs(r - u_r0));
  float band2 = smoothstep(u_ringW * 0.85, u_ringW * 0.45, abs(r - u_r0 * 0.6));
  float petals = wedge * (band1 + band2 * 0.6);
  // Thin bright petal cores; "high" (u_sharp) sharpens this edge detail.
  float rim = wedge * smoothstep(u_ringW * 0.3, 0.0, abs(r - u_r0));
  col += seedColor * (petals + rim * (0.25 + 0.75 * u_sharp)) * u_seedAmt;

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
  col = col / (1.0 + col * 0.7); // soft-clip: rolls off highlights instead of hard-clipping to white
  vec2 d = v_uv - 0.5;
  col *= 1.0 - dot(d, d) * 0.25; // gentle vignette
  o = vec4(pow(col, vec3(0.92)), 1.0);
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

export function createKaleidoFb(ctx: SceneContext): Scene {
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

  // Seed both buffers with a handful of hard-edged discs on an off-centre ring
  // (not black, not a central blob) so the very first frames already carry the
  // ring structure the fold recurses into, rather than waiting on the runtime
  // seed to bootstrap it.
  function seed(): void {
    const data = new Float32Array(N * N * 4);
    for (let i = 0; i < N * N; i++) data[i * 4 + 3] = 1;
    const blobs = 8;
    for (let s = 0; s < blobs; s++) {
      const a = (s / blobs) * Math.PI * 2 + Math.random() * 0.3;
      const rr = N * (0.2 + Math.random() * 0.06);
      const cx = N * 0.5 + Math.cos(a) * rr;
      const cy = N * 0.5 + Math.sin(a) * rr;
      const r = N * (0.02 + Math.random() * 0.02);
      const [cr, cg, cb] = hsv2rgb(Math.random(), 0.7, 0.5);
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
  let huePhase = 0;
  let seedAngle = 0;
  let nIdx = 0;
  let nCooldown = 0;
  let prevChange = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // level -> how hard the vortex twists: feedback outward-magnify + spin
      // rate. Higher level -> faster blooming, more turns per echo.
      const swirl = 0.5 + audio.level * 1.8;
      const zoom = 1 - Math.exp(-swirl * 0.5 * dt); // outward magnification/frame
      const rot = swirl * 0.6 * dt; // spin/frame

      // Always-below-1 decay (~0.977/frame) bounds the recursion against
      // saturation; slightly tighter at high level for extra WHITE headroom.
      const decayRate = 1.4 + audio.level * 0.5;
      const decay = Math.exp(-decayRate * dt);

      // centroid -> palette phase rotation for the flower's glow colour.
      huePhase = (huePhase + (0.05 + audio.centroid * 0.35) * dt) % 1;

      // high -> petal edge sharpness (crisp rim + slightly finer petals).
      const sharp = Math.min(1, audio.high * 1.3);
      const petFrac = 0.36 - sharp * 0.12;

      // bass -> ring radius (the flower breathes open) + injection strength; a
      // slow autonomous breath (driven only by t) keeps the seed alive and
      // changing even in total silence (BLACK/STATIC guards). kick + its pulse
      // add a bright but localised punch on the petals -- never a full flash.
      const r0 = 0.15 + audio.bass * 0.12 + 0.02 * Math.sin(t * 0.7);
      const breathPhase = (t / 1.3) % 1;
      const breathe = Math.exp(-breathPhase * 3.0);
      const seedAmt = 0.11 + breathe * 0.18 + audio.bass * 0.2 + audio.kickPulse * 0.5;
      // Seed rosette rotates slowly (spins the petals + helps send echoes out).
      seedAngle += (0.25 + audio.level * 0.6) * dt;

      // change/novelty -> symmetry regime reshuffle (6 <-> 8 <-> 12) on a
      // rising edge, with a cooldown so a sustained spike can't thrash it.
      nCooldown -= dt;
      const changeUp = audio.change > 0.55 && prevChange <= 0.55;
      prevChange = audio.change;
      if (changeUp && nCooldown <= 0) {
        nIdx = (nIdx + 1) % N_OPTIONS.length;
        nCooldown = 1.5;
      }
      const n = N_OPTIONS[nIdx];

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
      gl.uniform1f(uU.u_decay, decay);
      gl.uniform1f(uU.u_n, n);
      gl.uniform1f(uU.u_sharp, sharp);
      gl.uniform1f(uU.u_huePhase, huePhase);
      gl.uniform1f(uU.u_r0, r0);
      gl.uniform1f(uU.u_ringW, 0.05);
      gl.uniform1f(uU.u_petFrac, petFrac);
      gl.uniform1f(uU.u_seedAngle, seedAngle);
      gl.uniform1f(uU.u_seedAmt, seedAmt);
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
