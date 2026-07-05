// 27 CITY — a procedural skyline drive: box-SDF towers repeat in a grid down both
// sides of an endless street while the camera flies forward along the road. Window
// hashes per grid cell decide height/width/lit pattern; distance bands (mapped from
// the log spectrum) light up near/far building groups; a kick latches a world-space
// z-slice that sweeps past the camera as a local neon flash (not a screen strobe).
// Fragment raymarch through HDR PostFX.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { PostFX } from "../engine/postfx.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
uniform vec2  u_res;
uniform float u_z, u_sway, u_bass, u_centroid, u_level, u_kickZ, u_kickPulse;
uniform float u_spectrum[${BAND_COUNT}];
out vec4 o;

const float CELL_X = 3.4;
const float CELL_Z = 6.0;
const float BAND_SIZE = 6.0;

float sdBox(vec3 p, vec3 b){ vec3 d = abs(p) - b; return length(max(d,0.0)) + min(max(d.x,max(d.y,d.z)),0.0); }
float cellIdx(float x, float cell){ return floor(x/cell + 0.5); }
float foldMod(float x, float cell){ return mod(x + cell*0.5, cell) - cell*0.5; }

// Cyan <-> magenta <-> yellow neon triptych driven by spectral centroid.
vec3 neonHue(float t){
  vec3 cy = vec3(0.15, 0.85, 1.0);
  vec3 mg = vec3(1.0, 0.15, 0.85);
  vec3 ye = vec3(1.0, 0.92, 0.20);
  float c = clamp(t, 0.0, 1.0) * 2.0;
  if(c < 1.0) return mix(cy, mg, smoothstep(0.0, 1.0, c));
  return mix(mg, ye, smoothstep(0.0, 1.0, c - 1.0));
}

// Grid-repeated tower: fold x/z into the cell, keep the ix==0 column as the empty
// street, size + shape hashed from the (ix, iz) grid index (opRep-style domain repeat).
float buildingDist(vec3 p){
  float ix = cellIdx(p.x, CELL_X);
  float iz = cellIdx(p.z, CELL_Z);
  vec3 q = p;
  q.x = foldMod(p.x, CELL_X);
  q.z = foldMod(p.z, CELL_Z);

  float allowed = abs(ix) < 0.5 ? 0.0 : 1.0;

  float hH = hash11(ix*12.9898 + iz*78.233  + 3.0);
  float hW = hash11(ix*39.346  + iz*11.135  + 7.0);
  float hD = hash11(ix*5.235   + iz*1.7182  + 21.0);

  float height = mix(1.6, 9.5, hH*hH);
  float halfW  = mix(0.85, 1.55, hW);
  float halfD  = mix(0.85, 1.55, hD);

  vec3 lp = q - vec3(0.0, height*0.5, 0.0);
  float d = sdBox(lp, vec3(halfW, height*0.5, halfD));
  return mix(1000.0, d, allowed);
}

