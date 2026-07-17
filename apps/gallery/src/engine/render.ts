// In-page Hap export capture harness (?render=<id>&secs=8&fps=30&w=960&h=540).
//
// Renders one scene with a fixed timestep against the deterministic ScriptedAudio
// feed (same source QA uses), so the clip is reproducible run to run. Each frame is
// PNG-encoded and POSTed to the dev server's /__render/frame endpoint, which writes
// qa-out/render/<id>/frame-NNNNNN.png; qa/render.mjs drives this headless and pipes
// the PNG sequence through ffmpeg into a Hap-codec .mov (VJ material for external
// software: Resolume, Modul8, CoGe, ...).

import { getContext, fullscreenTriangle, GLError } from "./gl.ts";
import { GLScope } from "./track.ts";
import { ScriptedAudio } from "./scripted.ts";
import { findScene } from "../scenes/registry.ts";
import type { Scene, SceneContext } from "./scene.ts";

// Lets state-based sims (GPGPU) settle before the captured window starts, matching
// the QA harness's warmup so the clip doesn't open on a still-cold field.
const WARMUP_FRAMES = 90;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function mountRender(params: URLSearchParams): void {
  void runRender(params);
}

async function runRender(params: URLSearchParams): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `<div id="render" style="font:12px/1.6 ui-monospace,monospace;color:#cdd;padding:16px">
    <h2 style="margin:0 0 8px">RENDER</h2><div id="renderLog"></div></div>`;
  const log = app.querySelector<HTMLDivElement>("#renderLog")!;
  const say = (s: string): void => {
    const d = document.createElement("div");
    d.textContent = s;
    log.appendChild(d);
  };
  const fail = (s: string): void => {
    say(s);
    document.title = "RENDER_ERROR";
  };

  const id = params.get("render") ?? "";
  const def = findScene(id);
  if (!def?.create) return fail(`unknown/unplayable scene id: "${id}"`);

  const fps = Number(params.get("fps") ?? 30);
  const secs = Number(params.get("secs") ?? 8);
  const w = Number(params.get("w") ?? 960);
  const h = Number(params.get("h") ?? 540);
  const dt = 1 / fps;
  const totalFrames = Math.round(secs * fps);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  document.body.appendChild(canvas);

  let gl: WebGL2RenderingContext;
  try {
    gl = getContext(canvas, { preserveDrawingBuffer: true });
  } catch (e) {
    return fail(`GL init failed: ${e instanceof GLError ? e.message : String(e)}`);
  }
  const tri = fullscreenTriangle(gl);
  const bindOutput = (): void => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
  };
  const ctx: SceneContext = { gl, canvas, tri, bindOutput };

  const scope = new GLScope(gl);
  const realRandom = Math.random;
  Math.random = mulberry32(hashStr(def.id));

  let scene: Scene;
  try {
    scene = scope.track(() => def.create!(ctx));
    scope.track(() => scene.resize(w, h));
  } catch (e) {
    Math.random = realRandom;
    return fail(`create/resize failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const audio = new ScriptedAudio();
  audio.mode = "pattern";
  let simT = 0;
  for (let i = 0; i < WARMUP_FRAMES; i++) {
    audio.update(dt);
    simT += dt;
    scene.frame(simT, dt, audio);
  }

  say(`▶ ${def.no} ${def.title} — ${w}x${h} @ ${fps}fps × ${secs}s (${totalFrames} frames)`);

  for (let i = 0; i < totalFrames; i++) {
    audio.update(dt);
    simT += dt;
    scene.frame(simT, dt, audio);

    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
    );
    const buf = await blob.arrayBuffer();
    const res = await fetch(`/__render/frame?id=${encodeURIComponent(def.id)}&i=${i}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: buf,
    });
    if (!res.ok) {
      Math.random = realRandom;
      return fail(`frame ${i} POST failed (${res.status})`);
    }
    if (i % 30 === 0) say(`  frame ${i}/${totalFrames}`);
  }

  Math.random = realRandom;
  try {
    scene.dispose?.();
  } catch {
    /* dispose failures must not stop the run */
  }
  scope.dispose();

  await fetch("/__render/done", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: def.id,
      frames: totalFrames,
      fps,
      w,
      h,
      ts: new Date().toISOString(),
    }),
  });

  say(`done → qa-out/render/${def.id}`);
  document.title = "RENDER_DONE";
}
