// Per-scene GL resource tracker.
//
// The gallery scenes were written for a single, fixed scene: none implement
// dispose(), they just allocate programs, textures, framebuffers and VAOs through
// ctx.gl and never free them. The live VJ mode creates and destroys scenes
// continuously, so those leaked GL objects would exhaust VRAM within a handful of
// switches (slime alone holds ~180MB of state textures).
//
// Rather than retrofit dispose() into two dozen scene files, we capture every GL
// object a scene allocates by temporarily wrapping gl's create* methods *only while
// the scene's create() and resize() run* — the two moments scenes actually allocate.
// Frame rendering then runs against the untouched context, so there is zero
// per-frame overhead. dispose() deletes everything the scope captured.

type GLIndexable = Record<string, (...args: unknown[]) => unknown>;

const CREATE_TO_DELETE: Record<string, string> = {
  createProgram: "deleteProgram",
  createShader: "deleteShader",
  createTexture: "deleteTexture",
  createFramebuffer: "deleteFramebuffer",
  createRenderbuffer: "deleteRenderbuffer",
  createBuffer: "deleteBuffer",
  createVertexArray: "deleteVertexArray",
  createSampler: "deleteSampler",
  createTransformFeedback: "deleteTransformFeedback",
  createQuery: "deleteQuery",
};

export class GLScope {
  private readonly gl: WebGL2RenderingContext;
  private items: Array<{ del: string; obj: object }> = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** Run `fn` with gl's create* methods recording every object into this scope. */
  track<T>(fn: () => T): T {
    const gl = this.gl as unknown as GLIndexable;
    const names = Object.keys(CREATE_TO_DELETE);
    const saved: Record<string, PropertyDescriptor | undefined> = {};

    for (const name of names) {
      saved[name] = Object.getOwnPropertyDescriptor(gl, name);
      const original = gl[name].bind(gl);
      const del = CREATE_TO_DELETE[name];
      gl[name] = (...args: unknown[]): unknown => {
        const r = original(...args);
        if (r) this.items.push({ del, obj: r as object });
        return r;
      };
    }

    try {
      return fn();
    } finally {
      // Restore the context to exactly how we found it (own override or prototype).
      for (const name of names) {
        const d = saved[name];
        if (d) Object.defineProperty(gl, name, d);
        else delete gl[name];
      }
    }
  }

  /** Delete every GL object captured, newest first. Idempotent. */
  dispose(): void {
    const gl = this.gl as unknown as GLIndexable;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const { del, obj } = this.items[i];
      gl[del](obj);
    }
    this.items.length = 0;
  }
}
