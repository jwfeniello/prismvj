// Resolume-style parameter animation (manual pp. 141–145). The cogwheel opens
// a menu of modes; an animated parameter then expands inline with its own
// transport: direction, play mode, a mini timeline with a live playhead,
// in/out points, duration or beats, speed, and the animation range drawn as a
// bracket on the parameter's own slider. Audio Analysis shows the spectrum
// with L/M/H bands, gain and fall; Dashboard links to one of the 8 dials.
import { createAnimation, normalizeAnimation, ANIMATION_SHAPES, FFT_BANDS, BPM_SPEEDS } from '../animation.js';
import { resolvePath, findEffect } from '../params.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const FFT_LABELS = { external: 'External FFT', composition: 'Composition FFT', group: 'Group FFT', layer: 'Layer FFT', clip: 'Clip FFT' };
const PLAYMODES = [['loop', '⟳', 'Loop'], ['pingpong', '⇄', 'Bounce'], ['random', '⚄', 'Random'], ['once', '⇥', 'Play once']];
const SHAPE_LABELS = { ramp: 'Ramp', sine: 'Sine', triangle: 'Triangle', square: 'Square', random: 'Random', envelope: 'Envelope' };
const speedLabel = value => value === 0 ? '0' : value < 1 ? `1/${Math.round(1 / value)}` : `${value}×`;

// Which panel a parameter lives in decides its FFT and Clip Position options.
export function panelScope(project, path) {
  const [scope, id] = path.split('/');
  if (scope !== 'effect' && scope !== 'audiofx') return scope;
  const owner = findEffect(project, id, scope === 'audiofx')?.owner;
  if (!owner || owner === project) return 'composition';
  if ((project.groups || []).includes(owner)) return 'group';
  return project.layers.includes(owner) ? 'layer' : 'clip';
}

function save(target, animation) {
  target.owner.animations ||= {};
  if (animation) target.owner.animations[target.key] = normalizeAnimation(animation, target.param);
  else delete target.owner.animations[target.key];
}

// Items for the app's context menu: [label, action, disabled].
export function animationMenuItems(project, path, { changed, dashboardNames = [] }) {
  const target = resolvePath(project, path);
  if (!target) return [];
  const current = target.owner.animations?.[target.key] || null, panel = panelScope(project, path);
  const mark = (on, label) => `${on ? '✓' : '\u2007'} ${label}`;
  const set = change => () => {
    const base = current || createAnimation('timeline', target.param);
    save(target, change({ ...base, fft: { ...base.fft } }));
    changed(true);
  };
  const fftSources = ['external', 'composition', ...(panel === 'group' ? ['group'] : []), ...(panel === 'layer' || panel === 'clip' ? ['layer'] : []), ...(panel === 'clip' ? ['clip'] : [])];
  return [
    [mark(current?.mode === 'timeline', 'Timeline'), set(animation => ({ ...animation, mode: 'timeline' }))],
    [mark(current?.mode === 'bpm', 'BPM Sync'), set(animation => ({ ...animation, mode: 'bpm', speed: BPM_SPEEDS.includes(animation.speed) ? animation.speed : 1 }))],
    ...(panel === 'clip' ? [[mark(current?.mode === 'clip', 'Clip Position'), set(animation => ({ ...animation, mode: 'clip' }))]] : []),
    [mark(current?.mode === 'dashboard', 'Dashboard'), Array.from({ length: 8 }, (_, dial) => [mark(current?.mode === 'dashboard' && current.dial === dial, dashboardNames[dial] || `Dial ${dial + 1}`), set(animation => ({ ...animation, mode: 'dashboard', dial }))])],
    [mark(current?.mode === 'fft', 'Audio Analysis'), fftSources.map(source => [mark(current?.mode === 'fft' && current.fft.source === source, FFT_LABELS[source]), set(animation => ({ ...animation, mode: 'fft', fft: { ...animation.fft, source } }))])],
    ['-'],
    [mark(current?.shape === 'envelope', 'Envelope'), set(animation => ({ ...animation, shape: animation.shape === 'envelope' ? 'ramp' : 'envelope' })), !current || current.mode === 'dashboard'],
    ['Reset animation', () => { save(target, null); changed(true); }, !current],
  ];
}

