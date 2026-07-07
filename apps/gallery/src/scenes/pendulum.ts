// 76 PENDULUM — a swarm of chaotic double pendulums released from a shared pivot
// with almost identical initial angles. Semi-implicit (symplectic) Euler on the
// classic coupled double-pendulum ODE, sub-stepped at a fixed small dt for
// numerical stability regardless of frame rate or the audio-driven speed
// multiplier. All arms start visually coincident and swing together; the
// system's sensitive dependence on initial conditions fans them out into a
// chaotic tangle over a few periods. Each tip leaves a fading additive trail
// (its own decaying HDR framebuffer) so the divergence itself becomes the
// picture. Arms and trail strokes are camera-facing quads, not GL_LINES —
// line width is not honoured by the headless SwiftShader QA renderer.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const N = 40; // number of pendulums in the swarm
const L1 = 0.36,
  L2 = 0.32; // arm lengths (world units, isotropic after the aspect divide) — long
// enough that the swing sweeps a wide fan across the frame (coverage)
const M1 = 1,
  M2 = 1; // point masses (equal — classic chaotic configuration)
const PIVOT_X = 0,
  PIVOT_Y = 0.12; // near-central pivot so the swing uses the full height both ways

// A deliberately WIDE initial fan (±0.34rad on arm1, ±0.20rad on arm2, opposite
// signs so the swarm opens as a 2D crossing fan). The chaotic ODE still diverges
// them further, but even in a short QA capture the swarm already reads as many
// separate arms rather than one coincident line.
const BASE_THETA1 = Math.PI * 0.8; // high-energy near-inverted start: vigorous, chaotic swing
const BASE_THETA2 = Math.PI * 0.7;
const SPREAD_THETA1 = 0.34; // half-spread of arm1 initial angle across the swarm (rad)
const SPREAD_THETA2 = 0.2; // half-spread of arm2 (opposite ramp -> 2D fan)

const GRAVITY_BASE = 1.5;
const GRAVITY_BASS_SCALE = 2.2; // bass -> gravity/energy -> amplitude & chaos intensity
const SPEED_BASE = 1.0;
const SPEED_LEVEL_SCALE = 1.4; // level -> simulation speed

const SUB_DT = 1 / 300; // fixed integration step (s) — small & constant for symplectic-Euler stability
const MAX_SUBSTEPS = 40;

const KICK_OMEGA1 = 0.75; // kick -> common angular impulse to every pendulum (disturbance, not reset)
const KICK_OMEGA2 = -0.5;

// Brightness kept modest and additive overlap deliberately limited: 40 additive
// hues fuse to white where they pile up, so rods are dim, the pivot end of arm1
// is faded (all 40 share that point), the trail stamp is dimmer still and decays
// faster. The picture should read as many *coloured* strands, not one white loop.
const ARM_HALF_WIDTH = 0.009; // thin, sharp rods so the pendulum shape reads (wide enough to hold coverage)
const ARM_BRIGHT = 1.6;
const ARM_PIVOT_FADE = 0.22; // arm1's shared-pivot end is dimmed to kill the central white cluster
const TIP_RADIUS = 0.02; // small, sharp bob head
const BOB_BRIGHT = 1.3; // crisp bob drawn into the scene (reads as the pendulum head)
const TRAIL_STAMP_BRIGHT = 0.75; // soft trail stamp into the persistent FBO (dim -> stays coloured)
const TRAIL_DECAY_RATE = 2.4; // faster fade (~0.4s) so trails never saturate into a blob
const TRAIL_GAIN = 0.95; // trail sits under the rods, not over them

// --- arm rods: per-vertex colour already includes brightness, plain passthrough ---
const ARM_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec3 a_col;
out vec3 v_col;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_col = a_col;
}`;

const ARM_FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// --- tip strokes: written additively into the trail FBO each frame, with a
// radial falloff whose sharpness is driven by audio.high ---
const TIP_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec3 a_col;
out vec2 v_uv;
out vec3 v_col;
void main(){
  gl_Position = vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv;
  v_col = a_col;
}`;

