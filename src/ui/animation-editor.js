// Animation editor opened from a parameter's cogwheel (manual pp. 141–145).
import { createAnimation, normalizeAnimation, ANIMATION_LOOPS, ANIMATION_SHAPES, FFT_SOURCES, FFT_RESPONSES, FFT_BANDS } from '../animation.js';
import { resolvePath } from '../params.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODE_LABELS = { off: 'Off', timeline: 'Timeline', bpm: 'BPM Sync', clip: 'Clip Position', fft: 'Audio Analysis (FFT)', dashboard: 'Dashboard' };
let open = null;

export function closeAnimationEditor() { open?.close(); }

// ctx: { getProject, changed(structural), spectrum(source, id) → Float32Array|null, dashboardLabels(owner path) }
export function openAnimationEditor(anchor, path, ctx) {
  closeAnimationEditor();
  const target = resolvePath(ctx.getProject(), path);
  if (!target) return null;
  const { owner, key, param, scope } = target;
  const panel = document.createElement('div');
  panel.className = 'animation-editor';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', `Animate ${param.label || key}`);
  document.body.append(panel);
  const modes = ['off', 'timeline', 'bpm', ...(scope === 'clip' || path.includes('clip/') ? ['clip'] : []), 'fft', 'dashboard'];
  const numeric = param.type === 'float' || param.type === 'int';
  let raf = 0;

  const current = () => owner.animations?.[key] || null;
  const save = (animation, structural = false) => {
    owner.animations ||= {};
    if (animation) owner.animations[key] = normalizeAnimation(animation, param);
    else delete owner.animations[key];
    ctx.changed(structural);
  };

  function render() {
    const animation = current(), mode = animation?.mode || 'off';
    const field = (label, html) => `<label class="anim-field"><span>${label}</span>${html}</label>`;
    const number = (name, value, min, max, step = 'any') => `<input type="number" data-anim="${name}" value="${value}" min="${min}" max="${max}" step="${step}">`;
    let html = `<header><strong>${esc(param.label || key)}</strong><button data-anim-close title="Close">×</button></header>
      ${field('Mode', `<select data-anim-mode>${modes.map(item => `<option value="${item}" ${item === mode ? 'selected' : ''}>${MODE_LABELS[item]}</option>`).join('')}</select>`)}`;
    if (animation) {
      if (numeric) html += `<div class="anim-pair">${field('Min', number('min', animation.min, param.min ?? -65536, param.max ?? 65536))}${field('Max', number('max', animation.max, param.min ?? -65536, param.max ?? 65536))}</div>`;
      html += `<label class="anim-check"><input type="checkbox" data-anim-flag="invert" ${animation.invert ? 'checked' : ''}> Invert</label>`;
      if (mode === 'timeline' || mode === 'bpm') {
        html += `<div class="anim-transport">${[[-1, '◀'], [0, 'Ⅱ'], [1, '▶']].map(([value, label]) => `<button data-anim-direction="${value}" class="${animation.direction === value ? 'active' : ''}">${label}</button>`).join('')}
          <select data-anim="loop">${ANIMATION_LOOPS.map(item => `<option ${item === animation.loop ? 'selected' : ''}>${item}</option>`).join('')}</select></div>`;
        html += mode === 'timeline' ? field('Duration (s)', number('duration', animation.duration, 0.01, 86400)) : field('Beats', number('beats', animation.beats, 0.03125, 4096));
        html += field('Speed', number('speed', animation.speed, 0, 16));
        html += `<div class="anim-pair">${field('In', number('inPoint', animation.inPoint, 0, 0.999, 0.01))}${field('Out', number('outPoint', animation.outPoint, 0.001, 1, 0.01))}</div>`;
      }
      if (mode === 'fft') {
        const fft = animation.fft;
        html += field('Input', `<select data-anim-fft="source">${FFT_SOURCES.map(item => `<option ${item === fft.source ? 'selected' : ''}>${item}</option>`).join('')}</select>`);
        html += `<div class="anim-bands">${Object.entries(FFT_BANDS).map(([name, [lo, hi]]) => `<button data-anim-band="${name}" class="${Math.abs(fft.lo - lo) < 1e-3 && Math.abs(fft.hi - hi) < 1e-3 ? 'active' : ''}">${name[0].toUpperCase()}</button>`).join('')}
          <select data-anim-fft="response" title="Response">${FFT_RESPONSES.map(item => `<option value="${item}" ${item === fft.response ? 'selected' : ''}>${{ up: '> low to high', down: '< high to low', 'speed+': '+ speed forward', 'speed-': '- speed backward' }[item]}</option>`).join('')}</select></div>
          <canvas class="anim-spectrum" width="240" height="56" aria-label="Spectrum"></canvas>
          <div class="anim-pair">${field('Band in', `<input type="range" data-anim-fft="lo" min="0" max="1" step="0.005" value="${fft.lo}">`)}${field('Band out', `<input type="range" data-anim-fft="hi" min="0" max="1" step="0.005" value="${fft.hi}">`)}</div>
          <div class="anim-pair">${field('Gain', `<input type="range" data-anim-fft="gain" min="0" max="16" step="0.05" value="${fft.gain}">`)}${field('Fall', `<input type="range" data-anim-fft="fall" min="0" max="1" step="0.01" value="${fft.fall}">`)}</div>`;
      }
      if (mode === 'dashboard') {
        html += field('Dial', `<select data-anim="dial">${Array.from({ length: 8 }, (_, index) => `<option value="${index}" ${index === animation.dial ? 'selected' : ''}>Dial ${index + 1}</option>`).join('')}</select>`);
        html += '<small>Moves with the chosen dashboard dial of this panel. Link several parameters to one dial, each with its own range.</small>';
      }
      if (mode !== 'dashboard' && !(mode === 'fft' && (animation.fft.response === 'up' || animation.fft.response === 'down'))) {
        html += field('Shape', `<select data-anim="shape">${ANIMATION_SHAPES.map(item => `<option ${item === animation.shape ? 'selected' : ''}>${item}</option>`).join('')}</select>`);
        if (animation.shape === 'envelope') html += `<canvas class="anim-envelope" width="240" height="90" title="Click to add a point, drag to move, right-click to delete"></canvas><label class="anim-check"><input type="checkbox" data-anim-flag="stepped" ${animation.stepped ? 'checked' : ''}> Stepped</label>`;
      }
    }
    panel.innerHTML = html;
    bind();
    position();
  }

  function position() {
    const rect = anchor.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
    panel.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.right - width))}px`;
    panel.style.top = `${rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 6) : rect.bottom + 6}px`;
  }

  function update(change, structural = false) {
    const animation = { ...current() };
    change(animation);
    save(animation, structural);
  }

  function bind() {
    panel.querySelector('[data-anim-close]').onclick = closeAnimationEditor;
    panel.querySelector('[data-anim-mode]').onchange = event => {
      const mode = event.target.value;
      if (mode === 'off') save(null, true);
      else save({ ...(current() || createAnimation(mode, param)), mode }, true);
      render();
    };
    for (const input of panel.querySelectorAll('[data-anim]')) input.onchange = () => {
      update(animation => { animation[input.dataset.anim] = input.tagName === 'SELECT' && input.dataset.anim !== 'dial' ? input.value : Number(input.value); }, input.dataset.anim === 'shape');
      if (input.dataset.anim === 'shape') render();
    };
    for (const input of panel.querySelectorAll('[data-anim-flag]')) input.onchange = () => update(animation => { animation[input.dataset.animFlag] = input.checked; });
    for (const button of panel.querySelectorAll('[data-anim-direction]')) button.onclick = () => { update(animation => { animation.direction = Number(button.dataset.animDirection); }); render(); };
    for (const input of panel.querySelectorAll('[data-anim-fft]')) input[input.type === 'range' ? 'oninput' : 'onchange'] = () => {
      update(animation => { animation.fft = { ...animation.fft, [input.dataset.animFft]: input.type === 'range' ? Number(input.value) : input.value }; });
      if (input.dataset.animFft === 'response') render();
    };
    for (const button of panel.querySelectorAll('[data-anim-band]')) button.onclick = () => {
      const [lo, hi] = FFT_BANDS[button.dataset.animBand];
      update(animation => { animation.fft = { ...animation.fft, lo, hi }; }); render();
    };
    const envelope = panel.querySelector('.anim-envelope');
    if (envelope) bindEnvelope(envelope);
    cancelAnimationFrame(raf);
    const spectrumCanvas = panel.querySelector('.anim-spectrum');
    if (spectrumCanvas) drawSpectrumLoop(spectrumCanvas);
  }

  function bindEnvelope(canvas) {
    const context = canvas.getContext('2d');
    let dragging = -1;
    const points = () => current().points.map(point => [...point]);
    const draw = () => {
      const list = points(), w = canvas.width, h = canvas.height;
      context.clearRect(0, 0, w, h);
      context.strokeStyle = '#2a3140'; context.beginPath();
      for (let i = 1; i < 4; i++) { context.moveTo(w * i / 4, 0); context.lineTo(w * i / 4, h); }
      context.stroke();
      context.strokeStyle = '#8affd7'; context.lineWidth = 2; context.beginPath();
      list.forEach(([x, y], index) => {
        const px = x * w, py = (1 - y) * h;
        if (index === 0) context.moveTo(px, py);
        else if (current().stepped) { context.lineTo(px, (1 - list[index - 1][1]) * h); context.lineTo(px, py); } else context.lineTo(px, py);
      });
      context.stroke();
      context.fillStyle = '#e8fff7';
      for (const [x, y] of list) context.fillRect(x * w - 3, (1 - y) * h - 3, 6, 6);
    };
    const at = event => { const rect = canvas.getBoundingClientRect(); return [Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height))]; };
    const nearest = ([x, y]) => points().findIndex(point => Math.hypot((point[0] - x) * 240, (point[1] - y) * 90) < 8);
    canvas.onpointerdown = event => {
      const point = at(event), index = nearest(point);
      if (event.button === 2) { if (index >= 0 && points().length > 2) update(animation => { animation.points = points().filter((_, i) => i !== index); }); draw(); return; }
      if (index >= 0) dragging = index;
      else { const list = [...points(), point].sort((a, b) => a[0] - b[0]); update(animation => { animation.points = list; }); dragging = list.findIndex(item => item[0] === point[0] && item[1] === point[1]); }
      canvas.setPointerCapture(event.pointerId); draw();
    };
    canvas.onpointermove = event => {
      if (dragging < 0) return;
      const list = points(), point = at(event);
      const lo = dragging > 0 ? list[dragging - 1][0] : 0, hi = dragging < list.length - 1 ? list[dragging + 1][0] : 1;
      list[dragging] = [Math.min(hi, Math.max(lo, point[0])), point[1]];
      update(animation => { animation.points = list; }); draw();
    };
    canvas.onpointerup = () => { dragging = -1; };
    canvas.oncontextmenu = event => event.preventDefault();
    draw();
  }

  function drawSpectrumLoop(canvas) {
    const context = canvas.getContext('2d');
    const step = () => {
      if (!canvas.isConnected) return;
      const animation = current(), spectrum = animation ? ctx.spectrum(animation.fft.source, owner) : null, w = canvas.width, h = canvas.height;
      context.clearRect(0, 0, w, h);
      context.fillStyle = 'rgba(138,255,215,.12)';
      if (animation) context.fillRect(animation.fft.lo * w, 0, (animation.fft.hi - animation.fft.lo) * w, h);
      if (spectrum) {
        context.fillStyle = '#8affd7';
        const bar = w / spectrum.length;
        for (let i = 0; i < spectrum.length; i++) context.fillRect(i * bar, h - spectrum[i] * h, Math.max(1, bar - 1), spectrum[i] * h);
      } else { context.fillStyle = '#6b7689'; context.font = '11px sans-serif'; context.fillText('No audio on this input yet', 8, h / 2); }
      raf = requestAnimationFrame(step);
    };
    step();
  }

  const outside = event => { if (!panel.contains(event.target) && event.target !== anchor) closeAnimationEditor(); };
  const escape = event => { if (event.key === 'Escape') { event.stopPropagation(); closeAnimationEditor(); } };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  document.addEventListener('keydown', escape, true);
  open = { panel, close() { cancelAnimationFrame(raf); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); panel.remove(); open = null; ctx.onClose?.(); } };
  render();
  return open;
}