export function inOutBarHTML(attribute, lo, hi) {
  return `<div class="inout-bar" ${attribute} title="Drag the ends to set in and out points; Shift-drag to move the range"><div class="inout-band" style="left:${lo * 100}%;width:${(hi - lo) * 100}%"><span class="inout-handle" data-handle="in"></span><span class="inout-handle" data-handle="out"></span></div></div>`;
}

// Dual-handle in/out bar. get() → [lo, hi]; set(lo, hi) applies them.
export function bindInOutBar(bar, get, set) {
  if (!bar) return;
  const band = bar.querySelector('.inout-band');
  const paint = () => { const [lo, hi] = get(); band.style.left = `${lo * 100}%`; band.style.width = `${(hi - lo) * 100}%`; };
  bar.onpointerdown = event => {
    event.preventDefault();
    const rect = bar.getBoundingClientRect(), at = x => clamp((x - rect.left) / rect.width);
    const [lo, hi] = get(), start = at(event.clientX);
    const handle = event.target.dataset.handle || (event.shiftKey ? 'range' : Math.abs(start - lo) < Math.abs(start - hi) ? 'in' : 'out');
    bar.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      const x = at(moveEvent.clientX);
      if (handle === 'range') { const width = hi - lo, left = clamp(lo + x - start, 0, 1 - width); set(left, left + width); }
      else if (handle === 'in') set(Math.min(x, get()[1] - 0.001), get()[1]);
      else set(get()[0], Math.max(x, get()[0] + 0.001));
      paint();
    };
    move(event);
    bar.onpointermove = move;
    bar.onpointerup = bar.onpointercancel = () => { bar.onpointermove = null; set(...get(), true); };
  };
}

function transportHTML(animation) {
  const bpm = animation.mode === 'bpm';
  return `<div class="anim-row">
      <div class="radio-group" role="radiogroup" aria-label="Direction">${[[-1, '◀', 'Backward'], [0, 'Ⅱ', 'Pause'], [1, '▶', 'Forward']].map(([value, icon, label]) => `<button data-anim-direction="${value}" class="${animation.direction === value ? 'active' : ''}" title="${label}" aria-pressed="${animation.direction === value}">${icon}</button>`).join('')}</div>
      <div class="radio-group" role="radiogroup" aria-label="Play mode">${PLAYMODES.map(([value, icon, label]) => `<button data-anim-loop="${value}" class="${animation.loop === value ? 'active' : ''}" title="${label}" aria-pressed="${animation.loop === value}">${icon}</button>`).join('')}</div>
      <span class="grow"></span>
      ${bpm ? `<div class="beat-field"><button data-anim-beats="half" title="Divide by 2">÷2</button><button data-anim-beats="minus" title="One beat less">−</button><input type="number" data-anim-field="beats" value="${animation.beats}" min="0.03125" max="4096" step="any" aria-label="Beats"><button data-anim-beats="plus" title="One beat more">+</button><button data-anim-beats="double" title="Multiply by 2">×2</button><span class="unit">beats</span></div>`
        : `<div class="beat-field"><input type="number" data-anim-field="duration" value="${Number(animation.duration.toFixed(3))}" min="0.01" max="86400" step="any" aria-label="Duration in seconds"><span class="unit">s</span></div>`}
    </div>
    ${animation.shape === 'envelope' ? '<canvas class="anim-envelope" data-anim-envelope width="320" height="64" title="Click to add a point, drag to move, right-click to delete"></canvas>'
      : `<div class="anim-timeline" data-anim-timeline><div class="anim-window" style="left:${animation.inPoint * 100}%;width:${(animation.outPoint - animation.inPoint) * 100}%"></div><div class="anim-playhead"></div></div>`}
    ${inOutBarHTML('data-anim-inout', animation.inPoint, animation.outPoint)}
    <div class="anim-row"><label class="anim-label">Speed</label>${bpm
      ? `<div class="radio-group speed-steps">${BPM_SPEEDS.map(value => `<button data-anim-speed="${value}" class="${animation.speed === value ? 'active' : ''}">${speedLabel(value)}</button>`).join('')}</div>`
      : `<input type="range" data-anim-field="speed" min="0" max="4" step="0.01" value="${animation.speed}" aria-label="Animation speed"><span class="anim-value">${animation.speed.toFixed(2)}</span>`}</div>`;
}

