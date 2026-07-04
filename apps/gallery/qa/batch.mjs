#!/usr/bin/env node
// Batch QA orchestrator: bundles the four manual steps of a QA sweep
// (run → baseline compare → thumbnail export → recap) into one command.
//
//   node qa/batch.mjs <baseURL> <spec>
//   node qa/batch.mjs http://localhost:5173/ 13-life

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const qaOut = join(here, "..", "qa-out");
const baselinePath = join(qaOut, "baseline.json");
const reportPath = join(qaOut, "report.json");

function run(script, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
}

// Forward argv as-is so defaults (baseURL, spec) stay identical to qa/run.mjs.
const runArgs = process.argv.slice(2);

const runCode = await run(join(here, "run.mjs"), runArgs);
if (runCode !== 0) process.exit(runCode);

if (existsSync(baselinePath)) {
  // Compare only on a full sweep: a partial spec (the common case when QA'ing a
  // new batch) would report every unswept baseline scene as a false drift.
  const baselineCount = JSON.parse(readFileSync(baselinePath, "utf8")).scenes.length;
  const reportCount = JSON.parse(readFileSync(reportPath, "utf8")).scenes.length;
  if (reportCount >= baselineCount) {
    // Drift detection exits non-zero on purpose; keep going, just show its output.
    await run(join(here, "compare.mjs"), [baselinePath, reportPath]);
  } else {
    console.log(`[batch] partial sweep (${reportCount}/${baselineCount} scenes) — compare skipped`);
  }
}

await run(join(here, "thumbs.mjs"), []);

console.log(`[batch] sheet: ${join(qaOut, "sheet.html")}`);
console.log(`[batch] thumbs: ${join(qaOut, "thumbs")}`);

process.exit(runCode);
