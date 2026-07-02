// Deterministic stand-in for AudioEngine used by the QA harness (?qa=...).
//
// Synthesizes every signal scenes read (bands, spectrum, wave, onsets, tempo,
// phase) as a pure function of an internal clock advanced by update(dt), so a
// scene rendered with a fixed timestep produces identical frames run after run.
// "pattern" mode plays a 120 BPM kick/snare/hat groove; "quiet" holds a
// near-silent bed so a queued kick can be measured against a still baseline.
// It never touches AudioContext, so it needs no user gesture and no audio device.

import { AudioEngine, BAND_COUNT, WAVE_SIZE } from "./audio.ts";

export type ScriptedMode = "pattern" | "quiet";

export class ScriptedAudio extends AudioEngine {
  mode: ScriptedMode = "pattern";
  private clock = 0;
  private kickQueued = false;
  private stepKick = -1;
  private stepSnare = -1;
  private stepHat = -1;

  constructor() {
    super();
    this.running = true;
    this.source = "demo";
    this.bpm = 120;
  }

  /** Queue a single kick for the next update(), regardless of mode. */
  fireKick(): void {
    this.kickQueued = true;
  }

  override update(dt: number): void {
    const t = (this.clock += dt);
    const inPattern = this.mode === "pattern";

    // Step-counter onsets: fire once whenever the lane's step index advances.
    const lane = (period: number, offset: number, prev: number): [number, number] => {
      if (!inPattern || t < offset) return [0, prev];
      const idx = Math.floor((t - offset) / period);
      return idx !== prev ? [1, idx] : [0, prev];
    };
    let kick: number;
    [kick, this.stepKick] = lane(0.5, 0, this.stepKick);
    [this.snare, this.stepSnare] = lane(1.0, 0.5, this.stepSnare);
    [this.hat, this.stepHat] = lane(0.25, 0.125, this.stepHat);
    if (this.kickQueued) {
      kick = 1;
      this.kickQueued = false;
    }
    this.kick = kick;

    if (this.kick) {
      this.kickPulse = 1;
      this.kicks++;
      this.beatPhase = 0;
    } else {
      this.kickPulse *= Math.exp(-dt * 6.5);
      this.beatPhase = (this.beatPhase + dt * 2) % 1; // 120 BPM
    }
    this.kickPulseInternal = this.kickPulse;
    if (this.snare) {
      this.snarePulse = 1;
      this.snares++;
    } else this.snarePulse *= Math.exp(-dt * 9);
    if (this.hat) {
      this.hatPulse = 1;
      this.hats++;
    } else this.hatPulse *= Math.exp(-dt * 16);
    this.barPhase = ((t * 2) / 4) % 1;

    // Bands.
    if (inPattern) {
      this.bass = 0.22 + 0.5 * this.kickPulse + 0.05 * Math.sin(t * 0.9);
      this.mid = 0.3 + 0.12 * Math.sin(t * 1.7) + 0.25 * this.snarePulse;
      this.high = 0.18 + 0.3 * this.hatPulse;
    } else {
      this.bass = 0.06 + 0.5 * this.kickPulse;
      this.mid = 0.05;
      this.high = 0.04;
    }
    this.level = this.bass * 0.5 + this.mid * 0.35 + this.high * 0.15;

    // Log-spectrum: bass slope + a slowly wandering formant + treble tied to hats.
    for (let i = 0; i < BAND_COUNT; i++) {
      const x = i / (BAND_COUNT - 1);
      const formant = Math.exp(-((x - 0.45 - 0.1 * Math.sin(t * 0.7)) ** 2) * 16);
      const v = (1 - x) * this.bass + formant * this.mid + x * this.high * 0.9;
      this.spectrum[i] = Math.min(1, Math.max(0, v));
    }

    // Waveform: beat-locked fundamental plus a bright partial.
    for (let i = 0; i < WAVE_SIZE; i++) {
      const ph = i / WAVE_SIZE;
      this.wave[i] =
        Math.sin(6.28318 * (ph * 3 + t * 2)) * (0.2 + 0.55 * this.level) +
        Math.sin(6.28318 * ph * 13 + t) * this.high * 0.4;
    }

    // Descriptors; novelty bumps at each 8-second "section" boundary.
    this.centroid = 0.3 + 0.12 * Math.sin(t * 0.21) + this.high * 0.2;
    this.spread = 0.2 + 0.05 * Math.sin(t * 0.13);
    const sec = (t % 8) / 8;
    this.novelty = 1 + (inPattern ? Math.exp(-(((sec - 0.02) * 30) ** 2)) * 2.2 : 0);
    this.change = Math.min(1, Math.max(0.06, (this.novelty - 0.8) * 0.8));
  }
}