const TIP_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec3 v_col;
uniform float u_sharp; // radial falloff exponent (audio.high sharpens it)
uniform float u_mul;   // brightness — dim for the trail stamp, brighter for the crisp bob
out vec4 o;
void main(){
  float r = length(v_uv);
  float fall = pow(clamp(1.0 - r, 0.0, 1.0), u_sharp);
  o = vec4(v_col * fall * u_mul, fall * u_mul);
}`;

// --- trail decay: blends the existing trail towards black by a dt-scaled alpha ---
const DECAY_FS = `#version 300 es
precision highp float;
uniform float u_alpha;
out vec4 o;
void main(){ o = vec4(0.0, 0.0, 0.0, u_alpha); }`;

// --- composite: adds the (already decayed + freshly stroked) trail texture into
// the main HDR scene, additively, before PostFX bloom/tonemap ---
const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform float u_gain;
in vec2 v_uv;
out vec4 o;
void main(){ o = vec4(texture(u_src, v_uv).rgb * u_gain, 1.0); }`;

// Inigo-Quilez-style cosine palette (mirrors COMMON_GLSL's palette()), evaluated
// on the CPU so each pendulum's rod colour can be uploaded per vertex.
function palette(t: number): [number, number, number] {
  const tp = t * 6.28318;
  return [
    0.5 + 0.5 * Math.cos(tp + 0.0),
    0.5 + 0.5 * Math.cos(tp + 2.0944), // +2pi/3
    0.5 + 0.5 * Math.cos(tp + 4.18879), // +4pi/3
  ];
}

function colorFor(i: number, centroid: number): [number, number, number] {
  return palette((i / (N - 1)) * 0.85 + centroid * 0.6);
}

// Expands a segment A->B into a camera-facing quad, with independent colours at
// the A end and the B end so a rod can be brightness-graded along its length
// (arm1 fades towards its shared pivot to avoid a 40x additive white cluster).
function emitArmQuad(
  buf: Float32Array,
  vi: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ar: number,
  ag: number,
  ab: number,
  br: number,
  bg: number,
  bb: number,
  halfW: number,
): number {
  const ndx = bx - ax,
    ndy = by - ay;
  const nlen = Math.hypot(ndx, ndy) || 1e-6;
  const nx = (-ndy / nlen) * halfW,
    ny = (ndx / nlen) * halfW;
  const a0x = ax + nx,
    a0y = ay + ny;
  const a1x = ax - nx,
    a1y = ay - ny;
  const b0x = bx + nx,
    b0y = by + ny;
  const b1x = bx - nx,
    b1y = by - ny;
  // vertices a0,b0,a1,a1,b0,b1 — a-verts carry the A colour, b-verts the B colour
  const px = [a0x, b0x, a1x, a1x, b0x, b1x];
  const py = [a0y, b0y, a1y, a1y, b0y, b1y];
  const isA = [1, 0, 1, 1, 0, 0];
  for (let k = 0; k < 6; k++) {
    buf[vi++] = px[k];
    buf[vi++] = py[k];
    buf[vi++] = isA[k] ? ar : br;
    buf[vi++] = isA[k] ? ag : bg;
    buf[vi++] = isA[k] ? ab : bb;
  }
  return vi;
}

function emitTipQuad(
  buf: Float32Array,
  vi: number,
  cx: number,
  cy: number,
  half: number,
  r: number,
  g: number,
  b: number,
): number {
  const ox = [-half, half, -half, -half, half, half];
  const oy = [-half, -half, half, half, -half, half];
  const ux = [-1, 1, -1, -1, 1, 1];
  const uy = [-1, -1, 1, 1, -1, 1];
  for (let k = 0; k < 6; k++) {
    buf[vi++] = cx + ox[k];
    buf[vi++] = cy + oy[k];
    buf[vi++] = ux[k];
    buf[vi++] = uy[k];
    buf[vi++] = r;
    buf[vi++] = g;
    buf[vi++] = b;
  }
  return vi;
}

