// In-page QA harness (?qa=all | ?qa=<id>[,<id>...]).
//
// Renders each playable scene with a fixed timestep and the deterministic
// ScriptedAudio feed (Math.random is seeded per scene), captures thumbnails at
// scripted moments and computes metrics: black/blown frame, motion, kick
// response, direct null-FBO binds (bindOutput contract violations) and CPU
// ms/frame. Results render as an in-page report and POST to the dev server's
// /__qa/report endpoint, which writes qa-out/report.json + sheet.html — the
// headless runner (qa/run.mjs) waits for that file.

import { getContext, GLError, fullscreenTriangle } from "./gl.ts";
import { GLScope } from "./track.ts";
import { ScriptedAudio } from "./scripted.ts";
import { SCENES } from "../scenes/registry.ts";
import type { Scene, SceneContext, SceneDef } from "./scene.ts";

const W = 640;
const H = 360;
const TW = 240;
const TH = 135;
const DT = 1 / 60;

interface Capture {
  luma: Float32Array;
  mean: number;
  pctWhite: number;
  url: string;
}

export interface SceneReport {
  id: string;
  no: string;
  title: string;
  family: string;
  status: "ok" | "warn" | "error";
  notes: string[];
  msPerFrame: number;
  directNullBinds: number;
  quietMotion: number;
  kickDelta: number;
  loudMotion: number;
  meanLuma: number;
  /** dataURLs: quiet / kick / loud */
  thumbs: string[];
  error?: string;
}

export interface QAReport {
  ts: string;
  ua: string;
  w: number;
  h: number;
  scenes: SceneReport[];
}

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

const yield0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export function mountQA(spec: string): void {
  void runQA(spec === "" ? "all" : spec);
}

