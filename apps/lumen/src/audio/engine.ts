// LUMEN audio engine.
//
// Goes beyond the reference single-band beat tracker: it runs three independent
// adaptive-threshold onset detectors (low / mid / high) so a kick, a snare and a
// hat each fire their own visual event, tracks a continuous beat *phase* (not just
// a flag on the frame a kick lands), and exposes a log-spaced spectrum that the
// renderer embeds spatially. Everything is exponentially smoothed against dt so it
// reads the same at 60 or 144 fps.

import { DemoLoop } from "./demo.ts";

/** Number of log-spaced spectrum bands handed to the GPU. */
export const BAND_COUNT = 24;

// One adaptive onset detector. Keeps a short ring of recent flux values and fires
// when the newest value pops above mean + sensitivity*std, respecting a refractory
// gap so a single transient cannot machine-gun.
class OnsetDetector {
  private hist = new Float32Array(43); // ~0.7s at 60fps
  private idx = 0;
  private filled = 0;
  private last = -1;
  /** 0..1 envelope that snaps to 1 on a fresh onset and decays. */
  pulse = 0;
  /** Set to 1 only on the exact frame an onset is detected. */
  fired = 0;
  private sensitivity: number;
  private refractory: number;
  private floor: number;
  private decay: number;

  constructor(sensitivity: number, refractory: number, floor: number, decay: number) {
    this.sensitivity = sensitivity;
    this.refractory = refractory;
    this.floor = floor;
    this.decay = decay;
  }

  update(flux: number, t: number, dt: number): void {
    this.fired = 0;
    let mean = 0;
    for (let i = 0; i < this.filled; i++) mean += this.hist[i];
    mean = this.filled ? mean / this.filled : 0;
    let varc = 0;
    for (let i = 0; i < this.filled; i++) {
      const d = this.hist[i] - mean;
      varc += d * d;
    }
    const std = this.filled ? Math.sqrt(varc / this.filled) : 0;
    const thresh = mean + this.sensitivity * std + this.floor;
    if (flux > thresh && t - this.last > this.refractory) {
      this.fired = 1;
      this.pulse = 1;
      this.last = t;
    }
    this.hist[this.idx] = flux;
    this.idx = (this.idx + 1) % this.hist.length;
    if (this.filled < this.hist.length) this.filled++;
    this.pulse *= Math.exp(-dt * this.decay);
  }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private an: AnalyserNode | null = null;
  private freq = new Uint8Array(0);
  private prev = new Uint8Array(0);
  private demo: DemoLoop | null = null;
  running = false;
  source: "mic" | "demo" | null = null;

  // Broad bands, smoothed (0..~1).
  bass = 0;
  mid = 0;
  high = 0;
  level = 0;
  // Log-spaced spectrum for the renderer, smoothed.
  readonly spectrum = new Float32Array(BAND_COUNT);

  // Spectral descriptors.
  centroid = 0.3; // 0..1 normalised brightness
  spread = 0.2;
  private fluxFast = 0;
  private fluxSlow = 1e-4;
  novelty = 1; // ratio fast/slow flux — spikes on big musical changes
  change = 0.1; // eased novelty, 0.06..1

  // Snare / hat onsets via adaptive spectral flux; the kick is energy-based below
  // (an envelope ratio) which locks tempo far more reliably on busy low ends.
  private bassSlow = 0;
  private lastKickT = -1;
  private dSnare = new OnsetDetector(1.9, 0.11, 0.006, 9);
  private dHat = new OnsetDetector(2.0, 0.045, 0.004, 16);
  kick = 0;
  kickPulseInternal = 0;
  kickPulse = 0;
  snare = 0;
  snarePulse = 0;
  hat = 0;
  hatPulse = 0;
  // Cumulative counts (handy for tuning / sanity checks).
  kicks = 0;
  snares = 0;
  hats = 0;

  // Tempo + phase.
  private intervals: number[] = [];
  bpm = 0;
  beatPhase = 0; // 0..1 within the current beat, advances by time, resync on kick
  barPhase = 0; // 0..1 within a 4-beat bar
  private beatCount = 0;

  async initMic(): Promise<void> {
    this.ctx = new AudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.setup(this.ctx.createMediaStreamSource(stream), false);
    this.source = "mic";
  }

  initDemo(): void {
    this.ctx = new AudioContext();
    this.demo = new DemoLoop(this.ctx);
    this.setup(this.demo.out, true);
    this.demo.start();
    this.source = "demo";
  }

  private setup(node: AudioNode, toDest: boolean): void {
    const an = this.ctx!.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.4;
    node.connect(an);
    if (toDest) an.connect(this.ctx!.destination);
    this.an = an;
    this.freq = new Uint8Array(an.frequencyBinCount);
    this.prev = new Uint8Array(an.frequencyBinCount);
    this.running = true;
  }

