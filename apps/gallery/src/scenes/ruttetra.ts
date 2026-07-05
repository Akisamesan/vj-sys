// 57 RUTTETRA — Rutt-Etra style scan-line displacement. The screen is built from a
// fixed grid of thin horizontal scan lines; each line's vertical position is offset
// by the audio waveform sampled along its row, so the raw waveform itself becomes a
// rolling terrain of parallel traces (never colour-mapped directly, only used as a
// displacement). level scales how tall the terrain gets, spectrum bands tint each
// row by frequency, centroid drifts the palette phase and the aberration amount,
// and a kick tears a short, localized band of rows out of place before it settles
// back. Pure fragment: a small per-pixel search across nearby candidate rows finds
// the closest displaced scan-line curve (no video texture — the "video" is synthesised
// from wave[512] alone).

import { program, uniforms, texture, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { WAVE_SIZE, BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_amp, u_centroid, u_kickPulse;
uniform sampler2D u_wave;
uniform float u_spectrum[${BAND_COUNT}];
out vec4 o;

const float NL = 84.0;   // scan-line count (density tuned for 640x360 visibility)
const int K = 12;        // search half-window in rows around the pixel's own row

float waveAt(float sx){
  int i = int(clamp(sx, 0.0, 0.999999) * ${WAVE_SIZE - 1}.0);
  return texelFetch(u_wave, ivec2(i, 0), 0).r; // -1..1, raw waveform (never used as colour)
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float x = uv.x;
  float rowH = 1.0 / NL;
  float rowC = floor(uv.y / rowH);
  float drift = u_time * 0.015; // slow autonomous scroll so the terrain never fully stalls

  // kick jitter: a short band of rows (not the whole frame) tears sideways and
  // settles back as kickPulse decays — structural, not a flash.
  float bandCenter = floor(hash11(floor(u_time * 1.7) * 3.11) * NL);
  float tearSign = sign(hash11(bandCenter * 7.0 + 1.0) - 0.5);

  float best = 1e6;
  float bestRow = 0.0;

  for (int i = -K; i <= K; i++) {
    float r = clamp(rowC + float(i), 0.0, NL - 1.0);
    float shift = r * 0.0027 + drift;
    float wv = waveAt(fract(x + shift));
    float inBand = step(abs(r - bandCenter), 4.0);
    float tear = inBand * tearSign * u_kickPulse * 0.035;
    float dispY = (r + 0.5) * rowH + wv * u_amp + tear;
    float d = abs(uv.y - dispY);
    if (d < best) { best = d; bestRow = r; }
  }

  // re-derive the winning row's curve at three horizontal offsets for a thin
  // scan-line colour-aberration accent (amount grows with centroid).
  float shiftBest = bestRow * 0.0027 + drift;
  float inBandBest = step(abs(bestRow - bandCenter), 4.0);
  float tearBest = inBandBest * tearSign * u_kickPulse * 0.035;
  float baseYBest = (bestRow + 0.5) * rowH;
  float chroma = mix(0.0016, 0.005, u_centroid);
  float dispYR = baseYBest + waveAt(fract(x - chroma + shiftBest)) * u_amp + tearBest;
  float dispYB = baseYBest + waveAt(fract(x + chroma + shiftBest)) * u_amp + tearBest;

  float thickness = 1.5 / u_res.y;
  float maskG = smoothstep(thickness, 0.0, best);
  float maskR = smoothstep(thickness, 0.0, abs(uv.y - dispYR));
  float maskB = smoothstep(thickness, 0.0, abs(uv.y - dispYB));

  float bandT = (bestRow + 0.5) / NL;
  int band = int(clamp(floor(bandT * ${BAND_COUNT}.0), 0.0, ${BAND_COUNT - 1}.0));
  float e = u_spectrum[band];
  float hue = bandT + u_centroid * 0.4;
  vec3 bandColor = palette(hue, vec3(0.5,0.5,0.55), vec3(0.45,0.45,0.4), vec3(1.0), vec3(0.0,0.33,0.6));

  vec3 col = vec3(0.013, 0.015, 0.02); // faint navy floor (never pure black)
  col += vec3(1.0) * maskG * 0.4;               // monochrome core
  col += bandColor * maskG * (0.22 + e * 0.42);  // spectrum-band colour tint
  col.r += maskR * 0.3;                          // chromatic-aberration accents
  col.b += maskB * 0.3;

  o = vec4(pow(max(col, 0.0), vec3(0.92)), 1.0);
}`;

export function createRuttetra(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const waveTex = texture(gl, WAVE_SIZE, 1, {
    internal: gl.R32F,
    format: gl.RED,
    type: gl.FLOAT,
    filter: gl.NEAREST,
    wrap: gl.CLAMP_TO_EDGE,
  });
  let rw = 1,
    rh = 1;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, _dt, audio: AudioEngine) {
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WAVE_SIZE, 1, gl.RED, gl.FLOAT, audio.wave);

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_amp, 0.03 + audio.level * 0.07);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, waveTex);
      gl.uniform1i(u.u_wave, 0);
      gl.uniform1fv(u.u_spectrum, audio.spectrum);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
