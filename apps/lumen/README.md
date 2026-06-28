# VJ 01 — LUMEN

A music-reactive 3D particle nebula. ~400k GPU particles are stacked into rings by
frequency band (lows low, highs high); each band's live energy expands its ring, so
the spectrum is legible as a 3D structure rather than a bar graph. Kick, snare and hat
are detected independently and drive distinct events — kicks fire an expanding
shockwave plus a camera punch, hats sparkle the high bands — while novelty spikes
glide the whole scene between palette/field **regimes**.

Everything runs on WebGL2: a GPGPU ping-pong simulation (curl-noise flow + per-band
springs), additive HDR accumulation with temporal trails, and a bloom → chromatic
aberration → grain → ACES post chain.

## Run

```sh
vp install      # from the monorepo root
vp run lumen#dev
```

Open the printed URL, then **マイク入力で開始** (mic) or **デモ音源で開始** (built-in
demo track — use this where mic access is blocked).

## Controls

| key | action                 |
| --- | ---------------------- |
| `S` | advance regime         |
| `R` | reseed particles       |
| `P` | toggle post-processing |
| `F` | fullscreen             |
| `H` | toggle HUD             |

## Layout

- `src/audio/` — analysis engine (bands, spectral flux, multi-band onsets, tempo +
  beat phase) and the self-contained demo synth.
- `src/shaders/` — GLSL: shared noise/curl/palette, the GPGPU update, particle
  render, and the post chain.
- `src/sim/` — GPGPU particle controller (float-texture ping-pong, MRT).
- `src/render/` — HDR scene + bloom renderer, regime director, and camera.
