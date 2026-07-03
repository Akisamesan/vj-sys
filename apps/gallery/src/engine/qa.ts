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

// ---- 視認性/スケール指標(240×135 luma 上で計算、描画結果には影響しない) ----
// 判定は loud フレーム固定。kick フラッシュの微弱ノイズが coverage を飽和させ、
// 正例(41 TORUS 等)が逃げることが較正ランで判明したため「良い方」判定はしない。
// 閾値は 2026-07 の全シーン較正ラン(#8/#11)の分布から確定。再較正するときは
// report.json の visLoud/visKick バッテリーの分布を見る。
const BRIGHT_LUMA = 0.15; // これを超える画素を「明部」とみなす(coverage/blob の床)
const EDGE_GRAD_MIN = 0.12; // edgeDensity: Sobel 勾配ノルムがこれを超えたらエッジ画素
const HF_BLOCK = 8; // hfRatio: ブロック分散のブロックサイズ
// LOW_VIS 節A: 明部が極端に少ない(正例 41、次点の健全シーンは 0.06)
const LOW_VIS_COVERAGE = 0.02;
// LOW_VIS 節B: 単一の薄い塊が明部を支配し、かつ画面の 1/4 未満(正例 38/78。
// rms は 23 METABALLS の 0.195、coverage は 20 MANDELBULB の 0.296 が最近傍の健全値)
const LOW_VIS_BLOB_COVERAGE = 0.25;
const LOW_VIS_BLOB_RMS = 0.175;
const LOW_VIS_BLOB_DOMINANCE = 0.75;
// OVERSCALE: ほぼ全面が明るく、輪郭はあるがディテールがない(正例 24 GYROID。
// edge 上限は 32 VORONOI の 0.373、下限は 25 CLOUDS の 0.025 と区別する)
const OVERSCALE_COVERAGE = 0.85;
const OVERSCALE_EDGE_MIN = 0.1;
const OVERSCALE_EDGE_MAX = 0.3;
const OVERSCALE_HF = 0.15;
// 眩しさ: 白飛び画素率(正例 39 GABOR 0.225、次点の健全シーンは 0.074)
const WHITE_PCT = 0.18;
// 重さ: headless SwiftShader 実測(正例 22/25 は 25〜28ms、健全最大は 3.5ms)
const SLOW_MS = 15;

interface Capture {
  luma: Float32Array;
  mean: number;
  pctWhite: number;
  url: string;
}

interface VisMetrics {
  rmsContrast: number;
  coverage: number;
  edgeDensity: number;
  hfRatio: number;
  /** 較正用の候補指標(閾値確定後に不要なら削除する) */
  cov06: number;
  cov15: number;
  cov30: number;
  p99: number;
  tileOcc: number;
  spreadX: number;
  spreadY: number;
  lapMean: number;
  blobCount: number;
  meanBlobPx: number;
  maxBlobFrac: number;
}

