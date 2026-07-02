#!/usr/bin/env node
// Headless QA runner. Opens ?qa=<spec> in headless Chrome against a running dev
// server, waits for qa-out/report.json to be freshly written by the vite plugin,
// then prints a summary table. Exits 1 if any scene reports status "error".
//
//   node qa/run.mjs [baseURL] [spec]
//   node qa/run.mjs http://localhost:5173/ all

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const reportPath = join(here, "..", "qa-out", "report.json");
const base = process.argv[2] ?? "http://localhost:5173/";
const spec = process.argv[3] ?? "all";
const url = `${base}${base.includes("?") ? "&" : "?"}qa=${spec}`;

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

rmSync(reportPath, { force: true });
const profile = mkdtempSync(join(tmpdir(), "vj-qa-chrome-"));

console.log(`[qa] ${url}`);
const child = spawn(
  chrome,
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--hide-scrollbars",
    "--window-size=900,560",
    "--enable-unsafe-swiftshader",
    url,
  ],
  { stdio: "ignore" },
);

const t0 = Date.now();
const timeoutMs = 15 * 60 * 1000;
const poll = setInterval(() => {
  if (existsSync(reportPath)) {
    clearInterval(poll);
    child.kill("SIGKILL");
    finish();
  } else if (Date.now() - t0 > timeoutMs || child.exitCode !== null) {
    clearInterval(poll);
    child.kill("SIGKILL");
    console.error(
      child.exitCode !== null
        ? `[qa] chrome exited early (code ${child.exitCode}) without a report`
        : "[qa] timeout waiting for qa-out/report.json",
    );
    process.exit(2);
  }
}, 400);

function finish() {
  const r = JSON.parse(readFileSync(reportPath, "utf8"));
  const counts = { ok: 0, warn: 0, error: 0 };
  for (const s of r.scenes) {
    counts[s.status]++;
    const flag = s.status === "ok" ? " " : s.status === "warn" ? "!" : "✗";
    console.log(
      `${flag} ${s.no.padEnd(3)} ${s.title.padEnd(14)} ${s.msPerFrame.toFixed(1).padStart(6)}ms  kickΔ ${s.kickDelta.toFixed(4)}  nullBind ${String(s.directNullBinds).padStart(3)}  ${s.notes.join(", ")}${s.error ? "  ERR: " + s.error : ""}`,
    );
  }
  console.log(
    `[qa] ${r.scenes.length} scenes — ok ${counts.ok} / warn ${counts.warn} / error ${counts.error} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  );
  console.log(`[qa] sheet: ${join(here, "..", "qa-out", "sheet.html")}`);
  try {
    execSync(`rm -rf "${profile}"`);
  } catch {}
  process.exit(counts.error ? 1 : 0);
}
