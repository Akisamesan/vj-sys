// 55 SLITSCAN — a slit-scan glitch. A small ring-buffer history texture holds a
// compressed audio-lit "video" (columns = time, rows = space) that scrolls one texel
// left every frame, newest column entering on the right. The display reads each
// screen column from a *different* point back in that history, so motion smears into
// diagonal streaks instead of a single coherent instant. level spreads the read
// pointer across columns (scan speed), bass tilts the read line (shear), spectrum
// bands tint each row's saturation, kicks bake a stronger reference frame into the
// buffer (a structural landmark that reappears later as a bright streak, not an
// on-the-spot flash) and centroid rotates the hue.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT, WAVE_SIZE } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const HIST_W = 320; // ring-buffer depth (time axis, scrolls 1 texel/frame)
const HIST_H = 120; // compressed space axis (maps 1:1 onto screen rows)
const ROW_BANDS = 28; // hard-edged horizontal bands baked into every written column

const SCROLL_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_prev, u_wave;
uniform vec2 u_px;
uniform float u_time, u_kick;
uniform float u_spectrum[${BAND_COUNT}];
in vec2 v_uv; out vec4 o;
float specAt(float y){
  float f = y*float(${BAND_COUNT - 1});
  int i0 = int(floor(f)); int i1 = min(i0+1, ${BAND_COUNT - 1});
  return mix(u_spectrum[i0], u_spectrum[i1], fract(f));
}
void main(){
  if(v_uv.x < 1.0 - u_px.x){
    o = texture(u_prev, v_uv + vec2(u_px.x, 0.0)); // scroll left: older data drifts left
  } else {
    // Hard-edged "barcode" bands: a fixed row is either dark or bright, never a
    // smooth gradient, so a diagonal read later reveals real stripes.
    float bandIdx = floor(v_uv.y * ${ROW_BANDS}.0);
    float barTone = hash11(bandIdx*12.9898 + 3.1);
    float barBase = 0.05 + barTone*0.55;

    // Genuine high-frequency detail: the raw waveform sample for this row (real
    // audio micro-structure, not a smoothed band) plus a fast-varying noise octave.
    float w = texture(u_wave, vec2(v_uv.y, 0.5)).r;
    float fine = snoise(vec3(v_uv.y*42.0, u_time*0.6, 5.7));
    float detail = abs(w)*0.6 + max(fine, 0.0)*0.35;

    float band = specAt(v_uv.y);
    float val = barBase * (0.55 + 0.45*band) + detail;

    // Occasional hard streak marker: a thin bright line at a row that holds for a
    // short run of columns, so it reads as a real diagonal dash once sheared.
    float markerY = hash11(floor(u_time*8.0)*7.13 + 1.7);
    val += step(abs(v_uv.y - markerY), 0.008) * (0.6 + 0.4*band);

    val += u_kick * (0.5 + 0.5*barTone); // structural landmark write, not a flash
    o = vec4(val, 0.0, 0.0, 1.0);
  }
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform sampler2D u_hist;
uniform float u_level, u_bass, u_centroid, u_kickPulse;
uniform float u_spectrum[${BAND_COUNT}];
in vec2 v_uv; out vec4 o;
float specAt(float y){
  float f = y*float(${BAND_COUNT - 1});
  int i0 = int(floor(f)); int i1 = min(i0+1, ${BAND_COUNT - 1});
  return mix(u_spectrum[i0], u_spectrum[i1], fract(f));
}
void main(){
  float ageSpan = 0.12 + u_level*0.5;   // level -> scan speed (read-pointer spread across columns)
  float shear = (u_bass - 0.1) * 0.55;  // bass -> diagonal tilt of the read line
  float age = clamp((1.0-v_uv.x)*ageSpan + shear*(v_uv.y-0.5), 0.0, 0.97);
  float lum = texture(u_hist, vec2(1.0 - age, v_uv.y)).r;
  float v = pow(clamp(lum, 0.0, 1.6), 0.85);

  float band = specAt(v_uv.y);
  float hue = 0.52 + u_centroid*0.32 + v_uv.y*0.06;
  vec3 base = palette(hue, vec3(0.42,0.48,0.55), vec3(0.32,0.38,0.45), vec3(1.0,1.0,1.0), vec3(0.55,0.62,0.78));
  float sat = clamp(0.3 + band*1.0, 0.0, 1.2);
  vec3 col = mix(vec3(dot(base, vec3(0.333))), base, sat);
  col *= smoothstep(0.03, 0.8, v);
  col += vec3(0.5,0.7,1.0) * v * 0.22;

  float edgeDist = 1.0 - v_uv.x; // distance from the "now" write edge
  col += vec3(0.5,0.75,1.0) * exp(-edgeDist*28.0) * u_kickPulse * 0.7;

  vec2 d = v_uv - 0.5; col *= 1.0 - dot(d,d)*0.35;
  o = vec4(pow(clamp(col,0.0,3.0), vec3(0.9)), 1.0);
}`;

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export function createSlitscan(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const scroll = program(gl, FULLSCREEN_VS, SCROLL_FS);
  const disp = program(gl, FULLSCREEN_VS, DISPLAY_FS);
  const uS: Uniforms = uniforms(gl, scroll);
  const uD: Uniforms = uniforms(gl, disp);

  const opts = {
    internal: gl.RGBA16F,
    format: gl.RGBA,
    type: gl.HALF_FLOAT,
    filter: gl.LINEAR,
    wrap: gl.CLAMP_TO_EDGE,
  };

  function rt(): RT {
    const tex = texture(gl, HIST_W, HIST_H, opts);
    return { tex, fbo: framebuffer(gl, tex) };
  }
  let a = rt();
  let b = rt();

  const waveTex = texture(gl, WAVE_SIZE, 1, {
    internal: gl.R32F,
    format: gl.RED,
    type: gl.FLOAT,
    filter: gl.LINEAR,
    wrap: gl.CLAMP_TO_EDGE,
  });

  // Seed both buffers with a hard-banded baseline (never a smooth gradient) so the
  // ring buffer already reads as barcode-like stripes before real audio fills it.
  function seed(): void {
    const d = new Float32Array(HIST_W * HIST_H * 4);
    const bandTone = new Float32Array(ROW_BANDS);
    for (let i = 0; i < ROW_BANDS; i++) bandTone[i] = 0.05 + Math.random() * 0.55;
    for (let y = 0; y < HIST_H; y++) {
      const bandIdx = Math.min(ROW_BANDS - 1, Math.floor((y / HIST_H) * ROW_BANDS));
      const base = bandTone[bandIdx];
      for (let x = 0; x < HIST_W; x++) {
        const v = base + Math.random() * 0.1;
        const i = (y * HIST_W + x) * 4;
        d[i] = v;
        d[i + 1] = 0;
        d[i + 2] = 0;
        d[i + 3] = 1;
      }
    }
    for (const r of [a, b]) {
      gl.bindTexture(gl.TEXTURE_2D, r.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, HIST_W, HIST_H, gl.RGBA, gl.FLOAT, d);
    }
  }
  seed();

  const spec = new Float32Array(BAND_COUNT);

  return {
    resize() {
      // History buffers are a fixed internal resolution independent of canvas size,
      // so there is nothing to reallocate here.
    },
    key(k) {
      if (k === "r") {
        seed();
        return true;
      }
      return false;
    },
    frame(t, _dt, audio: AudioEngine) {
      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.2, audio.spectrum[i] * 1.5);
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WAVE_SIZE, 1, gl.RED, gl.FLOAT, audio.wave);

      gl.disable(gl.BLEND);

      // scroll a -> b, writing the newest column on the right edge
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
      gl.viewport(0, 0, HIST_W, HIST_H);
      gl.useProgram(scroll);
      gl.bindVertexArray(tri);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform1i(uS.u_prev, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.uniform1i(uS.u_wave, 1);
      gl.uniform2f(uS.u_px, 1 / HIST_W, 1 / HIST_H);
      gl.uniform1f(uS.u_time, t);
      gl.uniform1f(uS.u_kick, audio.kick);
      gl.uniform1fv(uS.u_spectrum, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [a, b] = [b, a];

      // display: slit-scan read of the history
      ctx.bindOutput();
      gl.useProgram(disp);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.tex);
      gl.uniform1i(uD.u_hist, 0);
      gl.uniform1f(uD.u_level, audio.level);
      gl.uniform1f(uD.u_bass, audio.bass);
      gl.uniform1f(uD.u_centroid, audio.centroid);
      gl.uniform1f(uD.u_kickPulse, audio.kickPulse);
      gl.uniform1fv(uD.u_spectrum, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
