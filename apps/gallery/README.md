# VJ SYSTEM — gallery

The hub for the 100-scene VJ collection. A shared engine (audio analysis, WebGL2
helpers, HDR post chain, scene host, live mix bus) drives every scene, so each scene
file stays small and focused on its own idea. The index lists all 100 concepts;
implemented ones are playable, the rest are the roadmap and fill in batch by batch.

## Run

```sh
vp install            # from the monorepo root
vp run gallery#dev
```

The index opens at the printed URL. Click a scene → pick **マイク入力** (mic) or
**デモ音源** (built-in demo). `?scene=<id>` opens a scene directly.

## LIVE mode (`?live`)

A generative auto-VJ. Two scene slots render into offscreen channels; the
**Director** (`engine/director.ts`) listens to the music — energy tiers,
breakdowns, drops, novelty spikes — and decides when to cut, which scene fits
the moment (intensity tags + family/recency avoidance) and how to transition
(crossfade / luma wipe / glitch / white-flash / zoom / hard cut), beat-synced
through the **Mixer** (`engine/mixer.ts`) with kick zoom-punch, RGB shift,
strobe and invert as master FX. Seeded and replayable: `?live&seed=42`.

Some segments become **blend-holds**: the next scene is layered onto the
current one full-time (add / screen / luma mask) instead of waiting for the
mix window, so two scenes read as one new image. Pairs come from the QA
profile (`scenes/profile.gen.ts`): `msPerFrame` is the load budget (the
TERRAIN/CLOUDS-class heavyweights never stack; tight pairs render the partner
at half res), `meanLuma` steers the pairing (dark base × bright partner for
additive blends, luma mask over bright bases). The blend amount breathes over
phrase-length curves — structure, not per-kick twitching — and the layer
resolves _into_ its partner, so every hold also advances the set. A runtime
FPS guard half-reses and then resolves any pair that misses 60fps, banning it
for the session.

Keys: `space/N` skip (resolves a hold early) · `G` glitch cut · `S` strobe ·
`M` fx on/off · `1-4` interval 4/8/16/32 · `P` pause · `F` fullscreen · `H` hud.

## Adding a scene

Read **[SCENES.md](./SCENES.md)** — contract, patterns, audio catalog, quality
bar and spec format. Short version: drop `src/scenes/<name>.ts` exporting one
`create*` factory; `registry.ts` auto-wires it by filename convention
(no imports to edit). Then run the QA harness.

## QA harness

Deterministic visual QA: every scene renders with a fixed timestep against a
scripted audio feed, and the harness measures black/blown output, motion, kick
response, contract violations and ms/frame, producing a contact sheet.

```sh
node qa/run.mjs http://localhost:5199/ all   # headless, ~20s for all scenes
open qa-out/sheet.html                        # contact sheet
node qa/compare.mjs qa-out/baseline.json qa-out/report.json  # pixel regression
```

`?qa=all` in a normal browser runs the same thing interactively. Live smoke:
`?live&auto=qa&seed=42&shots=6,14,30` writes screenshots + the director's
transition log (cuts and `hold:*` events) to `qa-out/`; `auto=qa` forces a
blend-hold on every eligible segment and disables the FPS guard so runs stay
deterministic.

After a QA run, regenerate the committed director profile (per-scene
cost/luma used for blend-hold pairing):

```sh
node qa/profile.mjs   # qa-out/report.json → src/scenes/profile.gen.ts
```

## Exporting VJ material (Hap)

Renders any scene offline with the same deterministic scripted audio the QA
harness uses, then encodes the frame sequence into a Hap-codec `.mov` — a
looping video file usable as material in external VJ software (Resolume,
Modul8, CoGe, ...). Requires `ffmpeg` with the `hap` encoder
(`ffmpeg -encoders | grep hap`; stock Ubuntu/Debian `ffmpeg` packages include
it).

```sh
node qa/render.mjs http://localhost:5199/ 31-plasma                     # one scene, defaults (8s/30fps/960x540)
node qa/render.mjs http://localhost:5199/ 02-reaction,44-platonic --secs 6 --w 1280 --h 720
```

Output: `qa-out/hap/<id>.mov`. `--format` selects the Hap variant: `hap`
(DXT1, no alpha, smallest), `hap_alpha` (DXT5), or `hap_q` (DXT5-YCoCg,
default — best quality). Frame PNGs land in `qa-out/render/<id>/` for
inspection and aren't cleaned up automatically. `?render=<id>&secs=8&fps=30`
in a normal browser runs the capture interactively (frames still POST to the
dev server, so it needs `vp run gallery#dev` running).

## Engine

- `engine/audio.ts` — bands, spectral flux, multi-band onsets, tempo + beat phase.
- `engine/scripted.ts` — deterministic AudioEngine stand-in for QA and render export.
- `engine/demo.ts` — self-contained demo track.
- `engine/gl.ts` / `engine/glsl.ts` — WebGL2 helpers + shared noise/curl/palette.
- `engine/postfx.ts` — reusable HDR bloom → CA → grain → vignette → ACES.
- `engine/host.ts` — the runtime that hosts a single scene.
- `engine/mixer.ts` — live mix bus: A/B channels, transitions, blend-hold, master FX.
- `engine/director.ts` — seeded auto-VJ decision logic (cuts + blend-hold pairing).
- `engine/live.ts` — live mode orchestration (slots, prefetch, holds, FPS guard, HUD).
- `engine/qa.ts` — in-page QA measurement.
- `engine/render.ts` — in-page Hap export capture (qa/render.mjs drives it headless).
- `scenes/profile.gen.ts` — generated per-scene cost/luma profile (qa/profile.mjs).
