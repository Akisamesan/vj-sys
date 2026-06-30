// 29 APOLLONIAN — Apollonian-gasket fractal raymarched (Inigo Quilez): infinitely
// nested spheres packing space. The fold scale animates with the spectral centroid
// so the packing radius reshapes; bass breathes the structure toward the viewer;
// an orbiting camera circles the gasket; kicks flash the surface.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_fold, u_angle, u_centroid, u_beat, u_level, u_bass, u_high;
out vec4 o;

float apolloDE(vec3 p, out float trap) {
  float s = u_fold;
  float scale = 1.0;
  trap = 1e9;
  for (int i = 0; i < 8; i++) {
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    float r2 = dot(p, p);
    trap = min(trap, r2);
    float k = s / max(r2, 1e-4);
    p *= k;
    scale *= k;
  }
  return 0.25 * abs(p.y) / scale;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float ca = cos(u_angle), sa = sin(u_angle);
  // Bass breathes the zoom — move ro closer to the structure
  float dist = 2.2 - u_bass * 0.45;
  vec3 ro = vec3(sa * dist, 0.3, ca * dist);
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x * rt + uv.y * up);

  float tmarch = 0.0;
  float hitTrap = 0.0;
  float hit = -1.0;
  for (int i = 0; i < 100; i++) {
    float tr;
    float d = apolloDE(ro + rd * tmarch, tr);
    if (d < 0.0006) { hit = tmarch; hitTrap = tr; break; }
    tmarch += d;
    if (tmarch > 8.0) break;
  }

  vec3 col = vec3(0.02, 0.02, 0.04) + vec3(0.01, 0.02, 0.05) * (1.0 - length(uv));
  if (hit > 0.0) {
    vec3 p = ro + rd * hit;
    float tr;
    vec2 e = vec2(0.001, 0.0);
    vec3 nrm = normalize(vec3(
      apolloDE(p + e.xyy, tr) - apolloDE(p - e.xyy, tr),
      apolloDE(p + e.yxy, tr) - apolloDE(p - e.yxy, tr),
      apolloDE(p + e.yyx, tr) - apolloDE(p - e.yyx, tr)));
    vec3 sun = normalize(vec3(0.5, 0.8, 0.3));
    float diff = clamp(dot(nrm, sun), 0.0, 1.0);
    float fill = clamp(dot(nrm, -sun) * 0.3 + 0.3, 0.0, 1.0);
    // high drives specular sharpness
    float spec = pow(clamp(dot(reflect(rd, nrm), sun), 0.0, 1.0), 8.0 + u_high * 48.0);
    // Fresnel rim — boosted on kick pulse
    float fres = pow(1.0 - clamp(dot(nrm, -rd), 0.0, 1.0), 3.0);
    vec3 base = palette(
      hitTrap * 1.8 + u_centroid * 0.5 + u_time * 0.015,
      vec3(0.5), vec3(0.5), vec3(1.0, 0.9, 0.8), vec3(0.0, 0.25, 0.5)
    );
    col = base * (0.1 + diff * 0.85 + fill * 0.15);
    col += vec3(0.8, 0.9, 1.0) * spec * 0.5;
    col += base * fres * (0.4 + u_beat * 1.2);
    // Distance fog
    float fog = 1.0 - exp(-hit * 0.25);
    col = mix(col, vec3(0.02, 0.02, 0.04), fog * 0.55);
  }
  col *= 1.0 + u_beat * 0.25 + u_level * 0.12;
  o = vec4(col, 1.0);
}`;

export function createApollonian(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri);
  let rw = 1,
    rh = 1;
  let angle = 0;
  let fold = 1.3;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // level drives orbit speed; centroid shapes the fold scale (eased)
      angle += dt * (0.08 + audio.level * 0.25);
      const foldTarget = 1.15 + audio.centroid * 0.3;
      fold += (foldTarget - fold) * (1 - Math.exp(-dt * 2.5));
      // change adds a small extra fold jolt so musical transitions reshape the gasket
      const foldJolt = fold + audio.change * 0.05;

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_fold, foldJolt);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.7 + audio.level * 0.4,
        exposure: 1.15 + audio.kickPulse * 0.2,
        aberration: 0.0008 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.35,
        threshold: 0.6,
        time: t,
      });
    },
  };
}
