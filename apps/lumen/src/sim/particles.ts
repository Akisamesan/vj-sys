import { program, uniforms, texture, framebuffer, FULLSCREEN_VS } from "../gl/glutil.ts";
import type { Uniforms } from "../gl/glutil.ts";
import { SIM_UPDATE_FS } from "../shaders/sim.ts";
import { BAND_COUNT } from "../audio/engine.ts";

export interface SimParams {
  dt: number;
  time: number;
  fieldScale: number;
  flowSpeed: number;
  curl: number;
  damp: number;
  swirl: number;
  bass: number;
  turb: number;
  radiusGain: number;
  height: number;
  baseR: number;
  shock: [number, number, number];
  shockR: number;
  shockStrength: number;
  spectrum: Float32Array;
}

interface PingState {
  pos: WebGLTexture;
  vel: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class Sim {
  readonly side: number;
  readonly count: number;
  private prog: WebGLProgram;
  private u: Uniforms;
  private a: PingState;
  private b: PingState;
  private read: PingState;
  private write: PingState;
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject, side: number) {
    this.gl = gl;
    this.vao = vao;
    this.side = side;
    this.count = side * side;
    this.prog = program(gl, FULLSCREEN_VS, SIM_UPDATE_FS);
    this.u = uniforms(gl, this.prog);
    this.a = this.makeState();
    this.b = this.makeState();
    this.read = this.a;
    this.write = this.b;
    this.seed();
  }

  private makeState(): PingState {
    const gl = this.gl;
    const opts = {
      internal: gl.RGBA32F,
      format: gl.RGBA,
      type: gl.FLOAT,
      filter: gl.NEAREST,
      wrap: gl.CLAMP_TO_EDGE,
    };
    const pos = texture(gl, this.side, this.side, opts);
    const vel = texture(gl, this.side, this.side, opts);
    const fbo = framebuffer(gl, pos, vel);
    return { pos, vel, fbo };
  }

  /** Seed positions on stacked frequency rings, with a band id baked into vel.w. */
  seed(): void {
    const gl = this.gl;
    const n = this.count;
    const pos = new Float32Array(n * 4);
    const vel = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const band = Math.floor((i / n) * BAND_COUNT) % BAND_COUNT;
      const bn = band / (BAND_COUNT - 1);
      const y = (bn - 0.5) * 4.5;
      const a = Math.random() * Math.PI * 2;
      const r = 1.0 + Math.random() * 0.6;
      pos[i * 4] = Math.cos(a) * r;
      pos[i * 4 + 1] = y + (Math.random() - 0.5) * 0.4;
      pos[i * 4 + 2] = Math.sin(a) * r;
      pos[i * 4 + 3] = 0.4 + Math.random() * 0.6; // life
      vel[i * 4] = -Math.sin(a) * 0.3;
      vel[i * 4 + 1] = 0;
      vel[i * 4 + 2] = Math.cos(a) * 0.3;
      vel[i * 4 + 3] = band;
    }
    for (const st of [this.a, this.b]) {
      gl.bindTexture(gl.TEXTURE_2D, st.pos);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.side, this.side, gl.RGBA, gl.FLOAT, pos);
      gl.bindTexture(gl.TEXTURE_2D, st.vel);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.side, this.side, gl.RGBA, gl.FLOAT, vel);
    }
    this.read = this.a;
    this.write = this.b;
  }

  get posTex(): WebGLTexture {
    return this.read.pos;
  }
  get velTex(): WebGLTexture {
    return this.read.vel;
  }

  update(p: SimParams): void {
    const gl = this.gl;
    const u = this.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.write.fbo);
    gl.viewport(0, 0, this.side, this.side);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.read.pos);
    gl.uniform1i(u.u_pos, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.read.vel);
    gl.uniform1i(u.u_vel, 1);
    gl.uniform1f(u.u_dt, p.dt);
    gl.uniform1f(u.u_time, p.time);
    gl.uniform1f(u.u_fieldScale, p.fieldScale);
    gl.uniform1f(u.u_flowSpeed, p.flowSpeed);
    gl.uniform1f(u.u_curl, p.curl);
    gl.uniform1f(u.u_damp, p.damp);
    gl.uniform1f(u.u_swirl, p.swirl);
    gl.uniform1f(u.u_bass, p.bass);
    gl.uniform1f(u.u_turb, p.turb);
    gl.uniform1f(u.u_radiusGain, p.radiusGain);
    gl.uniform1f(u.u_height, p.height);
    gl.uniform1f(u.u_baseR, p.baseR);
    gl.uniform3f(u.u_shockPos, p.shock[0], p.shock[1], p.shock[2]);
    gl.uniform1f(u.u_shockR, p.shockR);
    gl.uniform1f(u.u_shockStrength, p.shockStrength);
    gl.uniform1fv(u.u_spectrum, p.spectrum);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  }
}
