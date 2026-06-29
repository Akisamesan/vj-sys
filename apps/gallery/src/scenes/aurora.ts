// 62 AURORA — curtains of northern light. Vertical fBm ribbons ripple across the sky
// over a faint starfield; bass raises the curtains, highs make them shimmer, the
// centroid shifts the green↔magenta hue and kicks send a bright wave along them.
// Pure fragment.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res; uniform float u_time, u_bass, u_high, u_centroid, u_beat, u_level;
out vec4 o;

float fbm(vec2 p){
  float a=0.5, s=0.0;
  for(int i=0;i<5;i++){ s += a*snoise(vec3(p,0.0)); p*=2.01; a*=0.5; }
  return s;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 col = vec3(0.01,0.02,0.05) * (1.0 - uv.y*0.5);   // night sky gradient

  // stars
  vec2 sg = floor(uv*vec2(u_res.x/4.0, u_res.y/4.0));
  float st = step(0.997, hash11(dot(sg, vec2(1.0,57.0))));
  col += vec3(0.8,0.85,1.0) * st * (0.4+0.6*hash11(sg.x+sg.y));

  // aurora curtains: several wavy vertical sheets
  float light = 0.0;
  for(int k=0;k<3;k++){
    float fk = float(k);
    float wave = fbm(vec2(uv.x*3.0 + fk*5.0, u_time*0.3 + fk));
    float base = 0.35 + 0.25*fk + wave*0.18;             // curtain base height
    float top = base + 0.35 + u_bass*0.3;
    float band = smoothstep(base, base+0.02, uv.y) * smoothstep(top, top-0.4, uv.y);
    // vertical streaks
    float streak = 0.5+0.5*sin(uv.x*60.0 + wave*8.0 + u_time*(1.0+u_high*3.0));
    float intensity = band * (0.4 + streak*0.6) * (0.5 + u_level);
    light += intensity * (1.0 - fk*0.2);
  }
  // beat wave travels horizontally
  light *= 1.0 + u_beat * smoothstep(0.1, 0.0, abs(fract(uv.x - u_time*0.5) - 0.5)) * 2.0;

  vec3 aur = palette(0.3 + u_centroid*0.4 + uv.y*0.3, vec3(0.4,0.5,0.4), vec3(0.4,0.5,0.4), vec3(1.0,1.0,1.0), vec3(0.3,0.5,0.2));
  col += aur * light * 1.3;

  col *= 1.0 - 0.3*pow(abs(uv.x-0.5)*2.0, 3.0);
  o = vec4(pow(max(col,0.0), vec3(0.85)), 1.0);
}`;

export function createAurora(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, rw, rh);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
