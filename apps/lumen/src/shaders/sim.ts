import { COMMON_GLSL } from "./common.ts";
import { BAND_COUNT } from "../audio/engine.ts";

// GPGPU particle update. One fragment per particle, MRT out -> (position, velocity).
//
// The structure: every particle belongs to one spectrum band and has a "home" ring
// stacked by frequency (lows low, highs high). A soft spring holds the ring; the
// band's live energy pushes its ring outward, so the whole spectrum is legible as a
// 3D nebula-equaliser. Curl noise adds organic swirl; kicks fire an expanding radial
// shock; novelty cranks turbulence.

export const SIM_UPDATE_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform float u_dt, u_time;
uniform float u_fieldScale, u_flowSpeed, u_curl, u_damp, u_swirl;
uniform float u_bass, u_turb, u_radiusGain, u_height, u_baseR;
uniform vec3 u_shockPos;
uniform float u_shockR, u_shockStrength;
uniform float u_spectrum[${BAND_COUNT}];
layout(location=0) out vec4 outPos;
layout(location=1) out vec4 outVel;

void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(u_pos, c, 0);
  vec4 V = texelFetch(u_vel, c, 0);
  vec3 pos = P.xyz; float life = P.w;
  vec3 vel = V.xyz; float band = V.w;
  float seed = hash11(band*13.0 + float(c.x)*0.017 + float(c.y)*0.031);
  int bi = int(clamp(band, 0.0, float(${BAND_COUNT - 1}) ) + 0.5);
  float energy = u_spectrum[bi];

  // Home ring for this band.
  float bn = band / float(${BAND_COUNT - 1});
  float homeY = (bn - 0.5) * u_height;
  float targetR = u_baseR + energy * u_radiusGain + 0.25*sin(u_time*0.2 + band);

  // Cylindrical radial + vertical springs hold the structure together.
  vec2 rxz = pos.xz;
  float r = length(rxz) + 1e-4;
  vec2 rdir = rxz / r;
  vec3 force = vec3(0.0);
  force.xz += rdir * (targetR - r) * 2.4;
  force.y += (homeY - pos.y) * 1.6;

  // Tangential swirl (faster for energised bands).
  vec2 tang = vec2(-rdir.y, rdir.x);
  force.xz += tang * (u_swirl * (0.6 + energy*1.8));

  // Curl-noise turbulence.
  vec3 cn = curlNoise(pos*u_fieldScale + vec3(0.0, u_time*0.05, 0.0), u_time*u_flowSpeed);
  force += cn * (u_curl * (0.5 + u_turb)) * (0.4 + energy);

  // Kick shockwave: a thin expanding shell pushes particles outward from center.
  vec3 toP = pos - u_shockPos;
  float d = length(toP) + 1e-4;
  float shell = exp(-pow((d - u_shockR)*2.2, 2.0)) * u_shockStrength;
  force += (toP/d) * shell * 6.0;

  // Bass lifts overall energy.
  force *= (0.7 + u_bass*0.9);

  vel += force * u_dt;
  vel *= exp(-u_dt * u_damp);
  pos += vel * u_dt;

  // Life cycle -> respawn onto the band ring.
  life -= u_dt * (0.04 + seed*0.05);
  if (life <= 0.0 || length(pos) > 9.0){
    float a = seed * 6.28318 + u_time*0.1;
    float rr = u_baseR * (0.6 + 0.6*hash11(seed*91.7));
    pos = vec3(cos(a)*rr, homeY + (hash11(seed*7.3)-0.5)*0.4, sin(a)*rr);
    vel = vec3(-sin(a),0.0,cos(a)) * 0.4;
    life = 0.6 + hash11(seed*5.0)*0.4;
  }

  outPos = vec4(pos, life);
  outVel = vec4(vel, band);
}`;
