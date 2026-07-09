// 97 KNOT — a true (P,Q) torus-knot centreline, extruded into a solid glowing
// tube mesh (GL_TRIANGLES, Frenet-framed ring cross-section) — unlike 41 TORUS
// (thin additive line-strip) or 42 LISSAJOUS (Lissajous curve, not a torus
// knot). Fully procedural in the VS from gl_VertexID, no CPU rebuild, no
// attribute buffer: each vertex derives its (segment, side) grid cell, samples
// the analytic knot curve and its derivative for a stable tangent frame, and
// offsets around it by the tube radius. Camera orbits by rotating the mesh;
// PostFX HDR bloom turns the shaded tube into a neon glow.

import { program, uniforms } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

// Centreline sampled at SEGMENTS points around theta in [0, 2*PI]; each point
// gets a SIDES-sided ring cross-section, tiled into a closed tube mesh.
const SEGMENTS = 200;
const SIDES = 10;
const VERTS_PER_QUAD = 6; // two triangles, GL_TRIANGLES (no index buffer, no GL_LINES)
const TOTAL_VERTS = SEGMENTS * SIDES * VERTS_PER_QUAD;

const VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform float u_yaw, u_pitch, u_scale, u_aspect;
uniform float u_P, u_Q, u_R, u_r, u_tubeRadius;
uniform float u_time, u_centroid, u_high, u_kickTime;
out vec3 v_col;

const float TAU = 6.28318530718;
const float PI = 3.14159265359;
const float SEG = ${SEGMENTS}.0;
const float SID = ${SIDES}.0;

vec3 rotYP(vec3 p, float yaw, float pitch){
  float cy = cos(yaw), sy = sin(yaw);
  p = vec3(cy*p.x + sy*p.z, p.y, -sy*p.x + cy*p.z);
  float cp = cos(pitch), sp = sin(pitch);
  p = vec3(p.x, cp*p.y - sp*p.z, sp*p.y + cp*p.z);
  return p;
}

