// The live director: pure decision logic (no GL) that listens to the audio
// features and decides WHEN to cut (section spikes, drops, bar counts), WHAT
// scene comes next (energy-matched intensity, family/recency avoidance) and HOW
// to transition (long crossfades in breakdowns, glitch/flash cuts at peaks).
// It also plans blend-holds: segments where the next scene is layered onto the
// current one full-time (add / screen / luma mask), paired by the QA profile —
// msPerFrame as a load budget so heavyweight scenes never stack, meanLuma to
// favour dark×bright pairs where additive blending shines.
// Seeded, so a set can be replayed: same seed + same audio → same decisions.

import type { AudioEngine } from "./audio.ts";
import type { SceneDef } from "./scene.ts";
import type { TransitionKind, BlendMode } from "./mixer.ts";

export type EnergyTier = "low" | "mid" | "high";

export interface TransitionPlan {
  kind: TransitionKind;
  /** Mix window length in beats (0 for a hard cut). */
  beats: number;
}

/** Per-scene QA metrics (generated into scenes/profile.gen.ts by qa/profile.mjs). */
export interface SceneProfile {
  /** QA msPerFrame — a relative load ranking, not a fullHD prediction. */
  cost: number;
  /** meanLuma of the QA loud capture, 0..1. */
  luma: number;
}

export interface HoldPlan {
  /** Scene layered onto the current one; becomes the next on-air on exit. */
  partner: SceneDef;
  mode: BlendMode;
  /** Render the partner channel at half resolution (pair budget is tight). */
  halfRes: boolean;
  /** Plateau length in beats (ramp-in/out excluded). */
  beats: number;
  /** Baseline blend amount the hold slowly breathes around. */
  base: number;
}

// Load budget in QA msPerFrame units. SOLO_CAP keeps the known heavyweights
// (TERRAIN 27.9 / CLOUDS 24.6) out of any pair; PAIR_BUDGET caps a full-res
// pair, and a half-res partner counts at HALF_COST of its solo cost.
const SOLO_CAP = 8;
const PAIR_BUDGET = 6;
const HALF_COST = 0.45;

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
  private profiles: Record<string, SceneProfile>;
  private fast = 0.2;
  private slow = 0.2;
  private lastSpike = -99;
  private lowT = 0;
  private dropArm = 0;
  private history: string[] = [];
  private bannedPairs = new Set<string>();

  /** Current energy tier (relative to the track's own recent loudness). */
  tier: EnergyTier = "mid";
  /** True while the track sits in a sustained quiet passage. */
  breakdown = false;
  /** One-frame pulse: quiet passage just exploded back (cut NOW, hit hard). */
  drop = false;
  /** One-frame pulse: novelty spike, i.e. the track changed section. */
  section = false;

  constructor(seed: number, profiles: Record<string, SceneProfile> = {}) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.profiles = profiles;
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
    const next = this.weighted(c, weights);
    this.remember(next.id);
    return next;
  }

  private weighted<T>(c: T[], weights: number[]): T {
    let r = this.rng() * weights.reduce((a, b) => a + b, 0);
    let idx = 0;
    for (; idx < c.length - 1; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    return c[idx];
  }

  private remember(id: string): void {
    this.history.push(id);
    if (this.history.length > 32) this.history.shift();
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

  /**
   * Decide whether the segment that just started becomes a blend-hold, and
   * with which partner. Returns null when the dice say no, the current scene
   * is unprofiled/too heavy, or no partner fits the load budget. `force`
   * skips the dice (QA smoke) but never the budget.
   */
  planHold(pool: SceneDef[], current: SceneDef | null, force = false): HoldPlan | null {
    const roll = this.rng(); // always consumed: keeps decision streams replayable
    if (!current) return null;
    const cur = this.profiles[current.id];
    if (!cur || cur.cost > SOLO_CAP) return null;
    const chance = this.tier === "high" ? 0.25 : 0.45;
    if (!force && roll > chance) return null;

    const recent = new Set(this.history.slice(-6));
    const c = pool.filter((s) => {
      if (s.id === current.id || s.family === current.family) return false;
      const p = this.profiles[s.id];
      if (!p || p.cost > SOLO_CAP) return false;
      if (this.bannedPairs.has(pairKey(current.id, s.id))) return false;
      return cur.cost + p.cost * HALF_COST <= PAIR_BUDGET;
    });
    if (!c.length) return null;

    // Dark×bright pairs carry additive blends, so weight by luma contrast.
    const weights = c.map((s) => {
      const w = 0.5 + Math.abs(cur.luma - this.profiles[s.id].luma) * 4;
      return recent.has(s.id) ? w * 0.3 : w;
    });
    const partner = this.weighted(c, weights);
    const prof = this.profiles[partner.id];
    this.remember(partner.id);

    // Direction matters: adding light onto an already-bright base washes the
    // frame out, so add/screen want a dark base and a brighter partner, while
    // a bright base is better replaced through the partner's luma mask.
    const dLuma = prof.luma - cur.luma;
    const wash = cur.luma + prof.luma > 0.6 ? 0.25 : 1;
    const mode = this.weighted<BlendMode>(
      ["add", "screen", "lumaMask"],
      [
        (0.5 + Math.max(0, dLuma) * 5) * wash,
        (0.4 + Math.max(0, dLuma) * 2) * wash,
        0.5 + Math.max(0, cur.luma - 0.2) * 3,
      ],
    );

    return {
      partner,
      mode,
      halfRes: cur.cost + prof.cost > PAIR_BUDGET,
      beats: this.rng() < (this.tier === "high" ? 0.7 : 0.4) ? 16 : 32,
      base: 0.45 + this.rng() * 0.25,
    };
  }

  /** Session blacklist fed by the live FPS guard when a pair missed 60fps. */
  banHoldPair(a: string, b: string): void {
    this.bannedPairs.add(pairKey(a, b));
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
