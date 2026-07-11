#!/usr/bin/env node
// Headless Hap-codec export. Renders scene(s) with the deterministic ScriptedAudio
// feed against a running dev server (?render=<id>, see src/engine/render.ts),
// collects the PNG frame sequence the dev-server plugin writes to
// qa-out/render/<id>/, then pipes it through ffmpeg into a looping Hap .mov —
// VJ material for external software (Resolume, Modul8, CoGe, ...).
//
// Requires ffmpeg with the "hap" encoder (ffmpeg -encoders | grep hap).
//
//   node qa/render.mjs [baseURL] <id>[,<id>...] [--secs 8] [--fps 30] [--w 960] [--h 540] [--format hap_q]
//   node qa/render.mjs http://localhost:5199/ 02-reaction,31-plasma --secs 6

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let base = "http://localhost:5173/";
let spec = null;
let secs = 8;
let fps = 30;
let w = 960;
let h = 540;
let format = "hap_q"; // hap (DXT1, no alpha, smallest) | hap_alpha (DXT5) | hap_q (DXT5-YCoCg, best quality)

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--secs") secs = Number(args[++i]);
  else if (a === "--fps") fps = Number(args[++i]);
  else if (a === "--w") w = Number(args[++i]);
  else if (a === "--h") h = Number(args[++i]);
  else if (a === "--format") format = args[++i];
  else if (a.startsWith("http")) base = a;
  else spec = a;
}
if (!spec) {
  console.error(
    "usage: node qa/render.mjs [baseURL] <id>[,<id>...] [--secs 8] [--fps 30] [--w 960] [--h 540] [--format hap_q]",
  );
  process.exit(1);
}

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = join(root, "qa-out", "hap");
mkdirSync(outDir, { recursive: true });

const ids = spec.split(",").map((s) => s.trim());
let failed = 0;
for (const id of ids) {
  try {
    await renderOne(id);
  } catch (e) {
    console.error(`[render] ${id} failed: ${e.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);

async function renderOne(id) {
  const frameDir = join(root, "qa-out", "render", id);
  rmSync(frameDir, { recursive: true, force: true });
  const url = `${base}${base.includes("?") ? "&" : "?"}render=${encodeURIComponent(id)}&secs=${secs}&fps=${fps}&w=${w}&h=${h}`;
  console.log(`[render] ${id}: ${url}`);

  const profile = mkdtempSync(join(tmpdir(), "vj-render-chrome-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--hide-scrollbars",
      `--window-size=${w},${h}`,
      "--enable-unsafe-swiftshader",
      ...(process.env.CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
      url,
    ],
    { stdio: "ignore" },
  );

  const metaPath = join(frameDir, "meta.json");
  const t0 = Date.now();
  const timeoutMs = Math.max(60_000, secs * fps * 2000); // generous: 2s wall-clock budget/frame
  try {
    await new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        if (existsSync(metaPath)) {
          clearInterval(poll);
          child.kill("SIGKILL");
          resolve();
        } else if (Date.now() - t0 > timeoutMs || child.exitCode !== null) {
          clearInterval(poll);
          child.kill("SIGKILL");
          reject(
            new Error(
              child.exitCode !== null
                ? `chrome exited early (code ${child.exitCode}) without meta.json`
                : "timeout waiting for meta.json",
            ),
          );
        }
      }, 400);
    });
  } finally {
    try {
      execSync(`rm -rf "${profile}"`);
    } catch {
      /* best-effort cleanup */
    }
  }

  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const pngCount = readdirSync(frameDir).filter((f) => f.endsWith(".png")).length;
  if (pngCount !== meta.frames)
    throw new Error(`frame count mismatch: got ${pngCount} PNGs, expected ${meta.frames}`);

  const out = join(outDir, `${id}.mov`);
  console.log(`[render] ${id}: encoding ${pngCount} frames → ${out} (${format})`);
  execSync(
    `ffmpeg -y -hide_banner -loglevel warning -framerate ${meta.fps} -start_number 0 ` +
      `-i "${join(frameDir, "frame-%06d.png")}" -c:v hap -format ${format} -pix_fmt rgba "${out}"`,
    { stdio: "inherit" },
  );
  console.log(`[render] ${id}: done → ${out}`);
}
