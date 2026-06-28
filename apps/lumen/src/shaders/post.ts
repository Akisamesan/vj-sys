// Post chain: bright-pass -> separable gaussian blur (a couple of mips) -> composite
// with the HDR scene, applying chromatic aberration, vignette, film grain and an
// ACES-ish filmic tonemap.

export const BRIGHT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform float u_threshold, u_knee;
in vec2 v_uv;
out vec4 o;
void main(){
  vec3 c = texture(u_src, v_uv).rgb;
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  float soft = clamp(l - u_threshold + u_knee, 0.0, 2.0*u_knee);
  soft = soft*soft / (4.0*u_knee + 1e-4);
  float contrib = max(soft, l - u_threshold) / max(l, 1e-4);
  o = vec4(c * max(contrib, 0.0), 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_dir;   // texel-sized step along one axis
in vec2 v_uv;
out vec4 o;
void main(){
  // 9-tap gaussian
  float w[5];
  w[0]=0.227027; w[1]=0.1945946; w[2]=0.1216216; w[3]=0.054054; w[4]=0.016216;
  vec3 sum = texture(u_src, v_uv).rgb * w[0];
  for(int i=1;i<5;i++){
    vec2 off = u_dir * float(i);
    sum += texture(u_src, v_uv + off).rgb * w[i];
    sum += texture(u_src, v_uv - off).rgb * w[i];
  }
  o = vec4(sum, 1.0);
}`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_bloom1;
uniform sampler2D u_bloom2;
uniform vec2 u_res;
uniform float u_time;
uniform float u_bloomAmt, u_exposure, u_aberration, u_grain, u_vignette, u_flash;
in vec2 v_uv;
out vec4 o;

vec3 aces(vec3 x){
  float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);
}
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }

void main(){
  vec2 uv = v_uv;
  vec2 d = uv - 0.5;
  float r = dot(d,d);

  // Chromatic aberration grows toward the edges, pushed harder on flashes.
  float ab = u_aberration * (0.4 + r) * (1.0 + u_flash*2.0);
  vec2 dir = normalize(d + 1e-5);
  vec3 scene;
  scene.r = texture(u_scene, uv - dir*ab).r;
  scene.g = texture(u_scene, uv).g;
  scene.b = texture(u_scene, uv + dir*ab).b;

  vec3 bloom = texture(u_bloom1, uv).rgb + texture(u_bloom2, uv).rgb*0.7;
  vec3 col = scene + bloom * u_bloomAmt;
  col += u_flash * vec3(0.9,0.95,1.0) * 0.25;

  col *= u_exposure;
  col = aces(col);

  // Vignette.
  col *= 1.0 - r * u_vignette;

  // Film grain.
  float g = hash(uv*u_res + u_time*60.0) - 0.5;
  col += g * u_grain;

  col = pow(max(col,0.0), vec3(0.9));
  o = vec4(col, 1.0);
}`;
