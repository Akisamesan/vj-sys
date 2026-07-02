// Reusable HDR post chain a scene can opt into: render your frame into PostFX's
// HDR target, then call draw() to bloom + tonemap it to the screen. Bloom is a
// bright-pass + two-level separable gaussian; composite adds chromatic aberration,
// vignette, film grain and an ACES filmic curve.

import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "./gl.ts";
import type { Uniforms } from "./gl.ts";

const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform float u_threshold, u_knee;
in vec2 v_uv; out vec4 o;
void main(){
  vec3 c=texture(u_src,v_uv).rgb;
  float l=dot(c,vec3(0.2126,0.7152,0.0722));
  float soft=clamp(l-u_threshold+u_knee,0.0,2.0*u_knee);
  soft=soft*soft/(4.0*u_knee+1e-4);
  float contrib=max(soft,l-u_threshold)/max(l,1e-4);
  o=vec4(c*max(contrib,0.0),1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform vec2 u_dir;
in vec2 v_uv; out vec4 o;
void main(){
  float w[5]; w[0]=0.227027;w[1]=0.1945946;w[2]=0.1216216;w[3]=0.054054;w[4]=0.016216;
  vec3 s=texture(u_src,v_uv).rgb*w[0];
  for(int i=1;i<5;i++){ vec2 off=u_dir*float(i);
    s+=texture(u_src,v_uv+off).rgb*w[i]; s+=texture(u_src,v_uv-off).rgb*w[i]; }
  o=vec4(s,1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_scene,u_bloom1,u_bloom2;
uniform vec2 u_res; uniform float u_time,u_bloom,u_exposure,u_aberration,u_grain,u_vignette,u_flash;
in vec2 v_uv; out vec4 o;
vec3 aces(vec3 x){ float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0); }
float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
void main(){
  vec2 uv=v_uv; vec2 d=uv-0.5; float r=dot(d,d);
  float ab=u_aberration*(0.4+r)*(1.0+u_flash*2.0);
  vec2 dir=normalize(d+1e-5);
  vec3 sc; sc.r=texture(u_scene,uv-dir*ab).r; sc.g=texture(u_scene,uv).g; sc.b=texture(u_scene,uv+dir*ab).b;
  vec3 bloom=texture(u_bloom1,uv).rgb+texture(u_bloom2,uv).rgb*0.7;
  vec3 col=sc+bloom*u_bloom; col+=u_flash*vec3(0.9,0.95,1.0)*0.25;
  col*=u_exposure; col=aces(col); col*=1.0-r*u_vignette;
  col+=(h(uv*u_res+u_time*60.0)-0.5)*u_grain;
  o=vec4(pow(max(col,0.0),vec3(0.9)),1.0);
}`;

export interface PostParams {
  bloom: number;
  exposure: number;
  aberration: number;
  grain: number;
  vignette: number;
  flash: number;
  threshold: number;
  time: number;
}

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export class PostFX {
  private bright: WebGLProgram;
  private uBright: Uniforms;
  private blur: WebGLProgram;
  private uBlur: Uniforms;
  private comp: WebGLProgram;
  private uComp: Uniforms;
  private scene!: RT;
  private b0a!: RT;
  private b0b!: RT;
  private b1a!: RT;
  private b1b!: RT;
  private w = 1;
  private h = 1;
  private gl: WebGL2RenderingContext;
  private tri: WebGLVertexArrayObject;
  private output: (() => void) | undefined;

  constructor(gl: WebGL2RenderingContext, tri: WebGLVertexArrayObject, output?: () => void) {
    this.gl = gl;
    this.tri = tri;
    this.output = output;
    this.bright = program(gl, FULLSCREEN_VS, BRIGHT_FS);
    this.uBright = uniforms(gl, this.bright);
    this.blur = program(gl, FULLSCREEN_VS, BLUR_FS);
    this.uBlur = uniforms(gl, this.blur);
    this.comp = program(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.uComp = uniforms(gl, this.comp);
  }

  private rt(w: number, h: number): RT {
    const gl = this.gl;
    const tex = texture(gl, w, h, {
      internal: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
      filter: gl.LINEAR,
      wrap: gl.CLAMP_TO_EDGE,
    });
    return { tex, fbo: framebuffer(gl, tex), w, h };
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.scene = this.rt(w, h);
    this.b0a = this.rt(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.b0b = this.rt(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.b1a = this.rt(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.b1b = this.rt(Math.max(1, w >> 2), Math.max(1, h >> 2));
  }

  /** Bind the HDR scene target; render your frame, then call draw(). */
  bind(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.w, this.h);
  }

  get sceneTex(): WebGLTexture {
    return this.scene.tex;
  }

  private pass(p: WebGLProgram, target: RT): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(p);
    gl.bindVertexArray(this.tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private blurPass(src: RT, tmp: RT, dst: RT): void {
    const gl = this.gl;
    gl.useProgram(this.blur);
    gl.bindVertexArray(this.tri);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fbo);
    gl.viewport(0, 0, tmp.w, tmp.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.uBlur.u_src, 0);
    gl.uniform2f(this.uBlur.u_dir, 1 / src.w, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
    gl.uniform2f(this.uBlur.u_dir, 0, 1 / tmp.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Composite the HDR scene to the scene's output target with bloom + grade. */
  draw(outW: number, outH: number, p: PostParams): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.useProgram(this.bright);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.uBright.u_src, 0);
    gl.uniform1f(this.uBright.u_threshold, p.threshold);
    gl.uniform1f(this.uBright.u_knee, 0.6);
    this.pass(this.bright, this.b0a);
    this.blurPass(this.b0a, this.b0b, this.b0a);
    this.blurPass(this.b0a, this.b1b, this.b1a);

    if (this.output) {
      this.output();
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, outW, outH);
    }
    gl.useProgram(this.comp);
    gl.bindVertexArray(this.tri);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.uniform1i(this.uComp.u_scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.b0a.tex);
    gl.uniform1i(this.uComp.u_bloom1, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.b1a.tex);
    gl.uniform1i(this.uComp.u_bloom2, 2);
    gl.uniform2f(this.uComp.u_res, outW, outH);
    gl.uniform1f(this.uComp.u_time, p.time);
    gl.uniform1f(this.uComp.u_bloom, p.bloom);
    gl.uniform1f(this.uComp.u_exposure, p.exposure);
    gl.uniform1f(this.uComp.u_aberration, p.aberration);
    gl.uniform1f(this.uComp.u_grain, p.grain);
    gl.uniform1f(this.uComp.u_vignette, p.vignette);
    gl.uniform1f(this.uComp.u_flash, p.flash);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
