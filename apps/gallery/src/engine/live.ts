// Live VJ mode v2: a generative auto-VJ.
//
// Two scene slots render into the Mixer's offscreen channels (via each scene's
// ctx.bindOutput); the Director listens to the music and decides when to cut
// (bar counts, novelty spikes, drops), what scene fits the current energy tier
// and how to transition (crossfade / luma wipe / glitch / white-flash / zoom /
// hard cut), all beat-synced. The standby scene is pre-built halfway through
// the interval and only renders during the mix window, so steady-state GPU cost
// stays one scene + one fullscreen composite. GLScope reclaims all GL objects
// on every swap.
//
// Some segments become blend-holds: the Director pairs the current scene with
// a QA-profile-compatible partner (load budget + luma contrast) and the deck
// renders full-time, layered by the mix bus (add / screen / luma mask) with a
// phrase-length breathing blend amount — no per-kick twitching. The layer then
// resolves INTO the partner (pass-through exit), so the deck is always "the
// next scene". A runtime FPS guard drops the partner to half-res and, failing
// that, resolves the hold early and bans the pair for the session.
//
// URL params: ?live[&seed=N][&auto=demo|qa]  (auto=qa uses ScriptedAudio — no
// gesture, deterministic decisions, holds forced on every eligible segment,
// FPS guard off; used by the headless smoke test.)

import { getContext, fullscreenTriangle, GLError } from "./gl.ts";
import { AudioEngine } from "./audio.ts";
import { ScriptedAudio } from "./scripted.ts";
import { GLScope } from "./track.ts";
import { Mixer } from "./mixer.ts";
import { Director, mulberry32 } from "./director.ts";
import type { TransitionPlan, HoldPlan } from "./director.ts";
import { SCENES } from "../scenes/registry.ts";
import { PROFILES } from "../scenes/profile.gen.ts";
import type { SceneDef, Scene, SceneContext } from "./scene.ts";

function el<T extends HTMLElement>(html: string): T {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as T;
}

type PlayableScene = SceneDef & Required<Pick<SceneDef, "create">>;

interface Slot {
  channel: 0 | 1;
  scope: GLScope | null;
  scene: Scene | null;
  def: PlayableScene | null;
  /** Current seed macro value (0..1) and its drift velocity (per second). */
  seed: number;
  seedV: number;
}

interface HoldState {
  plan: HoldPlan;
  /** wait: partner not built yet → in: β ramp → hold: plateau → out: resolve to B. */
  phase: "wait" | "in" | "hold" | "out";
  beta: number;
  exitFast: boolean;
}

/** Blend-hold beat offsets: settle-in wait, β ramp, and pass-through exit. */
const HOLD_WAIT = 4;
const HOLD_RAMP = 4;
const HOLD_EXIT = 4;

