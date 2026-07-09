// 96 TYPO_FIELD — words surface from a decaying, diffusing energy field. A
// small CPU-side scalar grid (cheap "lightweight GPGPU": decay + 3x3 blur +
// injection, uploaded as a texture each frame) drives how crisply a tiled
// glyph mask reads: where the field is weak the words stay a faint bloom,
// where it is hot they snap into legible type. The glyph mask itself is
// baked once at scene creation via Canvas2D fillText into a texture (a
// one-time init cost, not per-frame) so no runtime text shaping is needed.
// level keeps a soft ambient hum in the field so it is never fully dark;
// kick injects a strong localized pulse (structural trigger, no flash);
// bass widens how far each pulse diffuses; centroid drifts the glyph hue;
// high sharpens the reveal edge / adds a light glitch offset to the mask UV.

import { program, uniforms, FULLSCREEN_VS, texture } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const WORDS = ["ECHO", "PULSE", "WAVE", "SOUND", "BEAT", "SIGNAL"];
const GLYPH_W = 512;
const GLYPH_H = 320;
const GRID_COLS = 3;
const GRID_ROWS = 2;

const FIELD_W = 48;
const FIELD_H = 27;
const FIELD_N = FIELD_W * FIELD_H;

function bakeGlyphMask(): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = GLYPH_W;
  canvas.height = GLYPH_H;
  const c2d = canvas.getContext("2d")!;
  c2d.clearRect(0, 0, GLYPH_W, GLYPH_H);
  c2d.fillStyle = "#fff";
  c2d.textAlign = "center";
  c2d.textBaseline = "middle";
  const cellW = GLYPH_W / GRID_COLS;
  const cellH = GLYPH_H / GRID_ROWS;
  let wi = 0;
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const word = WORDS[wi % WORDS.length];
      wi++;
      const cx = cellW * (gx + 0.5);
      const cy = cellH * (gy + 0.5);
      const fit = Math.min(cellH * 0.55, (cellW * 0.9) / (word.length * 0.62));
      c2d.font = `900 ${fit}px sans-serif`;
      c2d.save();
      c2d.translate(cx, cy);
      c2d.fillText(word, 0, 0);
      c2d.restore();
    }
  }
  const img = c2d.getImageData(0, 0, GLYPH_W, GLYPH_H);
  const out = new Uint8Array(GLYPH_W * GLYPH_H);
  for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4 + 3];
  return out;
}

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2 u_res;
uniform float u_time, u_aspect, u_centroid, u_high, u_density;
uniform sampler2D u_glyph, u_field;
out vec4 o;

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);

  // high (continuous): small glitchy UV offset on the glyph sampling only.
  vec2 gUV = uv * u_density;
  gUV.x += (hash11(floor(uv.y * 40.0) + floor(u_time * 6.0)) - 0.5) * u_high * 0.02;
  float glyph = texture(u_glyph, gUV).a;

  float field = texture(u_field, uv).r;

  // Continuous reveal: faint bloom at low field energy, crisp glyph at high.
  float soft = glyph * pow(field, 0.6) * 0.55;
  float crisp = smoothstep(0.35, 0.75, field) * glyph;
  float reveal = soft + crisp;

  float hue = 0.5 + u_centroid * 0.6 + u_time * 0.01;
  vec3 col = palette(hue, vec3(0.5), vec3(0.5), vec3(1.0, 0.9, 0.7), vec3(0.0, 0.33, 0.67));

  vec3 bg = vec3(0.01, 0.012, 0.02) + vec3(0.01, 0.015, 0.025) * field;
  vec3 fc = mix(bg, col, clamp(reveal, 0.0, 1.0));
  fc += col * crisp * u_high * 0.35;

  vec2 vd = uv - 0.5;
  fc *= 1.0 - dot(vd, vd) * 0.5;

  o = vec4(pow(max(fc, vec3(0.0)), vec3(0.9)), 1.0);
}`;

export function createTypoField(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);

  const glyphTex = texture(
    gl,
    GLYPH_W,
    GLYPH_H,
    {
      internal: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      filter: gl.LINEAR,
      wrap: gl.REPEAT,
    },
    (() => {
      // Re-expand the single-channel mask into RGBA so REPEAT wrap + LINEAR
      // filtering behave normally on all four channels (alpha only matters).
      const a = bakeGlyphMask();
      const rgba = new Uint8Array(a.length * 4);
      for (let i = 0; i < a.length; i++) rgba[i * 4 + 3] = a[i];
      return rgba;
    })(),
  );

  const fieldTex = texture(gl, FIELD_W, FIELD_H, {
    internal: gl.R8,
    format: gl.RED,
    type: gl.UNSIGNED_BYTE,
    filter: gl.LINEAR,
    wrap: gl.CLAMP_TO_EDGE,
  });

  const field = new Float32Array(FIELD_N);
  const fieldNext = new Float32Array(FIELD_N);
  const fieldBytes = new Uint8Array(FIELD_N);

  let rw = 1,
    rh = 1;

  function stampAt(fx: number, fy: number, amt: number, radius: number): void {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(fx - radius));
    const x1 = Math.min(FIELD_W - 1, Math.ceil(fx + radius));
    const y0 = Math.max(0, Math.floor(fy - radius));
    const y1 = Math.min(FIELD_H - 1, Math.ceil(fy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - fx,
          dy = y - fy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const k = Math.exp(-d2 * (2.5 / r2));
        field[y * FIELD_W + x] = Math.min(1.6, field[y * FIELD_W + x] + amt * k);
      }
    }
  }

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      const fdt = Math.min(dt, 1 / 30);

      // level (continuous): soft ambient hum keeps the field from ever going dark.
      const ambient = 0.05 + audio.level * 0.09;
      for (let i = 0; i < FIELD_N; i++) field[i] += (ambient - field[i] * 0.02) * fdt;

      // kick (trigger): a strong localized pulse at a rotating field position,
      // radius set by bass — structural, no screen flash.
      if (audio.kick) {
        const ang = t * 0.7;
        const fx = FIELD_W * 0.5 + Math.cos(ang) * FIELD_W * 0.28;
        const fy = FIELD_H * 0.5 + Math.sin(ang * 1.3) * FIELD_H * 0.28;
        stampAt(fx, fy, 1.1, 2.5 + audio.bass * 4.0);
      }

      // Cheap 3x3 blur (diffusion) + decay, ping-ponged through fieldNext.
      const decay = 0.965;
      for (let y = 0; y < FIELD_H; y++) {
        for (let x = 0; x < FIELD_W; x++) {
          let sum = 0,
            wsum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= FIELD_H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= FIELD_W) continue;
              const wgt = dx === 0 && dy === 0 ? 4 : 1;
              sum += field[yy * FIELD_W + xx] * wgt;
              wsum += wgt;
            }
          }
          fieldNext[y * FIELD_W + x] = Math.min(1.6, (sum / wsum) * decay);
        }
      }
      field.set(fieldNext);

      for (let i = 0; i < FIELD_N; i++) fieldBytes[i] = Math.min(255, field[i] * 180);

      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        FIELD_W,
        FIELD_H,
        gl.RED,
        gl.UNSIGNED_BYTE,
        fieldBytes,
      );

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_density, 1.6);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, glyphTex);
      gl.uniform1i(u.u_glyph, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.uniform1i(u.u_field, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
