// Resolume 4 manual pp. 9–11 names and observable behavior. The manual does not
// specify proprietary shader constants; docs/BLENDS.md records our choices.
const catalog = [
  ['normal', 'Alpha', 'color'],
  ['50-add', '50 Add', 'color', false],
  ['50-lighten', '50 Lighten', 'color', false],
  ['add', 'Add', 'color'],
  ['burn', 'Burn', 'color'],
  ['cube', 'Cube', 'spatial'],
  ['darken', 'Darken', 'color'],
  ['difference', 'Difference', 'color'],
  ['difference-invert', 'Difference I', 'color'],
  ['displace', 'Displace', 'spatial'],
  ['dodge', 'Dodge', 'color'],
  ['hard-light', 'HardLight', 'color'],
  ['lighten', 'Lighten', 'color'],
  ['lorez', 'LoRez', 'spatial'],
  ['luma-alpha', 'Luma is Alpha', 'key'],
  ['luma-key', 'Luma Key', 'key'],
  ['luma-key-invert', 'Luma Key I', 'key'],
  ['metamix', 'MetaMix', 'spatial'],
  ['multitask', 'MultiTask', 'spatial'],
  ['multiply', 'Multiply', 'color'],
  ['parts', 'Parts', 'spatial'],
  ['rgb', 'RGB', 'color'],
  ['rotate-x', 'Rotate X', 'spatial'],
  ['rotate-y', 'Rotate Y', 'spatial'],
  ['screen', 'Screen', 'color'],
  ['shift-rgb', 'Shift RGB', 'spatial'],
  ['soft-light', 'SoftLight', 'color'],
  ['static', 'Static', 'spatial'],
  ['subtract', 'Subtract', 'color'],
  ['tile', 'Tile', 'spatial'],
  ['time-switcher', 'TimeSwitcher', 'temporal'],
  ['wipe-down', 'Wipe Down', 'spatial'],
  ['wipe-ellipse', 'Wipe Ellipse', 'spatial'],
  ['wipe-left', 'Wipe Left', 'spatial'],
  ['wipe-right', 'Wipe Right', 'spatial'],
  ['wipe-up', 'Wipe Up', 'spatial'],
  ['zoom-in', 'Zoom In', 'spatial'],
  ['zoom-out', 'Zoom Out', 'spatial'],
  ['overlay', 'Overlay (legacy)', 'color'],
];
export const BLEND_MODES = Object.freeze([
  ...catalog.map(([id, label, category, transition = true], index) => Object.freeze({ id, label, category, index, transition, supported: true })),
  Object.freeze({ id: '50-mask', label: '50 Mask (unresolved)', category: 'key', index: -1, transition: false, supported: false }),
]);
export const BLEND_IDS = Object.freeze(BLEND_MODES.filter(mode => mode.supported).map(mode => mode.id));
export const TRANSITION_IDS = Object.freeze(BLEND_MODES.filter(mode => mode.supported && mode.transition).map(mode => mode.id));
const lookup = new Map(BLEND_MODES.filter(mode => mode.supported).map(mode => [mode.id, mode]));
const aliases = new Map(BLEND_MODES.filter(mode => mode.supported).flatMap(mode => [
  [mode.label.toLowerCase().replace(/[^a-z0-9]/g, ''), mode.id],
  [mode.id.replace(/-/g, ''), mode.id],
]));
aliases.set('alpha', 'normal');
// ISF transitions ("isf:<id>") are kept even before their shader loads; the
// engine crossfades until it is available.
const ISF_MODE = /^isf:[a-zA-Z0-9_:.-]{1,116}$/;
export const isIsfBlend = value => typeof value === 'string' && ISF_MODE.test(value);
export function normalizeBlend(value, fallback = 'normal') {
  if (isIsfBlend(value)) return value;
  const key = typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  return aliases.get(key) || (lookup.has(fallback) ? fallback : 'normal');
}
export function blendIndex(value) { return (lookup.get(normalizeBlend(value)) || lookup.get('normal')).index; }
const index = id => lookup.get(id).index;

