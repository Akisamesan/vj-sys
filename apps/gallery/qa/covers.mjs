#!/usr/bin/env node
// Turns qa-out/report.json (produced by `node qa/run.mjs`) into the static cover
// images the gallery index uses as card thumbnails. Picks the "loud" capture
// (thumbs[2]) — the QA harness's brightest, most-motion frame — as the single
// representative frame per scene, and writes it to public/covers/<id>.jpg.
//
// Re-run this after any change that alters a scene's visuals so its cover stays
// in sync: node qa/run.mjs && node qa/covers.mjs
//
//   node qa/covers.mjs [reportPath] [--out <dir>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let outArg = null;
let reportArg = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") outArg = args[++i];
  else reportArg = a;
}

const reportPath = reportArg ? resolve(reportArg) : join(here, "..", "qa-out", "report.json");
const outDir = outArg ? resolve(outArg) : join(here, "..", "public", "covers");

if (!existsSync(reportPath)) {
  console.error(`[covers] report not found: ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));

mkdirSync(outDir, { recursive: true });

let written = 0;
let skipped = 0;
for (const s of report.scenes) {
  const dataUrl = s.thumbs?.[2];
  if (!dataUrl) {
    skipped++;
    continue;
  }
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  writeFileSync(join(outDir, `${s.id}.jpg`), Buffer.from(b64, "base64"));
  written++;
}

console.log(`[covers] ${written} covers written, ${skipped} skipped (no capture) → ${outDir}`);
