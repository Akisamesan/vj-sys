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

Keys: `space/N` skip · `G` glitch cut · `S` strobe · `M` fx on/off ·
`1-4` interval 4/8/16/32 · `P` pause · `F` fullscreen · `H` hud.

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
transition log to `qa-out/`.

## Engine

- `engine/audio.ts` — bands, spectral flux, multi-band onsets, tempo + beat phase.
- `engine/scripted.ts` — deterministic AudioEngine stand-in for QA.
- `engine/demo.ts` — self-contained demo track.
- `engine/gl.ts` / `engine/glsl.ts` — WebGL2 helpers + shared noise/curl/palette.
- `engine/postfx.ts` — reusable HDR bloom → CA → grain → vignette → ACES.
- `engine/host.ts` — the runtime that hosts a single scene.
- `engine/mixer.ts` — live mix bus: A/B channels, transitions, master FX.
- `engine/director.ts` — seeded auto-VJ decision logic.
- `engine/live.ts` — live mode orchestration (slots, prefetch, HUD).
- `engine/qa.ts` — in-page QA measurement.