function visMetrics(luma: Float32Array): VisMetrics {
  const n = luma.length;
  let sum = 0;
  let sumSq = 0;
  let cov06 = 0;
  let cov15 = 0;
  let cov30 = 0;
  for (let i = 0; i < n; i++) {
    const l = luma[i];
    sum += l;
    sumSq += l * l;
    if (l > 0.06) cov06++;
    if (l > BRIGHT_LUMA) cov15++;
    if (l > 0.3) cov30++;
  }
  const mean = sum / n;
  const variance = Math.max(sumSq / n - mean * mean, 0);
  const sorted = Float32Array.from(luma).sort();
  const p99 = sorted[Math.floor(n * 0.99)];

  let edges = 0;
  let lapSum = 0;
  for (let y = 1; y < TH - 1; y++) {
    for (let x = 1; x < TW - 1; x++) {
      const i = y * TW + x;
      const gx =
        luma[i - TW + 1] +
        2 * luma[i + 1] +
        luma[i + TW + 1] -
        luma[i - TW - 1] -
        2 * luma[i - 1] -
        luma[i + TW - 1];
      const gy =
        luma[i + TW - 1] +
        2 * luma[i + TW] +
        luma[i + TW + 1] -
        luma[i - TW - 1] -
        2 * luma[i - TW] -
        luma[i - TW + 1];
      if (gx * gx + gy * gy > EDGE_GRAD_MIN * EDGE_GRAD_MIN) edges++;
      lapSum += Math.abs(luma[i - TW] + luma[i + TW] + luma[i - 1] + luma[i + 1] - 4 * luma[i]);
    }
  }

  let blockVarSum = 0;
  let blocks = 0;
  const bn = HF_BLOCK * HF_BLOCK;
  for (let by = 0; by + HF_BLOCK <= TH; by += HF_BLOCK) {
    for (let bx = 0; bx + HF_BLOCK <= TW; bx += HF_BLOCK) {
      let s = 0;
      let s2 = 0;
      for (let y = 0; y < HF_BLOCK; y++) {
        for (let x = 0; x < HF_BLOCK; x++) {
          const l = luma[(by + y) * TW + bx + x];
          s += l;
          s2 += l * l;
        }
      }
      const bm = s / bn;
      blockVarSum += Math.max(s2 / bn - bm * bm, 0);
      blocks++;
    }
  }

  // 明部(>0.15)の空間統計: 15×15pxタイル被覆率と重心まわりの正規化分散。
  const TILE = 15;
  const tw = Math.floor(TW / TILE);
  const th = Math.floor(TH / TILE);
  const tiles = new Uint8Array(tw * th);
  let bx0 = 0;
  let by0 = 0;
  let bx2 = 0;
  let by2 = 0;
  let bright = 0;
  for (let y = 0; y < TH; y++) {
    for (let x = 0; x < TW; x++) {
      if (luma[y * TW + x] > BRIGHT_LUMA) {
        bright++;
        const nx = x / TW;
        const ny = y / TH;
        bx0 += nx;
        by0 += ny;
        bx2 += nx * nx;
        by2 += ny * ny;
        const tx = Math.min(Math.floor(x / TILE), tw - 1);
        const ty = Math.min(Math.floor(y / TILE), th - 1);
        tiles[ty * tw + tx] = 1;
      }
    }
  }
  let occ = 0;
  for (let i = 0; i < tiles.length; i++) occ += tiles[i];
  const mx = bright ? bx0 / bright : 0.5;
  const my = bright ? by0 / bright : 0.5;

  // 明部(>0.15)の連結成分(4近傍)。構造の「かたまり」サイズを測る。
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  let blobCount = 0;
  let maxBlob = 0;
  for (let i = 0; i < n; i++) {
    if (luma[i] <= BRIGHT_LUMA || label[i]) continue;
    blobCount++;
    let size = 0;
    let sp = 0;
    stack[sp++] = i;
    label[i] = blobCount;
    while (sp > 0) {
      const j = stack[--sp];
      size++;
      const x = j % TW;
      if (x > 0 && luma[j - 1] > BRIGHT_LUMA && !label[j - 1]) {
        label[j - 1] = blobCount;
        stack[sp++] = j - 1;
      }
      if (x < TW - 1 && luma[j + 1] > BRIGHT_LUMA && !label[j + 1]) {
        label[j + 1] = blobCount;
        stack[sp++] = j + 1;
      }
      if (j >= TW && luma[j - TW] > BRIGHT_LUMA && !label[j - TW]) {
        label[j - TW] = blobCount;
        stack[sp++] = j - TW;
      }
      if (j < n - TW && luma[j + TW] > BRIGHT_LUMA && !label[j + TW]) {
        label[j + TW] = blobCount;
        stack[sp++] = j + TW;
      }
    }
    if (size > maxBlob) maxBlob = size;
  }

  return {
    rmsContrast: Math.sqrt(variance),
    coverage: cov15 / n,
    edgeDensity: edges / ((TW - 2) * (TH - 2)),
    hfRatio: variance > 1e-6 ? blockVarSum / blocks / variance : 0,
    cov06: cov06 / n,
    cov15: cov15 / n,
    cov30: cov30 / n,
    p99,
    tileOcc: occ / tiles.length,
    spreadX: bright ? Math.sqrt(Math.max(bx2 / bright - mx * mx, 0)) : 0,
    spreadY: bright ? Math.sqrt(Math.max(by2 / bright - my * my, 0)) : 0,
    lapMean: lapSum / ((TW - 2) * (TH - 2)),
    blobCount,
    meanBlobPx: blobCount ? bright / blobCount : 0,
    maxBlobFrac: bright ? maxBlob / bright : 0,
  };
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
  /** loud フレームの白飛び画素率 */
  pctWhite: number;
  /** kick フラッシュの輝度ジャンプ(kick平均 - quiet平均) */
  flashJump: number;
  rmsContrast: number;
  coverage: number;
  edgeDensity: number;
  hfRatio: number;
  /** 単一の薄い塊が明部に占める割合(LOW_VIS 節Bの判定材料) */
  maxBlobFrac: number;
  /** 較正用: loud/kick 両フレームの生指標バッテリー(再較正時に分布を見る) */
  visKick?: VisMetrics;
  visLoud?: VisMetrics;
  /** dataURLs: quiet / kick / loud */
  thumbs: string[];
  /** Macro sweep dataURLs (scenes exposing macros.seed): seed 0.2 / 0.5 / 0.8. */
  macroThumbs?: string[];
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
      pctWhite: 0,
      flashJump: 0,
      rmsContrast: 0,
      coverage: 0,
      edgeDensity: 0,
      hfRatio: 0,
      maxBlobFrac: 0,
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
      r.pctWhite = l1.pctWhite;
      r.flashJump = k.mean - q2.mean;
      r.thumbs = [q2.url, k.url, l1.url];

      // 視認性/スケール指標は loud フレームで判定する(冒頭の定数コメント参照)。
      const mL = visMetrics(l1.luma);
      r.visKick = visMetrics(k.luma);
      r.visLoud = mL;
      r.rmsContrast = mL.rmsContrast;
      r.coverage = mL.coverage;
      r.edgeDensity = mL.edgeDensity;
      r.hfRatio = mL.hfRatio;
      r.maxBlobFrac = mL.maxBlobFrac;

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
        if (l1.pctWhite > WHITE_PCT)
          r.notes.push(`WHITE: 白飛び画素が${(l1.pctWhite * 100).toFixed(0)}%で眩しい`);
        if (r.loudMotion < 0.0015) r.notes.push("STATIC: ラウド時のモーションが極小");
        if (r.kickDelta < 0.004 && r.kickDelta < r.quietMotion * 1.5)
          r.notes.push("KICK_WEAK: キック応答が静止ノイズと区別できない");
        if (r.msPerFrame > SLOW_MS) r.notes.push(`SLOW: ${r.msPerFrame.toFixed(1)}ms/frame`);
        if (
          r.coverage < LOW_VIS_COVERAGE ||
          (r.coverage < LOW_VIS_BLOB_COVERAGE &&
            r.rmsContrast < LOW_VIS_BLOB_RMS &&
            r.maxBlobFrac > LOW_VIS_BLOB_DOMINANCE)
        )
          r.notes.push("LOW_VIS: 画面に対して要素が小さい/薄い");
        else if (
          r.coverage > OVERSCALE_COVERAGE &&
          r.edgeDensity >= OVERSCALE_EDGE_MIN &&
          r.edgeDensity < OVERSCALE_EDGE_MAX &&
          r.hfRatio < OVERSCALE_HF
        )
          r.notes.push("OVERSCALE: 拡大されすぎで構造が見えない");
        if (r.notes.length) r.status = "warn";
      }

      // Macro sweep: scenes exposing macros.seed render three faces for the
      // sheet. Runs after all metric captures, so thumbs/metrics above stay
      // bit-identical to a build without the sweep. Re-rendering at the same
      // sim time isolates the seed effect from plain motion, so a small
      // absolute threshold detects a dead macro reliably.
      const setSeed = scene.macros?.seed;
      if (setSeed) {
        const face = (v: number): Capture => {
          setSeed(v);
          scene!.frame(simT, DT, audio);
          return capture();
        };
        const sweep = [0.2, 0.5, 0.8].map(face);
        r.macroThumbs = sweep.map((c) => c.url);
        if (
          r.status !== "error" &&
          diff(sweep[0], sweep[1]) < 0.004 &&
          diff(sweep[1], sweep[2]) < 0.004
        ) {
          r.notes.push("MACRO_DEAD: seed 掃引で画が変わらない");
          r.status = "warn";
        }
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
      <td>${s.thumbs.map((t) => `<img src="${t}" width="120" style="margin-right:4px"/>`).join("")}${
        s.macroThumbs
          ? `<br/>${s.macroThumbs.map((t) => `<img src="${t}" width="120" style="margin-right:4px"/>`).join("")}`
          : ""
      }</td>
      <td>${s.msPerFrame.toFixed(1)}ms · kickΔ ${s.kickDelta.toFixed(4)} · nullBind ${s.directNullBinds}<br/>cov ${s.coverage.toFixed(3)} · rms ${s.rmsContrast.toFixed(3)} · edge ${s.edgeDensity.toFixed(3)} · hf ${s.hfRatio.toFixed(2)} · blob ${s.maxBlobFrac.toFixed(2)}<br/>${s.notes.join("<br/>")}${s.error ? `<br/><span style="color:#f55">${s.error}</span>` : ""}</td>
    </tr>`,
    )
    .join("");
  root.insertAdjacentHTML(
    "beforeend",
    `<table style="border-spacing:8px 6px;margin-top:12px">${rows}</table>`,
  );
}