// Inputs and output are premultiplied RGBA. The same shader serves layer mixing
// and two-clip transitions, with the latter always preserving exact endpoints.
export const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uBase;
uniform sampler2D uTop;
uniform int uBlend;
uniform float uOpacity;
uniform float uTime;
uniform vec2 uResolution;
uniform bool uTransition;
const float PI = 3.141592653589793;
vec3 straight(vec4 c) { return c.a > 0.00001 ? c.rgb/c.a : vec3(0.0); }
vec4 over(vec4 b, vec4 t) { return t+b*(1.0-t.a); }
vec4 at(sampler2D image, vec2 q) {
  if (any(lessThan(q,vec2(0.0))) || any(greaterThan(q,vec2(1.0)))) return vec4(0.0);
  return texture(image,q);
}
float luma(vec4 c) { return dot(straight(c),vec3(0.2126,0.7152,0.0722)); }
float hash(vec2 q) { return fract(sin(dot(q,vec2(127.1,311.7)))*43758.5453123); }
vec4 blended(vec4 b, vec4 t, vec3 color) {
  return vec4((1.0-t.a)*b.rgb+(1.0-b.a)*t.rgb+b.a*t.a*color,t.a+b.a*(1.0-t.a));
}
vec3 hardLight(vec3 b, vec3 t) { return mix(2.0*b*t,1.0-2.0*(1.0-b)*(1.0-t),step(vec3(0.5),t)); }
float dodge(float b,float t) { return b <= 0.0 ? 0.0 : t >= 1.0 ? 1.0 : min(1.0,b/(1.0-t)); }
float burn(float b,float t) { return b >= 1.0 ? 1.0 : t <= 0.0 ? 0.0 : 1.0-min(1.0,(1.0-b)/t); }
vec3 softLight(vec3 b,vec3 t) {
  vec3 d=mix(((16.0*b-12.0)*b+4.0)*b,sqrt(max(b,vec3(0.0))),step(vec3(0.25),b));
  return mix(b-(1.0-2.0*t)*b*(1.0-b),b+(2.0*t-1.0)*(d-b),step(vec3(0.5),t));
}
vec3 rotateY(vec3 q,float a) { float c=cos(a),s=sin(a);return vec3(c*q.x+s*q.z,q.y,-s*q.x+c*q.z); }
vec3 rotateX(vec3 q,float a) { float c=cos(a),s=sin(a);return vec3(q.x,c*q.y-s*q.z,s*q.y+c*q.z); }
vec4 panel(sampler2D image,vec3 center,float angle,bool aroundX,bool flip) {
  vec3 origin=vec3(0.0,0.0,2.0)-center;
  vec3 direction=vec3((uv-0.5)*2.0,-3.0);
  origin=aroundX?rotateX(origin,-angle):rotateY(origin,-angle);
  direction=aroundX?rotateX(direction,-angle):rotateY(direction,-angle);
  if(abs(direction.z)<0.00001)return vec4(0.0);
  float distance=-origin.z/direction.z;
  if(distance<=0.0)return vec4(0.0);
  vec2 q=(origin+direction*distance).xy+0.5;
  if(flip){if(aroundX)q.y=1.0-q.y;else q.x=1.0-q.x;}
  return at(image,q);
}
vec4 cube(float p) {
  vec3 origin=rotateY(vec3(0.0,0.0,2.0),-p*PI*0.5);
  vec3 direction=rotateY(vec3((uv-0.5)*2.0,-3.0),-p*PI*0.5);
  vec3 inverse=1.0/(sign(direction+vec3(0.0000001))*max(abs(direction),vec3(0.000001)));
  vec3 first=(-vec3(0.5)-origin)*inverse,last=(vec3(0.5)-origin)*inverse;
  vec3 near=min(first,last),far=max(first,last);
  float enter=max(max(near.x,near.y),near.z),leave=min(min(far.x,far.y),far.z);
  if(enter>leave||leave<0.0)return vec4(0.0);
  vec3 hit=origin+direction*max(enter,0.0);
  return abs(hit.x)>abs(hit.z)?at(uTop,vec2(hit.z+0.5,hit.y+0.5)):at(uBase,hit.xy+0.5);
}
vec4 channels(float p, bool shifted) {
  vec3 color=vec3(0.0),coverage=vec3(0.0);
  for(int channel=0;channel<3;channel++) {
    float start=float(2-channel)/3.0;
    float amount=clamp((p-start)*3.0,0.0,1.0);
    vec4 b=texture(uBase,uv),t=texture(uTop,uv);
    if(shifted){
      float distance=0.8+float(channel)*0.4;
      b=at(uBase,uv+vec2(p*distance,0.0));
      t=at(uTop,uv-vec2((1.0-p)*distance,0.0));
      amount=p;
    }
    color[channel]=mix(b[channel],t[channel],amount);
    coverage[channel]=mix(b.a,t.a,amount);
  }
  return vec4(color,max(max(coverage.r,coverage.g),coverage.b));
}
void main() {
  float p=clamp(uOpacity,0.0,1.0);
  vec4 base=texture(uBase,uv),top=texture(uTop,uv);
  vec4 incoming=uTransition?top:over(base,top);
  if(p<=0.0){frag=base;return;}
  if(uTransition&&p>=1.0){frag=top;return;}
  if(uBlend==${index('normal')}){frag=uTransition?mix(base,top,p):over(base,top*p);return;}
  vec3 b=straight(base),t=straight(top),color=t;
  bool colorMode=true;
  if(uBlend==${index('50-add')}||uBlend==${index('add')})color=min(b+t,vec3(1.0));
  else if(uBlend==${index('50-lighten')}||uBlend==${index('lighten')})color=max(b,t);
  else if(uBlend==${index('burn')})color=vec3(burn(b.r,t.r),burn(b.g,t.g),burn(b.b,t.b));
  else if(uBlend==${index('dodge')})color=vec3(dodge(b.r,t.r),dodge(b.g,t.g),dodge(b.b,t.b));
  else if(uBlend==${index('darken')})color=min(b,t);
  else if(uBlend==${index('difference')})color=abs(b-t);
  else if(uBlend==${index('difference-invert')})color=1.0-abs(b-t);
  else if(uBlend==${index('hard-light')})color=hardLight(b,t);
  else if(uBlend==${index('multiply')})color=b*t;
  else if(uBlend==${index('screen')})color=1.0-(1.0-b)*(1.0-t);
  else if(uBlend==${index('soft-light')})color=softLight(b,t);
  else if(uBlend==${index('subtract')})color=max(b+t-1.0,vec3(0.0));
  else if(uBlend==${index('overlay')})color=hardLight(t,b);
  else colorMode=false;
  if(colorMode){
    bool midpoint=uTransition||uBlend==${index('add')}||uBlend==${index('darken')}||uBlend==${index('difference')}||uBlend==${index('difference-invert')}||uBlend==${index('lighten')}||uBlend==${index('subtract')};
    vec4 combined=blended(base,top,color);
    frag=midpoint?(p<=0.5?mix(base,combined,p*2.0):mix(combined,incoming,p*2.0-1.0)):blended(base,top*p,color);
    return;
  }
  if(uBlend==${index('luma-alpha')}){
    vec4 combined=over(base,top*luma(top));
    frag=uTransition?(p<=0.5?mix(base,combined,p*2.0):mix(combined,top,p*2.0-1.0)):over(base,top*(p*luma(top)));return;
  }
  if(uBlend==${index('luma-key')}||uBlend==${index('luma-key-invert')}){
    float shown=uBlend==${index('luma-key')}?step(1.0-p,luma(top)):step(luma(top),p);
    frag=uTransition?mix(base,top,shown):over(base,top*shown);return;
  }
  if(uBlend==${index('time-switcher')}){
    float shown=step(0.5,fract(max(0.0,uTime)*(0.5+19.5*p)));
    frag=mix(base,incoming,shown);return;
  }
  if(p>=1.0&&uBlend!=${index('displace')}){frag=incoming;return;}
  if(uBlend==${index('cube')}){frag=cube(p);return;}
  if(uBlend==${index('rotate-x')}||uBlend==${index('rotate-y')}){
    bool x=uBlend==${index('rotate-x')};
    frag=p<0.5?panel(uBase,vec3(0.0,0.0,0.5),p*PI,x,false):panel(uTop,vec3(0.0,0.0,0.5),p*PI,x,true);return;
  }
  if(uBlend==${index('multitask')}){
    vec4 oldPanel=panel(uBase,vec3(-1.25*p,0.0,0.5-0.4*sin(p*PI)),-p*1.05,false,false);
    vec4 newPanel=panel(uTop,vec3(1.25*(1.0-p),0.0,0.5-0.4*sin(p*PI)),(1.0-p)*1.05,false,false);
    frag=p<0.5?over(newPanel,oldPanel):over(oldPanel,newPanel);return;
  }
  if(uBlend==${index('displace')}){
    float amplitude=(uTransition?sin(p*PI):p)*0.15*top.a;
    vec2 offset=(luma(top)-0.5)*2.0*amplitude*vec2(1.0,0.75);
    vec4 glass=texture(uBase,clamp(uv+offset,0.0,1.0));
    frag=uTransition?mix(glass,top,smoothstep(0.45,1.0,p)):glass;return;
  }
  if(uBlend==${index('lorez')}){
    float size=1.0+sin(p*PI)*min(uResolution.x,uResolution.y)*0.2;
    vec2 cells=max(vec2(2.0),uResolution/max(1.0,size));
    vec2 q=(floor(uv*cells)+0.5)/cells;
    frag=mix(texture(uBase,q),texture(uTop,q),smoothstep(0.35,0.65,p));return;
  }
  if(uBlend==${index('metamix')}){
    float copies=exp2(8.0*p);
    vec2 repeated=fract((uv-0.5)*copies+0.5);
    float collapse=smoothstep(0.35,1.0,p);
    float revealed=smoothstep(hash(floor(uv*copies))-0.1,hash(floor(uv*copies))+0.1,collapse);
    frag=mix(texture(uBase,repeated),top,revealed);return;
  }
  if(uBlend==${index('tile')}){
    float copies=exp2(floor(sin(p*PI)*3.999));
    vec2 q=fract(uv*copies),cell=floor(uv*copies);
    float revealed=smoothstep(hash(cell)-0.15,hash(cell)+0.15,p);
    frag=mix(texture(uBase,q),texture(uTop,q),revealed);return;
  }
  if(uBlend==${index('parts')}){frag=mix(base,incoming,step(hash(floor(uv*vec2(12.0,8.0))),p));return;}
  if(uBlend==${index('rgb')}){frag=channels(p,false);return;}
  if(uBlend==${index('shift-rgb')}){frag=channels(p,true);return;}
  if(uBlend==${index('static')}){
    float tick=floor(uTime*30.0),noise=hash(floor(uv*uResolution)+vec2(tick,tick*0.37));
    float distortion=sin(p*PI);
    vec2 q=vec2(fract(uv.x+(hash(vec2(floor(uv.y*uResolution.y),tick))-0.5)*0.2*distortion),uv.y);
    vec4 video=mix(texture(uBase,q),texture(uTop,q),step(noise,p));
    frag=mix(video,vec4(vec3(noise)*video.a,video.a),distortion*0.55);return;
  }
  if(uBlend==${index('wipe-ellipse')}){
    vec2 aspect=vec2(uResolution.x/max(1.0,uResolution.y),1.0);
    float radius=length(aspect*0.5)*p;
    float edge=1.0/max(1.0,uResolution.y);
    float shown=1.0-smoothstep(radius-edge,radius+edge,length((uv-0.5)*aspect));
    frag=mix(base,incoming,shown);return;
  }
  if(uBlend==${index('wipe-left')}||uBlend==${index('wipe-right')}||uBlend==${index('wipe-up')}||uBlend==${index('wipe-down')}){
    vec2 direction=uBlend==${index('wipe-left')}?vec2(1.0,0.0):uBlend==${index('wipe-right')}?vec2(-1.0,0.0):uBlend==${index('wipe-down')}?vec2(0.0,1.0):vec2(0.0,-1.0);
    frag=over(at(uBase,uv+direction*p),at(uTop,uv-direction*(1.0-p)));return;
  }
  if(uBlend==${index('zoom-in')}||uBlend==${index('zoom-out')}){
    float scale=uBlend==${index('zoom-in')}?1.0+15.0*sin(p*PI):1.0-0.9*sin(p*PI);
    vec2 q=(uv-0.5)/scale+0.5;
    frag=mix(at(uBase,q),at(uTop,q),smoothstep(0.4,0.6,p));return;
  }
  frag=uTransition?mix(base,top,p):over(base,top*p);
}`;
