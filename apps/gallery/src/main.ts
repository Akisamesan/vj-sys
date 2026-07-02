import "./style.css";
import { SCENES, findScene } from "./scenes/registry.ts";
import { mountScene } from "./engine/host.ts";
import { mountLive } from "./engine/live.ts";

const params = new URLSearchParams(location.search);
const sceneId = params.get("scene");
const def = findScene(sceneId);

const qa = params.get("qa");
if (qa !== null) {
  void import("./engine/qa.ts").then((m) => m.mountQA(qa));
} else if (params.has("live")) {
  mountLive();
} else if (def?.href) {
  location.href = def.href;
} else if (def?.create) {
  mountScene(def);
} else {
  renderIndex();
}

function renderIndex(): void {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const live = SCENES.filter((s) => s.create || s.href).length;
  const cards = SCENES.map((s) => {
    const playable = Boolean(s.create || s.href);
    const href = s.href ?? `?scene=${s.id}`;
    const cls = playable ? "card" : "card planned";
    const tag = playable ? "a" : "div";
    const attrs = playable ? ` href="${href}"` : "";
    return `
      <${tag} class="${cls}"${attrs}>
        <div class="no">${s.no}</div>
        <div class="ttl">${s.title}</div>
        <div class="fam">${s.family}</div>
        <div class="bl">${s.blurb}</div>
        ${playable ? '<div class="go">▶ play</div>' : '<div class="soon">soon</div>'}
      </${tag}>`;
  }).join("");

  app.innerHTML = `
    <header class="ghead">
      <h1>VJ&nbsp;<span>SYSTEM</span></h1>
      <p>音楽インタラクティブな100種のVJシーン。<b>${live}</b>本が再生可能、残りは順次実装中。<br/>
         各シーンでマイク入力かデモ音源を選んで開始してください。</p>
      <a href="?live" class="live-btn">▶ LIVE MODE</a>
    </header>
    <main class="grid">${cards}</main>
    <footer class="gfoot">WebGL2 · Web Audio · Vite+ &nbsp;|&nbsp; ↑↓ scroll · click to play</footer>`;
}