float mapScene(vec3 p){
  return min(buildingDist(p), p.y);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*u_res) / u_res.y;

  // Forward drive down the street, with a slow autonomous weave so the image
  // keeps moving even in silence.
  vec3 ro = vec3(sin(u_sway)*0.85, 1.7 + sin(u_sway*0.6)*0.05, u_z);
  vec3 fw = normalize(vec3(cos(u_sway)*0.10, -0.05, 1.0));
  vec3 rt = normalize(cross(vec3(0.0,1.0,0.0), fw));
  vec3 up = cross(fw, rt);
  vec3 rd = normalize(fw + uv.x*rt + uv.y*up);

  float t = 0.05;
  float hit = -1.0;
  for(int i=0; i<100; i++){
    vec3 p = ro + rd*t;
    float d = mapScene(p);
    if(d < 0.015){ hit = t; break; }
    t += d*0.85;
    if(t > 150.0) break;
  }

  // Night sky: deep navy fading to a faint neon horizon glow + static stars.
  vec3 skyDeep = vec3(0.012, 0.015, 0.03);
  vec3 skyHorizon = neonHue(u_centroid) * 0.09;
  float grad = smoothstep(-0.08, 0.4, rd.y);
  vec3 col = mix(skyHorizon, skyDeep, grad);
  float star = step(0.9975, hash11(dot(floor(rd.xy*380.0), vec2(12.9, 78.2))));
  col += vec3(star) * 0.55 * step(0.1, rd.y);

  float worldZ = hit > 0.0 ? (ro.z + rd.z*hit) : (ro.z + rd.z*45.0);

  if(hit > 0.0){
    vec3 p = ro + rd*hit;
    vec2 e = vec2(0.03, 0.0);
    vec3 nrm = normalize(vec3(
      mapScene(p+e.xyy) - mapScene(p-e.xyy),
      mapScene(p+e.yxy) - mapScene(p-e.yxy),
      mapScene(p+e.yyx) - mapScene(p-e.yyx)
    ));

    float dB = buildingDist(p);
    bool onBuilding = dB < p.y;

    if(onBuilding){
      float ix = cellIdx(p.x, CELL_X);
      float iz = cellIdx(p.z, CELL_Z);
      vec3 q = p; q.x = foldMod(p.x, CELL_X); q.z = foldMod(p.z, CELL_Z);
      float hSeed = hash11(ix*3.581 + iz*97.193 + 13.0);

      // Window grid on whichever face is more perpendicular to view.
      vec2 wuv = abs(nrm.x) > abs(nrm.z) ? q.zy : q.xy;
      float cellW = floor(wuv.x * 1.3);
      float cellH = floor(p.y * 1.05);
      float winHash = hash11(cellW*17.17 + cellH*9.181 + hSeed*131.0 + ix*3.0 + iz*7.0);

      // Distance band: near buildings <- low spectrum bands, far <- high bands.
      float bandDist = max(0.0, iz*CELL_Z - u_z);
      float bandIdx = clamp(floor(bandDist / BAND_SIZE), 0.0, float(${BAND_COUNT} - 1));
      float bandDensity = u_spectrum[int(bandIdx)];

      float litProb = clamp(0.10 + u_bass*0.34 + bandDensity*0.62 + (hSeed-0.5)*0.12, 0.04, 0.92);
      float windowOn = step(1.0 - litProb, winHash);
      float roofMask = smoothstep(0.55, 0.85, nrm.y);

      float hueBase = clamp(u_centroid + (hSeed-0.5)*0.16, 0.0, 1.0);
      vec3 winCol = neonHue(hueBase) * (0.6 + bandDensity*0.5);

      vec3 wallShade = vec3(0.02, 0.022, 0.035)
        * (0.55 + 0.45*clamp(dot(nrm, vec3(0.25, 0.7, -0.15)), 0.0, 1.0));

      col = wallShade
        + winCol * windowOn * (1.0 - roofMask) * (0.85 + u_bass*0.5)
        + vec3(0.01, 0.012, 0.02) * roofMask;
    } else {
      float lane = smoothstep(0.10, 0.0, abs(p.x));
      float seam = smoothstep(0.03, 0.0, abs(fract(p.z*0.5 + 0.5) - 0.5)*2.0);
      vec3 asphalt = vec3(0.018, 0.02, 0.028) + seam*0.01;
      col = asphalt + neonHue(u_centroid) * lane * 0.22 * (0.4 + u_level*0.5);
    }

    float fog = 1.0 - exp(-hit * 0.02);
    col = mix(col, skyDeep, fog);
  }

  // Kick: latch a world-z slice (set from JS on the trigger frame) and sweep a
  // local, decaying neon glow through it via mix() — never a full-screen strobe.
  float band = exp(-pow((worldZ - u_kickZ) * 0.09, 2.0));
  float flashAmt = clamp(band * u_kickPulse, 0.0, 1.0);
  col = mix(col, neonHue(u_centroid) * 1.35, flashAmt * 0.8);

  col *= 1.0 + u_level*0.08;
  o = vec4(col, 1.0);
}`;

export function createCity(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  const post = new PostFX(gl, tri, ctx.bindOutput);
  const spec = new Float32Array(BAND_COUNT);
  let rw = 1,
    rh = 1;
  let z = 0;
  let sway = 0;
  let kickZ = -9999;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
      post.resize(w, h);
    },
    frame(t, dt, audio: AudioEngine) {
      // level drives forward drive speed; a nonzero base keeps the street scrolling in silence.
      const speed = 1.6 + audio.level * 4.2;
      z += dt * speed;
      sway += dt * 0.17;
      if (audio.kick) kickZ = z + 11.0; // latch a slice just ahead of the camera

      for (let i = 0; i < BAND_COUNT; i++) spec[i] = Math.min(1.3, audio.spectrum[i] * 1.6);

      post.bind();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);
      gl.uniform2f(u.u_res, rw, rh);
      gl.uniform1f(u.u_z, z);
      gl.uniform1f(u.u_sway, sway);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1f(u.u_kickZ, kickZ);
      gl.uniform1f(u.u_kickPulse, audio.kickPulse);
      gl.uniform1fv(u.u_spectrum, spec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post.draw(rw, rh, {
        bloom: 0.75 + audio.level * 0.4,
        exposure: 1.05 + audio.kickPulse * 0.15,
        aberration: 0.0007 + audio.change * 0.002,
        grain: 0.04,
        vignette: 1.2,
        flash: audio.kickPulse * 0.15,
        threshold: 0.62,
        time: t,
      });
    },
  };
}
