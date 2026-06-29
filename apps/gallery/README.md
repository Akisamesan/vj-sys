# VJ SYSTEM — gallery

The hub for the 100-scene VJ collection. A shared engine (audio analysis, WebGL2
helpers, HDR post chain, scene host) drives every scene, so each scene file stays
small and focused on its own idea. The index lists all 100 concepts; implemented
ones are playable, the rest are the roadmap and fill in batch by batch.

## Run

```sh
vp install            # from the monorepo root
vp run gallery#dev
```

The index opens at the printed URL. Click a scene → pick **マイク入力** (mic) or
**デモ音源** (built-in demo). `?scene=<id>` opens a scene directly.

## Implemented

| no  | scene    | strength                                                           |
| --- | -------- | ------------------------------------------------------------------ |
| 01  | LUMEN    | 3D spectral particle nebula (ships as its own app under `/lumen/`) |
| 02  | REACTION | Gray-Scott reaction-diffusion — living Turing patterns             |
| 03  | MOIRE    | kaleidoscopic interference mandala                                 |
| 04  | TUNNEL   | endless neon tunnel rush                                           |
| 05  | WARP     | hyperspace starfield with beat-driven warp                         |

## Adding a scene

1. Create `src/scenes/<name>.ts` exporting `create<Name>(ctx: SceneContext): Scene`.
2. Wire its `create` into the matching entry in `src/scenes/registry.ts`.

The host provides the canvas/GL, a fullscreen-triangle VAO, the audio engine, the
start overlay, the HUD and the RAF loop. A scene just renders each frame and may use
`engine/postfx.ts` for bloom/grade.

## Engine

- `engine/audio.ts` — bands, spectral flux, multi-band onsets, tempo + beat phase.
- `engine/demo.ts` — self-contained demo track.
- `engine/gl.ts` / `engine/glsl.ts` — WebGL2 helpers + shared noise/curl/palette.
- `engine/postfx.ts` — reusable HDR bloom → CA → grain → vignette → ACES.
- `engine/host.ts` — the runtime that hosts any scene.
