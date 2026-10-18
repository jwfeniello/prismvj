// Generated controls for catalog parameters (effects, audio effects, sources)
// and the effect stack panels. Every control addresses its value by path
// (see params.js), so animation, shortcuts and OSC share one addressing model.
import { effectDefinition, audioEffectDefinition, sourceDefinition } from '../fx/registry.js';
import { normalizeParam } from '../fx/shader-template.js';
import { blendOptions } from '../inspector-fields.js';
import { resolvePath, readOwner, writeOwner } from '../params.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PRESET_KEY = 'prism-effect-presets';

export function cogButton(path, owner, key) {
  const animated = !!owner?.animations?.[key];
  return `<button class="param-cog ${animated ? 'animated' : ''}" data-animate-path="${esc(path)}" title="${animated ? 'Edit animation' : 'Animate this parameter'}" aria-label="Animate">⚙</button>`;
}

const decimals = param => param.type === 'int' ? 0 : (param.max - param.min) > 50 ? 1 : 3;

export function paramControlHTML(param, value, path, owner, key = param.key) {
  const v = normalizeParam(param, value), label = esc(param.label || param.key), cog = ['text'].includes(param.type) ? '' : cogButton(path, owner, key);
  const data = `data-param-path="${esc(path)}"`;
  if (param.type === 'bool') return `<div class="param-row param-bool"><label><input type="checkbox" ${data} ${v ? 'checked' : ''}> ${label}</label>${cog}</div>`;
  if (param.type === 'choice') return `<div class="param-row"><label>${label}</label><select ${data}>${(param.options || []).map((option, index) => `<option value="${index}" ${index === v ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select>${cog}</div>`;
  if (param.type === 'color') return `<div class="param-row"><label>${label}</label><input type="color" ${data} value="${esc(v.slice(0, 7))}">${cog}</div>`;
  if (param.type === 'text') return `<div class="param-row param-text"><label>${label}</label><textarea ${data} rows="${param.multiline === false ? 1 : 2}" maxlength="${param.maxLength || 4096}">${esc(v)}</textarea></div>`;
  if (param.type === 'point') return `<div class="param-row param-point"><label>${label}</label>${['X', 'Y'].map((axis, index) => `<input type="range" ${data} data-axis="${index}" min="${param.min ?? 0}" max="${param.max ?? 1}" step="0.001" value="${v[index]}" aria-label="${label} ${axis}">`).join('')}${cog}</div>`;
  const step = param.step ?? (param.type === 'int' ? 1 : (param.max - param.min) / 1000);
  return `<div class="param-row"><label title="Double-click the slider to reset">${label}</label><input type="range" ${data} min="${param.min}" max="${param.max}" step="${step}" value="${v}"><input type="number" class="number-value" ${data} data-number min="${param.min}" max="${param.max}" step="${step}" value="${Number(v).toFixed(decimals(param))}" aria-label="${label} value">${cog}</div>`;
}

// Read a control's value in the parameter's own type.
function controlValue(input, param, current) {
  if (param.type === 'bool') return input.checked;
  if (param.type === 'choice') return Number(input.value);
  if (param.type === 'color') return input.value;
  if (param.type === 'text') return input.value;
  if (param.type === 'point') { const next = [...(Array.isArray(current) ? current : [0.5, 0.5])]; next[Number(input.dataset.axis)] = Number(input.value); return next; }
  return Number(input.value);
}

// Bind every [data-param-path] control inside host. `onChange(structural)`.
export function bindParamControls(host, getProject, onChange) {
  for (const input of host.querySelectorAll('[data-param-path]')) {
    const update = () => {
      const target = resolvePath(getProject(), input.dataset.paramPath);
      if (!target) return;
      const raw = controlValue(input, target.param, readOwner(target.scope, target.owner, target.key));
      if ((target.param.type === 'float' || target.param.type === 'int') && !Number.isFinite(raw)) return;
      const value = normalizeParam(target.param, raw);
      writeOwner(target.scope, target.owner, target.key, value);
      for (const sibling of host.querySelectorAll(`[data-param-path="${CSS.escape(input.dataset.paramPath)}"]`)) {
        if (sibling === input || sibling === document.activeElement) continue;
        if (sibling.dataset.number !== undefined) sibling.value = Number(value).toFixed(decimals(target.param));
        else if (sibling.type === 'range' && sibling.dataset.axis === undefined) sibling.value = value;
      }
      onChange(false, target);
    };
    input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' || input.dataset.number !== undefined ? 'change' : 'input', update);
    if (input.type === 'range') input.addEventListener('dblclick', () => {
      const target = resolvePath(getProject(), input.dataset.paramPath);
      if (!target) return;
      const value = normalizeParam(target.param, undefined);
      input.value = Array.isArray(value) ? value[Number(input.dataset.axis)] : value;
      update();
    });
  }
}

// Refresh visible controls of animated parameters (called from the frame loop).
export function refreshAnimatedControls(host, project) {
  for (const cog of host.querySelectorAll('.param-cog.animated')) {
    const path = cog.dataset.animatePath, target = resolvePath(project, path);
    if (!target) continue;
    const value = readOwner(target.scope, target.owner, target.key);
    for (const input of host.querySelectorAll(`[data-param-path="${CSS.escape(path)}"], [data-prop="${CSS.escape(target.key)}"][data-animate-owner="${CSS.escape(path)}"]`)) {
      if (input === document.activeElement) continue;
      if (input.type === 'checkbox') input.checked = !!value;
      else if (input.tagName === 'SELECT') input.value = String(value);
      else if (input.dataset.number !== undefined) input.value = Number(value).toFixed(2);
      else if (input.dataset.axis !== undefined && Array.isArray(value)) input.value = value[Number(input.dataset.axis)];
      else if (input.type === 'range') input.value = value;
    }
  }
}

export const effectDefinitionFor = (effect, audio) => (audio ? audioEffectDefinition : effectDefinition)(effect.type);

function effectCard(effect, index, audio) {
  const definition = effectDefinitionFor(effect, audio), scope = audio ? 'audiofx' : 'effect', base = `${scope}/${effect.id}`;
  const name = definition?.name || effect.type;
  const presets = definition ? readPresets()[presetKey(effect.type, audio)] || [] : [];
  const missing = definition ? '' : '<small class="effect-missing">This effect is not loaded on this computer. Its settings are kept.</small>';
  return `<div class="effect-card ${effect.enabled ? '' : 'bypassed'}" data-effect="${esc(effect.id)}" data-effect-index="${index}" draggable="true">
    <div class="effect-head"><span class="drag-grip" title="Drag to reorder">≡</span><button class="fx-bypass ${effect.enabled ? '' : 'active'}" data-fx-bypass title="Bypass (B)">B</button>${cogButton(`${base}/enabled`, effect, 'enabled')}<strong class="grow" title="${esc(definition?.category || '')}">${esc(name)}</strong>
      ${definition ? `<select class="fx-preset" data-fx-preset aria-label="${esc(name)} preset"><option value="">Preset</option>${presets.map((preset, i) => `<option value="${i}">${esc(preset.name)}</option>`).join('')}<option value="save">Save as…</option>${presets.length ? '<option value="delete">Delete preset…</option>' : ''}</select>` : ''}
      <button data-fx-move="-1" title="Move up">↑</button><button data-fx-move="1" title="Move down">↓</button><button data-fx-remove title="Remove (X)">×</button></div>
    <div class="effect-body">${missing}${audio ? '' : `<div class="param-row"><label>Blend</label><select data-fx-blend>${blendOptions(effect.blend || 'normal')}</select></div>${paramControlHTML({ key: 'opacity', label: 'Opacity', type: 'float', min: 0, max: 1, default: 1 }, effect.opacity ?? 1, `${base}/opacity`, effect, 'opacity')}`}
      ${(definition?.params || []).map(param => paramControlHTML(param, effect.params?.[param.key], `${base}/${param.key}`, effect)).join('')}</div></div>`;
}

export function effectStackHTML(owner, { audio = false, title } = {}) {
  const list = (audio ? owner.audioEffects : owner.effects) || [];
  return `<div class="section effect-stack" data-effect-stack="${audio ? 'audio' : 'video'}"><div class="row"><h3 class="grow">${title || (audio ? 'Audio effects' : 'Effects')}</h3><button class="icon-btn" data-browse-effects="${audio ? 'audio' : 'video'}">+ Add</button></div>
    <div class="effect-drop" data-effect-drop="${audio ? 'audio' : 'video'}">${list.map((effect, index) => effectCard(effect, index, audio)).join('') || `<small class="drop-hint">Drop ${audio ? 'an audio effect' : 'an effect'} here, or use + Add.</small>`}</div></div>`;
}

function presetKey(type, audio) { return `${audio ? 'audio:' : ''}${type}`; }
export function readPresets() { try { const value = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function writePresets(value) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ } }
export function savePreset(effect, name, audio = false) {
  const all = readPresets(), key = presetKey(effect.type, audio), list = (all[key] || []).filter(item => item.name !== name);
  list.push({ name: String(name).slice(0, 80), params: structuredClone(effect.params || {}), opacity: effect.opacity, blend: effect.blend });
  all[key] = list.slice(-64); writePresets(all);
}
export function applyPreset(effect, preset) {
  // Presets set values once ("the octopus visits once"), they do not stay linked.
  effect.params = structuredClone(preset.params || {});
  if (preset.opacity !== undefined) effect.opacity = preset.opacity;
  if (preset.blend) effect.blend = preset.blend;
}

// ctx: { getProject, changed(structural), toast, prompt(title, value) → Promise<string|null>, onBrowse(kind) }
export function bindEffectStacks(host, owner, ctx) {
  for (const stack of host.querySelectorAll('[data-effect-stack]')) {
    const audio = stack.dataset.effectStack === 'audio', list = () => audio ? (owner.audioEffects ||= []) : owner.effects;
    stack.querySelector('[data-browse-effects]')?.addEventListener('click', () => ctx.onBrowse(audio ? 'audio' : 'video'));
    for (const card of stack.querySelectorAll('[data-effect]')) {
      const effect = list().find(item => item.id === card.dataset.effect);
      if (!effect) continue;
      card.querySelector('[data-fx-bypass]').onclick = () => { effect.enabled = !effect.enabled; ctx.changed(true); };
      card.querySelector('[data-fx-remove]').onclick = () => { const items = list(); items.splice(items.indexOf(effect), 1); ctx.changed(true); };
      for (const button of card.querySelectorAll('[data-fx-move]')) button.onclick = () => {
        const items = list(), from = items.indexOf(effect), to = from + Number(button.dataset.fxMove);
        if (to < 0 || to >= items.length) return;
        items.splice(from, 1); items.splice(to, 0, effect); ctx.changed(true);
      };
      const blend = card.querySelector('[data-fx-blend]');
      if (blend) blend.onchange = () => { effect.blend = blend.value; ctx.changed(false); };
      const preset = card.querySelector('[data-fx-preset]');
      if (preset) preset.onchange = async () => {
        const value = preset.value; preset.value = '';
        const presets = readPresets()[presetKey(effect.type, audio)] || [];
        if (value === 'save') {
          const name = await ctx.prompt('Save effect preset', effectDefinitionFor(effect, audio)?.name || 'Preset');
          if (name) { savePreset(effect, name, audio); ctx.toast(`Preset “${name}” saved.`); ctx.changed(true); }
        } else if (value === 'delete') {
          const name = await ctx.prompt('Delete which preset? (name)', presets.at(-1)?.name || '');
          if (name) { const all = readPresets(); all[presetKey(effect.type, audio)] = presets.filter(item => item.name !== name); writePresets(all); ctx.changed(true); }
        } else if (value !== '' && presets[Number(value)]) { applyPreset(effect, presets[Number(value)]); ctx.changed(true); }
      };
      card.addEventListener('dragstart', event => {
        if (event.target !== card) return;
        event.dataTransfer.setData('application/prism-effect-move', JSON.stringify({ id: effect.id, audio }));
        event.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('application/prism-effect-move')) { event.preventDefault(); card.classList.add('drag-over'); } });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', event => {
        const data = event.dataTransfer.getData('application/prism-effect-move');
        card.classList.remove('drag-over');
        if (!data) return;
        event.preventDefault(); event.stopPropagation();
        const { id } = JSON.parse(data), items = list(), moving = items.find(item => item.id === id);
        if (!moving || moving === effect) return;
        items.splice(items.indexOf(moving), 1); items.splice(items.indexOf(effect), 0, moving); ctx.changed(true);
      });
    }
    // Inputs within cards use the generic path binding.
  }
  bindParamControls(host, ctx.getProject, structural => ctx.changed(structural));
}

export function sourceParamsHTML(clip) {
  const definition = sourceDefinition(clip.source);
  if (!definition?.params?.length) return '';
  return `<div class="section source-params"><h3>${esc(definition.name)} <span class="muted">· source</span></h3>${definition.params.map(param => paramControlHTML(param, param.key === 'color' ? clip.color : clip.params?.[param.key], `clip/${clip.id}/source.${param.key}`, clip, `source.${param.key}`)).join('')}</div>`;
}
