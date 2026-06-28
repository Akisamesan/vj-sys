import { COMMON_GLSL } from "./common.ts";
import { BAND_COUNT } from "../audio/engine.ts";

// Attributeless point rendering: the vertex shader fetches each particle's position
// from the sim texture by gl_VertexID, projects it, and sizes/colours it. Drawn with
// additive blending into an HDR (RGBA16F) target so dense regions bloom to white.

export const PARTICLE_VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_pos;
uniform sampler2D u_vel;
uniform mat4 u_viewProj;
uniform vec2 u_res;
uniform float u_time, u_pointScale, u_hatPulse, u_centroid;
uniform vec3 u_camPos;
uniform vec3 u_palA, u_palB, u_palC, u_palD;
uniform float u_spectrum[${BAND_COUNT}];
out vec3 v_col;
out float v_soft;

void main(){
  int tex = textureSize(u_pos, 0).x;
  ivec2 c = ivec2(gl_VertexID % tex, gl_VertexID / tex);
  vec4 P = texelFetch(u_pos, c, 0);
  vec4 V = texelFetch(u_vel, c, 0);
  vec3 pos = P.xyz; float life = P.w;
  float band = V.w;
  float speed = length(V.xyz);
  float bn = band / float(${BAND_COUNT - 1});
  int bi = int(band + 0.5);
  float energy = u_spectrum[bi];

  vec4 clip = u_viewProj * vec4(pos, 1.0);
  gl_Position = clip;

  // Perspective + energy sizing; flicker the highs on hi-hats.
  float dist = length(pos - u_camPos);
  float twinkle = 0.7 + 0.6*hash11(band*3.1 + float(gl_VertexID)*0.001 + u_time);
  float sz = u_pointScale * (1.0 + energy*2.2) * (0.5 + life) / (dist*0.35 + 0.5);
  sz *= mix(1.0, twinkle, u_hatPulse * bn);
  gl_PointSize = clamp(sz * u_res.y / 900.0, 0.5, 14.0);

  // Colour: cosine palette over band + centroid + speed, brightened by energy & life.
  float h = bn*0.7 + u_centroid*0.5 + speed*0.05 + u_time*0.01;
  vec3 col = palette(h, u_palA, u_palB, u_palC, u_palD);
  // Per-particle deposit kept tiny: hundreds overlap additively and trails integrate them.
  float bright = (0.05 + energy*0.6 + speed*0.06) * (0.3 + life*0.7);
  v_col = col * bright * 0.05;
  v_soft = clamp(life, 0.0, 1.0);
}`;

export const PARTICLE_FS = `#version 300 es
precision highp float;
in vec3 v_col;
in float v_soft;
out vec4 o;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d,d);
  if (r2 > 0.25) discard;
  // soft gaussian-ish sprite
  float a = exp(-r2*7.0);
  o = vec4(v_col * a, a);
}`;

// Temporal feedback: fade the previous accumulated frame for motion trails.
export const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_prev;
uniform float u_decay;
in vec2 v_uv;
out vec4 o;
void main(){ o = texture(u_prev, v_uv) * u_decay; }`;