function stripHTML(path, animation, param) {
  const shape = animation.mode === 'dashboard' || (animation.mode === 'fft' && ['up', 'down'].includes(animation.fft.response)) ? ''
    : `<select data-anim-field="shape" class="anim-shape" aria-label="Curve">${ANIMATION_SHAPES.map(item => `<option value="${item}" ${item === animation.shape ? 'selected' : ''}>${SHAPE_LABELS[item]}</option>`).join('')}</select>`;
  const head = label => `<div class="anim-head"><span class="anim-mode">${label}</span>${shape}<span class="grow"></span>${['bool', 'choice'].includes(animation.valueType) ? `<label class="anim-check"><input type="checkbox" data-anim-flag="invert" ${animation.invert ? 'checked' : ''}> Invert</label>` : ''}</div>`;
  let body = '';
  if (animation.mode === 'timeline' || animation.mode === 'bpm') body = head(animation.mode === 'bpm' ? 'BPM Sync' : 'Timeline') + transportHTML(animation);
  else if (animation.mode === 'clip') body = `${head('Clip Position')}<div class="anim-timeline" data-anim-timeline><div class="anim-window" style="left:0;width:100%"></div><div class="anim-playhead"></div></div><small class="muted">Follows the clip's playhead, including scrubbing, speed and BeatLoopr.</small>`;
  else if (animation.mode === 'dashboard') {
    body = `${head('Dashboard')}<div class="anim-row"><select data-anim-field="dial" aria-label="Dashboard dial">${Array.from({ length: 8 }, (_, dial) => `<option value="${dial}" ${dial === animation.dial ? 'selected' : ''}>Dial ${dial + 1}</option>`).join('')}</select><div class="anim-meter"><span data-anim-meter></span></div></div>`;
  } else if (animation.mode === 'fft') {
    const fft = animation.fft;
    body = `${head(FFT_LABELS[fft.source])}<div class="anim-row">
        <div class="radio-group" aria-label="Frequency band">${Object.entries(FFT_BANDS).map(([name, [lo, hi]]) => `<button data-anim-band="${name}" class="${Math.abs(fft.lo - lo) < 1e-3 && Math.abs(fft.hi - hi) < 1e-3 ? 'active' : ''}" title="${{ low: 'Low', mid: 'Middle', high: 'High' }[name]} frequencies">${name[0].toUpperCase()}</button>`).join('')}</div>
        <div class="radio-group" aria-label="Response">${[['up', '>', 'Low to high'], ['down', '<', 'High to low'], ['speed-', '−', 'Audio drives speed backward'], ['speed+', '+', 'Audio drives speed forward']].map(([value, icon, label]) => `<button data-anim-response="${value}" class="${fft.response === value ? 'active' : ''}" title="${label}">${icon}</button>`).join('')}</div>
        <span class="grow"></span><div class="anim-meter"><span data-anim-meter></span></div></div>
      <canvas class="anim-spectrum" data-anim-spectrum width="320" height="54" title="Drag to choose the frequency range"></canvas>
      <div class="anim-row"><label class="anim-label">Gain</label><input type="range" data-anim-fft="gain" min="0" max="16" step="0.05" value="${fft.gain}"><label class="anim-label">Fall</label><input type="range" data-anim-fft="fall" min="0" max="1" step="0.01" value="${fft.fall}"></div>
      ${['speed+', 'speed-'].includes(fft.response) ? `<div class="anim-timeline" data-anim-timeline><div class="anim-window" style="left:0;width:100%"></div><div class="anim-playhead"></div></div>` : ''}`;
  }
  return `<div class="anim-strip" data-anim-strip="${esc(path)}" data-param-type="${esc(param.type)}">${body}</div>`;
}

