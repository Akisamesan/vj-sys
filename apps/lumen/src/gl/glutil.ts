// Thin WebGL2 helpers. Throwing on any failure so the boot path can show
// a clean error overlay instead of a half-initialised black screen.

export class GLError extends Error {}

export function getContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    alpha: false,
    depth: false,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  if (!gl)
    throw new GLError("WebGL2 を初期化できませんでした。デスクトップブラウザでお試しください。");
  if (!gl.getExtension("EXT_color_buffer_float"))
    throw new GLError("float レンダーターゲット非対応です (EXT_color_buffer_float)。");
  gl.getExtension("OES_texture_float_linear");
  return gl;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) ?? "";
    const numbered = src
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(3)}| ${l}`)
      .join("\n");
    throw new GLError(`shader compile error:\n${log}\n${numbered}`);
  }
  return s;
}

export function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new GLError(`program link error:\n${gl.getProgramInfoLog(p)}`);
  return p;
}

export type Uniforms = Record<string, WebGLUniformLocation | null>;

export function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram): Uniforms {
  const m: Uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, "");
    m[name] = gl.getUniformLocation(p, info.name);
  }
  return m;
}

export interface TexOpts {
  internal: number;
  format: number;
  type: number;
  filter?: number;
  wrap?: number;
}

export function texture(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  opts: TexOpts,
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const filter = opts.filter ?? gl.NEAREST;
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, opts.internal, w, h, 0, opts.format, opts.type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return t;
}

export function framebuffer(
  gl: WebGL2RenderingContext,
  ...attachments: WebGLTexture[]
): WebGLFramebuffer {
  const f = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  const bufs: number[] = [];
  attachments.forEach((tex, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
    bufs.push(gl.COLOR_ATTACHMENT0 + i);
  });
  if (bufs.length > 1) gl.drawBuffers(bufs);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw new GLError("framebuffer incomplete");
  return f;
}

// A single fullscreen triangle. Bind this VAO and drawArrays(TRIANGLES, 0, 3).
export function fullscreenTriangle(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export const FULLSCREEN_VS = `#version 300 es
layout(location=0) in vec2 a;
out vec2 v_uv;
void main(){ v_uv = a*0.5+0.5; gl_Position = vec4(a,0.,1.); }`;
