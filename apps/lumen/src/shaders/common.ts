// Shared GLSL injected into multiple programs: Ashima 3D simplex noise, a
// divergence-free curl-noise flow field built from it, a hash, and a cosine
// palette. Kept as one string so every shader reads the same field.

export const COMMON_GLSL = `
// --- hash ---
float hash11(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
vec3 hash31(float p){
  vec3 p3=fract(vec3(p)*vec3(0.1031,0.1030,0.0973));
  p3+=dot(p3,p3.yzx+33.33);
  return fract((p3.xxy+p3.yzz)*p3.zyx);
}

// --- Ashima simplex noise 3D (https://github.com/ashima/webgl-noise, MIT) ---
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(
      i.z+vec4(0.0,i1.z,i2.z,1.0))
    + i.y+vec4(0.0,i1.y,i2.y,1.0))
    + i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 mq=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  mq*=mq;
  return 42.0*dot(mq*mq,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}

// Potential field -> curl gives a divergence-free (incompressible) flow.
vec3 potential(vec3 p, float t){
  float o = 31.7;
  vec3 a = vec3(snoise(p), snoise(p+o), snoise(p+2.0*o));
  vec3 b = vec3(snoise(p*0.5+t*0.1+11.0), snoise(p*0.5-t*0.1+5.0), snoise(p*0.5+7.0));
  return a + 0.5*b;
}
vec3 curlNoise(vec3 p, float t){
  const float e = 0.18;
  vec3 dx=vec3(e,0.,0.), dy=vec3(0.,e,0.), dz=vec3(0.,0.,e);
  vec3 px0=potential(p-dx,t), px1=potential(p+dx,t);
  vec3 py0=potential(p-dy,t), py1=potential(p+dy,t);
  vec3 pz0=potential(p-dz,t), pz1=potential(p+dz,t);
  float x=(py1.z-py0.z)-(pz1.y-pz0.y);
  float y=(pz1.x-pz0.x)-(px1.z-px0.z);
  float z=(px1.y-px0.y)-(py1.x-py0.x);
  return vec3(x,y,z)/(2.0*e);
}

vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){
  return a + b*cos(6.28318*(c*t+d));
}
`;
