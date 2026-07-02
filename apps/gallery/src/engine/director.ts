// The live director: pure decision logic (no GL) that listens to the audio
// features and decides WHEN to cut (section spikes, drops, bar counts), WHAT
// scene comes next (energy-matched intensity, family/recency avoidance) and HOW
// to transition (long crossfades in breakdowns, glitch/flash cuts at peaks).
// Seeded, so a set can be replayed: same seed + same audio → same decisions.

import type { AudioEngine } from "./audio.ts";
import type { SceneDef } from "./scene.ts";
import type { TransitionKind } from "./mixer.ts";

export type EnergyTier = "low" | "mid" | "high";

export interface TransitionPlan {
  kind: TransitionKind;
  /** Mix window length in beats (0 for a hard cut). */
  beats: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export class Director {
  readonly seed: number;
  private rng: () => number;
  private fast = 0.2;
  private slow = 0.2;
  private lastSpike = -99;
  private lowT = 0;
  private dropArm = 0;
  private history: string[] = [];

  /** Current energy tier (relative to the track's own recent loudness). */
  tier: EnergyTier = "mid";
  /** True while the track sits in a sustained quiet passage. */
  breakdown = false;
  /** One-frame pulse: quiet passage just exploded back (cut NOW, hit hard). */
  drop = false;
  /** One-frame pulse: novelty spike, i.e. the track changed section. */
  section = false;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
  }

  update(t: number, dt: number, audio: AudioEngine): void {
    this.drop = false;
    this.section = false;

    this.fast += (audio.level - this.fast) * (1 - Math.exp(-dt / 1.2));
    this.slow += (audio.level - this.slow) * (1 - Math.exp(-dt / 20));
    const ratio = this.fast / Math.max(this.slow, 0.04);
    this.tier =
      ratio > 1.12 && this.fast > 0.22 ? "high" : ratio < 0.8 || this.fast < 0.1 ? "low" : "mid";

    // Breakdown: sustained low energy with a quiet low end.
    if (this.fast < Math.max(0.1, this.slow * 0.6) && audio.bass < 0.16) this.lowT += dt;
    else this.lowT = 0;
    this.breakdown = this.lowT > 1.6;

    // Drop: shortly after a breakdown ends, a kick lands on a bass surge.
    if (this.breakdown) this.dropArm = 4;
    else this.dropArm = Math.max(0, this.dropArm - dt);
    if (this.dropArm > 0 && !this.breakdown && audio.kick === 1 && audio.bass > 0.4) {
      this.drop = true;
      this.dropArm = 0;
    }

    if (audio.novelty > 2.1 && t - this.lastSpike > 4) {
      this.section = true;
      this.lastSpike = t;
    }
  }

  /** Pick the next scene: avoid recent repeats and the current family, weight by tier fit. */
  pickNext(pool: SceneDef[], current: SceneDef | null): SceneDef {
    const want = this.tier === "high" ? 3 : this.tier === "low" ? 1 : 2;
    const recent = new Set(this.history.slice(-Math.min(8, pool.length >> 1)));
    let c = pool.filter(
      (s) => !recent.has(s.id) && s.id !== current?.id && s.family !== current?.family,
    );
    if (!c.length) c = pool.filter((s) => s.id !== current?.id);
    if (!c.length) c = pool;

    const weights = c.map((s) => {
      const d = Math.abs((s.intensity ?? 2) - want);
      return d === 0 ? 6 : d === 1 ? 2 : 0.4;
    });
    let r = this.rng() * weights.reduce((a, b) => a + b, 0);
    let idx = 0;
    for (; idx < c.length - 1; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    const next = c[idx];
    this.history.push(next.id);
    if (this.history.length > 32) this.history.shift();
    return next;
  }

  /** Choose how the coming cut should feel, given the current energy state. */
  planTransition(): TransitionPlan {
    const r = this.rng();
    if (this.drop) return r < 0.5 ? { kind: "flash", beats: 1 } : { kind: "cut", beats: 0 };
    if (this.breakdown || this.tier === "low") return { kind: "xfade", beats: r < 0.4 ? 8 : 4 };
    if (this.tier === "high") {
      if (r < 0.35) return { kind: "cut", beats: 0 };
      if (r < 0.6) return { kind: "glitch", beats: 1 };
      if (r < 0.8) return { kind: "zoom", beats: 2 };
      return { kind: "flash", beats: 1 };
    }
    if (r < 0.35) return { kind: "luma", beats: 2 };
    if (r < 0.65) return { kind: "xfade", beats: 2 };
    if (r < 0.85) return { kind: "zoom", beats: 2 };
    return { kind: "glitch", beats: 1 };
  }
}
