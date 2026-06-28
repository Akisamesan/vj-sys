import "./style.css";
import { getContext, fullscreenTriangle, GLError } from "./gl/glutil.ts";
import { AudioEngine, BAND_COUNT } from "./audio/engine.ts";
import { Sim } from "./sim/particles.ts";
import type { SimParams } from "./sim/particles.ts";
import { Renderer } from "./render/renderer.ts";
import { Director, Camera } from "./render/director.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#gl")!;
const overlay = document.querySelector<HTMLDivElement>("#overlay")!;
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const errEl = document.querySelector<HTMLDivElement>("#err")!;

function fail(msg: string): never {
  errEl.querySelector("#errMsg")!.textContent = msg;
  errEl.style.display = "grid";
  throw new Error(msg);
}

// Particle grid side. 640^2 = ~409k. Drop to 512 on coarse devices.
const SIDE = Math.max(window.screen.width, window.screen.height) < 1280 ? 512 : 640;

let gl: WebGL2RenderingContext;
try {
  gl = getContext(canvas);
} catch (e) {
  fail(e instanceof GLError ? e.message : String(e));
}

const tri = fullscreenTriangle(gl);
const sim = new Sim(gl, tri, SIDE);
const renderer = new Renderer(gl, tri);
const director = new Director();
const camera = new Camera();
const audio = new AudioEngine();

const spec = new Float32Array(BAND_COUNT);

// Expose the live engine for debugging / external instrumentation.
(globalThis as unknown as { lumen: unknown }).lumen = { audio, director };

let rw = 1,
  rh = 1;
function resize(): void {
  const dpr = Math.min(devicePixelRatio || 1, 1.75);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  rw = canvas.width;
  rh = canvas.height;
  renderer.resize(rw, rh);
}
addEventListener("resize", resize);
resize();

// Kick shockwave state.
let shockR = 0;
let shockStrength = 0;

let lastT = performance.now() / 1000;
let started = false;
let showPost = true;

function frame(): void {
  requestAnimationFrame(frame);
  const t = performance.now() / 1000;
  const dt = Math.min(0.05, t - lastT);
  lastT = t;

  audio.update(dt);
  director.update(dt, audio, t);
  camera.update(dt, audio);

  for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.4, audio.spectrum[i] * 1.7);

  // shockwave
  if (audio.kick) {
    shockR = 0.3;
    shockStrength = 0.8 + audio.change * 0.6;
  }
  shockR += dt * 9.0;
  shockStrength *= Math.exp(-dt * 3.2);

  const c = director.cur;
  const turb = audio.change * 1.4 + audio.snarePulse * 0.6;
  const simParams: SimParams = {
    dt,
    time: t,
    fieldScale: c.fieldScale,
    flowSpeed: c.flowSpeed,
    curl: c.curl,
    damp: c.damp,
    swirl: c.swirl * (0.6 + audio.mid * 1.2),
    bass: audio.bass,
    turb,
    radiusGain: c.radiusGain,
    height: c.height,
    baseR: c.baseR,
    shock: [0, 0, 0],
    shockR,
    shockStrength: shockStrength > 0.02 ? shockStrength : 0,
    spectrum: spec,
  };
  sim.update(simParams);

  const aspect = rw / rh;
  const { vp, eye } = camera.viewProj(aspect, t);

  const sceneTex = renderer.renderScene(sim, {
    viewProj: vp,
    camPos: eye,
    time: t,
    pointScale: c.pointScale,
    hatPulse: audio.hatPulse,
    centroid: audio.centroid,
    decay: c.decay,
    palA: c.palA,
    palB: c.palB,
    palC: c.palC,
    palD: c.palD,
    spectrum: spec,
  });

  renderer.post(sceneTex, rw, rh, {
    bloomAmt: showPost ? c.bloomAmt * (0.85 + audio.level * 0.5) : 0.0,
    exposure: c.exposure + audio.kickPulse * 0.25,
    aberration: showPost ? 0.0008 + audio.change * 0.0025 : 0,
    grain: showPost ? 0.05 : 0,
    vignette: c.vignette,
    flash: audio.kickPulse * 0.7 + audio.snarePulse * 0.3,
    threshold: 0.7,
    time: t,
  });

  updateHud(t);
}

/* ---------------- HUD ---------------- */
const bars: HTMLSpanElement[] = [];
const barWrap = document.querySelector<HTMLDivElement>("#bars")!;
for (let i = 0; i < BAND_COUNT; i++) {
  const b = document.createElement("span");
  barWrap.appendChild(b);
  bars.push(b);
}
const hBpm = document.querySelector<HTMLSpanElement>("#hBpm")!;
const hReg = document.querySelector<HTMLSpanElement>("#hReg")!;
const hSrc = document.querySelector<HTMLSpanElement>("#hSrc")!;
const hChg = document.querySelector<HTMLSpanElement>("#hChg")!;
const dotK = document.querySelector<HTMLSpanElement>("#dotK")!;
const dotS = document.querySelector<HTMLSpanElement>("#dotS")!;
const dotH = document.querySelector<HTMLSpanElement>("#dotH")!;

let hudN = 0;
function updateHud(t: number): void {
  // beat dots fire every frame (cheap)
  dotK.style.opacity = String(0.25 + audio.kickPulse * 0.75);
  dotS.style.opacity = String(0.25 + audio.snarePulse * 0.75);
  dotH.style.opacity = String(0.25 + audio.hatPulse * 0.75);
  if (++hudN % 2 === 0) {
    for (let i = 0; i < BAND_COUNT; i++) {
      bars[i].style.height = `${Math.min(100, audio.spectrum[i] * 140)}%`;
    }
  }
  if (hudN % 6 === 0) {
    hBpm.textContent = audio.bpm ? String(audio.bpm) : "--";
    hReg.textContent = `${director.index} ${director.name}`;
    hSrc.textContent = audio.source ?? "--";
    hChg.textContent = audio.change.toFixed(2);
  }
  void t;
}

/* ---------------- UI / boot ---------------- */
function begin(): void {
  overlay.style.display = "none";
  hud.classList.remove("hidden");
  if (!started) {
    started = true;
    requestAnimationFrame(frame);
  }
}

document.querySelector<HTMLButtonElement>("#bMic")!.onclick = async () => {
  try {
    await audio.initMic();
    begin();
  } catch {
    alert(
      "マイクにアクセスできませんでした (プレビュー環境ではブロックされることがあります)。デモ音源をお試しください。",
    );
  }
};
document.querySelector<HTMLButtonElement>("#bDemo")!.onclick = () => {
  audio.initDemo();
  begin();
};

addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "s") director.next(performance.now() / 1000);
  else if (k === "r") sim.seed();
  else if (k === "p") showPost = !showPost;
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
