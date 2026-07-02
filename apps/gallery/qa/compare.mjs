#!/usr/bin/env node
// Compares two QA reports (e.g. baseline vs after a refactor sweep). The harness
// is deterministic, so an equivalence-preserving change must produce IDENTICAL
// thumbnails; any pixel drift is a behavioural regression.
//
//   node qa/compare.mjs qa-out/baseline.json qa-out/report.json

import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, "utf8")));
let drift = 0;

for (const sa of a.scenes) {
  const sb = b.scenes.find((s) => s.id === sa.id);
  if (!sb) {
    console.log(`✗ ${sa.no} ${sa.title}: 比較先に存在しない`);
    drift++;
    continue;
  }
  const same = sa.thumbs.every((t, i) => t === sb.thumbs[i]);
  const dKick = Math.abs(sa.kickDelta - sb.kickDelta);
  const dLuma = Math.abs(sa.meanLuma - sb.meanLuma);
  const statusChange = sa.status !== sb.status ? ` status ${sa.status}→${sb.status}` : "";
  if (same && !statusChange) {
    console.log(
      `  ${sa.no.padEnd(3)} ${sa.title.padEnd(14)} identical  nullBind ${sa.directNullBinds}→${sb.directNullBinds}`,
    );
  } else {
    drift++;
    console.log(
      `✗ ${sa.no.padEnd(3)} ${sa.title.padEnd(14)} PIXELS ${same ? "same" : "DIFFER"}  ΔkickΔ ${dKick.toFixed(4)}  Δluma ${dLuma.toFixed(4)}  nullBind ${sa.directNullBinds}→${sb.directNullBinds}${statusChange}`,
    );
  }
}
for (const sb of b.scenes)
  if (!a.scenes.some((s) => s.id === sb.id)) console.log(`+ ${sb.no} ${sb.title}: 新規`);

console.log(drift ? `\n${drift} 件のドリフト検出` : "\n全シーン一致");
process.exit(drift ? 1 : 0);