async function runQA(spec: string): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `<div id="qa" style="font:12px/1.6 ui-monospace,monospace;color:#cdd;padding:16px">
    <h2 style="margin:0 0 8px">QA RUN</h2><div id="qaLog"></div></div>`;
  const log = app.querySelector<HTMLDivElement>("#qaLog")!;
  const say = (s: string): void => {
    const d = document.createElement("div");
    d.textContent = s;
    log.appendChild(d);
  };

  const pool = SCENES.filter((s): s is SceneDef & Required<Pick<SceneDef, "create">> =>
    Boolean(s.create),
  );
  const wanted =
    spec === "all"
      ? pool
      : pool.filter((s) => spec.split(",").some((w) => s.id === w || s.no === w));

  const report: QAReport = {
    ts: new Date().toISOString(),
    ua: navigator.userAgent,
    w: W,
    h: H,
    scenes: [],
  };

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = "position:fixed;right:16px;bottom:16px;width:320px;border:1px solid #333";
  document.body.appendChild(canvas);

  let gl: WebGL2RenderingContext;
  try {
    gl = getContext(canvas, { preserveDrawingBuffer: true });
  } catch (e) {
    say(`GL init failed: ${e instanceof GLError ? e.message : String(e)}`);
    await postReport(report);
    document.title = "QA_DONE";
    return;
  }
  const tri = fullscreenTriangle(gl);

  // Count direct null-FBO binds (contract violations once scenes use bindOutput).
  type BindFn = (target: number, fb: WebGLFramebuffer | null) => void;
  const origBind: BindFn = gl.bindFramebuffer.bind(gl) as BindFn;
  let nullBinds = 0;
  let inHostBind = false;
  let counting = false;
  (gl as unknown as { bindFramebuffer: BindFn }).bindFramebuffer = (target, fb) => {
    if (counting && fb === null && !inHostBind) nullBinds++;
    origBind(target, fb);
  };
  const bindOutput = (): void => {
    inHostBind = true;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    inHostBind = false;
    gl.viewport(0, 0, W, H);
  };
  const ctx: SceneContext = { gl, canvas, tri, bindOutput };

  const thumb = document.createElement("canvas");
  thumb.width = TW;
  thumb.height = TH;
  const t2d = thumb.getContext("2d", { willReadFrequently: true })!;

  const capture = (): Capture => {
    t2d.drawImage(canvas, 0, 0, TW, TH);
    const img = t2d.getImageData(0, 0, TW, TH).data;
    const luma = new Float32Array(TW * TH);
    let mean = 0;
    let white = 0;
    for (let i = 0; i < luma.length; i++) {
      const l = (img[i * 4] * 0.2126 + img[i * 4 + 1] * 0.7152 + img[i * 4 + 2] * 0.0722) / 255;
      luma[i] = l;
      mean += l;
      if (l > 0.97) white++;
    }
    mean /= luma.length;
    return { luma, mean, pctWhite: white / luma.length, url: thumb.toDataURL("image/jpeg", 0.72) };
  };

  const diff = (a: Capture, b: Capture): number => {
    let s = 0;
    for (let i = 0; i < a.luma.length; i++) s += Math.abs(a.luma[i] - b.luma[i]);
    return s / a.luma.length;
  };

  const resetGL = (): void => {
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
    gl.useProgram(null);
    origBind(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const realRandom = Math.random;

  for (const def of wanted) {
    const r: SceneReport = {
      id: def.id,
      no: def.no,
      title: def.title,
      family: def.family,
      status: "ok",
      notes: [],
      msPerFrame: 0,
      directNullBinds: 0,
      quietMotion: 0,
      kickDelta: 0,
      loudMotion: 0,
      meanLuma: 0,
      thumbs: [],
    };
    report.scenes.push(r);
    say(`▶ ${def.no} ${def.title}`);
    await yield0();

    resetGL();
    Math.random = mulberry32(hashStr(def.id));
    const audio = new ScriptedAudio();
    const scope = new GLScope(gl);
    let scene: Scene | null = null;
    let simT = 0;

    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) {
        audio.update(DT);
        simT += DT;
        scene!.frame(simT, DT, audio);
      }
    };

    try {
      scene = scope.track(() => def.create(ctx));
      scope.track(() => scene!.resize(W, H));
      nullBinds = 0;
      counting = true;

      frames(96); // warmup, pattern mode
      await yield0();

      audio.mode = "quiet";
      frames(30);
      const q1 = capture();
      frames(9);
      const q2 = capture();
      audio.fireKick();
      frames(3);
      const k = capture();
      await yield0();

      audio.mode = "pattern";
      // Bracket the timed window with capture() (getImageData) — the only call
      // that verifiably drains the GPU pipe here; finish()/readPixels returned
      // immediately in headless Chrome and reported 0.0 ms for everything. The
      // extra capture cost is a small constant shared by all scenes.
      capture();
      const t0 = performance.now();
      frames(90);
      const l1 = capture();
      r.msPerFrame = (performance.now() - t0) / 90;
      frames(15);
      const l2 = capture();

      counting = false;
      r.directNullBinds = nullBinds;
      r.quietMotion = diff(q1, q2);
      r.kickDelta = diff(q2, k);
      r.loudMotion = diff(l1, l2);
      r.meanLuma = l1.mean;
      r.thumbs = [q2.url, k.url, l1.url];

      const glErr = gl.getError();
      if (glErr !== gl.NO_ERROR) {
        r.status = "error";
        r.notes.push(`GL_ERROR 0x${glErr.toString(16)}`);
      }
      if (l1.mean < 0.015 && k.mean < 0.015) {
        r.status = "error";
        r.notes.push("BLACK: 出力がほぼ真っ黒");
      }
      if (r.status !== "error") {
        if (l1.pctWhite > 0.85) r.notes.push("WHITE: 白飛び面積が85%超");
        if (r.loudMotion < 0.0015) r.notes.push("STATIC: ラウド時のモーションが極小");
        if (r.kickDelta < 0.004 && r.kickDelta < r.quietMotion * 1.5)
          r.notes.push("KICK_WEAK: キック応答が静止ノイズと区別できない");
        if (r.msPerFrame > 33) r.notes.push(`SLOW: ${r.msPerFrame.toFixed(1)}ms/frame`);
        if (r.notes.length) r.status = "warn";
      }
    } catch (e) {
      counting = false;
      r.status = "error";
      r.error = e instanceof Error ? `${e.message}` : String(e);
      r.notes.push("EXCEPTION");
    } finally {
      Math.random = realRandom;
      try {
        scene?.dispose?.();
      } catch {
        /* dispose failures must not stop the run */
      }
      scope.dispose();
    }
    say(`  ${r.status}${r.notes.length ? " — " + r.notes.join(", ") : ""}`);
    await yield0();
  }

  resetGL();
  say("POSTing report…");
  const saved = await postReport(report);
  say(saved ? "report saved → qa-out/" : "report POST failed (dev server plugin?)");
  renderTable(log, report);
  document.title = "QA_DONE";
}

async function postReport(report: QAReport): Promise<boolean> {
  try {
    const res = await fetch("/__qa/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function renderTable(root: HTMLElement, report: QAReport): void {
  const color = { ok: "#4c8", warn: "#fa3", error: "#f55" } as const;
  const rows = report.scenes
    .map(
      (s) => `<tr>
      <td style="color:${color[s.status]}">${s.status.toUpperCase()}</td>
      <td>${s.no} ${s.title}</td>
      <td>${s.thumbs.map((t) => `<img src="${t}" width="120" style="margin-right:4px"/>`).join("")}</td>
      <td>${s.msPerFrame.toFixed(1)}ms · kickΔ ${s.kickDelta.toFixed(4)} · nullBind ${s.directNullBinds}<br/>${s.notes.join("<br/>")}${s.error ? `<br/><span style="color:#f55">${s.error}</span>` : ""}</td>
    </tr>`,
    )
    .join("");
  root.insertAdjacentHTML(
    "beforeend",
    `<table style="border-spacing:8px 6px;margin-top:12px">${rows}</table>`,
  );
}
