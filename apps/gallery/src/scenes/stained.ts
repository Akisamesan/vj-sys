// 86 STAINED — a stained-glass voronoi: each cell is a pane of coloured glass,
// lead-lined in black, lit from behind. A slow layered-noise backlight stands in
// for the light source; level swells the glow that passes through the panes, bass
// breathes the pane scale, the 24-band spectrum is scattered across panes (each
// pane listens to one band and flickers with it), centroid slowly turns the whole
// window's hue, kickPulse lights a clustered patch of panes (never the whole
// field), and high sharpens the lead lines and sparks tiny glints. Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_scale, u_level, u_high, u_centroid, u_kick;
uniform float u_spec[24];
out vec4 o;

// Quantise a hash into one of five deep church-glass hues (red/gold/green/blue/violet).
float glassHue(float x){
  if (x < 0.20) return 0.98;
  else if (x < 0.40) return 0.10;
  else if (x < 0.68) return 0.37;
  else if (x < 0.88) return 0.62;
  else return 0.80;
}

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res)/u_res.y;
  vec2 p = uv * u_scale;
  vec2 g = floor(p);
  vec2 f = fract(p);

  // F1/F2 voronoi: nearest and second-nearest feature-point distances + winning cell id.
  float d1 = 8.0, d2 = 8.0;
  vec2 cellId = vec2(0.0);
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 cell = vec2(float(i), float(j));
    vec3 rnd3 = hash31(dot(g+cell, vec2(127.1, 311.7)));
    vec2 pt = cell + 0.5 + 0.42*sin(6.2831*rnd3.xy + u_time*(0.12+0.10*rnd3.z));
    float d = length(pt - f);
    if(d < d1){ d2 = d1; d1 = d; cellId = g+cell; }
    else if(d < d2){ d2 = d; }
  }

  // Lead line: thin dark seam at the cell boundary; high sharpens (thins) it.
  float leadW = mix(0.09, 0.045, clamp(u_high, 0.0, 1.0));
  float lead = 1.0 - smoothstep(0.0, leadW, d2 - d1);

  // Per-pane identity: hue bucket + mid saturation + brightness, all deterministic.
  vec3 rc = hash31(dot(cellId, vec2(12.9898, 78.233)) + 3.7);
  float hue = fract(glassHue(rc.x) + u_centroid * 0.18);
  float sat = 0.45 + rc.y * 0.30;
  float val = 0.50 + rc.z * 0.20;

  // Spectrum band scattered across panes (each pane listens to one band).
  int bandIdx = int(clamp(hash11(dot(cellId, vec2(41.3, 91.7))) * 24.0, 0.0, 23.0));
  float energy = max(0.0, u_spec[bandIdx]);

  // Backlight: slow layered noise standing in for light through the window,
  // always animating (autonomous motion even in silence).
  float bl1 = snoise(vec3(uv * 0.8, u_time * 0.06));
  float bl2 = snoise(vec3(uv * 1.7 - 5.0, -u_time * 0.045 + 10.0));
  float backN = clamp(0.5 + 0.3*bl1 + 0.15*bl2, 0.0, 1.0);

  // Kick: illuminate a clustered patch of panes (3x3 block groups), never the whole field.
  vec2 blockId = floor(cellId / 3.0);
  float blockHash = hash11(dot(blockId, vec2(31.7, 57.1)));
  float kickSel = step(0.74, blockHash);
  float kickGlow = kickSel * u_kick;

  float lum = 0.30 + backN*0.30 + energy*0.45 + u_level*0.30;
  lum += kickGlow * 0.55;
  lum = clamp(lum, 0.0, 1.3);

  vec3 glass = hsv2rgb(vec3(hue, clamp(sat, 0.0, 0.8), val));
  vec3 col = glass * lum;

  // Tiny specular glints inside the glass, sharpened by high.
  float spark = pow(max(0.0, snoise(vec3(f*3.4 + cellId*1.7, u_time*0.7))), 10.0);
  col = mix(col, vec3(1.0, 0.95, 0.85), spark * clamp(u_high, 0.0, 1.0) * 0.5);

  // Warm kick highlight on the selected panes only (never the whole frame).
  col += vec3(0.85, 0.7, 0.4) * kickGlow * 0.3 * (1.0 - lead);

  // Lead came: near-black seam.
  col = mix(col, vec3(0.015, 0.012, 0.02), lead);

  vec2 dd = uv;
  col *= 1.0 - dot(dd, dd) * 0.12;
  col = clamp(col, vec3(0.0), vec3(1.15));

  o = vec4(pow(max(col, 0.0), vec3(0.9)), 1.0);
}`;

export function createStained(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const spec = new Float32Array(24);
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      for (let i = 0; i < 24; i++) spec[i] = Math.min(1.2, audio.spectrum[i] * 1.6);
      const scale = 5.5 + Math.sin(t * 0.12) * 0.5 + audio.bass * 1.6;

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_scale, scale);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kick, audio.kickPulse);
      gl.uniform1fv(u.u_spec, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
