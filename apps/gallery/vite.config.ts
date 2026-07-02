// Gallery app config. The qaReport plugin receives the in-page QA harness's
// results (?qa=all posts to /__qa/report) and writes qa-out/report.json plus a
// human-friendly contact sheet qa-out/sheet.html. qa/run.mjs drives this headless.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

interface SheetScene {
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
  thumbs: string[];
  error?: string;
}

interface SheetReport {
  ts: string;
  ua: string;
  w: number;
  h: number;
  scenes: SheetScene[];
}

function renderSheet(r: SheetReport): string {
  const color = { ok: "#4c8", warn: "#fa3", error: "#f55" };
  const cards = r.scenes
    .map(
      (s) => `<div class="card ${s.status}">
      <div class="head"><b>${s.no} ${s.title}</b> <span class="fam">${s.family}</span>
        <span class="st" style="color:${color[s.status]}">${s.status.toUpperCase()}</span></div>
      <div class="thumbs">${s.thumbs.map((t, i) => `<figure><img src="${t}"/><figcaption>${["quiet", "kick", "loud"][i]}</figcaption></figure>`).join("")}</div>
      <div class="m">${s.msPerFrame.toFixed(1)}ms/f · kickΔ ${s.kickDelta.toFixed(4)} · motion ${s.loudMotion.toFixed(4)} · luma ${s.meanLuma.toFixed(3)} · nullBind ${s.directNullBinds}</div>
      ${s.notes.length ? `<div class="n">${s.notes.join("<br/>")}</div>` : ""}
      ${s.error ? `<div class="e">${s.error}</div>` : ""}
    </div>`,
    )
    .join("");
  const counts = { ok: 0, warn: 0, error: 0 };
  for (const s of r.scenes) counts[s.status]++;
  return `<!doctype html><meta charset="utf-8"/><title>VJ QA sheet</title>
<style>
 body{background:#0b0d10;color:#cdd;font:13px/1.5 ui-monospace,monospace;padding:20px}
 .sum{margin-bottom:16px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px}
 .card{border:1px solid #223;border-radius:8px;padding:10px;background:#11151a}
 .card.error{border-color:#833} .card.warn{border-color:#763}
 .head{display:flex;gap:8px;align-items:baseline} .fam{color:#578;font-size:11px}
 .st{margin-left:auto;font-weight:700}
 .thumbs{display:flex;gap:6px;margin:8px 0} figure{margin:0} img{width:100%;display:block;border-radius:4px}
 figcaption{color:#567;font-size:10px;text-align:center}
 .m{color:#89a;font-size:11px} .n{color:#fa3;margin-top:4px} .e{color:#f55;margin-top:4px}
</style>
<div class="sum"><h2 style="margin:0">QA ${r.ts}</h2>
 ${r.scenes.length} scenes — <span style="color:#4c8">${counts.ok} ok</span> ·
 <span style="color:#fa3">${counts.warn} warn</span> · <span style="color:#f55">${counts.error} error</span>
 · ${r.w}x${r.h} · ${r.ua}</div>
<div class="grid">${cards}</div>`;
}

interface LiveSmoke {
  seed: number;
  shots: Array<{ t: number; dataUrl: string }>;
  transitions: Array<{ t: number; kind: string; beats: number; from: string; to: string }>;
}

function qaReport(): Plugin {
  return {
    name: "vj-qa-report",
    configureServer(server) {
      // Live-mode smoke test: canvas shots + the director's transition log.
      server.middlewares.use("/__qa/live", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as LiveSmoke;
            const dir = join(server.config.root, "qa-out");
            mkdirSync(dir, { recursive: true });
            for (const s of body.shots)
              writeFileSync(
                join(dir, `live-${s.t}s.jpg`),
                Buffer.from(s.dataUrl.split(",")[1], "base64"),
              );
            writeFileSync(
              join(dir, "live-report.json"),
              JSON.stringify({ seed: body.seed, transitions: body.transitions }, null, 1),
            );
            res.setHeader("content-type", "application/json");
            res.end('{"ok":true}');
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
      server.middlewares.use("/__qa/report", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SheetReport;
            const dir = join(server.config.root, "qa-out");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "report.json"), JSON.stringify(body, null, 1));
            writeFileSync(join(dir, "sheet.html"), renderSheet(body));
            res.setHeader("content-type", "application/json");
            res.end('{"ok":true}');
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [qaReport()],
});
