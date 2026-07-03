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
// URL params: ?live[&seed=N][&auto=demo|qa]  (auto=qa uses ScriptedAudio — no
// gesture, deterministic decisions; used by the headless smoke test.)

import { getContext, fullscreenTriangle, GLError } from "./gl.ts";
import { AudioEngine } from "./audio.ts";
import { ScriptedAudio } from "./scripted.ts";
import { GLScope } from "./track.ts";
import { Mixer } from "./mixer.ts";
import { Director, mulberry32 } from "./director.ts";
import type { TransitionPlan } from "./director.ts";
import { SCENES } from "../scenes/registry.ts";
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
  const director = new Director(seed);
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
      scope.track(() => scene.resize(rw, rh));
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

  /** Swap deck on air; the old program becomes the (empty) deck. */
  function swap(): void {
    onAir.scope?.dispose();
    onAir.scope = null;
    onAir.scene = null;
    const t = onAir;
    onAir = deck;
    deck = t;
    beats = 0;
    pending = false;
    forcedPlan = null;
    prefetched = false;
    plan = null;
    progress = 0;
    lastCutT = performance.now() / 1000;
  }

  /** Begin the planned transition (or hard-swap for cuts). */
  function beginTransition(): void {
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
    for (const s of [onAir, deck])
      if (s.scene && s.scope) s.scope.track(() => s.scene!.resize(rw, rh));
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
    const dt = Math.min(0.05, lastT ? now - lastT : 0.016);
    lastT = now;

    audio.update(dt);
    director.update(now, dt, audio);

    if (audio.kick) beats++;

    // --- cut scheduling ---
    if (!prefetched && beats >= Math.ceil(interval / 2)) {
      prefetched = true;
      prefetch();
    }
    if (!pending && beats >= interval) pending = true;
    // Novelty section change: cut early once at least half a bar has passed.
    if (!pending && !plan && director.section && beats >= 8) pending = true;
    // BPM undetected fallback.
    if (!pending && now - lastCutT > 20) pending = true;
    // Drop: hit immediately, don't wait for the downbeat.
    if (!plan && director.drop) {
      pending = true;
      beginTransition();
    } else if (pending && !plan && (audio.beatPhase < 0.12 || now - lastCutT > 25)) {
      beginTransition();
    }

    // --- macro drive: slow seed drift so the on-air face keeps morphing ---
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
    if (plan) drift(deck);

    // --- render ---
    onAir.scene?.frame(now, dt, audio);
    if (plan) {
      deck.scene?.frame(now, dt, audio);
      progress += (dt * ((audio.bpm || 120) / 60)) / plan.beats;
    }

    // Master FX values.
    strobeT = Math.max(0, strobeT - dt);
    invertT = Math.max(0, invertT - dt);
    if (fxOn && director.section && director.tier === "high") invertT = 0.09;
    const strobe = fxOn && strobeT > 0 && Math.floor(now * 14) % 2 === 0 ? 1 : 0;

    mixer.composite(onAir.channel, deck.channel, {
      kind: plan?.kind ?? "cut",
      progress,
      time: now,
      kickPulse: fxOn ? audio.kickPulse : 0,
      rgbShift: fxOn ? audio.snarePulse * 0.4 + audio.change * 0.15 : 0,
      strobe,
      invert: invertT > 0 ? 1 : 0,
    });

    if (plan && progress >= 1) swap();
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
    prefetch();
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
