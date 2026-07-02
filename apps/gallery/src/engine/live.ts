// Live VJ mode: cycles through all implemented scenes in BPM-sync.
//
// Counts kicks from AudioEngine and cuts to the next scene every N beats
// (default 16, changeable to 4/8/32 via keys). The next scene is pre-built
// halfway through the current interval so the cut frame is nearly free.
// GLScope tracks every GL object each scene allocates and deletes them on cut,
// preventing the VRAM exhaustion that would otherwise occur after a few scenes.

import { getContext, fullscreenTriangle, GLError } from "./gl.ts";
import { AudioEngine } from "./audio.ts";
import { GLScope } from "./track.ts";
import { SCENES } from "../scenes/registry.ts";
import type { SceneDef, Scene, SceneContext } from "./scene.ts";

function el<T extends HTMLElement>(html: string): T {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as T;
}

type PlayableScene = SceneDef & Required<Pick<SceneDef, "create">>;

export function mountLive(): void {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = "";

  const pool = SCENES.filter((s): s is PlayableScene => s.create !== undefined);
  if (!pool.length) {
    app.textContent = "実装済みシーンがありません。";
    return;
  }

  const queue: PlayableScene[] = [...pool].sort(() => Math.random() - 0.5);

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
      <div class="live-meter"><span id="lMeter"></span></div>
      <div class="k keys">[space/N] skip &nbsp;[P] pause &nbsp;[1-4] 4/8/16/32 &nbsp;[←] index &nbsp;[F] full &nbsp;[H] hud</div>
    </div>`);
  const overlay = el<HTMLDivElement>(`
    <div id="overlay">
      <a class="back" href="./">← gallery</a>
      <h1>VJ <span>LIVE</span></h1>
      <p>実装済み ${pool.length} シーンを BPM に同期して自動ミックス。<br/><br/>
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
  const audio = new AudioEngine();

  // Playback state
  let interval = 16;
  let paused = false;
  let qi = 0;
  let beats = 0;
  let pending = false;
  let prefetched = false;
  let lastCutT = 0;

  // Current and next (prefetch) scene slots
  let curScope: GLScope | null = null;
  let curScene: Scene | null = null;
  let curDef: PlayableScene = queue[0];
  let nxtScope: GLScope | null = null;
  let nxtScene: Scene | null = null;
  let nxtDef: PlayableScene = queue[1 % queue.length];

  let rw = 1;
  let rh = 1;

  function make(def: PlayableScene): { scope: GLScope; scene: Scene } | null {
    const scope = new GLScope(gl);
    try {
      const sctx: SceneContext = {
        gl,
        canvas,
        tri,
        bindOutput: () => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, rw, rh);
        },
      };
      const scene = scope.track(() => def.create(sctx));
      scope.track(() => scene.resize(rw, rh));
      return { scope, scene };
    } catch (e) {
      console.error("[live]", def.id, e);
      scope.dispose();
      return null;
    }
  }

  function prefetch(): void {
    nxtDef = queue[(qi + 1) % queue.length];
    if (nxtScene) return; // already ready
    const r = make(nxtDef);
    nxtScope = r?.scope ?? null;
    nxtScene = r?.scene ?? null;
  }

  function cut(): void {
    curScope?.dispose();
    if (nxtScene) {
      curScope = nxtScope;
      curScene = nxtScene;
      curDef = nxtDef;
      qi = queue.indexOf(nxtDef);
    } else {
      qi = (qi + 1) % queue.length;
      curDef = queue[qi];
      const r = make(curDef);
      curScope = r?.scope ?? null;
      curScene = r?.scene ?? null;
    }
    nxtScope = null;
    nxtScene = null;
    beats = 0;
    pending = false;
    prefetched = false;
    lastCutT = performance.now() / 1000;
  }

  const resize = (): void => {
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    canvas.width = rw = Math.floor(innerWidth * dpr);
    canvas.height = rh = Math.floor(innerHeight * dpr);
    if (curScene && curScope) curScope.track(() => curScene!.resize(rw, rh));
    if (nxtScene && nxtScope) nxtScope.track(() => nxtScene!.resize(rw, rh));
  };
  addEventListener("resize", resize);
  resize();

  const lNow = hud.querySelector<HTMLSpanElement>("#lNow")!;
  const lNxt = hud.querySelector<HTMLSpanElement>("#lNxt")!;
  const lBpm = hud.querySelector<HTMLSpanElement>("#lBpm")!;
  const lInt = hud.querySelector<HTMLSpanElement>("#lInt")!;
  const lBar = hud.querySelector<HTMLSpanElement>("#lBar")!;
  const lMeter = hud.querySelector<HTMLSpanElement>("#lMeter")!;

  let lastT = 0;
  let started = false;
  let tick = 0;

  const frame = (): void => {
    requestAnimationFrame(frame);
    if (paused) return;

    const now = performance.now() / 1000;
    const dt = Math.min(0.05, lastT ? now - lastT : 0.016);
    lastT = now;

    audio.update(dt);
    curScene?.frame(now, dt, audio);

    if (audio.kick) beats++;

    // Prefetch next scene halfway through the interval
    if (!prefetched && beats >= Math.ceil(interval / 2)) {
      prefetched = true;
      prefetch();
    }

    // Mark pending when beat count reached
    if (!pending && beats >= interval) pending = true;
    // Fallback if BPM not detected: cut after 20 s
    if (!pending && now - lastCutT > 20) pending = true;
    // Execute cut on downbeat or after 25 s absolute max
    if (pending && (audio.beatPhase < 0.12 || now - lastCutT > 25)) cut();

    // HUD: meter every frame, text every 4 frames
    const prog = Math.min(1, (beats + audio.beatPhase) / Math.max(1, interval));
    lMeter.style.width = `${prog * 100}%`;
    if (++tick % 4 === 0) {
      lNow.textContent = `${curDef.no} ${curDef.title}`;
      lNxt.textContent = `${nxtDef.no} ${nxtDef.title}`;
      lBpm.textContent = audio.bpm ? String(audio.bpm) : "--";
      lInt.textContent = String(interval);
      lBar.textContent = `${beats}/${interval}`;
    }
  };

  const begin = (): void => {
    overlay.style.display = "none";
    hud.classList.remove("hidden");
    lastCutT = performance.now() / 1000;
    const r = make(curDef);
    curScope = r?.scope ?? null;
    curScene = r?.scene ?? null;
    prefetch();
    prefetched = true; // already done above
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

  addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === " " || k === "n") {
      if (started) pending = true;
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
      curScope?.dispose();
      nxtScope?.dispose();
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