void main(){
  float vid = float(gl_VertexID);
  float quadIdx = floor(vid / ${VERTS_PER_QUAD}.0);
  float cornerIdx = vid - quadIdx * ${VERTS_PER_QUAD}.0;
  float segIdx = floor(quadIdx / SID);
  float sideIdx = quadIdx - segIdx * SID;

  // Quad corners: A=(seg,side) B=(seg+1,side) C=(seg+1,side+1) D=(seg,side+1)
  // tri1 = A,B,C  tri2 = A,C,D
  float segOff, sideOff;
  if (cornerIdx < 0.5)      { segOff = 0.0; sideOff = 0.0; } // A
  else if (cornerIdx < 1.5) { segOff = 1.0; sideOff = 0.0; } // B
  else if (cornerIdx < 2.5) { segOff = 1.0; sideOff = 1.0; } // C
  else if (cornerIdx < 3.5) { segOff = 0.0; sideOff = 0.0; } // A
  else if (cornerIdx < 4.5) { segOff = 1.0; sideOff = 1.0; } // C
  else                       { segOff = 0.0; sideOff = 1.0; } // D

  float s0 = mod(segIdx + segOff, SEG);
  float t0 = mod(sideIdx + sideOff, SID);

  float theta = s0 / SEG * TAU;
  float phi = t0 / SID * TAU;

  // (P,Q) torus-knot centreline x(theta),y(theta),z(theta) and its analytic
  // derivative, used to build a stable Frenet-ish frame (tangent + a fixed
  // reference vector, Gram-Schmidt orthogonalised) without neighbour sampling.
  float rho  = u_R + u_r * cos(u_Q * theta);
  float rhoD = -u_r * u_Q * sin(u_Q * theta);
  float cp = cos(u_P * theta), sp = sin(u_P * theta);

  vec3 pos = vec3(rho * cp, rho * sp, u_r * sin(u_Q * theta));
  vec3 dpos = vec3(
    rhoD * cp - rho * u_P * sp,
    rhoD * sp + rho * u_P * cp,
    u_r * u_Q * cos(u_Q * theta)
  );
  vec3 T = normalize(dpos);
  vec3 ref = vec3(0.0, 0.0, 1.0);
  vec3 N = normalize(ref - dot(ref, T) * T + vec3(1e-5, 0.0, 0.0));
  vec3 B = cross(T, N);

  float cphi = cos(phi), sphi = sin(phi);
  vec3 normalDir = cphi * N + sphi * B;
  vec3 tubePos = pos + u_tubeRadius * normalDir;

  // Fit the whole knot (major radius + minor breathing + tube) into ~1 unit.
  vec3 p = tubePos * (1.0 / 2.6);
  p = rotYP(p, u_yaw, u_pitch);
  vec3 nrm = rotYP(normalDir, u_yaw, u_pitch);

  float persp = 1.0 / (2.6 - p.z * 0.4);
  vec2 clip = p.xy * u_scale * persp;
  clip.x /= u_aspect;
  gl_Position = vec4(clip, 0.0, 1.0);

  // Cheap fixed-key-light shading: diffuse + specular, shininess/gain from high.
  vec3 viewDir = vec3(0.0, 0.0, 1.0);
  vec3 lightDir = normalize(vec3(0.35, 0.55, 1.0));
  vec3 H = normalize(viewDir + lightDir);
  float shin = 10.0 + u_high * 90.0;
  float spec = pow(max(dot(nrm, H), 0.0), shin) * (0.35 + u_high * 1.2);
  float diff = 0.35 + 0.65 * max(dot(nrm, lightDir), 0.0);

  // Kick: structural trigger — a glow band starts at theta=0 and travels once
  // around the loop, fading out. No screen flash, the propagation itself
  // reads the beat against the tube geometry.
  float travel = u_time - u_kickTime;
  float front = mod(travel * 2.4, TAU);
  float decay = exp(-travel * 1.4);
  float dAng = abs(mod(theta - front + PI, TAU) - PI);
  float pulseGlow = exp(-dAng * dAng * 30.0) * decay;

  float depth = 0.5 + p.z * 0.35;
  float hue = u_centroid * 0.6 + theta / TAU * 0.4;
  vec3 col = palette(hue, vec3(0.5), vec3(0.5), vec3(1.0, 0.9, 0.8), vec3(0.0, 0.25, 0.5));
  col *= (0.22 + diff * 0.55) * (0.6 + depth * 0.6);
  col += spec * vec3(1.0, 0.97, 0.9);
  col += pulseGlow * vec3(1.3, 1.0, 0.55);

  v_col = col;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col;
out vec4 o;
void main(){ o = vec4(v_col, 1.0); }`;

// Curated coprime (P,Q) pairs (both 2..5, P!=Q) so the knot always stays a
// genuine single-component torus knot as it re-ties on structural change.
const KNOTS: [number, number][] = [
  [2, 3],
  [3, 2],
  [2, 5],
  [5, 2],
  [3, 4],
  [4, 3],
  [5, 3],
  [3, 5],
];

export function createKnot(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;

  const prog = program(gl, VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);

  // Empty VAO — the whole tube mesh is generated procedurally via gl_VertexID.
  const vao = gl.createVertexArray()!;

  let rw = 1,
    rh = 1;
  let yaw = 0,
    pitch = 0.32;
  let scaleCur = 3.2;
  let pCur = 2,
    qCur = 3;
  let knotIdx = 0;
  let lastKnotChange = -10;
  let tubeRadiusCur = 0.065;
  let rMinorCur = 0.42;
  let kickTime = -1000;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },

    frame(t, dt, audio: AudioEngine) {
      // Re-tie the knot's topology on structural musical change, never on
      // every kick — the (p,q) pair steps discretely but eases in smoothly.
      if (audio.change > 0.55 && t - lastKnotChange > 3.0) {
        knotIdx = (knotIdx + 1) % KNOTS.length;
        lastKnotChange = t;
      }
      const [pT, qT] = KNOTS[knotIdx];
      const knotEase = 1 - Math.exp(-dt * 1.2);
      pCur += (pT - pCur) * knotEase;
      qCur += (qT - qCur) * knotEase;

      // Kick: record the trigger time; the VS grows a travelling glow band
      // from it every frame (no CPU-side pulse bookkeeping needed).
      if (audio.kick) kickTime = t;

      // Camera orbit speed + knot spin from continuous level.
      yaw += dt * (0.15 + audio.level * 0.75);
      pitch += dt * 0.05;

      // Bass: continuous tube thickness + minor-radius (winding "pitch")
      // breathing — never a discrete/quantized change.
      const tubeTarget = 0.065 + audio.bass * 0.07;
      tubeRadiusCur += (tubeTarget - tubeRadiusCur) * (1 - Math.exp(-dt * 5));
      const rTarget = 0.42 + audio.bass * 0.22;
      rMinorCur += (rTarget - rMinorCur) * (1 - Math.exp(-dt * 4));
      scaleCur += (3.2 - scaleCur) * (1 - Math.exp(-dt * 4));

      // ---- render ----
      post.bind();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_pitch, pitch);
      gl.uniform1f(u.u_scale, scaleCur);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_P, pCur);
      gl.uniform1f(u.u_Q, qCur);
      gl.uniform1f(u.u_R, 1.55);
      gl.uniform1f(u.u_r, rMinorCur);
      gl.uniform1f(u.u_tubeRadius, tubeRadiusCur);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_kickTime, kickTime);

      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, TOTAL_VERTS);
      gl.disable(gl.BLEND);

      post.draw(rw, rh, {
        bloom: 1.15 + audio.level * 0.45,
        exposure: 1.05 + audio.kickPulse * 0.2,
        aberration: 0.0009 + audio.change * 0.0015,
        grain: 0.035,
        vignette: 1.15,
        flash: audio.kickPulse * 0.15,
        threshold: 0.55,
        time: t,
      });
    },
  };
}
