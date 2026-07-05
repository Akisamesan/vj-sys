// 28 KIFS — Kaleidoscopic Iterated Function System raymarched: a tetrahedral
// fold (abs + sort-swizzle + scale/offset affine map, 8 reps) self-similarly
// tiles space into a crystalline kaleidoscope, circled by an orbiting camera.
// Bass breathes the fold offset so the facets open and close; centroid turns
// the rainbow palette phase; level drives orbit speed; kicks light up the
// creases via an AO-driven local glow (no global flash); high sharpens specular.

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
uniform float u_time, u_angle, u_yaw, u_pitch, u_centroid, u_kick, u_level, u_bass, u_high;
out vec4 o;

float sdBox(vec3 p, vec3 b){ vec3 d=abs(p)-b; return length(max(d,0.0))+min(max(d.x,max(d.y,d.z)),0.0); }
vec3 rotY(vec3 p, float a){ float c=cos(a),s=sin(a); return vec3(c*p.x+s*p.z, p.y, -s*p.x+c*p.z); }
vec3 rotX(vec3 p, float a){ float c=cos(a),s=sin(a); return vec3(p.x, c*p.y-s*p.z, s*p.y+c*p.z); }

// Tetrahedral KIFS: abs() folds into the positive octant, the 3-compare sort
// network folds further into the Weyl chamber (conditional swizzle), then a
// scale/offset affine map repeats the cell. Bass nudges the offset so the
// folds visibly open and close with the low end.
float kifsDE(vec3 p, out float trap) {
  float scale = 2.0;
  float fo = 1.0 + u_bass * 0.35;
  vec3 off = vec3(fo);
  float s = 1.0;
  trap = 1e9;
  for (int i = 0; i < 8; i++) {
    p = abs(p);
    if (p.x < p.y) p.xy = p.yx;
    if (p.y < p.z) p.yz = p.zy;
    if (p.x < p.y) p.xy = p.yx;
    p = p * scale - off * (scale - 1.0);
    s *= scale;
    trap = min(trap, dot(p, p) / (s * s));
  }
  return sdBox(p, vec3(1.0)) / s;
}

float sceneDE(vec3 p, out float trap) {
  return kifsDE(rotX(rotY(p, u_yaw), u_pitch), trap);
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0, trd;
  for (int i = 0; i < 5; i++) {
    float h = 0.01 + 0.13 * float(i) / 4.0;
    float d = sceneDE(p + n * h, trd);
    occ += (h - d) * sca;
    sca *= 0.7;
  }
  return clamp(1.0 - 2.6 * occ, 0.0, 1.0);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;

  float orbitR = 3.0;
  vec3 ro = vec3(sin(u_angle) * orbitR, 0.3 + sin(u_time * 0.09) * 0.2, cos(u_angle) * orbitR);
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x * rt + uv.y * up);

  float t = 0.0;
  float hit = -1.0;
  float hitTrap = 0.0;
  for (int i = 0; i < 100; i++) {
    float tr;
    float d = sceneDE(ro + rd * t, tr);
    if (d < 0.0015) { hit = t; hitTrap = tr; break; }
    t += d * 0.78;
    if (t > 10.0) break;
  }

  vec3 bg = vec3(0.015, 0.02, 0.05) + vec3(0.02, 0.01, 0.05) * (1.0 - length(uv));
  vec3 col = bg;

  if (hit > 0.0) {
    vec3 p = ro + rd * hit;
    vec2 e = vec2(0.001, 0.0);
    float trx;
    vec3 nrm = normalize(vec3(
      sceneDE(p + e.xyy, trx) - sceneDE(p - e.xyy, trx),
      sceneDE(p + e.yxy, trx) - sceneDE(p - e.yxy, trx),
      sceneDE(p + e.yyx, trx) - sceneDE(p - e.yyx, trx)));
    float ao = calcAO(p, nrm);

    vec3 sun = normalize(vec3(0.5, 0.8, 0.35));
    float diff = clamp(dot(nrm, sun), 0.0, 1.0);
    float fill = clamp(dot(nrm, -sun) * 0.25 + 0.25, 0.0, 1.0);
    // high sharpens the fold facets' specular highlights
    float shininess = 8.0 + u_high * 44.0;
    float spec = pow(clamp(dot(reflect(rd, nrm), sun), 0.0, 1.0), shininess);

    // centroid rotates the rainbow palette phase; hitTrap gives the
    // fold-scale-derived banding that reads as a kaleidoscope
    vec3 base = palette(
      hitTrap * 2.2 + u_centroid * 0.6 + u_time * 0.015,
      vec3(0.55), vec3(0.45), vec3(1.0), vec3(0.0, 0.33, 0.67)
    );

    col = base * (0.12 + diff * 0.7 + fill * 0.18) * (0.35 + 0.65 * ao);
    col += vec3(0.85, 0.9, 1.0) * spec * (0.4 + 0.6 * ao);

    // kick: local glow in the AO-darkened creases and grazing normals —
    // a surface glint, not a global flash
    float rim = pow(1.0 - clamp(dot(nrm, -rd), 0.0, 1.0), 2.0);
    float crevice = 1.0 - ao;
    float glow = crevice * crevice * 0.7 + rim * 0.3;
    col += base * glow * u_kick * 1.7;

    float fog = 1.0 - exp(-hit * 0.22);
    col = mix(col, bg, fog * 0.55);
  }

  col *= 1.0 + u_level * 0.08;
  o = vec4(col, 1.0);
}`;

export function createKifs(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let angle = 0;
  let yaw = 0;
  let pitch = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // level drives the orbit speed; the object also drifts on its own so
      // the image keeps moving through silence
      angle += dt * (0.1 + audio.level * 0.3);
      yaw += dt * 0.05;
      pitch += dt * 0.025;

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_yaw, yaw);
      gl.uniform1f(u.u_pitch, pitch);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.6 + audio.level * 0.35,
        exposure: 1.1 + audio.kickPulse * 0.1,
        aberration: 0.0008 + audio.change * 0.0016,
        grain: 0.035,
        vignette: 1.15,
        flash: 0.0,
        threshold: 0.62,
        time: t,
      });
    },
  };
}
