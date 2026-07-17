Pilot preview clips for the Hap export pipeline (PR #17), committed so they're
viewable/downloadable directly from GitHub (including on mobile — GitHub renders
`.mp4` inline with a player) without depending on chat file transfer. H.264, not
the actual Hap deliverable — see `apps/gallery/README.md` § "Exporting VJ
material (Hap)" for how `qa/render.mjs` produces the real `.mov` files.

Safe to delete once the pipeline is reviewed; regenerate with:

```sh
node qa/render.mjs http://localhost:5199/ 02-reaction,31-plasma,44-platonic
ffmpeg -i qa-out/hap/<id>.mov -c:v libx264 -crf 23 -pix_fmt yuv420p -movflags +faststart qa/samples/<id>.mp4
```