// Insert strips and range brackets for every animated control in `host`.
// ctx: { getProject, changed(structural), animator, pixelScale(key), spectrum(source) }
export function decorateAnimations(host, ctx) {
  const project = ctx.getProject(), live = [];
  for (const cog of host.querySelectorAll('.param-cog.animated')) {
    const path = cog.dataset.animatePath, target = resolvePath(project, path);
    const animation = target?.owner.animations?.[target.key];
    if (!animation) continue;
    const row = cog.closest('.param-row, .field, .effect-head');
    if (!row) continue;
    row.classList.add('is-animated');
    row.insertAdjacentHTML('afterend', stripHTML(path, animation, target.param));
    const strip = row.nextElementSibling;
    const range = row.querySelector('input[type="range"]');
    let bracket = null;
    if (range && (target.param.type === 'float' || target.param.type === 'int')) bracket = addBracket(row, range, target, animation, ctx);
    bindStrip(strip, path, ctx);
    live.push({ strip, path, animation, bracket, playhead: strip.querySelector('.anim-playhead'), meter: strip.querySelector('[data-anim-meter]'), spectrum: strip.querySelector('[data-anim-spectrum]'), envelope: strip.querySelector('[data-anim-envelope]') });
  }
  host.animationStrips = live;
}

function addBracket(row, range, target, animation, ctx) {
  const scale = range.dataset.unit === 'pixels' ? ctx.pixelScale(target.key) : 1;
  const min = Number(range.min), max = Number(range.max);
  const fraction = value => clamp((value * scale - min) / (max - min || 1));
  const bracket = document.createElement('div');
  bracket.className = 'anim-bracket';
  bracket.title = 'Animation range: drag either end. Drag one end past the other to invert.';
  bracket.innerHTML = '<span class="anim-bracket-band"></span><span class="anim-bracket-handle" data-end="min"></span><span class="anim-bracket-handle" data-end="max"></span>';
  row.append(bracket);
  const place = () => {
    const current = target.owner.animations?.[target.key] || animation;
    bracket.style.left = `${range.offsetLeft}px`; bracket.style.width = `${range.offsetWidth}px`; bracket.style.top = `${range.offsetTop}px`; bracket.style.height = `${range.offsetHeight}px`;
    const a = fraction(current.min), b = fraction(current.max);
    bracket.querySelector('.anim-bracket-band').style.cssText = `left:${Math.min(a, b) * 100}%;width:${Math.abs(b - a) * 100}%`;
    bracket.querySelector('[data-end="min"]').style.left = `${a * 100}%`;
    bracket.querySelector('[data-end="max"]').style.left = `${b * 100}%`;
    bracket.classList.toggle('inverted', current.min > current.max);
  };
  requestAnimationFrame(place);
  for (const handle of bracket.querySelectorAll('[data-end]')) handle.onpointerdown = event => {
    event.preventDefault(); event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    const end = handle.dataset.end;
    handle.onpointermove = move => {
      const rect = range.getBoundingClientRect(), f = clamp((move.clientX - rect.left) / rect.width);
      const value = (min + f * (max - min)) / scale;
      const current = target.owner.animations[target.key];
      save(target, { ...current, [end]: target.param.type === 'int' ? Math.round(value) : value });
      animation = target.owner.animations[target.key];
      place(); ctx.changed(false);
    };
    handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; ctx.changed(true, { keepPanels: true }); };
  };
  return { place };
}