export function mountLive(): void {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = "";

  const params = new URLSearchParams(location.search);
  const auto = params.get("auto"); // "demo" | "qa" | null
  const seed = Number(params.get("seed")) || (Math.random() * 0xffffffff) >>> 0;

  const pool = SCENES.filter((s): s is PlayableScene => s.create !== undefined);
  if (!pool.length) {
    app.textContent = "実装済みシーンがありません。";
    return;
  }

  const canvas = el<HTMLCanvasElement>(`<canvas id="gl"></canvas>`);
  const hud = el<HTMLDivElement>(`
    <div id="hud">
      <div class="row"><span class="k">NOW</span> <span id="lNow">--</span></div>
      <div class="row"><span class="k">NXT</span> <span id="lNxt">--</span></div>
      <div class="row">
        <span class="k">BPM</span>&nbsp;<span id="lBpm">--</span>
        &nbsp;<span class="k">INT</span>&nbsp;<span id="lInt">16</span>
        &nbsp;<span class="k">BAR</span>&nbsp;<span id="lBar">0/16</span>
      </div>
      <div class="row">
        <span class="k">NRG</span>&nbsp;<span id="lNrg">mid</span>
        &nbsp;<span class="k">TRN</span>&nbsp;<span id="lTrn">--</span>
        &nbsp;<span class="k">SEED</span>&nbsp;<span id="lSeed">--</span>
      </div>
      <div class="live-meter"><span id="lMeter"></span></div>
      <div class="k keys">[space/N] skip [P] pause [1-4] 4/8/16/32 [G] glitch [S] strobe [M] fx [←] index [F] full [H] hud</div>
    </div>`);
  const overlay = el<HTMLDivElement>(`
    <div id="overlay">
      <a class="back" href="./">← gallery</a>
      <h1>VJ <span>LIVE</span></h1>
      <p>実装済み ${pool.length} シーンを Director が自動ミックス。<br/>
         エネルギー・ドロップ・展開を検出してカットとトランジションを決めます。<br/><br/>
         ※ マイクがブロックされる環境では「デモ音源」を使ってください。</p>
      <div class="btns">
        <button id="bMic">マイク入力で開始</button>
        <button id="bDemo">デモ音源で開始</button>
      </div>
    </div>`);
  app.append(canvas, hud, overlay);

  let gl: WebGL2RenderingContext;
  try {
    gl = getContext(canvas);
  } catch (e) {
    overlay.innerHTML = `<p style="color:#f66;padding:20px">${e instanceof GLError ? e.message : String(e)}</p>`;
    return;
  }

  const tri = fullscreenTriangle(gl);
  const mixer = new Mixer(gl, tri);
  const director = new Director(seed, PROFILES);
  // Macro modulation gets its own rng stream so the director's decision replay
  // (same seed + same audio → same cuts) stays identical to pre-macro builds.
  const macroRng = mulberry32(seed ^ 0x9e3779b9);
  const audio: AudioEngine = auto === "qa" ? new ScriptedAudio() : new AudioEngine();

  // Playback state
  let interval = 16;
  let paused = false;
  let beats = 0;
  let pending = false;
  let forcedPlan: TransitionPlan | null = null;
  let prefetched = false;
  let lastCutT = 0;

  // Transition state
  let plan: TransitionPlan | null = null;
  let progress = 0;

  // Blend-hold state
  let hold: HoldState | null = null;
  /** True while the deck channel is allocated at half resolution. */
  let deckHalf = false;
  // FPS guard (real-audio modes only): EMA of the raw frame delta.
  let emaDt = 1 / 60;
  let slowT = 0;

  // Master FX
  let fxOn = true;
  let strobeT = 0;
  let invertT = 0;

  const program: Slot = { channel: 0, scope: null, scene: null, def: null, seed: 0, seedV: 0 };
  const standby: Slot = { channel: 1, scope: null, scene: null, def: null, seed: 0, seedV: 0 };
  let onAir = program;
  let deck = standby;

  let rw = 1;
  let rh = 1;

  function make(slot: Slot, def: PlayableScene): boolean {
    slot.scope?.dispose();
    slot.scope = null;
    slot.scene = null;
    slot.def = null;
    const scope = new GLScope(gl);
    try {
      const sctx: SceneContext = {
        gl,
        canvas,
        tri,
        bindOutput: () => mixer.bindChannel(slot.channel),
      };
      const scene = scope.track(() => def.create(sctx));
      const [cw, ch] = mixer.channelSize(slot.channel);
      scope.track(() => scene.resize(cw, ch));
      // Every cut gets its own face: seed the scene's macro (if exposed) and a
      // slow drift velocity so the look keeps morphing over its airtime.
      slot.seed = macroRng();
      slot.seedV = (macroRng() < 0.5 ? -1 : 1) * 0.012;
      scope.track(() => scene.macros?.seed?.(slot.seed));
      slot.scope = scope;
      slot.scene = scene;
      slot.def = def;
      return true;
    } catch (e) {
      console.error("[live]", def.id, e);
      scope.dispose();
      return false;
    }
  }

  /** Build the deck slot with the director's next pick (retries on broken scenes). */
  function prefetch(): void {
    if (deck.scene) return;
    for (let tries = 0; tries < 4; tries++) {
      const def = director.pickNext(pool, onAir.def) as PlayableScene;
      if (make(deck, def)) return;
    }
  }

  /** Resize a slot's scene to its mixer channel's current pixel size. */
  function fitChannel(slot: Slot): void {
    if (!slot.scene || !slot.scope) return;
    const [cw, ch] = mixer.channelSize(slot.channel);
    slot.scope.track(() => slot.scene!.resize(cw, ch));
  }

  /** Swap deck on air; the old program becomes the (empty) deck. */
  function swap(): void {
    onAir.scope?.dispose();
    onAir.scope = null;
    onAir.scene = null;
    const t = onAir;
    onAir = deck;
    deck = t;
    if (deckHalf) {
      // The promoted scene rendered half-res during the hold — restore full res.
      deckHalf = false;
      mixer.setChannelScale(onAir.channel, 1);
      fitChannel(onAir);
    }
    beats = 0;
    pending = false;
    forcedPlan = null;
    prefetched = false;
    plan = null;
    progress = 0;
    hold = null;
    lastCutT = performance.now() / 1000;
    scheduleHold();
  }

  /** Roll the dice for a blend-hold on the segment that just started. */
  function scheduleHold(): void {
    const p = director.planHold(pool, onAir.def, auto === "qa");
    if (p) hold = { plan: p, phase: "wait", beta: 0, exitFast: false };
  }

  /** Begin the planned transition (or hard-swap for cuts). */
  function beginTransition(): void {
    hold = null; // transitions and blend-holds are mutually exclusive
    if (!deck.scene) prefetch();
    if (!deck.scene) {
      // Nothing playable to go to; reset the bar and try again next interval.
      beats = 0;
      pending = false;
      return;
    }
    const p = forcedPlan ?? director.planTransition();
    if (director.drop) strobeT = 0.9;
    smokeLog(p.kind, p.beats);
    if (p.kind === "cut" || p.beats <= 0) {
      swap();
      lTrn.textContent = "cut";
      return;
    }
    plan = p;
    progress = 0;
    lTrn.textContent = `${p.kind} ${p.beats}b`;
  }

  const resize = (): void => {
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    canvas.width = rw = Math.floor(innerWidth * dpr);
    canvas.height = rh = Math.floor(innerHeight * dpr);
    mixer.resize(rw, rh);
    for (const s of [onAir, deck]) fitChannel(s);
  };
  addEventListener("resize", resize);
  resize();

  const lNow = hud.querySelector<HTMLSpanElement>("#lNow")!;
  const lNxt = hud.querySelector<HTMLSpanElement>("#lNxt")!;
  const lBpm = hud.querySelector<HTMLSpanElement>("#lBpm")!;
  const lInt = hud.querySelector<HTMLSpanElement>("#lInt")!;
  const lBar = hud.querySelector<HTMLSpanElement>("#lBar")!;
  const lNrg = hud.querySelector<HTMLSpanElement>("#lNrg")!;
  const lTrn = hud.querySelector<HTMLSpanElement>("#lTrn")!;
  const lSeed = hud.querySelector<HTMLSpanElement>("#lSeed")!;
  const lMeter = hud.querySelector<HTMLSpanElement>("#lMeter")!;
  lSeed.textContent = String(seed);

  let lastT = 0;
  let started = false;
  let tick = 0;

  // --- smoke-test hooks (auto=qa): capture shots at ?shots=<s,s,..> seconds and
  // log every transition, then POST both to /__qa/live for the runner. ---
  const shotTimes = (params.get("shots") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const shots: Array<{ t: number; dataUrl: string }> = [];
  const transitions: Array<{ t: number; kind: string; beats: number; from: string; to: string }> =
    [];
  let smokeT = 0;
  let smokePosted = false;
  const smokeLog = (kind: string, beatsN: number): void => {
    if (auto === "qa")
      transitions.push({
        t: Math.round(smokeT * 10) / 10,
        kind,
        beats: beatsN,
        from: onAir.def?.id ?? "--",
        to: deck.def?.id ?? "--",
      });
  };
  const smokeTick = (dt: number): void => {
    smokeT += dt;
    if (shotTimes.length && smokeT >= shotTimes[0]) {
      shotTimes.shift();
      shots.push({ t: Math.round(smokeT * 10) / 10, dataUrl: canvas.toDataURL("image/jpeg", 0.8) });
    }
    if (!shotTimes.length && !smokePosted && shots.length) {
      smokePosted = true;
      void fetch("/__qa/live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed, shots, transitions }),
      }).finally(() => {
        document.title = "QA_DONE";
      });
    }
  };

  const frame = (): void => {
    requestAnimationFrame(frame);
    if (paused) return;

    const now = performance.now() / 1000;
    const rawDt = lastT ? now - lastT : 1 / 60;
    const dt = Math.min(0.05, rawDt);
    lastT = now;

    audio.update(dt);
    director.update(now, dt, audio);

    if (audio.kick) beats++;
    const beatsF = beats + audio.beatPhase;

    // --- cut scheduling (hold segments run on their own clock) ---
    if (!prefetched && !hold && beats >= Math.ceil(interval / 2)) {
      prefetched = true;
      prefetch();
    }
    if (!pending && !hold && beats >= interval) pending = true;
    // Novelty section change: cut early once at least half a bar has passed.
    if (!pending && !hold && !plan && director.section && beats >= 8) pending = true;
    // BPM undetected fallback.
    if (!pending && !hold && now - lastCutT > 20) pending = true;

    // Hold interrupts: drops, manual skips and the stuck-clock fallback all
    // resolve the layer early instead of starting a competing transition.
    if (hold && (director.drop || pending || now - lastCutT > 40)) {
      if (hold.phase === "wait") {
        hold = null; // partner not built yet — fall back to the normal path
        prefetched = false;
      } else if (hold.phase !== "out") {
        hold.phase = "out";
        hold.exitFast = true;
        progress = 0;
        smokeLog("hold:exit", 1);
      }
      if (hold) pending = false;
    }

    // Drop: hit immediately, don't wait for the downbeat.
    if (!plan && !hold && director.drop) {
      pending = true;
      beginTransition();
    } else if (pending && !plan && !hold && (audio.beatPhase < 0.12 || now - lastCutT > 25)) {
      beginTransition();
    }

    // --- blend-hold timeline ---
    if (hold) {
      const h = hold;
      if (h.phase === "wait" && beatsF >= HOLD_WAIT) {
        if (h.plan.halfRes) mixer.setChannelScale(deck.channel, 0.5);
        if (make(deck, h.plan.partner as PlayableScene)) {
          deckHalf = h.plan.halfRes;
          h.phase = "in";
          smokeLog(`hold:${h.plan.mode}`, h.plan.beats);
        } else {
          mixer.setChannelScale(deck.channel, 1);
          hold = null;
          prefetched = false;
        }
      } else if (h.phase === "in") {
        const x = Math.min(1, (beatsF - HOLD_WAIT) / HOLD_RAMP);
        h.beta = h.plan.base * x * x * (3 - 2 * x);
        if (x >= 1) h.phase = "hold";
      } else if (h.phase === "hold") {
        // Phrase-length breathing (one cycle per 16 beats) — the layer swells
        // with the bar structure instead of twitching per kick.
        const breathe = Math.sin((beatsF / 16) * Math.PI * 2) * 0.12;
        h.beta = Math.min(0.82, Math.max(0.35, h.plan.base + breathe));
        if (beatsF >= HOLD_WAIT + HOLD_RAMP + h.plan.beats) {
          h.phase = "out";
          progress = 0;
          smokeLog("hold:exit", HOLD_EXIT);
        }
      } else if (h.phase === "out") {
        progress += (dt * ((audio.bpm || 120) / 60)) / (h.exitFast ? 1 : HOLD_EXIT);
      }
    }

    const holdLive = hold !== null && hold.phase !== "wait";

    // FPS guard (skipped in auto=qa: SwiftShader would trip it instantly and
    // it would break decision determinism). Half-res the partner first; if the
    // pair still can't hold 60fps, resolve early and ban it for the session.
    if (auto !== "qa" && holdLive && hold!.phase !== "out") {
      if (rawDt < 0.25) emaDt += (rawDt - emaDt) * Math.min(1, dt / 0.35);
      slowT = emaDt > 1 / 57 ? slowT + dt : Math.max(0, slowT - dt * 2);
      if (slowT > 1) {
        slowT = 0;
        if (!deckHalf) {
          deckHalf = true;
          mixer.setChannelScale(deck.channel, 0.5);
          fitChannel(deck);
        } else {
          director.banHoldPair(onAir.def!.id, deck.def!.id);
          hold!.phase = "out";
          hold!.exitFast = true;
          progress = 0;
          smokeLog("hold:exit", 1);
        }
      }
    } else {
      slowT = 0;
    }

    // --- macro drive: slow seed drift so the on-air face (and any live deck,
    // whether transitioning or held) keeps morphing over its airtime ---
    const drift = (s: Slot): void => {
      if (!s.scene?.macros?.seed) return;
      s.seed += s.seedV * dt;
      if (s.seed < 0 || s.seed > 1) {
        s.seedV = -s.seedV;
        s.seed = Math.min(1, Math.max(0, s.seed));
      }
      s.scene.macros.seed(s.seed);
    };
    drift(onAir);
    if (plan || holdLive) drift(deck);

    // --- render ---
    onAir.scene?.frame(now, dt, audio);
    if (plan || holdLive) deck.scene?.frame(now, dt, audio);
    if (plan) progress += (dt * ((audio.bpm || 120) / 60)) / plan.beats;

    // Master FX values. During a hold the kick zoom is attenuated and the
    // section invert skipped: the layer's slow breathing carries the music.
    strobeT = Math.max(0, strobeT - dt);
    invertT = Math.max(0, invertT - dt);
    if (fxOn && !holdLive && director.section && director.tier === "high") invertT = 0.09;
    const strobe = fxOn && strobeT > 0 && Math.floor(now * 14) % 2 === 0 ? 1 : 0;

    mixer.composite(onAir.channel, deck.channel, {
      kind: plan?.kind ?? "cut",
      progress,
      blend: holdLive ? { mode: hold!.plan.mode, amount: hold!.beta } : null,
      time: now,
      kickPulse: fxOn ? audio.kickPulse * (holdLive ? 0.3 : 1) : 0,
      rgbShift: fxOn ? audio.snarePulse * 0.4 + audio.change * 0.15 : 0,
      strobe,
      invert: invertT > 0 ? 1 : 0,
    });

    if ((plan || (hold && hold.phase === "out")) && progress >= 1) swap();
    if (auto === "qa") smokeTick(dt);

    // --- HUD ---
    const prog = Math.min(1, (beats + audio.beatPhase) / Math.max(1, interval));
    lMeter.style.width = `${prog * 100}%`;
    if (++tick % 4 === 0) {
      lNow.textContent = onAir.def ? `${onAir.def.no} ${onAir.def.title}` : "--";
      lNxt.textContent = deck.def ? `${deck.def.no} ${deck.def.title}` : "--";
      lBpm.textContent = audio.bpm ? String(audio.bpm) : "--";
      lInt.textContent = String(interval);
      lBar.textContent = `${beats}/${interval}`;
      lNrg.textContent = director.breakdown ? "break" : director.tier;
      if (holdLive)
        lTrn.textContent = `hold ${hold!.plan.mode}${deckHalf ? " ½" : ""} β${hold!.beta.toFixed(2)}`;
    }
  };

  const begin = (): void => {
    overlay.style.display = "none";
    hud.classList.remove("hidden");
    lastCutT = performance.now() / 1000;
    for (let tries = 0; tries < 4 && !onAir.scene; tries++) {
      const def = director.pickNext(pool, null) as PlayableScene;
      make(onAir, def);
    }
    scheduleHold();
    if (!hold) prefetch();
    prefetched = true;
    if (!started) {
      started = true;
      requestAnimationFrame(frame);
    }
  };

  overlay.querySelector<HTMLButtonElement>("#bMic")!.onclick = async () => {
    try {
      await audio.initMic();
      begin();
    } catch {
      alert("マイクにアクセスできませんでした。デモ音源をお試しください。");
    }
  };
  overlay.querySelector<HTMLButtonElement>("#bDemo")!.onclick = () => {
    audio.initDemo();
    begin();
  };

  if (auto === "qa") {
    begin();
  } else if (auto === "demo") {
    audio.initDemo();
    begin();
  }

  addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === " " || k === "n") {
      if (started) pending = true;
    } else if (k === "g") {
      forcedPlan = { kind: "glitch", beats: 1 };
      pending = true;
    } else if (k === "s") {
      strobeT = 0.9;
    } else if (k === "m") {
      fxOn = !fxOn;
    } else if (k === "p") {
      paused = !paused;
    } else if (k === "1") {
      interval = 4;
    } else if (k === "2") {
      interval = 8;
    } else if (k === "3") {
      interval = 16;
    } else if (k === "4") {
      interval = 32;
    } else if (k === "arrowleft") {
      onAir.scope?.dispose();
      deck.scope?.dispose();
      mixer.dispose();
      location.href = "./";
    } else if (k === "f") {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } else if (k === "h") {
      hud.classList.toggle("hidden");
    }
  });

  let idleTimer: ReturnType<typeof setTimeout>;
  addEventListener("mousemove", () => {
    if (!started) return;
    hud.classList.remove("hidden");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => hud.classList.add("hidden"), 3500);
  });
}
