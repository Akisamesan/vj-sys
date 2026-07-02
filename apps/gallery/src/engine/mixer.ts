// The live mix bus. Owns two offscreen channels scenes render into (via their
// ctx.bindOutput) and composites them to the screen with a beat-synced
// transition plus a thin layer of master FX (kick zoom-pulse, RGB shift,
// strobe, invert). Channels are LDR (scenes tone-map themselves), so the bus
// stays cheap: one RGBA8 target per channel and a single fullscreen pass.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "./gl.ts";
import type { Uniforms } from "./gl.ts";

/** Transition kinds the director can pick. "cut" swaps without a mix window. */
export type TransitionKind = "cut" | "xfade" | "luma" | "glitch" | "flash" | "zoom";

const KIND_ID: Record<TransitionKind, number> = {
  cut: 0,
  xfade: 1,
  luma: 2,
  glitch: 3,
  flash: 4,
  zoom: 5,
};

const MIX_FS = `#version 300 es
precision highp float;
uniform sampler2D u_a, u_b;
uniform vec2 u_res;
uniform float u_mode;    // KIND_ID
uniform float u_prog;    // transition progress 0..1 (0 => pure A)
uniform float u_time;
uniform float u_kick;    // kick pulse 0..1 -> zoom punch + rgb shift
uniform float u_shift;   // extra rgb shift 0..1
uniform float u_strobe;  // 0/1 flicker (already gated CPU-side)
uniform float u_invert;  // 0..1 invert flash
out vec4 o;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 grab(sampler2D t, vec2 uv, float ab){
  vec2 d = uv - 0.5;
  vec3 c;
  c.r = texture(t, uv - d * ab).r;
  c.g = texture(t, uv).g;
  c.b = texture(t, uv + d * ab).b;
  return c;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  // Kick zoom punch (subtle, centre-anchored).
  uv = (uv - 0.5) / (1.0 + u_kick * 0.035) + 0.5;
  float ab = (u_kick * 0.004 + u_shift * 0.006);

  float p = clamp(u_prog, 0.0, 1.0);
  float ps = p * p * (3.0 - 2.0 * p);
  vec3 col;

  if (u_mode < 0.5) {                       // cut / no transition
    col = grab(u_a, uv, ab);
  } else if (u_mode < 1.5) {                // crossfade
    col = mix(grab(u_a, uv, ab), grab(u_b, uv, ab), ps);
  } else if (u_mode < 2.5) {                // luma wipe: dark areas turn first
    vec3 a = grab(u_a, uv, ab);
    vec3 b = grab(u_b, uv, ab);
    float th = ps * 1.3 - 0.15;
    float m = smoothstep(th + 0.15, th - 0.15, luma(a));
    col = mix(a, b, clamp(m, 0.0, 1.0));
  } else if (u_mode < 3.5) {                // glitch: sliced displacement swap
    float g = sin(p * 3.14159);
    float row = floor(uv.y * 28.0);
    float r1 = hash(vec2(row, floor(u_time * 24.0)));
    float r2 = hash(vec2(row + 57.0, floor(u_time * 24.0)));
    vec2 guv = uv + vec2((r1 - 0.5) * 0.35 * g, 0.0);
    vec3 a = grab(u_a, guv, ab + g * 0.01);
    vec3 b = grab(u_b, guv, ab + g * 0.01);
    col = mix(a, b, step(r2, ps));
  } else if (u_mode < 4.5) {                // white-flash cut
    col = mix(grab(u_a, uv, ab), grab(u_b, uv, ab), step(0.5, p));
    float w = sin(p * 3.14159);
    col += vec3(0.95, 0.97, 1.0) * w * w * 0.85;
  } else {                                  // zoom punch-through
    vec2 da = (uv - 0.5) * (1.0 + ps * 1.5) + 0.5;
    vec2 db = (uv - 0.5) / (1.0 + (1.0 - ps) * 1.5) + 0.5;
    vec3 a = grab(u_a, da, ab + ps * 0.02);
    vec3 b = grab(u_b, db, ab + (1.0 - ps) * 0.02);
    col = mix(a, b, ps);
  }

  col = mix(col, 1.0 - col, u_invert);
  col *= 1.0 + u_strobe * 1.6;
  o = vec4(col, 1.0);
}`;

export interface MixParams {
  kind: TransitionKind;
  /** 0..1; ignored for "cut". */
  progress: number;
  time: number;
  kickPulse: number;
  rgbShift: number;
  strobe: number;
  invert: number;
}

interface Channel {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class Mixer {
  private gl: WebGL2RenderingContext;
  private tri: WebGLVertexArrayObject;
  private prog: WebGLProgram;
  private u: Uniforms;
  private ch: [Channel, Channel] | null = null;
  private w = 1;
  private h = 1;

  constructor(gl: WebGL2RenderingContext, tri: WebGLVertexArrayObject) {
    this.gl = gl;
    this.tri = tri;
    this.prog = program(gl, FULLSCREEN_VS, MIX_FS);
    this.u = uniforms(gl, this.prog);
  }

  resize(w: number, h: number): void {
    const gl = this.gl;
    this.w = w;
    this.h = h;
    if (this.ch)
      for (const c of this.ch) {
        gl.deleteFramebuffer(c.fbo);
        gl.deleteTexture(c.tex);
      }
    const make = (): Channel => {
      const tex = texture(gl, w, h, {
        internal: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        filter: gl.LINEAR,
      });
      return { tex, fbo: framebuffer(gl, tex) };
    };
    this.ch = [make(), make()];
  }

  /** Bind channel i as the render target (what a slot's ctx.bindOutput calls). */
  bindChannel(i: 0 | 1): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ch![i].fbo);
    gl.viewport(0, 0, this.w, this.h);
  }

  /** Composite channel a (and b while transitioning) to the screen. */
  composite(a: 0 | 1, b: 0 | 1, p: MixParams): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.tri);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ch![a].tex);
    gl.uniform1i(this.u.u_a, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.ch![b].tex);
    gl.uniform1i(this.u.u_b, 1);
    gl.uniform2f(this.u.u_res, this.w, this.h);
    gl.uniform1f(this.u.u_mode, KIND_ID[p.kind]);
    gl.uniform1f(this.u.u_prog, p.progress);
    gl.uniform1f(this.u.u_time, p.time);
    gl.uniform1f(this.u.u_kick, p.kickPulse);
    gl.uniform1f(this.u.u_shift, p.rgbShift);
    gl.uniform1f(this.u.u_strobe, p.strobe);
    gl.uniform1f(this.u.u_invert, p.invert);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    if (this.ch)
      for (const c of this.ch) {
        gl.deleteFramebuffer(c.fbo);
        gl.deleteTexture(c.tex);
      }
    this.ch = null;
    gl.deleteProgram(this.prog);
  }
}
