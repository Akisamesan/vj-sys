// A self-contained techno/house demo loop so the piece is fully playable without
// mic permission (preview sandboxes block getUserMedia). Scheduled with the classic
// look-ahead timer pattern. Sections evolve so novelty / regime switching has
// something to react to: intro -> groove -> peak -> breakdown.

export class DemoLoop {
  out: GainNode;
  private step = 0;
  private bar = 0;
  private section = 0;
  private next = 0;
  private bpm = 124;
  private noise: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ctx: AudioContext;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.85;
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(1.6, 2.5);
    const wet = ctx.createGain();
    wet.gain.value = 0.18;
    this.out.connect(ctx.destination);
    this.out.connect(verb);
    verb.connect(wet);
    wet.connect(ctx.destination);
  }

  start(): void {
    this.next = this.ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private schedule(): void {
    const spb = 60 / this.bpm / 4; // 16th notes
    while (this.next < this.ctx.currentTime + 0.12) {
      this.play(this.step % 16, this.next);
      this.step++;
      if (this.step % 16 === 0) {
        this.bar++;
        if (this.bar % 8 === 0) this.section = (this.section + 1) % 4;
      }
      this.next += spb;
    }
  }

  // section: 0 intro, 1 groove, 2 peak, 3 breakdown
  private play(s: number, t: number): void {
    const sec = this.section;
    if (sec !== 3 && s % 4 === 0) this.kick(t);
    if (sec >= 1 && s % 2 === 1) this.hat(t, 0.11, 0.16);
    if (sec === 2 && s % 2 === 0) this.hat(t, 0.04, 0.08);
    if ((sec === 1 || sec === 2) && (s === 4 || s === 12)) this.clap(t);

    const bassline = [55, 0, 55, 41.2, 0, 55, 0, 82.4, 55, 0, 49, 55, 0, 65.4, 0, 49];
    if (sec !== 3 && bassline[s]) this.bass(t, bassline[s], sec === 2 ? 1700 : 560);

    // Plucky lead arpeggio in the peak.
    const arp = [440, 0, 659, 0, 554, 0, 880, 0, 659, 0, 554, 0, 740, 0, 659, 0];
    if (sec === 2 && arp[s]) this.lead(t, arp[s]);
    if (sec === 0 && s % 8 === 0) this.lead(t, s === 0 ? 880 : 659, 0.06);

    if (sec === 3 && s === 0) this.pad(t);
  }

  private kick(t: number): void {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(170, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + 0.32);
  }

  private noiseBuf(): AudioBuffer {
    if (!this.noise) {
      const b = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.4, this.ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = b;
    }
    return this.noise;
  }

  private hat(t: number, dec: number, gain: number): void {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf();
    const f = this.ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 8000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    s.connect(f);
    f.connect(g);
    g.connect(this.out);
    s.start(t);
    s.stop(t + dec + 0.02);
  }

  private clap(t: number): void {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf();
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1700;
    f.Q.value = 1.3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    s.connect(f);
    f.connect(g);
    g.connect(this.out);
    s.start(t);
    s.stop(t + 0.22);
  }

  private bass(t: number, fq: number, cut: number): void {
    const o = this.ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = fq;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = cut;
    f.Q.value = 7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(f);
    f.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + 0.25);
  }

  private lead(t: number, fq: number, gain = 0.12): void {
    const o = this.ctx.createOscillator();
    o.type = "square";
    o.frequency.value = fq;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(fq * 6, t);
    f.frequency.exponentialRampToValueAtTime(fq * 1.5, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(f);
    f.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + 0.24);
  }

  private pad(t: number): void {
    [220, 277.2, 329.6, 415.3].forEach((fq, i) => {
      const o = this.ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = fq * (i === 1 ? 1.004 : i === 3 ? 0.997 : 1);
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(360, t);
      f.frequency.linearRampToValueAtTime(2400, t + 3.4);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.7);
      g.gain.linearRampToValueAtTime(0, t + 3.8);
      o.connect(f);
      f.connect(g);
      g.connect(this.out);
      o.start(t);
      o.stop(t + 3.9);
    });
  }

  private impulse(dur: number, decay: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }
}
