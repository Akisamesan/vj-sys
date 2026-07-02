// The shared runtime that hosts any scene: it owns the canvas/GL, the audio engine,
// the start overlay (mic / demo), a generic HUD (BPM, source, change, beat dots,
// spectrum bars), the RAF loop and resize handling. Scenes stay tiny because all of
// this is provided once here.

import { getContext, fullscreenTriangle, GLError } from "./gl.ts";
import { AudioEngine, BAND_COUNT } from "./audio.ts";
import type { SceneDef, Scene } from "./scene.ts";

function el<T extends HTMLElement>(html: string): T {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as T;
}

export function mountScene(def: SceneDef): void {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = "";

  const canvas = el<HTMLCanvasElement>(`<canvas id="gl"></canvas>`);
  app.appendChild(canvas);

  const bars = Array.from({ length: BAND_COUNT }, () => `<span></span>`).join("");
  const hud = el<HTMLDivElement>(`
    <div id="hud" class="hidden">
      <div class="t">${def.no} ${def.title}</div>
      <div class="row">
        <span class="k">BPM</span> <span id="hBpm">--</span>
        <span class="k">SRC</span> <span id="hSrc">--</span>
        <span class="k">CHG</span> <span id="hChg">0.00</span>
      </div>
      <div class="row beats">
        <span class="k">KIK</span><span id="dotK" class="dot"></span>
        <span class="k">SNR</span><span id="dotS" class="dot"></span>
        <span class="k">HAT</span><span id="dotH" class="dot"></span>
      </div>
      <div id="bars">${bars}</div>
      <div class="k keys">${def.keys ?? ""} [←] index&nbsp; [F] fullscreen&nbsp; [H] hud</div>
    </div>`);
  app.appendChild(hud);

  const overlay = el<HTMLDivElement>(`
    <div id="overlay">
      <a class="back" href="./">← gallery</a>
      <h1>${def.no} <span>${def.title}</span></h1>
      <p>${def.blurb}<br /><br />※ マイクがブロックされる環境では「デモ音源」を使ってください。</p>
      <div class="btns">
        <button id="bMic">マイク入力で開始</button>
        <button id="bDemo">デモ音源で開始</button>
      </div>
    </div>`);
  app.appendChild(overlay);

  const errEl = el<HTMLDivElement>(`<div id="err"><div id="errMsg"></div></div>`);
  app.appendChild(errEl);

  const fail = (msg: string): never => {
    (errEl.querySelector("#errMsg") as HTMLElement).textContent = msg;
    errEl.style.display = "grid";
    throw new Error(msg);
  };

  let gl: WebGL2RenderingContext;
  try {
    gl = getContext(canvas);
  } catch (e) {
    return fail(e instanceof GLError ? e.message : String(e));
  }

  const tri = fullscreenTriangle(gl);
  const audio = new AudioEngine();
  (globalThis as unknown as { vj: unknown }).vj = { audio, id: def.id };

  const bindOutput = (): void => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  let scene: Scene;
  try {
    scene = def.create!({ gl, canvas, tri, bindOutput });
  } catch (e) {
    return fail(e instanceof GLError ? e.message : String(e));
  }

  let rw = 1,
    rh = 1;
  const resize = (): void => {
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    rw = canvas.width;
    rh = canvas.height;
    scene.resize(rw, rh);
  };
  addEventListener("resize", resize);
  resize();

  const hBpm = hud.querySelector<HTMLSpanElement>("#hBpm")!;
  const hSrc = hud.querySelector<HTMLSpanElement>("#hSrc")!;
  const hChg = hud.querySelector<HTMLSpanElement>("#hChg")!;
  const dotK = hud.querySelector<HTMLSpanElement>("#dotK")!;
  const dotS = hud.querySelector<HTMLSpanElement>("#dotS")!;
  const dotH = hud.querySelector<HTMLSpanElement>("#dotH")!;
  const barEls = Array.from(hud.querySelectorAll<HTMLSpanElement>("#bars span"));

  let lastT = performance.now() / 1000;
  let started = false;
  let n = 0;

  const frame = (): void => {
    requestAnimationFrame(frame);
    const t = performance.now() / 1000;
    const dt = Math.min(0.05, t - lastT);
    lastT = t;
    audio.update(dt);
    scene.frame(t, dt, audio);

    dotK.style.opacity = String(0.25 + audio.kickPulse * 0.75);
    dotS.style.opacity = String(0.25 + audio.snarePulse * 0.75);
    dotH.style.opacity = String(0.25 + audio.hatPulse * 0.75);
    if (++n % 2 === 0)
      for (let i = 0; i < BAND_COUNT; i++)
        barEls[i].style.height = `${Math.min(100, audio.spectrum[i] * 140)}%`;
    if (n % 6 === 0) {
      hBpm.textContent = audio.bpm ? String(audio.bpm) : "--";
      hSrc.textContent = audio.source ?? "--";
      hChg.textContent = audio.change.toFixed(2);
    }
  };

  const begin = (): void => {
    overlay.style.display = "none";
    hud.classList.remove("hidden");
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
    if (scene.key && scene.key(k)) return;
    if (k === "arrowleft") location.href = "./";
    else if (k === "f") {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } else if (k === "h") hud.classList.toggle("hidden");
  });

  let idle: ReturnType<typeof setTimeout>;
  addEventListener("mousemove", () => {
    if (!started) return;
    hud.classList.remove("hidden");
    clearTimeout(idle);
    idle = setTimeout(() => hud.classList.add("hidden"), 3500);
  });
}
