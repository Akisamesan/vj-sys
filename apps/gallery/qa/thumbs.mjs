#!/usr/bin/env node
// Expands the base64 data-URL thumbs in qa-out/report.json into standalone jpg
// files for visual review. Replaces the one-off Python snippets previously
// written per QA session.
//
//   node qa/thumbs.mjs [--only 08,15-cyclic] [--out <dir>] [reportPath]
//
// --only filters scenes by "no" (e.g. 08) or "id" (e.g. 15-cyclic), comma-separated.
// reportPath and --out default to qa-out/report.json and qa-out/thumbs/, resolved
// relative to this script's location (same convention as qa/run.mjs).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let onlyArg = null;
let outArg = null;
let reportArg = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--only") onlyArg = args[++i];
  else if (a === "--out") outArg = args[++i];
  else reportArg = a;
}

const reportPath = reportArg ? resolve(reportArg) : join(here, "..", "qa-out", "report.json");
const outDir = outArg ? resolve(outArg) : join(here, "..", "qa-out", "thumbs");
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;

if (!existsSync(reportPath)) {
  console.error(`[thumbs] report not found: ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const scenes = only ? report.scenes.filter((s) => only.has(s.no) || only.has(s.id)) : report.scenes;

mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(outDir)) {
  if (name.endsWith(".jpg")) unlinkSync(join(outDir, name));
}

let fileCount = 0;
for (const s of scenes) {
  // A scene that crashed mid-capture may have no thumbs; keep expanding the rest.
  (s.thumbs ?? []).forEach((dataUrl, i) => {
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const file = join(outDir, `${s.no}-${s.title}-${i}.jpg`);
    writeFileSync(file, Buffer.from(b64, "base64"));
    fileCount++;
  });
}

console.log(`[thumbs] ${scenes.length} scenes / ${fileCount} files → ${outDir}`);
