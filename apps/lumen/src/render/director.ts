import { perspective, lookAt, multiply } from "../math/mat4.ts";
import type { Mat4, Vec3 } from "../math/mat4.ts";
import type { AudioEngine } from "../audio/engine.ts";

// A "regime" is a complete visual configuration: field behaviour + palette + post.
// Novelty spikes (big musical changes) advance to the next regime, and every value
// is eased so transitions glide rather than cut.

export interface Regime {
  name: string;
  fieldScale: number;
  flowSpeed: number;
  curl: number;
  swirl: number;
  damp: number;
  baseR: number;
  radiusGain: number;
  height: number;
  decay: number; // trail persistence
  pointScale: number;
  exposure: number;
  bloomAmt: number;
  vignette: number;
  palA: Vec3;
  palB: Vec3;
  palC: Vec3;
  palD: Vec3;
}

const REGIMES: Regime[] = [
  {
    name: "NEBULA",
    fieldScale: 0.35,
    flowSpeed: 0.5,
    curl: 1.1,
    swirl: 1.0,
    damp: 1.4,
    baseR: 2.0,
    radiusGain: 2.6,
    height: 4.6,
    decay: 0.84,
    pointScale: 3.2,
    exposure: 0.95,
    bloomAmt: 0.6,
    vignette: 1.0,
    palA: [0.5, 0.5, 0.55],
    palB: [0.5, 0.45, 0.5],
    palC: [1.0, 1.0, 1.0],
    palD: [0.55, 0.35, 0.18],
  },
  {
    name: "PLASMA",
    fieldScale: 0.6,
    flowSpeed: 0.9,
    curl: 1.8,
    swirl: 1.7,
    damp: 1.1,
    baseR: 1.6,
    radiusGain: 3.2,
    height: 3.4,
    decay: 0.87,
    pointScale: 2.6,
    exposure: 1.0,
    bloomAmt: 0.75,
    vignette: 1.15,
    palA: [0.6, 0.35, 0.4],
    palB: [0.5, 0.45, 0.45],
    palC: [1.0, 1.2, 0.7],
    palD: [0.0, 0.25, 0.55],
  },
  {
    name: "AURORA",
    fieldScale: 0.28,
    flowSpeed: 0.35,
    curl: 0.9,
    swirl: 0.7,
    damp: 1.7,
    baseR: 2.4,
    radiusGain: 2.2,
    height: 5.6,
    decay: 0.89,
    pointScale: 3.6,
    exposure: 0.92,
    bloomAmt: 0.65,
    vignette: 0.9,
    palA: [0.35, 0.5, 0.45],
    palB: [0.4, 0.45, 0.4],
    palC: [0.8, 1.0, 1.1],
    palD: [0.5, 0.55, 0.65],
  },
  {
    name: "EMBER",
    fieldScale: 0.5,
    flowSpeed: 0.7,
    curl: 1.4,
    swirl: 1.3,
    damp: 1.25,
    baseR: 1.8,
    radiusGain: 3.0,
    height: 3.0,
    decay: 0.84,
    pointScale: 2.8,
    exposure: 1.05,
    bloomAmt: 0.8,
    vignette: 1.2,
    palA: [0.6, 0.4, 0.3],
    palB: [0.55, 0.4, 0.25],
    palC: [1.1, 0.9, 0.6],
    palD: [0.1, 0.18, 0.32],
  },
];

export class Director {
  private idx = 0;
  private lastSwitch = 0;
  readonly cur: Regime;

  constructor() {
    this.cur = structuredClone(REGIMES[0]);
  }

  get name(): string {
    return REGIMES[this.idx].name;
  }
  get index(): number {
    return this.idx;
  }

  next(t: number): void {
    this.idx = (this.idx + 1) % REGIMES.length;
    this.lastSwitch = t;
  }

  update(dt: number, audio: AudioEngine, t: number): void {
    if (audio.running && audio.novelty > 2.2 && t - this.lastSwitch > 4.0) this.next(t);
    const target = REGIMES[this.idx];
    const k = 1 - Math.exp(-dt * 1.4);
    const c = this.cur as unknown as Record<string, number | Vec3>;
    const tg = target as unknown as Record<string, number | Vec3>;
    for (const key of Object.keys(target)) {
      if (key === "name") continue;
      const tv = tg[key];
      if (typeof tv === "number") {
        c[key] = (c[key] as number) + (tv - (c[key] as number)) * k;
      } else {
        const cv = c[key] as Vec3;
        for (let i = 0; i < 3; i++) cv[i] += (tv[i] - cv[i]) * k;
      }
    }
  }
}

export class Camera {
  private angle = 0;
  private elev = 0.2;
  private radius = 7.5;
  private shake = 0;
  eye: Vec3 = [0, 0, 8];

  update(dt: number, audio: AudioEngine): void {
    // Orbit speed eases up with energy; bass pulls the camera in.
    this.angle += dt * (0.05 + audio.level * 0.22 + audio.change * 0.15);
    this.elev += (0.15 + Math.sin(audio.beatPhase * Math.PI) * 0.12 - this.elev) * dt * 1.2;
    const targetR = 8.8 - audio.bass * 2.2 - audio.level * 1.0;
    this.radius += (targetR - this.radius) * dt * 1.5;
    if (audio.kick) this.shake = Math.min(1, this.shake + 0.5 + audio.change * 0.4);
    this.shake *= Math.exp(-dt * 6);
  }

  /** Build the view-projection and current eye position. */
  viewProj(aspect: number, t: number): { vp: Mat4; eye: Vec3 } {
    const sh = this.shake;
    const sx = Math.sin(t * 53.0) * sh * 0.18;
    const sy = Math.cos(t * 61.0) * sh * 0.18;
    const eye: Vec3 = [
      Math.cos(this.angle) * this.radius + sx,
      Math.sin(this.elev) * this.radius * 0.6 + sy,
      Math.sin(this.angle) * this.radius,
    ];
    this.eye = eye;
    const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 60);
    const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
    return { vp: multiply(proj, view), eye };
  }
}
