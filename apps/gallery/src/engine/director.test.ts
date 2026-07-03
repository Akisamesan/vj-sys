// planHold is pure, seeded logic — verify the load-budget / pairing invariants
// that keep heavyweight scenes out of blend-holds (the 60fps acceptance bar).

import { describe, expect, it } from "vitest";
import { Director } from "./director.ts";
import type { SceneProfile } from "./director.ts";
import type { SceneDef } from "./scene.ts";

function def(id: string, family: string): SceneDef {
  return { id, no: id.slice(0, 2), title: id, blurb: "", family };
}

// Costs mirror the real QA report's shape: mostly cheap, two mid raymarchers
// whose full-res sum busts PAIR_BUDGET (6), one TERRAIN-class heavyweight.
const PROFILES: Record<string, SceneProfile> = {
  "01-dark": { cost: 0.5, luma: 0.05 },
  "02-bright": { cost: 0.5, luma: 0.35 },
  "03-mid": { cost: 3.0, luma: 0.2 },
  "04-heavy": { cost: 27.9, luma: 0.16 },
  "05-midheavy": { cost: 3.4, luma: 0.13 },
};

const DARK = def("01-dark", "a");
const BRIGHT = def("02-bright", "b");
const MID = def("03-mid", "c");
const HEAVY = def("04-heavy", "d");
const MIDHEAVY = def("05-midheavy", "e");
const POOL = [DARK, BRIGHT, MID, HEAVY, MIDHEAVY];

describe("Director.planHold", () => {
  it("重量級シーンが on-air のときは force でも hold しない", () => {
    const d = new Director(1, PROFILES);
    expect(d.planHold(POOL, HEAVY, true)).toBeNull();
  });

  it("未計測シーンは on-air でもパートナーでも対象外", () => {
    const d = new Director(1, PROFILES);
    expect(d.planHold(POOL, def("99-unknown", "z"), true)).toBeNull();
    expect(d.planHold([def("98-unknown", "y")], DARK, true)).toBeNull();
  });

  it("重量級シーンをパートナーに選ばない・同 family も組まない", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const d = new Director(seed, PROFILES);
      const plan = d.planHold(POOL, DARK, true);
      expect(plan).not.toBeNull();
      expect(plan!.partner.id).not.toBe("04-heavy");
      expect(plan!.partner.family).not.toBe(DARK.family);
    }
  });

  it("ペア予算を超える中量級ペアは半解像度に落ちる", () => {
    const d = new Director(7, PROFILES);
    const plan = d.planHold([MID, MIDHEAVY], MID, true);
    expect(plan).not.toBeNull();
    expect(plan!.partner.id).toBe("05-midheavy");
    expect(plan!.halfRes).toBe(true); // 3.0 + 3.4 > 6, half-res で許容
    expect(["add", "screen", "lumaMask"]).toContain(plan!.mode);
    expect([16, 32]).toContain(plan!.beats);
    expect(plan!.base).toBeGreaterThanOrEqual(0.45);
    expect(plan!.base).toBeLessThanOrEqual(0.7);
  });

  it("軽量ペアはフル解像度のまま", () => {
    const d = new Director(7, PROFILES);
    const plan = d.planHold([DARK, BRIGHT], DARK, true);
    expect(plan).not.toBeNull();
    expect(plan!.halfRes).toBe(false);
  });

  it("banHoldPair したペアは以後選ばれない", () => {
    const d = new Director(3, PROFILES);
    d.banHoldPair("01-dark", "02-bright");
    expect(d.planHold([DARK, BRIGHT], DARK, true)).toBeNull();
  });

  it("明るいベースには光を足さず lumaMask を主に選ぶ(白飛び回避)", () => {
    const profiles: Record<string, SceneProfile> = {
      "10-brightbase": { cost: 0, luma: 0.56 },
      "11-partner": { cost: 0.1, luma: 0.21 },
    };
    const base = def("10-brightbase", "a");
    const partner = def("11-partner", "b");
    let mask = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const d = new Director(seed, profiles);
      const plan = d.planHold([base, partner], base, true);
      if (plan!.mode === "lumaMask") mask++;
    }
    expect(mask).toBeGreaterThan(70);
  });

  it("暗×明のコントラストが大きいパートナーを優先する", () => {
    let bright = 0;
    let mid = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const d = new Director(seed, PROFILES);
      const plan = d.planHold([DARK, BRIGHT, MID], DARK, true);
      if (plan!.partner.id === "02-bright") bright++;
      else mid++;
    }
    expect(bright).toBeGreaterThan(mid);
  });

  it("同じ seed なら同じ計画(リプレイ可能)", () => {
    const a = new Director(42, PROFILES).planHold(POOL, DARK, true);
    const b = new Director(42, PROFILES).planHold(POOL, DARK, true);
    expect(a).toEqual(b);
  });
});