function bindStrip(strip, path, ctx) {
  const target = () => resolvePath(ctx.getProject(), path);
  const current = () => { const t = target(); return t?.owner.animations?.[t.key]; };
  const update = (change, rerender = false) => {
    const t = target(), animation = current();
    if (!t || !animation) return;
    const next = { ...animation, fft: { ...animation.fft }, points: animation.points.map(point => [...point]) };
    change(next);
    save(t, next);
    ctx.changed(rerender, { keepPanels: !rerender });
  };
  for (const button of strip.querySelectorAll('[data-anim-direction]')) button.onclick = () => update(a => { a.direction = Number(button.dataset.animDirection); }, true);
  for (const button of strip.querySelectorAll('[data-anim-loop]')) button.onclick = () => update(a => { a.loop = button.dataset.animLoop; }, true);
  for (const button of strip.querySelectorAll('[data-anim-speed]')) button.onclick = () => update(a => { a.speed = Number(button.dataset.animSpeed); }, true);
  for (const button of strip.querySelectorAll('[data-anim-beats]')) button.onclick = () => update(a => {
    const op = button.dataset.animBeats;
    a.beats = clamp(op === 'half' ? a.beats / 2 : op === 'double' ? a.beats * 2 : op === 'plus' ? Math.floor(a.beats) + 1 : Math.max(1, Math.ceil(a.beats) - 1), 0.03125, 4096);
  }, true);
  for (const button of strip.querySelectorAll('[data-anim-band]')) button.onclick = () => update(a => { [a.fft.lo, a.fft.hi] = FFT_BANDS[button.dataset.animBand]; }, true);
  for (const button of strip.querySelectorAll('[data-anim-response]')) button.onclick = () => update(a => { a.fft.response = button.dataset.animResponse; }, true);
  for (const input of strip.querySelectorAll('[data-anim-field]')) {
    const live = input.type === 'range';
    input[live ? 'oninput' : 'onchange'] = () => update(a => {
      const field = input.dataset.animField;
      a[field] = field === 'shape' ? input.value : Number(input.value);
      if (live) input.nextElementSibling && (input.nextElementSibling.textContent = Number(input.value).toFixed(2));
    }, !live);
  }
  for (const input of strip.querySelectorAll('[data-anim-fft]')) input.oninput = () => update(a => { a.fft[input.dataset.animFft] = Number(input.value); });
  for (const input of strip.querySelectorAll('[data-anim-flag]')) input.onchange = () => update(a => { a[input.dataset.animFlag] = input.checked; });
  bindInOutBar(strip.querySelector('[data-anim-inout]'), () => { const a = current(); return [a.inPoint, a.outPoint]; }, (lo, hi, done) => {
    update(a => { a.inPoint = lo; a.outPoint = hi; }, false);
    const window = strip.querySelector('.anim-window');
    if (window) { window.style.left = `${lo * 100}%`; window.style.width = `${(hi - lo) * 100}%`; }
    if (done) ctx.changed(true, { keepPanels: true });
  });
  const spectrum = strip.querySelector('[data-anim-spectrum]');
  if (spectrum) spectrum.onpointerdown = event => {
    const rect = spectrum.getBoundingClientRect(), at = x => clamp((x - rect.left) / rect.width), start = at(event.clientX);
    spectrum.setPointerCapture(event.pointerId);
    spectrum.onpointermove = move => { const x = at(move.clientX); update(a => { a.fft.lo = Math.min(start, x); a.fft.hi = Math.max(start, x, Math.min(start, x) + 0.01); }); };
    spectrum.onpointerup = () => { spectrum.onpointermove = null; ctx.changed(true, { keepPanels: false }); };
  };
  const envelope = strip.querySelector('[data-anim-envelope]');
  if (envelope) bindEnvelope(envelope, current, points => update(a => { a.points = points; }));
}