  update(dt: number): void {
    if (!this.running || !this.an || !this.ctx) return;
    this.prev.set(this.freq);
    this.an.getByteFrequencyData(this.freq);
    const n = this.freq.length;
    const binHz = this.ctx.sampleRate / 2 / n;
    const t = this.ctx.currentTime;

    const bassTo = Math.max(3, Math.round(160 / binHz));
    const midTo = Math.round(2200 / binHz);
    let b = 0,
      m = 0,
      h = 0,
      cw = 0,
      cs = 0;
    let midFlux = 0,
      highFlux = 0,
      totalFlux = 0;
    for (let i = 1; i < n; i++) {
      const v = this.freq[i] / 255;
      if (i < bassTo) b += v;
      else if (i < midTo) m += v;
      else h += v;
      const d = (this.freq[i] - this.prev[i]) / 255;
      const pos = d > 0 ? d : 0;
      if (i >= bassTo && i < midTo) midFlux += pos;
      else if (i >= midTo) highFlux += pos;
      totalFlux += pos;
      cw += v * i;
      cs += v;
    }
    b /= bassTo;
    m /= midTo - bassTo;
    h /= n - midTo;
    midFlux /= midTo - bassTo;
    highFlux /= n - midTo;
    totalFlux /= n * 0.05;

    const k = 1 - Math.exp(-dt * 12);
    this.bass += (b - this.bass) * k;
    this.mid += (m - this.mid) * k;
    this.high += (h - this.high) * k;
    this.level += (b * 0.5 + m * 0.35 + h * 0.15 - this.level) * k;

    // Log-spaced spectrum -> render bands.
    const minHz = 30,
      maxHz = 16000;
    const logMin = Math.log(minHz),
      logSpan = Math.log(maxHz) - logMin;
    for (let band = 0; band < BAND_COUNT; band++) {
      const f0 = Math.exp(logMin + (logSpan * band) / BAND_COUNT);
      const f1 = Math.exp(logMin + (logSpan * (band + 1)) / BAND_COUNT);
      const i0 = Math.max(1, Math.floor(f0 / binHz));
      const i1 = Math.min(n - 1, Math.max(i0 + 1, Math.ceil(f1 / binHz)));
      let s = 0;
      for (let i = i0; i < i1; i++) s += this.freq[i] / 255;
      s /= i1 - i0;
      this.spectrum[band] += (s - this.spectrum[band]) * k;
    }

    // Spectral centroid + spread (normalised brightness / how wide the energy sits).
    const cen = cs > 1e-3 ? cw / cs / n : 0.3;
    this.centroid += (cen - this.centroid) * k * 0.6;
    let sw = 0;
    if (cs > 1e-3) {
      for (let i = 1; i < n; i++) {
        const v = this.freq[i] / 255;
        const dn = i / n - cen;
        sw += v * dn * dn;
      }
      sw = Math.sqrt(sw / cs);
    }
    this.spread += (sw - this.spread) * k * 0.5;

    // Novelty (fast/slow flux ratio) as in the reference, drives regime changes.
    this.fluxFast += (totalFlux - this.fluxFast) * (1 - Math.exp(-dt * 8));
    this.fluxSlow += (totalFlux - this.fluxSlow) * (1 - Math.exp(-dt * 0.35));
    this.novelty = this.fluxFast / Math.max(this.fluxSlow, 1e-4);
    this.change = Math.min(1, Math.max(0.06, (this.novelty - 0.8) * 0.8));

    // Kick: bass energy rising well above its slow envelope (reference-style, robust).
    this.bassSlow += (b - this.bassSlow) * (1 - Math.exp(-dt * 1.0));
    this.kick = 0;
    if (b > this.bassSlow * 1.45 + 0.05 && t - this.lastKickT > 0.33) {
      this.kick = 1;
      this.kickPulseInternal = 1;
      this.lastKickT = t;
    }
    this.kickPulseInternal *= Math.exp(-dt * 6.5);
    this.kickPulse = this.kickPulseInternal;

    // Snare / hat via adaptive flux.
    this.dSnare.update(midFlux, t, dt);
    this.dHat.update(highFlux, t, dt);
    this.snare = this.dSnare.fired;
    this.snarePulse = this.dSnare.pulse;
    this.hat = this.dHat.fired;
    this.hatPulse = this.dHat.pulse;
    this.kicks += this.kick;
    this.snares += this.snare;
    this.hats += this.hat;

    // Tempo from kick intervals (median), plus a continuous phase.
    if (this.kick) {
      const iv = t - (this.lastKick ?? t);
      this.lastKick = t;
      if (iv > 0.27 && iv < 1.6) {
        this.intervals.push(iv);
        if (this.intervals.length > 12) this.intervals.shift();
        const sorted = [...this.intervals].sort((a, c) => a - c);
        this.bpm = Math.round(60 / sorted[sorted.length >> 1]);
      }
      this.beatPhase = 0; // resync downbeat to the kick
      this.beatCount = (this.beatCount + 1) % 4;
    }
    if (this.bpm > 0) {
      const beatsPerSec = this.bpm / 60;
      this.beatPhase = (this.beatPhase + dt * beatsPerSec) % 1;
    }
    this.barPhase = (this.beatCount + this.beatPhase) / 4;
  }

  private lastKick: number | null = null;

  /** A soft metronome envelope (1 on the beat, easing to 0) even without a fresh onset. */
  get beatEnvelope(): number {
    return Math.pow(1 - this.beatPhase, 2.2);
  }
}
