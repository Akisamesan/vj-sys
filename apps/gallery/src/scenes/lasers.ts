// 58 LASERS — a grid-mounted bundle of laser beams fans and sweeps through
// haze, converging and crossing mid-frame like moving-head fixtures over a
// foggy floor. Every beam is a signed distance to an infinite line (no
// GL_LINES: SwiftShader's headless QA backend ignores gl.lineWidth), widened
// by a Gaussian falloff along the perpendicular axis and dimmed by a
// pseudo-volumetric exponential fog term along the beam's own direction.
// Pure fragment, single pass.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const NUM_BEAMS = 10;

const FS = `#version 300 es
precision highp float;
#define NUM_BEAMS ${NUM_BEAMS}
uniform vec2 u_res;
uniform float u_time, u_barPhase, u_bass, u_centroid, u_kickPulse;
uniform float u_bandAmp[NUM_BEAMS];
out vec4 o;

vec3 hsv2rgb(float h, float s, float v){
  vec3 k = vec3(1.0, 2.0/3.0, 1.0/3.0);
  vec3 p = abs(fract(h + k) * 6.0 - 3.0);
  return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;

  // Whole-bundle sweep angle: a slow autonomous rotation keeps the rig alive
  // with no audio at all, and a bar-length term rides on top so the sweep
  // reads as musical structure rather than per-beat jitter. sin(2*pi*barPhase)
  // matches barPhase's own 0->1 wrap each bar, so nothing snaps at the seam.
  float sweep = sin(u_time * 0.085) * 0.55 + sin(6.28318 * u_barPhase) * 0.30;

  // bass thickens the haze (denser fog -> beams read shorter/softer) and
  // widens the beams themselves (more particulate to scatter off).
  float fogDensity = 0.55 + u_bass * 0.65;
  float sigmaBase = 0.048 + u_bass * 0.05;

  const float FAN = 0.85;   // total angular spread of the beam fan (radians)
  const float GRID_W = 1.5; // horizontal spread of the beam origins (a "grid" of fixtures)
  const float TOP_Y = 1.35; // origins sit just above the visible frame

  float top1 = 0.0;
  float top2 = 0.0;
  float total = 0.0;

  for (int i = 0; i < NUM_BEAMS; i++) {
    float frac = float(i) / float(NUM_BEAMS - 1) - 0.5; // -0.5..0.5 across the grid
    vec2 origin = vec2(frac * GRID_W * aspect, TOP_Y);
    // Converging fan: each beam leans in from its origin side so the bundle
    // crosses through the middle of the frame instead of staying parallel.
    float angle = sweep - frac * FAN;
    vec2 dir = vec2(sin(angle), -cos(angle));

    vec2 rel = p - origin;
    float along = dot(rel, dir);           // distance travelled along the beam
    float perp = rel.x * dir.y - rel.y * dir.x; // signed distance off the beam axis

    float startMask = smoothstep(-0.08, 0.08, along);
    float fog = exp(-max(along, 0.0) * fogDensity);
    float sigma = sigmaBase * (1.0 + max(along, 0.0) * 0.12); // slight divergence with distance

    float amp = 0.32 + u_bandAmp[i] * 1.35; // spectrum band -> this beam's brightness
    float glow = exp(-(perp * perp) / (2.0 * sigma * sigma)) * amp * fog * startMask;

    total += glow;
    if (glow > top1) { top2 = top1; top1 = glow; }
    else if (glow > top2) { top2 = glow; }
  }

  // kickPulse: a short local glow only where the two brightest beams cross —
  // never a full-frame flash.
  float crossGlow = top1 * top2 * u_kickPulse * 3.2;

  // Single neon hue for the whole frame, drifting slowly with centroid
  // (green -> cyan -> red-violet), never a spatial rainbow.
  float hue = fract(0.33 + u_centroid * 0.62);
  vec3 neon = hsv2rgb(hue, 0.82, 1.0);

  float raw = total * 0.9 + crossGlow + 0.02;
  vec3 col = neon * (1.0 - exp(-raw * 1.25));

  vec2 vd = uv - 0.5;
  col *= 1.0 - dot(vd, vd) * 0.35;

  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export function createLasers(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const bandAmp = new Float32Array(NUM_BEAMS);
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      const bandCount = audio.spectrum.length;
      for (let i = 0; i < NUM_BEAMS; i++) {
        const bandIdx = Math.min(
          bandCount - 1,
          Math.floor((i / (NUM_BEAMS - 1)) * (bandCount - 1)),
        );
        bandAmp[i] = audio.spectrum[bandIdx];
      }

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_barPhase, audio.barPhase);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1fv(u.u_bandAmp, bandAmp);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
