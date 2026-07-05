// 26 OCEAN — a low, forward flight over a Gerstner-composited swell. Five dispersive
// sine waves (each with its own amplitude, wave vector and phase speed, related by a
// deep-water dispersion relation) build the big rollers; two fast ripple waves layer
// wind-chop on top. Fragment raymarch against the sea height field, shaded with a
// fresnel sky reflection and a warm/cool sunset<->blue sky that tracks the spectral
// centroid. Kicks seed a scatter of crest glints (exp(-d^2*k) glow gated to steep wave
// faces), never a screen-wide flash.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_z, u_amp, u_ripple, u_centroid, u_kick;
out vec4 o;

// Sea height field: a sum of dispersive sinusoids (Gerstner-style swell). Each wave
// differs in amplitude, wave vector (direction*wavenumber) and phase speed (omega =
// sqrt(G*k), precomputed below), so crests drift past each other instead of marching
// in lockstep. Two small high-k ripple waves ride on top for wind-chop.
float seaHeight(vec2 p, float t, float amp, float ripple){
  float h = 0.0;
  h += amp*0.50*sin(dot(vec2( 0.970, 0.243), p)*0.150 - 0.5745*t);
  h += amp*0.32*sin(dot(vec2(-0.555, 0.832), p)*0.240 - 0.7266*t + 1.7);
  h += amp*0.20*sin(dot(vec2( 0.862,-0.507), p)*0.350 - 0.8775*t + 4.1);
  h += amp*0.12*sin(dot(vec2(-0.954,-0.301), p)*0.500 - 1.0488*t + 2.3);
  h += amp*0.07*sin(dot(vec2( 0.199,-0.980), p)*0.750 - 1.2845*t + 5.5);
  h += ripple*0.05*sin(dot(vec2( 0.707, 0.707), p)*1.60 - 1.8762*t + 0.9);
  h += ripple*0.03*sin(dot(vec2(-0.508, 0.861), p)*2.30 - 2.2494*t + 3.4);
  return h;
}

vec3 skyColor(vec3 rd, float cen){
  float hband = clamp(rd.y*0.5+0.5, 0.0, 1.0);
  vec3 cool = mix(vec3(0.015,0.035,0.09), vec3(0.30,0.50,0.72), hband);
  vec3 warm = mix(vec3(0.06,0.025,0.05), vec3(0.92,0.52,0.34), hband);
  vec3 sky = mix(cool, warm, cen);
  vec3 sunDir = normalize(vec3(0.35, 0.18+cen*0.22, -0.9));
  float sun = pow(max(dot(rd, sunDir), 0.0), 64.0);
  sky += sun*mix(vec3(0.55,0.68,1.0), vec3(1.0,0.72,0.4), cen)*0.7;
  return sky;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  vec3 rd = normalize(vec3(uv.x, uv.y*0.62 - 0.30, 1.0));
  float camY = seaHeight(vec2(0.0, u_z), u_time, u_amp, u_ripple) + 1.25 + 0.12*sin(u_time*0.37);
  vec3 ro = vec3(0.0, camY, u_z);

  float t = 0.6;
  float hit = -1.0;
  for(int i=0;i<100;i++){
    vec3 p = ro + rd*t;
    float hgt = seaHeight(p.xz, u_time, u_amp, u_ripple);
    float d = p.y - hgt;
    if(d < 0.015){ hit = t; break; }
    t += clamp(d*0.5, 0.02, 1.4);
    if(t > 90.0) break;
  }

  vec3 sky = skyColor(rd, u_centroid);
  vec3 col = sky;

  if(hit > 0.0){
    vec3 p = ro + rd*hit;
    vec2 e = vec2(0.06, 0.0);
    float hL = seaHeight(p.xz - e.xy, u_time, u_amp, u_ripple);
    float hR = seaHeight(p.xz + e.xy, u_time, u_amp, u_ripple);
    float hD = seaHeight(p.xz - e.yx, u_time, u_amp, u_ripple);
    float hU = seaHeight(p.xz + e.yx, u_time, u_amp, u_ripple);
    vec3 n = normalize(vec3(hL-hR, 2.0*e.x, hD-hU));
    float slope = length(vec2(hL-hR, hD-hU)) / (2.0*e.x);

    vec3 sunDir = normalize(vec3(0.35, 0.18+u_centroid*0.22, -0.9));
    float diff = clamp(dot(n, sunDir), 0.0, 1.0);
    vec3 seaBase = mix(vec3(0.012,0.085,0.11), vec3(0.05,0.30,0.32), diff*0.75+0.2);
    seaBase = mix(seaBase, seaBase*vec3(1.1,0.95,0.85)+vec3(0.02,0.0,0.0), u_centroid*0.4);

    float fresnel = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 5.0);
    col = mix(seaBase, sky, clamp(fresnel*0.8, 0.0, 0.8));

    float foam = smoothstep(0.4, 0.95, slope) * smoothstep(0.15, 0.7, u_amp);
    col = mix(col, vec3(0.82,0.90,0.93), foam*0.55);

    // Kick sparkle: procedural glints seeded per-cell, gated to steep crest faces,
    // shaped as a local gaussian glow (exp(-d^2*k)) and scaled by the kick envelope —
    // a structural trigger, not a screen-wide flash. A faint async twinkle keeps the
    // whitecaps alive between kicks.
    vec2 gp = p.xz*3.0;
    vec2 cell = floor(gp);
    vec2 fp = fract(gp) - 0.5;
    vec3 hs = hash31(dot(cell, vec2(127.1, 311.7)));
    vec2 jitter = (hs.xy - 0.5) * 0.9;
    float glintD = length(fp - jitter);
    float crestGate = smoothstep(0.5, 0.95, slope);
    float glint = exp(-glintD*glintD*45.0) * crestGate;
    float tw = 0.5 + 0.5*sin(hs.z*37.0 + u_time*1.3);
    float sparkle = glint*tw*0.35 + glint*u_kick*1.1;
    col = mix(col, vec3(1.0,0.98,0.92), clamp(sparkle, 0.0, 0.9));

    float fog = 1.0 - exp(-hit*0.018);
    col = mix(col, sky, fog);
  }

  col *= 1.0 + u_kick*0.08;
  o = vec4(col, 1.0);
}`;

export function createOcean(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  let rw = 1,
    rh = 1;
  let z = 0;
  let amp = 0.5;
  let ripple = 0.15;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      z += dt * (0.6 + audio.level * 2.4);
      amp += (0.5 + audio.bass * 1.3 - amp) * (1 - Math.exp(-dt * 2.2));
      ripple += (0.15 + audio.high * 0.9 - ripple) * (1 - Math.exp(-dt * 3.0));

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_z, z);
      gl.uniform1f(u.u_amp, amp);
      gl.uniform1f(u.u_ripple, ripple);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.5 + audio.level * 0.3,
        exposure: 1.05 + audio.kickPulse * 0.12,
        aberration: 0.0006 + audio.change * 0.0015,
        grain: 0.03,
        vignette: 1.05,
        flash: audio.kickPulse * 0.1,
        threshold: 0.72,
        time: t,
      });
    },
  };
}
