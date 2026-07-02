// 93 MANDALA — spectral radial rings × kaleidoscope: each concentric ring maps
// to a spectrum band and pulses with its energy. N-fold rotational + mirror
// symmetry reconfigures on musical change; ornamental filigree shimmers between
// petals; jewel centre flashes on kick. Meditative, ornamental, breathing.

import { program, uniforms, FULLSCREEN_VS } from "../engine/gl.ts";
import type { Uniforms } from "../engine/gl.ts";
import { COMMON_GLSL } from "../engine/glsl.ts";
import { BAND_COUNT } from "../engine/audio.ts";
import type { Scene, SceneContext } from "../engine/scene.ts";
import type { AudioEngine } from "../engine/audio.ts";

const FS = `#version 300 es
precision highp float;
${COMMON_GLSL}
in vec2 v_uv;
uniform float u_time, u_aspect, u_sym, u_rings, u_rot;
uniform float u_bass, u_centroid, u_high, u_beat, u_level;
uniform float u_spec[${BAND_COUNT}];
out vec4 o;

void main(){
  // Aspect-correct centred coordinates; bass makes the mandala breathe outward
  float breathe = 1.0 + u_bass * 0.22;
  vec2 q = (v_uv - 0.5) * vec2(u_aspect, 1.0) * breathe;
  float r = length(q);
  float a = atan(q.y, q.x) + u_rot;

  // N-fold kaleidoscope: fold angle into a wedge then mirror within it
  float seg = 6.28318530718 / u_sym;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  // a in [0, pi/u_sym]

  // Map radial distance to spectrum band index
  float rf = r * u_rings;
  int ri = int(clamp(rf, 0.0, ${BAND_COUNT - 1}.0));
  float energy = u_spec[ri];

  // Petal: one cosine half-wave across the folded wedge.
  // Multiplying by u_sym*0.5 maps [0, pi/u_sym] to [0, pi/2] for any u_sym,
  // so the petal peaks at the wedge axis and fades at the edge.
  float petalVal = cos(a * u_sym * 0.5);
  // Wider petals when band energy is higher
  float thresh = 0.22 - energy * 0.38;
  float petal = smoothstep(thresh - 0.06, thresh + 0.06, petalVal);

  // Thin outlines at ring boundaries (rimming = dim at fract extremes)
  float ringFrac = fract(rf);
  float rim = smoothstep(0.0, 0.04, ringFrac) * smoothstep(1.0, 0.96, ringFrac);

  // Core brightness: band energy drives petal width + ambient inner glow
  float bright = rim * (energy * (0.45 + petal * 0.75) + 0.02);

  // Slow-rotating filigree in symmetry space (snoise honours fold)
  vec2 fp = vec2(cos(a), sin(a)) * r;
  float fg = snoise(vec3(fp * (2.2 + u_high * 5.0), u_time * 0.12));
  bright += (fg * 0.5 + 0.5) * 0.13 * (0.3 + energy * 0.7);

  // Kick ripple: a bright ring that expands from centre outward over the pulse
  float rippleR = (1.0 - u_beat) * 0.52;
  float ripple  = exp(-pow((r - rippleR) * 13.0, 2.0)) * u_beat;
  bright += ripple * 0.72;

  // Jewel-toned palette keyed by ring index + centroid + slow time drift
  float hue = float(ri) / float(${BAND_COUNT}) + u_centroid * 0.45 + u_time * 0.015;
  vec3 col = palette(hue,
    vec3(0.50, 0.40, 0.55),
    vec3(0.45, 0.42, 0.40),
    vec3(0.90, 0.75, 0.85),
    vec3(0.00, 0.20, 0.50)
  );
  col *= bright * (1.0 + u_level * 0.45);

  // Specular glint on high-energy petals
  col += vec3(0.88, 1.00, 0.92) * smoothstep(0.70, 1.0, petal * (0.5 + energy)) * 0.42;

  // Centre jewel: flash and colour-shift on kick
  float jewel = smoothstep(0.08, 0.0, r) * (0.50 + u_beat * 1.60);
  col += vec3(1.00, 0.88, 0.65) * jewel;
  col += vec3(0.50, 0.65, 1.00) * jewel * u_beat * 0.55;

  // Radial vignette
  col *= 1.0 - smoothstep(0.42, 1.05, r) * 0.68;

  // Gamma
  o = vec4(pow(max(col, vec3(0.0)), vec3(0.85)), 1.0);
}`;

export function createMandala(ctx: SceneContext): Scene {
  const { gl, tri } = ctx;
  const prog = program(gl, FULLSCREEN_VS, FS);
  const u: Uniforms = uniforms(gl, prog);
  let rw = 1;
  let rh = 1;
  let rot = 0;
  let sym = 12.0;
  let symTarget = 12.0;
  let lastChangeT = 0;

  return {
    resize(w, h) {
      rw = w;
      rh = h;
    },
    frame(t, dt, audio: AudioEngine) {
      // Rotation: base drift + level boosts speed + centroid adds slow wander
      rot += dt * (0.04 + audio.level * 0.22 + audio.centroid * 0.07);

      // Symmetry order steps on strong musical transitions, then eases
      if (audio.change > 0.45 && t - lastChangeT > 1.2) {
        // Even values 8..16 driven by spectral centroid
        symTarget = 8 + Math.round(audio.centroid * 4) * 2;
        lastChangeT = t;
      }
      sym += (symTarget - sym) * (1 - Math.exp(-dt * 1.8));

      ctx.bindOutput();
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(tri);

      gl.uniform1f(u.u_time, t);
      gl.uniform1f(u.u_aspect, rw / rh);
      gl.uniform1f(u.u_sym, sym);
      gl.uniform1f(u.u_rings, 40.0);
      gl.uniform1f(u.u_rot, rot);
      gl.uniform1f(u.u_bass, audio.bass);
      gl.uniform1f(u.u_centroid, audio.centroid);
      gl.uniform1f(u.u_high, audio.high);
      gl.uniform1f(u.u_beat, audio.kickPulse);
      gl.uniform1f(u.u_level, audio.level);
      gl.uniform1fv(u.u_spec, audio.spectrum);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
