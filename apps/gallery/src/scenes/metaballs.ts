// 23 METABALLS — six organic blobs raymarched with smooth-minimum distance
// estimation. Bass deepens the gooey merge (smooth-min blend), kicks scatter
// the balls outward with impulse offsets, spectrum bands pulse per-ball radii,
// centroid shifts the iridescent palette, high drives fresnel sharpness.
// Fragment raymarch through HDR PostFX.

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
uniform float u_time, u_angle, u_centroid, u_high, u_level, u_blend;
uniform vec3 u_ball[6];
uniform float u_rad[6];
out vec4 o;

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0-h);
}

float de(vec3 p){
  float d = 1e9;
  for(int i=0;i<6;i++){
    d = smin(d, length(p - u_ball[i]) - u_rad[i], u_blend);
  }
  return d;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  float ca = cos(u_angle), sa = sin(u_angle);
  vec3 ro = vec3(sa*4.0, 1.2 + sin(u_time*0.09)*0.5, ca*4.0);
  vec3 fw = normalize(-ro);
  vec3 rt = normalize(cross(vec3(0.0,1.0,0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x*rt + uv.y*up);

  float tRay = 0.0; float hit = -1.0;
  for(int i=0;i<80;i++){
    vec3 p = ro + rd*tRay;
    float d = de(p);
    if(d < 0.001){ hit = tRay; break; }
    tRay += max(d, 0.01);
    if(tRay > 10.0) break;
  }

  // Background
  vec3 col = vec3(0.02, 0.02, 0.06) + vec3(0.01, 0.02, 0.05)*(1.0 - length(uv));

  if(hit > 0.0){
    vec3 p = ro + rd*hit;

    // Normal by DE gradient
    vec2 e = vec2(0.002, 0.0);
    vec3 nrm = normalize(vec3(
      de(p+e.xyy)-de(p-e.xyy),
      de(p+e.yxy)-de(p-e.yxy),
      de(p+e.yyx)-de(p-e.yyx)));

    // Lambert + fill lighting
    vec3 sun = normalize(vec3(0.7, 0.8, 0.5));
    float diff = clamp(dot(nrm, sun), 0.0, 1.0);
    float fill = clamp(dot(nrm, -sun)*0.4 + 0.6, 0.0, 1.0);

    // Fresnel rim — sharpness driven by u_high
    float ndotv = clamp(dot(nrm, -rd), 0.0, 1.0);
    float fresnelPow = mix(2.0, 7.0, u_high);
    float fres = pow(1.0 - ndotv, fresnelPow);

    // Specular (metallic-ish) — tighter with more u_high
    vec3 hvec = normalize(sun - rd);
    float specPow = mix(24.0, 140.0, u_high);
    float spec = pow(clamp(dot(nrm, hvec), 0.0, 1.0), specPow);

    // Palette: world-space position seeded with centroid + slow time drift
    float pSeed = length(p)*0.45 + u_centroid*0.7 + u_time*0.014;
    vec3 base = palette(pSeed,
      vec3(0.5, 0.5, 0.5),
      vec3(0.5, 0.5, 0.5),
      vec3(1.0, 0.8, 0.95),
      vec3(0.0 + u_centroid*0.2, 0.3, 0.55 + u_centroid*0.3));

    col  = base * (0.1*fill + diff*0.85);
    col += base * spec * (0.35 + u_high*0.5);
    col += vec3(0.55, 0.75, 1.0) * fres * (0.4 + u_level*0.2);

    // Distance fog
    float fog = 1.0 - exp(-hit*0.18);
    col = mix(col, vec3(0.02, 0.02, 0.06), fog*0.5);
  }

  col *= 1.0 + u_level*0.1;
  o = vec4(col, 1.0);
}`;

// Per-ball orbit state kept on the JS side.
interface Ball {
  orbitR: number;
  speed: number;
  phase: number;
  tilt: number;
  baseRad: number;
  scatter: number;
  scatterDir: number[];
}

function makeBalls(): Ball[] {
  const balls: Ball[] = [];
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    balls.push({
      orbitR: 0.8 + (i % 3) * 0.32,
      speed: 0.2 + i * 0.065,
      phase: ang,
      tilt: (i / 6) * Math.PI * 0.85,
      baseRad: 0.4 + (i % 2) * 0.1,
      scatter: 0,
      scatterDir: [Math.cos(ang), i % 2 === 0 ? 0.4 : -0.4, Math.sin(ang)],
    });
  }
  return balls;
}

export function createMetaballs(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let angle = 0;

  const balls = makeBalls();
  const ballPos = new Float32Array(6 * 3);
  const ballRad = new Float32Array(6);

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },

    frame(t, dt, audio: AudioEngine) {
      // Camera orbit — speed scales with level
      angle += dt * (0.08 + audio.level * 0.18);

      // Kick → scatter impulse
      if (audio.kick) {
        for (let i = 0; i < 6; i++) {
          balls[i].scatter = 0.45 + Math.random() * 0.45;
          const a = Math.random() * Math.PI * 2;
          balls[i].scatterDir = [Math.cos(a), (Math.random() - 0.5) * 0.8, Math.sin(a)];
        }
      }

      // Update ball positions
      for (let i = 0; i < 6; i++) {
        const b = balls[i];
        b.scatter *= Math.exp(-dt * 4.2);

        const phi = t * b.speed + b.phase;
        const ct = Math.cos(b.tilt);
        const st = Math.sin(b.tilt);
        const ox = Math.cos(phi) * b.orbitR;
        const oy = Math.sin(phi) * b.orbitR * 0.38;
        const oz = Math.sin(phi) * b.orbitR;
        // Tilt the orbital plane (rotate around Y)
        const px = ox * ct + oz * st;
        const py = oy;
        const pz = -ox * st + oz * ct;

        const sd = b.scatterDir;
        ballPos[i * 3 + 0] = px + sd[0] * b.scatter;
        ballPos[i * 3 + 1] = py + sd[1] * b.scatter;
        ballPos[i * 3 + 2] = pz + sd[2] * b.scatter;

        // Radius: base + spectrum band (6 evenly-spaced bands from 24)
        const bandIdx = i * 4; // 0,4,8,12,16,20
        ballRad[i] = b.baseRad + audio.spectrum[bandIdx] * 0.24;
      }

      // Bass → blend (merge strength 0.3..1.1)
      const blend = 0.3 + audio.bass * 0.8;

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_angle, angle);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_blend, blend);
      gl.uniform3fv(u.u_ball, ballPos);
      gl.uniform1fv(u.u_rad, ballRad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.8 + audio.level * 0.4,
        exposure: 1.1 + audio.kickPulse * 0.2,
        aberration: 0.0006 + audio.change * 0.003,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.4,
        threshold: 0.6,
        time: t,
      });
    },
  };
}
