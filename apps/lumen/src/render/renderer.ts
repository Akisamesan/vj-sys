import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../gl/glutil.ts";
import type { Uniforms } from "../gl/glutil.ts";
import { PARTICLE_VS, PARTICLE_FS, FADE_FS } from "../shaders/render.ts";
import { BRIGHT_FS, BLUR_FS, COMPOSITE_FS } from "../shaders/post.ts";
import type { Sim } from "../sim/particles.ts";
import type { Mat4 } from "../math/mat4.ts";

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export interface SceneParams {
  viewProj: Mat4;
  camPos: [number, number, number];
  time: number;
  pointScale: number;
  hatPulse: number;
  centroid: number;
  decay: number;
  palA: [number, number, number];
  palB: [number, number, number];
  palC: [number, number, number];
  palD: [number, number, number];
  spectrum: Float32Array;
}

export interface PostParams {
  bloomAmt: number;
  exposure: number;
  aberration: number;
  grain: number;
  vignette: number;
  flash: number;
  threshold: number;
  time: number;
}

export class Renderer {
  private particle: WebGLProgram;
  private uPart: Uniforms;
  private fade: WebGLProgram;
  private uFade: Uniforms;
  private bright: WebGLProgram;
  private uBright: Uniforms;
  private blur: WebGLProgram;
  private uBlur: Uniforms;
  private composite: WebGLProgram;
  private uComp: Uniforms;
  private points: WebGLVertexArrayObject;

  private sceneA!: RT;
  private sceneB!: RT;
  private b0a!: RT;
  private b0b!: RT;
  private b1a!: RT;
  private b1b!: RT;
  private w = 1;
  private h = 1;
  private gl: WebGL2RenderingContext;
  private tri: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext, tri: WebGLVertexArrayObject) {
    this.gl = gl;
    this.tri = tri;
    this.particle = program(gl, PARTICLE_VS, PARTICLE_FS);
    this.uPart = uniforms(gl, this.particle);
    this.fade = program(gl, FULLSCREEN_VS, FADE_FS);
    this.uFade = uniforms(gl, this.fade);
    this.bright = program(gl, FULLSCREEN_VS, BRIGHT_FS);
    this.uBright = uniforms(gl, this.bright);
    this.blur = program(gl, FULLSCREEN_VS, BLUR_FS);
    this.uBlur = uniforms(gl, this.blur);
    this.composite = program(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.uComp = uniforms(gl, this.composite);
    this.points = gl.createVertexArray()!;
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
    const fbo = framebuffer(gl, tex);
    return { tex, fbo, w, h };
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.sceneA = this.rt(w, h);
    this.sceneB = this.rt(w, h);
    const hw = Math.max(1, w >> 1),
      hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2),
      qh = Math.max(1, h >> 2);
    this.b0a = this.rt(hw, hh);
    this.b0b = this.rt(hw, hh);
    this.b1a = this.rt(qw, qh);
    this.b1b = this.rt(qw, qh);
    // clear scene buffers so trails start from black
    const gl = this.gl;
    for (const s of [this.sceneA, this.sceneB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  private draw(p: WebGLProgram, target: RT): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(p);
    gl.bindVertexArray(this.tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Fade previous frame + additively splat particles. Returns the live scene tex. */
  renderScene(sim: Sim, s: SceneParams): WebGLTexture {
    const gl = this.gl;
    // 1) fade prev (sceneA) -> sceneB
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneB.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.fade);
    gl.bindVertexArray(this.tri);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneA.tex);
    gl.uniform1i(this.uFade.u_prev, 0);
    gl.uniform1f(this.uFade.u_decay, s.decay);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) additive particles onto sceneB
    gl.useProgram(this.particle);
    gl.bindVertexArray(this.points);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sim.posTex);
    gl.uniform1i(this.uPart.u_pos, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, sim.velTex);
    gl.uniform1i(this.uPart.u_vel, 1);
    gl.uniformMatrix4fv(this.uPart.u_viewProj, false, s.viewProj);
    gl.uniform2f(this.uPart.u_res, this.w, this.h);
    gl.uniform3f(this.uPart.u_camPos, s.camPos[0], s.camPos[1], s.camPos[2]);
    gl.uniform1f(this.uPart.u_time, s.time);
    gl.uniform1f(this.uPart.u_pointScale, s.pointScale);
    gl.uniform1f(this.uPart.u_hatPulse, s.hatPulse);
    gl.uniform1f(this.uPart.u_centroid, s.centroid);
    gl.uniform3fv(this.uPart.u_palA, s.palA);
    gl.uniform3fv(this.uPart.u_palB, s.palB);
    gl.uniform3fv(this.uPart.u_palC, s.palC);
    gl.uniform3fv(this.uPart.u_palD, s.palD);
    gl.uniform1fv(this.uPart.u_spectrum, s.spectrum);
    gl.drawArrays(gl.POINTS, 0, sim.count);
    gl.disable(gl.BLEND);

    // swap: sceneB is now current
    const tmp = this.sceneA;
    this.sceneA = this.sceneB;
    this.sceneB = tmp;
    return this.sceneA.tex;
  }

  /** Bloom + composite the HDR scene to the default framebuffer. */
  post(sceneTex: WebGLTexture, outW: number, outH: number, p: PostParams): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);

    // bright pass: scene -> b0a
    gl.useProgram(this.bright);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(this.uBright.u_src, 0);
    gl.uniform1f(this.uBright.u_threshold, p.threshold);
    gl.uniform1f(this.uBright.u_knee, 0.6);
    this.draw(this.bright, this.b0a);

    this.blurPass(this.b0a, this.b0b); // level 0 (half) -> result in b0a
    // downsample level0 -> level1 (quarter) -> result in b1a
    this.blurPass(this.b0a, this.b1b, this.b1a);

    // composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.composite);
    gl.bindVertexArray(this.tri);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(this.uComp.u_scene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.b0a.tex);
    gl.uniform1i(this.uComp.u_bloom1, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.b1a.tex);
    gl.uniform1i(this.uComp.u_bloom2, 2);
    gl.uniform2f(this.uComp.u_res, outW, outH);
    gl.uniform1f(this.uComp.u_time, p.time);
    gl.uniform1f(this.uComp.u_bloomAmt, p.bloomAmt);
    gl.uniform1f(this.uComp.u_exposure, p.exposure);
    gl.uniform1f(this.uComp.u_aberration, p.aberration);
    gl.uniform1f(this.uComp.u_grain, p.grain);
    gl.uniform1f(this.uComp.u_vignette, p.vignette);
    gl.uniform1f(this.uComp.u_flash, p.flash);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Separable gaussian: src -> (H) tmp -> (V) dst. When dst omitted, result lands back in src.
  private blurPass(src: RT, tmp: RT, dst?: RT): void {
    const gl = this.gl;
    const out = dst ?? src;
    gl.useProgram(this.blur);
    gl.bindVertexArray(this.tri);
    // horizontal: src -> tmp
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fbo);
    gl.viewport(0, 0, tmp.w, tmp.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.uBlur.u_src, 0);
    gl.uniform2f(this.uBlur.u_dir, 1 / src.w, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // vertical: tmp -> out
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.w, out.h);
    gl.bindTexture(gl.TEXTURE_2D, tmp.tex);
    gl.uniform2f(this.uBlur.u_dir, 0, 1 / tmp.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
