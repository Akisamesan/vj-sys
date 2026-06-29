// The contract every VJ scene implements. A scene owns its own GL programs and
// render targets; the host only hands it the context, timing and live audio, then
// calls frame() each tick. Scenes render straight to the default framebuffer (they
// may use PostFX internally for bloom etc.).

import type { AudioEngine } from "./audio.ts";

export interface SceneContext {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** A ready-to-use fullscreen-triangle VAO (bind + drawArrays(TRIANGLES,0,3)). */
  tri: WebGLVertexArrayObject;
}

export interface Scene {
  /** Called on mount and whenever the drawing buffer size changes. */
  resize(w: number, h: number): void;
  /** Render one frame to the default framebuffer. */
  frame(t: number, dt: number, audio: AudioEngine): void;
  /** Optional key handling (single lowercased key). Return true if handled. */
  key?(k: string): boolean;
  dispose?(): void;
}

export interface SceneDef {
  /** Stable url id, e.g. "02-fluid". */
  id: string;
  /** Display number, e.g. "02". */
  no: string;
  /** Short title, e.g. "FLUID". */
  title: string;
  /** One-line Japanese description shown on the overlay / index. */
  blurb: string;
  /** Concept family for grouping in the index. */
  family: string;
  /** External/standalone link (e.g. a scene that ships as its own app). */
  href?: string;
  /** Per-scene HUD hint line (controls). */
  keys?: string;
  /** Factory. Absent => not yet implemented (planned). */
  create?: (ctx: SceneContext) => Scene;
}