export function createPendulum(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;

  const armProg = program(gl, ARM_VS, ARM_FS);
  const tipProg = program(gl, TIP_VS, TIP_FS);
  const uTip: Uniforms = uniforms(gl, tipProg);
  const decayProg = program(gl, FULLSCREEN_VS, DECAY_FS);
  const uDecay: Uniforms = uniforms(gl, decayProg);
  const compProg = program(gl, FULLSCREEN_VS, COMPOSITE_FS);
  const uComp: Uniforms = uniforms(gl, compProg);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // Physics state, one entry per pendulum.
  const theta1 = new Float32Array(N);
  const theta2 = new Float32Array(N);
  const omega1 = new Float32Array(N);
  const omega2 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const frac = (i - (N - 1) / 2) / (N - 1); // -0.5..0.5 across the swarm
    // Opposite-sign ramps so arm1 and arm2 fan the swarm along two axes (a 2D
    // spread of initial conditions, not a single 1D line of nearly-equal starts).
    theta1[i] = BASE_THETA1 + frac * 2 * SPREAD_THETA1 + (Math.random() - 0.5) * 0.004;
    theta2[i] = BASE_THETA2 - frac * 2 * SPREAD_THETA2 + (Math.random() - 0.5) * 0.004;
    omega1[i] = 0;
    omega2[i] = 0;
  }

  // Arm rods buffer: 2 segments/pendulum * 6 verts * (x,y,r,g,b).
  const armVertCount = N * 2 * 6;
  const armBuf = new Float32Array(armVertCount * 5);
  const armVao = gl.createVertexArray()!;
  const armVbo = gl.createBuffer()!;
  gl.bindVertexArray(armVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, armVbo);
  gl.bufferData(gl.ARRAY_BUFFER, armBuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
  gl.bindVertexArray(null);

  // Tip stroke buffer: 1 quad/pendulum * 6 verts * (x,y,u,v,r,g,b).
  const tipVertCount = N * 6;
  const tipBuf = new Float32Array(tipVertCount * 7);
  const tipVao = gl.createVertexArray()!;
  const tipVbo = gl.createBuffer()!;
  gl.bindVertexArray(tipVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, tipVbo);
  gl.bufferData(gl.ARRAY_BUFFER, tipBuf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 28, 16);
  gl.bindVertexArray(null);

  let rw = 1,
    rh = 1;
  let trailTex!: WebGLTexture;
  let trailFbo!: WebGLFramebuffer;

  function allocTrail(w: number, h: number): void {
    trailTex = texture(gl, w, h, {
      internal: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
      filter: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    });
    trailFbo = framebuffer(gl, trailTex);
  }

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
      allocTrail(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // Continuous mapping 1: level -> simulation speed.
      const speedMult = SPEED_BASE + audio.level * SPEED_LEVEL_SCALE;
      // Continuous mapping 2: bass -> gravity/energy -> amplitude & chaos intensity.
      const gravity = GRAVITY_BASE + audio.bass * GRAVITY_BASS_SCALE;

      const fdt = Math.min(dt, 1 / 24);
      const dtTotal = fdt * speedMult;
      const nSub = Math.min(MAX_SUBSTEPS, Math.max(1, Math.round(dtTotal / SUB_DT)));

      // Trigger: kick gives every pendulum the same small angular impulse — a
      // shared disturbance layered on top of already-diverged trajectories, not
      // a state reset. Because the impulse is identical for all, it briefly
      // pulls their motion back towards coherence before chaos reasserts itself.
      if (audio.kick) {
        for (let i = 0; i < N; i++) {
          omega1[i] += KICK_OMEGA1;
          omega2[i] += KICK_OMEGA2;
        }
      }

      for (let s = 0; s < nSub; s++) {
        for (let i = 0; i < N; i++) {
          const th1 = theta1[i],
            th2 = theta2[i],
            w1 = omega1[i],
            w2 = omega2[i];
          const delta = th1 - th2;
          const cosDelta = Math.cos(delta);
          const sinDelta = Math.sin(delta);
          const den = 2 * M1 + M2 - M2 * Math.cos(2 * delta);
          const a1 =
            (-gravity * (2 * M1 + M2) * Math.sin(th1) -
              M2 * gravity * Math.sin(th1 - 2 * th2) -
              2 * sinDelta * M2 * (w2 * w2 * L2 + w1 * w1 * L1 * cosDelta)) /
            (L1 * den);
          const a2 =
            (2 *
              sinDelta *
              (w1 * w1 * L1 * (M1 + M2) +
                gravity * (M1 + M2) * Math.cos(th1) +
                w2 * w2 * L2 * M2 * cosDelta)) /
            (L2 * den);
          // Semi-implicit (symplectic) Euler: velocity updates first, position
          // uses the *new* velocity — bounded energy error at a fixed small step.
          const nw1 = w1 + a1 * SUB_DT;
          const nw2 = w2 + a2 * SUB_DT;
          omega1[i] = nw1;
          omega2[i] = nw2;
          theta1[i] = th1 + nw1 * SUB_DT;
          theta2[i] = th2 + nw2 * SUB_DT;
        }
      }

      const aspect = rw / rh;
      const pivotX = PIVOT_X / aspect;
      // Phase/centroid mapping: colour hue rotates with the spectral centroid.
      const kickBoost = 1 + audio.kickPulse * 2.0;
      const tipHalf = TIP_RADIUS * (1 + audio.kickPulse * 0.5);

      let avi = 0;
      let tvi = 0;
      for (let i = 0; i < N; i++) {
        const th1 = theta1[i],
          th2 = theta2[i];
        const x1 = PIVOT_X + L1 * Math.sin(th1);
        const y1 = PIVOT_Y - L1 * Math.cos(th1);
        const x2 = x1 + L2 * Math.sin(th2);
        const y2 = y1 - L2 * Math.cos(th2);
        const [r, g, b] = colorFor(i, audio.centroid);
        const er = r * ARM_BRIGHT,
          eg = g * ARM_BRIGHT,
          eb = b * ARM_BRIGHT;

        // arm1: dim at the shared pivot (A end), full at the elbow (B end).
        avi = emitArmQuad(
          armBuf,
          avi,
          pivotX,
          PIVOT_Y,
          x1 / aspect,
          y1,
          er * ARM_PIVOT_FADE,
          eg * ARM_PIVOT_FADE,
          eb * ARM_PIVOT_FADE,
          er,
          eg,
          eb,
          ARM_HALF_WIDTH,
        );
        // arm2: full brightness both ends (it does not crowd the pivot).
        avi = emitArmQuad(
          armBuf,
          avi,
          x1 / aspect,
          y1,
          x2 / aspect,
          y2,
          er,
          eg,
          eb,
          er,
          eg,
          eb,
          ARM_HALF_WIDTH,
        );

        // tip carries plain hue * kick emphasis; per-pass u_mul sets brightness.
        tvi = emitTipQuad(
          tipBuf,
          tvi,
          x2 / aspect,
          y2,
          tipHalf,
          r * kickBoost,
          g * kickBoost,
          b * kickBoost,
        );
      }

      // 1) Update the persistent trail FBO: fade its existing contents, then
      // additively stamp this frame's tip strokes on top. Kept as its own HDR
      // target (independent of PostFX's internal scene RT) so it survives
      // across frames while the rods below are redrawn crisp every frame.
      gl.bindFramebuffer(gl.FRAMEBUFFER, trailFbo);
      gl.viewport(0, 0, rw, rh);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(decayProg);
      gl.uniform1f(uDecay.u_alpha, 1 - Math.exp(-fdt * TRAIL_DECAY_RATE));
      gl.bindVertexArray(tri);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(tipProg);
      gl.bindVertexArray(tipVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, tipVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, tipBuf);
      // Continuous mapping 3: high -> sharpness of the trail glow falloff.
      const highClamped = Math.min(1, Math.max(0, audio.high));
      gl.uniform1f(uTip.u_sharp, 1.6 + highClamped * 2.8);
      gl.uniform1f(uTip.u_mul, TRAIL_STAMP_BRIGHT); // dim, soft stamp -> stays coloured
      gl.drawArrays(gl.TRIANGLES, 0, tipVertCount);
      gl.disable(gl.BLEND);

      // 2) Composite rods + bobs + trail into the main HDR scene, then bloom/tonemap.
      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(armProg);
      gl.bindVertexArray(armVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, armVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, armBuf);
      gl.drawArrays(gl.TRIANGLES, 0, armVertCount);

      // Crisp bob heads: same tip buffer, but a tight falloff and higher brightness
      // so each pendulum reads as an arm + a distinct point, not just a glow loop.
      gl.useProgram(tipProg);
      gl.bindVertexArray(tipVao);
      gl.uniform1f(uTip.u_sharp, 3.5 + highClamped * 1.5);
      gl.uniform1f(uTip.u_mul, BOB_BRIGHT);
      gl.drawArrays(gl.TRIANGLES, 0, tipVertCount);

      gl.useProgram(compProg);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, trailTex);
      gl.uniform1i(uComp.u_src, 0);
      gl.uniform1f(uComp.u_gain, TRAIL_GAIN);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);

      // Gentle bloom + a high threshold so only the hottest cores bloom: the 40
      // coloured strands must survive tonemapping as hues, not fuse into white.
      post.draw(rw, rh, {
        bloom: 0.55 + audio.level * 0.3,
        exposure: 1.0 + audio.kickPulse * 0.15,
        aberration: 0.001 + audio.change * 0.0016,
        grain: 0.03,
        vignette: 1.15,
        flash: audio.kickPulse * 0.1,
        threshold: 0.68,
        time: t,
      });
    },
  };
}
