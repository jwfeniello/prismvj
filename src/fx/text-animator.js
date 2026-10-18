// Text Animator source (Resolume's Text Animator): draws text into a reused 2D
// canvas that the engine uploads as a layer texture. Transparent background,
// straight alpha.
//
// Params use the types from shader-template.js plus one extra type:
//   'text' -> { key, label, type: 'text', default: string, maxLength }
//   A plain string ('\n' starts a new line). It is never a shader uniform.
//
// Position X/Y are normalized to the frame (0,0 = top-left, 1,1 = bottom-right)
// and Alignment says which side of the text sits on Position X. Size is a
// fraction of the frame height, Spacing X (tracking) is in em and Spacing Y
// (leading) is a line-height multiplier. With Animate on, each unit chosen by
// Range (character, word, line or all) gets scale/rotation/offset/opacity/colour
// scaled by curve((time - delay * order) * speed), so a frame is a pure function
// of time and can be scrubbed.

import { colorToVec4, normalizeParam } from './shader-template.js';

export const TEXT_FONTS = Object.freeze([
  Object.freeze({ label: 'Sans Serif', family: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif" }),
  Object.freeze({ label: 'Serif', family: "Georgia, 'Times New Roman', serif" }),
  Object.freeze({ label: 'Monospace', family: "Consolas, 'Courier New', monospace" }),
  Object.freeze({ label: 'Condensed', family: "'Arial Narrow', 'Roboto Condensed', sans-serif" }),
  Object.freeze({ label: 'Impact', family: "Impact, Haettenschweiler, 'Arial Black', sans-serif" }),
]);

const CURVES = ['Sine', 'Triangle', 'Saw', 'Square', 'Bounce', 'Ease In Out'];

const num = (key, label, def, min, max) => Object.freeze({ key, label, type: 'float', min, max, default: def });
const pick = (key, label, options, def = 0) => Object.freeze({ key, label, type: 'choice', options: Object.freeze(options), default: def });

export const TEXT_ANIMATOR = Object.freeze({
  id: 'text-animator',
  name: 'Text Animator',
  category: 'Text',
  kind: 'canvas',
  params: Object.freeze([
    Object.freeze({ key: 'text', label: 'Text', type: 'text', default: 'PrismVJ', maxLength: 4000 }),
    pick('font', 'Font', TEXT_FONTS.map(font => font.label)),
    pick('style', 'Style', ['Regular', 'Bold', 'Italic', 'Bold Italic'], 1),
    Object.freeze({ key: 'color', label: 'Color', type: 'color', default: '#ffffff' }),
    num('size', 'Size', 0.18, 0.01, 1),
    pick('alignment', 'Alignment', ['Left', 'Center', 'Right'], 1),
    num('x', 'Position X', 0.5, 0, 1),
    num('y', 'Position Y', 0.5, 0, 1),
    num('spacingX', 'Spacing X', 0, -0.5, 2),
    num('spacingY', 'Spacing Y', 1.2, 0.5, 4),
    Object.freeze({ key: 'animate', label: 'Animate', type: 'bool', default: false }),
    pick('curve', 'Curve', CURVES),
    num('speed', 'Speed', 0.5, 0, 10),
    num('delay', 'Delay', 0.08, 0, 2),
    pick('order', 'Order', ['Front To Back', 'Back To Front', 'Random']),
    pick('range', 'Range', ['Character', 'Word', 'Line', 'All']),
    num('animScale', 'Scale', 0, -1, 4),
    num('animRotation', 'Rotation', 0, -360, 360),
    num('animX', 'Offset X', 0, -4, 4),
    num('animY', 'Offset Y', 0.5, -4, 4),
    num('animOpacity', 'Opacity', 0, 0, 1),
    Object.freeze({ key: 'animColor', label: 'Animate Color', type: 'color', default: '#ff6a38' }),
    num('animColorAmount', 'Color Amount', 0, 0, 1),
  ]),
});

function normalizeTextParam(param, value) {
  if (param.type === 'text') return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').slice(0, param.maxLength) : param.default;
  return normalizeParam(param, value);
}

export function normalizeTextParams(values) {
  const input = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  return Object.fromEntries(TEXT_ANIMATOR.params.map(param => [param.key, normalizeTextParam(param, input[param.key])]));
}

const fract = value => value - Math.floor(value);

function curveValue(curve, u) {
  if (curve === 1) return 1 - Math.abs(2 * fract(u) - 1);
  if (curve === 2) return fract(u);
  if (curve === 3) return fract(u) < 0.5 ? 0 : 1;
  if (curve === 4) return Math.abs(Math.sin(Math.PI * u));
  if (curve === 5) { const t = 1 - Math.abs(2 * fract(u) - 1); return t * t * (3 - 2 * t); }
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
}

function shuffled(count) {
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  let seed = (count * 2654435761) >>> 0 || 1;
  for (let i = count - 1; i > 0; i--) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    const j = seed % (i + 1);
    const swap = order[i]; order[i] = order[j]; order[j] = swap;
  }
  return order;
}

const PALETTE_STEPS = 32;
const WHITESPACE = /\s/;

export class TextAnimator {
  constructor({ canvas } = {}) {
    this.canvas = canvas || (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas'));
    this.ctx = this.canvas.getContext('2d');
    this.values = {};
    this.layout = null;
    this.layoutCount = 0;
    this.palette = null;
    this.paletteKey = '';
    this.ctxFont = '';
  }

  _read(params) {
    const input = params && typeof params === 'object' ? params : {};
    for (const param of TEXT_ANIMATOR.params) this.values[param.key] = normalizeTextParam(param, input[param.key]);
    return this.values;
  }

  _font(font) {
    if (this.ctxFont !== font) { this.ctx.font = font; this.ctxFont = font; }
  }

  _layoutFor(v, fontPx) {
    const cached = this.layout;
    if (cached && cached.text === v.text && cached.fontIndex === v.font && cached.style === v.style && cached.fontPx === fontPx && cached.spacingX === v.spacingX) return cached;
    const ctx = this.ctx;
    const italic = v.style >= 2 ? 'italic ' : '', bold = v.style % 2 === 1 ? 'bold ' : '';
    const font = `${italic}${bold}${fontPx}px ${TEXT_FONTS[v.font].family}`;
    this._font(font);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const tracking = v.spacingX * fontPx;
    const lineTexts = v.text.split('\n');
    const lines = lineTexts.length;
    const chars = [], xs = [], ws = [], lineOf = [], wordOf = [], wordLeft = [], wordRight = [];
    const lineWidth = new Float32Array(lines);
    let word = -1;
    lineTexts.forEach((text, k) => {
      const glyphs = Array.from(text);
      let prefix = '', inWord = false;
      glyphs.forEach((ch, i) => {
        const x = (prefix ? ctx.measureText(prefix).width : 0) + i * tracking;
        prefix += ch;
        if (WHITESPACE.test(ch)) { inWord = false; return; }
        const w = ctx.measureText(ch).width;
        if (!inWord) { word++; inWord = true; wordLeft.push(x); wordRight.push(x + w); }
        else wordRight[word] = x + w;
        chars.push(ch); xs.push(x); ws.push(w); lineOf.push(k); wordOf.push(word);
      });
      lineWidth[k] = glyphs.length ? ctx.measureText(text).width + (glyphs.length - 1) * tracking : 0;
    });
    const metrics = ctx.measureText('Mg');
    const ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || fontPx * 0.8;
    const descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || fontPx * 0.2;
    this.layoutCount++;
    this.layout = {
      text: v.text, fontIndex: v.font, style: v.style, fontPx, spacingX: v.spacingX, font,
      count: chars.length, chars, lines, lineTexts, lineWidth, blockWidth: Math.max(0, ...lineWidth),
      x: Float32Array.from(xs), w: Float32Array.from(ws), line: Int32Array.from(lineOf), word: Int32Array.from(wordOf),
      words: word + 1, wordCenter: Float32Array.from(wordLeft, (left, i) => (left + wordRight[i]) / 2),
      ascent, descent, random: [null, null, null, null],
    };
    return this.layout;
  }

  _palette(base, target) {
    const key = base + target;
    if (this.paletteKey === key) return this.palette;
    const a = colorToVec4(base), b = colorToVec4(target);
    this.palette = Array.from({ length: PALETTE_STEPS + 1 }, (_, i) => {
      const t = i / PALETTE_STEPS, mix = c => a[c] + (b[c] - a[c]) * t;
      return `rgba(${Math.round(mix(0) * 255)},${Math.round(mix(1) * 255)},${Math.round(mix(2) * 255)},${mix(3).toFixed(3)})`;
    });
    this.paletteKey = key;
    return this.palette;
  }

  render(params, timeSeconds = 0, width = 1920, height = 1080) {
    const canvas = this.canvas, ctx = this.ctx;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      this.ctxFont = '';
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    const v = this._read(params);
    const fontPx = Math.max(1, Math.round(v.size * h * 100) / 100);
    const L = this._layoutFor(v, fontPx);
    if (!L.count) return canvas;
    this._font(L.font);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = v.color;
    const lineHeight = fontPx * v.spacingY;
    const blockHeight = (L.lines - 1) * lineHeight + L.ascent + L.descent;
    const top = v.y * h - blockHeight / 2;
    const anchorX = v.x * w;
    const align = v.alignment * 0.5;
    const midOffset = (L.ascent - L.descent) / 2;

    if (!v.animate) {
      if (v.spacingX === 0) {
        for (let k = 0; k < L.lines; k++) if (L.lineTexts[k]) ctx.fillText(L.lineTexts[k], anchorX - L.lineWidth[k] * align, top + L.ascent + k * lineHeight);
      } else {
        for (let g = 0; g < L.count; g++) {
          const k = L.line[g];
          ctx.fillText(L.chars[g], anchorX - L.lineWidth[k] * align + L.x[g], top + L.ascent + k * lineHeight);
        }
      }
      return canvas;
    }

    const range = v.range;
    const groups = range === 0 ? L.count : range === 1 ? L.words : range === 2 ? L.lines : 1;
    let random = null;
    if (v.order === 2) random = L.random[range] || (L.random[range] = shuffled(groups));
    const palette = v.animColorAmount > 0 ? this._palette(v.color, v.animColor) : null;
    const rotation = v.animRotation * Math.PI / 180;
    const allX = anchorX + L.blockWidth * (0.5 - align), allY = top + blockHeight / 2;
    for (let g = 0; g < L.count; g++) {
      const k = L.line[g];
      const left = anchorX - L.lineWidth[k] * align, baseline = top + L.ascent + k * lineHeight;
      const group = range === 0 ? g : range === 1 ? L.word[g] : range === 2 ? k : 0;
      let px = allX, py = allY;
      if (range === 0) { px = left + L.x[g] + L.w[g] / 2; py = baseline - midOffset; }
      else if (range === 1) { px = left + L.wordCenter[group]; py = baseline - midOffset; }
      else if (range === 2) { px = left + L.lineWidth[k] / 2; py = baseline - midOffset; }
      const index = random ? random[group] : v.order === 1 ? groups - 1 - group : group;
      const c = curveValue(v.curve, (timeSeconds - v.delay * index) * v.speed);
      const alpha = Math.min(1, Math.max(0, 1 - v.animOpacity * c));
      const scale = Math.max(0, 1 + v.animScale * c);
      if (alpha <= 0 || scale <= 0) continue;
      const cos = Math.cos(rotation * c) * scale, sin = Math.sin(rotation * c) * scale;
      const tx = px + v.animX * c * fontPx, ty = py - v.animY * c * fontPx;
      ctx.setTransform(cos, sin, -sin, cos, tx - (cos * px - sin * py), ty - (sin * px + cos * py));
      ctx.globalAlpha = alpha;
      if (palette) ctx.fillStyle = palette[Math.round(c * v.animColorAmount * PALETTE_STEPS)];
      ctx.fillText(L.chars[g], left + L.x[g], baseline);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    return canvas;
  }

  dispose() {
    if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
    this.canvas = null;
    this.ctx = null;
    this.layout = null;
    this.palette = null;
  }
}