function bindEnvelope(canvas, current, setPoints) {
  let dragging = -1;
  const at = event => { const rect = canvas.getBoundingClientRect(); return [clamp((event.clientX - rect.left) / rect.width), clamp(1 - (event.clientY - rect.top) / rect.height)]; };
  const nearest = ([x, y]) => current().points.findIndex(point => Math.hypot((point[0] - x) * canvas.clientWidth, (point[1] - y) * canvas.clientHeight) < 8);
  canvas.oncontextmenu = event => event.preventDefault();
  canvas.onpointerdown = event => {
    const point = at(event), index = nearest(point), points = current().points.map(item => [...item]);
    if (event.button === 2) { if (index >= 0 && points.length > 2) setPoints(points.filter((_, i) => i !== index)); return; }
    if (index >= 0) dragging = index;
    else { points.push(point); points.sort((a, b) => a[0] - b[0]); setPoints(points); dragging = current().points.findIndex(item => item[0] === point[0] && item[1] === point[1]); }
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (dragging < 0) return;
    const points = current().points.map(item => [...item]), point = at(event);
    const lo = dragging > 0 ? points[dragging - 1][0] : 0, hi = dragging < points.length - 1 ? points[dragging + 1][0] : 1;
    points[dragging] = [clamp(point[0], lo, hi), point[1]];
    setPoints(points);
  };
  canvas.onpointerup = canvas.onpointercancel = () => { dragging = -1; };
}

function drawEnvelope(canvas, animation, phase) {
  const context = canvas.getContext('2d'), w = canvas.width, h = canvas.height, points = animation.points;
  context.clearRect(0, 0, w, h);
  context.fillStyle = 'rgba(132,255,212,.08)';
  context.fillRect(animation.inPoint * w, 0, (animation.outPoint - animation.inPoint) * w, h);
  context.strokeStyle = '#84ffd4'; context.lineWidth = 2; context.beginPath();
  points.forEach(([x, y], index) => {
    const px = x * w, py = (1 - y) * (h - 4) + 2;
    if (index === 0) context.moveTo(px, py);
    else if (animation.stepped) { context.lineTo(px, (1 - points[index - 1][1]) * (h - 4) + 2); context.lineTo(px, py); } else context.lineTo(px, py);
  });
  context.stroke();
  context.fillStyle = '#e8fff7';
  for (const [x, y] of points) context.fillRect(x * w - 3, (1 - y) * (h - 4) + 2 - 3, 6, 6);
  context.fillStyle = '#ffffff'; context.fillRect(phase * w - 1, 0, 2, h);
}

function drawSpectrum(canvas, animation, spectrum, level) {
  const context = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  context.clearRect(0, 0, w, h);
  context.fillStyle = 'rgba(132,255,212,.14)';
  context.fillRect(animation.fft.lo * w, 0, (animation.fft.hi - animation.fft.lo) * w, h);
  if (spectrum) {
    const bar = w / spectrum.length;
    for (let i = 0; i < spectrum.length; i++) {
      const inside = i / spectrum.length >= animation.fft.lo && i / spectrum.length < animation.fft.hi;
      context.fillStyle = inside ? '#84ffd4' : '#4c5a56';
      context.fillRect(i * bar, h - spectrum[i] * h, Math.max(1, bar - 1), spectrum[i] * h);
    }
  } else { context.fillStyle = '#7d8a87'; context.font = '11px Segoe UI, sans-serif'; context.fillText('No audio on this input', 8, h / 2 + 4); }
  context.fillStyle = '#ffffff';
  context.fillRect(0, h - 3, clamp(level) * w, 3);
}

// Per-frame: move playheads, meters, spectra and envelope cursors.
export function updateAnimationStrips(host, ctx) {
  for (const item of host.animationStrips || []) {
    if (!item.strip.isConnected) continue;
    const t = resolvePath(ctx.getProject(), item.path), animation = t?.owner.animations?.[t.key];
    if (!animation) continue;
    const phase = ctx.animator.phase(animation);
    if (item.playhead) item.playhead.style.left = `${clamp(phase) * 100}%`;
    if (item.meter) item.meter.style.width = `${clamp(animation.mode === 'fft' ? ctx.animator.level(animation) * animation.fft.gain : phase) * 100}%`;
    if (item.envelope) drawEnvelope(item.envelope, animation, phase);
    if (item.spectrum) drawSpectrum(item.spectrum, animation, ctx.spectrum(animation.fft.source), ctx.animator.level(animation));
  }
}
