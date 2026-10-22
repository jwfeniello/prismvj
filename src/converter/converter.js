// PrismVJ Converter: an Alley-style convert view for HAP. View (sources),
// Convert (targets with settings) and Queue (encoding jobs) on the left,
// Conversion Settings in the middle, a preview with trim on the right. The
// encoding itself runs in the main process (electron/hap-converter.cjs).

import './converter.css';

const PRESET_KEY = 'prism-converter-presets';
const FORMATS = [['auto', 'Auto: HAP, or HAP Alpha if transparent'], ['auto_q', 'Auto HQ: HAP Q, or HAP Alpha if transparent'], ['hap', 'HAP'], ['hap_alpha', 'HAP Alpha'], ['hap_q', 'HAP Q']];
const FORMAT_LABEL = { hap: 'HAP', hap_alpha: 'HAP Alpha', hap_q: 'HAP Q' };
const SIZES = [['source', 'Same as Source'], ['1280x720', '1280 x 720'], ['1920x1080', '1920 x 1080'], ['2560x1440', '2560 x 1440'], ['3840x2160', '3840 x 2160'], ['custom', 'Custom…']];
const RATES = [[0, 'Same as Source'], [24, '24'], [25, '25'], [29.97, '29.97'], [30, '30'], [50, '50'], [60, '60']];
const BUILT_IN = [
  { name: 'Auto (HAP / HAP Alpha)', settings: { format: 'auto' } },
  { name: 'Auto High Quality (HAP Q / HAP Alpha)', settings: { format: 'auto_q' } },
  { name: 'HAP', settings: { format: 'hap' } },
  { name: 'HAP Alpha', settings: { format: 'hap_alpha' } },
  { name: 'HAP Q', settings: { format: 'hap_q' } },
];
const DEFAULT_SETTINGS = { format: 'auto', size: { mode: 'source' }, scaling: 'fit', fps: 0, trim: { enabled: false, start: 0, end: 0 }, audio: { enabled: true, sampleRate: 0, bitDepth: 16 }, output: { mode: 'beside', folder: '' }, fileName: '' };

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = value => JSON.parse(JSON.stringify(value));
const clock = seconds => { const s = Math.max(0, seconds || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = Math.floor(s % 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; };
const bytes = value => !value ? '' : value > 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${Math.round(value / 1e6)} MB`;
const resolveFormat = (format, alpha) => format === 'auto' ? (alpha === 'used' ? 'hap_alpha' : 'hap') : format === 'auto_q' ? (alpha === 'used' ? 'hap_alpha' : 'hap_q') : format;
const alphaText = alpha => alpha === 'used' ? 'With Alpha' : alpha === 'channel' ? 'Alpha channel (opaque)' : 'No Alpha';
const baseName = item => item.name.replace(/\.[^.]+$/, '');

function readPresets(storage) { try { const list = JSON.parse(storage.getItem(PRESET_KEY) || '[]'); return Array.isArray(list) ? list.filter(item => item && typeof item.name === 'string' && item.settings).slice(0, 64) : []; } catch { return []; } }
function writePresets(storage, list) { try { storage.setItem(PRESET_KEY, JSON.stringify(list.slice(0, 64))); } catch { /* storage unavailable */ } }

// settings for the main process (trim only when enabled; size resolved).
function wireSettings(settings, presetName) {
  const size = settings.size.mode === 'source' ? { mode: 'source' } : { mode: 'custom', width: settings.size.width, height: settings.size.height };
  return { ...clone(settings), size, trim: settings.trim.enabled ? { start: settings.trim.start, end: settings.trim.end } : { start: 0, end: 0 }, output: { ...settings.output, label: settings.output.mode === 'subfolder' ? presetName : '' } };
}

export function openConverter({ host, desktop, storage = localStorage, compositionPaths = () => [], onReplace = () => {}, onImport = null, onClose = () => {}, toast = () => {}, initialPaths = [] }) {
  const state = {
    tab: 'view', items: [], entries: [], jobs: [], selected: new Set(), selectedEntries: new Set(), selectedJob: null, anchor: null,
    presetName: BUILT_IN[0].name, presets: readPresets(storage), replaced: new Set(), adding: 0, previewFor: null, closed: false,
  };
  const root = document.createElement('div');
  root.className = 'cv-root';
  host.append(root);

  // -------------------------------------------------- data

  const itemFor = id => state.items.find(item => item.id === id);
  const presetSettings = name => clone({ ...DEFAULT_SETTINGS, ...((BUILT_IN.find(item => item.name === name) || state.presets.find(item => item.name === name))?.settings || {}) });
  const outputName = entry => {
    const item = itemFor(entry.itemId), format = resolveFormat(entry.settings.format, item?.alpha);
    if (entry.settings.fileName) return entry.settings.fileName.replace(/\.mov$/i, '') + '.mov';
    return entry.settings.output.mode === 'beside' ? `${baseName(item)} (${FORMAT_LABEL[format]}).mov` : `${baseName(item)}.mov`;
  };

  async function add(promise) {
    state.adding++; render();
    try {
      const added = await promise;
      const fresh = (added || []).filter(item => !item.error && !state.items.some(existing => existing.source?.path && existing.source.path === item.source?.path));
      const failed = (added || []).filter(item => item.error);
      state.items.push(...fresh);
      if (failed.length) toast(`${failed.length} file${failed.length === 1 ? '' : 's'} could not be read: ${failed[0].name}: ${failed[0].error}`, true);
      if (fresh.length) { state.selected = new Set(fresh.map(item => item.id)); selectPreview(fresh[0].id); }
      return fresh;
    } catch (error) { toast(`Could not add files: ${error.message}`, true); return []; }
    finally { state.adding--; render(); }
  }

  function toConvert(ids, { replace = false } = {}) {
    const list = (ids.length ? ids : state.items.map(item => item.id)).map(itemFor).filter(Boolean);
    const created = list.map(item => ({ id: crypto.randomUUID(), itemId: item.id, settings: presetSettings(state.presetName), preset: state.presetName, replace: replace || !!item.fromComposition }));
    for (const entry of created) { const item = itemFor(entry.itemId); entry.settings.trim.end = Math.round((item.duration || 0) * 100) / 100; }
    state.entries.push(...created);
    state.selectedEntries = new Set(created.map(entry => entry.id));
    state.tab = 'convert';
    render();
  }

  async function queue(entryIds) {
    const list = (entryIds.length ? entryIds : state.entries.map(entry => entry.id)).map(id => state.entries.find(entry => entry.id === id)).filter(Boolean);
    if (!list.length) return;
    const created = await desktop.convertEnqueue(list.map(entry => ({ itemId: entry.itemId, settings: wireSettings(entry.settings, entry.preset) })));
    created.forEach((job, index) => { if (list[index]?.replace) state.replaced.add(`pending:${job.id}`); });
    state.entries = state.entries.filter(entry => !list.includes(entry));
    state.selectedEntries.clear();
    state.tab = 'queue';
    render();
  }
  // -------------------------------------------------- rendering

  const card = (item, extra = '') => `<div class="cv-card" style="${item.thumbnail ? `background-image:linear-gradient(90deg,rgba(0,0,0,.86) 0%,rgba(0,0,0,.55) 55%,rgba(0,0,0,.15) 100%),url('${esc(item.thumbnail)}')` : ''}">
    <strong>${esc(item.name)}</strong><span>${esc(item.codec)}${item.profile ? ` ${esc(item.profile)}` : ''}, ${alphaText(item.alpha)}</span>
    <span>${item.width} x ${item.height} ${item.fps ? `${Math.round(item.fps * 100) / 100} FPS` : ''}</span><span>${clock(item.duration)}${item.bytes ? `, ${bytes(item.bytes)}` : ''}${item.hasAudio ? ', audio' : ''}</span>${extra}</div>`;

  function listHTML() {
    if (state.tab === 'view') {
      if (!state.items.length) return `<div class="cv-empty">Drop video files, image sequence folders or folders here,<br>or use <b>+ Files</b> / <b>+ Folder</b>.</div>`;
      return state.items.map(item => `<div class="cv-row ${state.selected.has(item.id) ? 'selected' : ''}" data-item="${esc(item.id)}">${card(item)}</div>`).join('');
    }
    if (state.tab === 'convert') {
      if (!state.entries.length) return `<div class="cv-empty">Select files in View and press <b>Convert</b>.</div>`;
      return state.entries.map(entry => {
        const item = itemFor(entry.itemId), format = resolveFormat(entry.settings.format, item.alpha);
        return `<div class="cv-row ${state.selectedEntries.has(entry.id) ? 'selected' : ''}" data-entry="${esc(entry.id)}">${card(item)}<div class="cv-target"><b>»</b> <span class="cv-target-name">${esc(outputName(entry))}</span><small>${esc(FORMAT_LABEL[format])}${entry.settings.size.mode !== 'source' ? ` · ${entry.settings.size.width} x ${entry.settings.size.height}` : ''}${entry.replace ? ' · replaces clips in composition' : ''}</small></div></div>`;
      }).join('');
    }
    if (!state.jobs.length) return `<div class="cv-empty">Nothing queued yet.</div>`;
    return state.jobs.map(job => `<div class="cv-job ${job.status} ${state.selectedJob === job.id ? 'selected' : ''}" data-job="${esc(job.id)}">
      <div class="cv-job-head"><strong>${esc(job.output ? job.output.split(/[\\/]/).pop() : job.name)}</strong><span class="cv-job-status">${jobStatus(job)}</span></div>
      <div class="cv-bar"><i style="width:${Math.round((job.progress || 0) * 100)}%"></i></div>
      <div class="cv-job-actions">${job.status === 'queued' ? `<button data-job-first="${esc(job.id)}">Convert first</button>` : ''}${job.status === 'queued' || job.status === 'running' ? `<button data-job-cancel="${esc(job.id)}">Cancel</button>` : ''}${job.status === 'done' ? `<button data-job-reveal="${esc(job.id)}">Show in folder</button>${onImport ? `<button data-job-import="${esc(job.id)}">Add to layer</button>` : ''}` : ''}${job.error ? `<small class="cv-error">${esc(job.error)}</small>` : ''}</div></div>`).join('');
  }

  function jobStatus(job) {
    if (job.status === 'running') return `${Math.round(job.progress * 100)}% · ${job.fps || 0} fps${job.eta !== null && job.eta !== undefined ? ` · ${clock(job.eta).replace(/^00:/, '')} left` : ''}`;
    if (job.status === 'done') return `Done in ${Math.max(1, Math.round((job.finishedAt - job.startedAt) / 1000))} s · ${FORMAT_LABEL[job.format]}`;
    if (job.status === 'failed') return 'Failed';
    if (job.status === 'cancelled') return 'Cancelled';
    return `Queued · ${FORMAT_LABEL[job.format] || ''}`;
  }

  function footerHTML() {
    if (state.tab === 'view') { const n = state.selected.size || state.items.length; return `<button class="cv-primary" data-act="convert" ${n ? '' : 'disabled'}>Convert ${n} File${n === 1 ? '' : 's'}</button>`; }
    if (state.tab === 'convert') { const n = state.selectedEntries.size || state.entries.length; return `<button class="cv-primary" data-act="queue" ${n ? '' : 'disabled'}>Queue ${n} File${n === 1 ? '' : 's'}</button>`; }
    const active = state.jobs.filter(job => job.status === 'running' || job.status === 'queued');
    const progress = active.length ? active.reduce((sum, job) => sum + (job.progress || 0), 0) / active.length : 1;
    return `<div class="cv-overall"><div class="cv-bar"><i style="width:${Math.round(progress * 100)}%"></i></div><span>${active.length ? `${active.length} converting` : 'All done'}</span></div><button data-act="clear">Clear finished</button>`;
  }

  const select = (key, options, value, attrs = '') => `<select data-set="${key}" ${attrs}>${options.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const field = (label, control) => `<label class="cv-field"><span>${label}</span>${control}</label>`;
  const stepper = (key, value, disabled) => `<div class="cv-stepper ${disabled ? 'disabled' : ''}"><button data-step="${key}" data-delta="-0.1" ${disabled ? 'disabled' : ''}>-</button><input data-set="${key}" type="number" step="0.01" min="0" value="${Number(value || 0).toFixed(2)}" ${disabled ? 'disabled' : ''}><button data-step="${key}" data-delta="0.1" ${disabled ? 'disabled' : ''}>+</button><button data-mark="${key}" title="Set to the preview playhead" ${disabled ? 'disabled' : ''}>Set</button></div>`;

  function settingsHTML() {
    const entries = state.entries.filter(entry => state.selectedEntries.has(entry.id));
    if (!entries.length) return `<h2>Conversion Settings</h2><p class="cv-note">Select one or more files in the Convert list to change how they convert.</p>`;
    const s = entries[0].settings, item = itemFor(entries[0].itemId), single = entries.length === 1;
    const presets = [...BUILT_IN, ...state.presets].map(preset => [preset.name, preset.name]);
    const sizeValue = s.size.mode === 'source' ? 'source' : SIZES.some(([value]) => value === `${s.size.width}x${s.size.height}`) && !s.size.custom ? `${s.size.width}x${s.size.height}` : 'custom';
    const resolved = resolveFormat(s.format, item.alpha);
    return `<h2>Conversion Settings</h2>${entries.length > 1 ? `<p class="cv-note">${entries.length} files selected: changes apply to all of them.</p>` : ''}
      ${field('Presets', `<div class="cv-inline">${select('preset', entries.every(entry => entry.preset === entries[0].preset) ? presets : [['', 'Custom'], ...presets], entries[0].preset || '')}<button data-act="save-preset" title="Save these settings as a preset">Save…</button>${state.presets.some(preset => preset.name === entries[0].preset) ? '<button data-act="delete-preset" title="Delete this preset">✕</button>' : ''}</div>`)}
      <h3>Video</h3>
      ${field('Format', select('format', FORMATS, s.format))}
      <p class="cv-note">${single ? `This file ${item.alpha === 'used' ? 'uses transparency' : item.alpha === 'channel' ? 'has an alpha channel but is fully opaque' : 'has no transparency'}: it converts to <b>${FORMAT_LABEL[resolved]}</b>.` : 'Auto picks HAP Alpha for each file that uses transparency.'}</p>
      ${field('Size', select('size', SIZES, sizeValue))}
      ${sizeValue === 'custom' ? `<div class="cv-pair">${field('Width', `<input data-set="width" type="number" min="4" max="8192" step="4" value="${s.size.width || item.width}">`)}${field('Height', `<input data-set="height" type="number" min="4" max="8192" step="4" value="${s.size.height || item.height}">`)}</div>` : ''}
      ${s.size.mode !== 'source' ? field('Scaling', select('scaling', [['fit', 'Fit (black bars)'], ['fill', 'Fill (crop)'], ['stretch', 'Stretch']], s.scaling)) : ''}
      ${field('Frame rate', select('fps', RATES, s.fps))}
      <label class="cv-check"><input type="checkbox" data-set="trim" ${s.trim.enabled ? 'checked' : ''}> Trim</label>
      <div class="cv-pair">${field('Start', stepper('start', s.trim.start, !s.trim.enabled))}${field('End', stepper('end', s.trim.end, !s.trim.enabled))}</div>
      <h3>Audio</h3>
      <label class="cv-check"><input type="checkbox" data-set="audio" ${s.audio.enabled ? 'checked' : ''} ${single && !item.hasAudio ? 'disabled' : ''}> ${single && !item.hasAudio ? 'No audio track' : 'Include audio (Linear PCM)'}</label>
      ${s.audio.enabled && (!single || item.hasAudio) ? `<div class="cv-pair">${field('Sample rate', select('rate', [[0, 'Same as Source'], [44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']], s.audio.sampleRate))}${field('Bit depth', select('depth', [[16, '16 bit'], [24, '24 bit']], s.audio.bitDepth))}</div>` : ''}
      <h3>Output</h3>
      ${field('Output Folder', select('output', [['beside', 'Same as Source'], ['subfolder', 'Same as Source / Preset Name'], ['folder', s.output.folder ? s.output.folder : 'Browse…']], s.output.mode))}
      ${s.output.mode === 'folder' ? `<button data-act="browse" class="cv-link">${s.output.folder ? 'Change folder…' : 'Choose folder…'}</button>` : ''}
      ${field('Filename', `<input data-set="fileName" type="text" value="${esc(single ? outputName(entries[0]) : '')}" ${single ? '' : 'disabled placeholder="Each file keeps its own name"'}>`)}
      ${entries.some(entry => itemFor(entry.itemId)?.fromComposition) ? `<label class="cv-check"><input type="checkbox" data-set="replace" ${entries.every(entry => entry.replace) ? 'checked' : ''}> Replace the clips in this composition when done</label>` : ''}`;
  }

  // The preview video lives across renders so playback is not interrupted.
  const video = document.createElement('video');
  video.muted = true; video.loop = true; video.playsInline = true;
  video.addEventListener('loadeddata', () => renderPreview());
  const still = document.createElement('img');
  still.alt = '';
  let previewToken = 0;

  async function selectPreview(itemId) {
    if (state.previewFor === itemId) return;
    state.previewFor = itemId;
    const item = itemFor(itemId), token = ++previewToken;
    video.removeAttribute('src'); video.load();
    still.src = item?.thumbnail || '';
    renderPreview();
    if (!item) return;
    try {
      const url = await desktop.convertPreview(itemId);
      if (token !== previewToken) return;
      video.src = url;
      await video.play().catch(() => {});
    } catch (error) { if (token === previewToken) toast(`Preview unavailable: ${error.message}`, true); }
    renderPreview();
  }

  function previewHTML() {
    const item = itemFor(state.previewFor);
    if (!item) return `<div class="cv-stage"><div class="cv-empty">Select a file to preview it.</div></div>`;
    const entry = state.entries.find(candidate => state.selectedEntries.has(candidate.id) && candidate.itemId === item.id);
    const trim = entry?.settings.trim.enabled ? entry.settings.trim : null, duration = item.duration || 1;
    return `<div class="cv-title">${esc(item.name)}</div><div class="cv-stage ${item.alpha === 'used' ? 'cv-checker' : ''}" data-stage></div>
      <div class="cv-transport"><button data-pv="start" title="To start">⏮</button><button data-pv="pause" title="Pause">❚❚</button><button data-pv="play" title="Play">▶</button>
      <div class="cv-scrub">${trim ? `<i class="cv-trim" style="left:${trim.start / duration * 100}%;width:${Math.max(0, (Math.min(trim.end || duration, duration) - trim.start) / duration * 100)}%"></i>` : ''}<input type="range" data-pv="seek" min="0" max="${duration}" step="0.01" value="0"></div><span class="cv-time" data-pv-time>00.00</span></div>`;
  }

  function renderPreview() {
    const pane = root.querySelector('.cv-preview');
    if (!pane) return;
    pane.innerHTML = previewHTML();
    const stage = pane.querySelector('[data-stage]');
    // Show the thumbnail until the preview video has a frame to show.
    if (stage) stage.append(video.src && video.readyState >= 2 ? video : still);
  }

  function render() {
    if (state.closed) return;
    const counts = { view: state.items.length, convert: state.entries.length, queue: state.jobs.filter(job => job.status !== 'done').length };
    root.dataset.tab = state.tab;
    root.innerHTML = `<header class="cv-header"><strong>Converter</strong><span class="cv-sub">HAP · HAP Alpha · HAP Q</span><span class="cv-spacer"></span><button data-act="close">Close</button></header>
      <section class="cv-left"><nav class="cv-tabs">${[['view', 'View'], ['convert', 'Convert'], ['queue', 'Queue']].map(([tab, label]) => `<button data-tab="${tab}" class="${state.tab === tab ? 'active' : ''}">${label}${counts[tab] ? ` (${counts[tab]})` : ''}</button>`).join('')}</nav>
        ${state.tab === 'view' ? `<div class="cv-add"><button data-act="files">+ Files</button><button data-act="folder">+ Folder</button><button data-act="composition" title="Add the media used by this composition">+ From composition</button></div>` : ''}
        <div class="cv-list" data-drop>${state.adding ? '<div class="cv-empty">Reading files…</div>' : ''}${listHTML()}</div><footer class="cv-footer">${footerHTML()}</footer></section>
      <section class="cv-settings">${settingsHTML()}</section>
      <section class="cv-preview"></section>`;
    renderPreview();
  }
  // -------------------------------------------------- events

  function prompt(title, value = '') {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'cv-dialog';
      dialog.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><input type="text" maxlength="60" value="${esc(value)}"><footer><button value="cancel">Cancel</button><button value="ok" class="cv-primary">Save</button></footer></form>`;
      root.append(dialog);
      dialog.addEventListener('close', () => { const text = dialog.querySelector('input').value.trim(); dialog.remove(); resolve(dialog.returnValue === 'ok' && text ? text : null); });
      dialog.showModal();
      dialog.querySelector('input').select();
    });
  }

  const selectedEntryList = () => state.entries.filter(entry => state.selectedEntries.has(entry.id));
  function apply(change) { for (const entry of selectedEntryList()) { change(entry.settings, entry); if (entry.preset !== undefined && !change.keepPreset) entry.preset = ''; } render(); }

  function selectRow(set, id, event, order) {
    if (event.shiftKey && state.anchor && order.includes(state.anchor)) {
      const [a, b] = [order.indexOf(state.anchor), order.indexOf(id)].sort((x, y) => x - y);
      if (!event.ctrlKey && !event.metaKey) set.clear();
      for (const key of order.slice(a, b + 1)) set.add(key);
    } else if (event.ctrlKey || event.metaKey) { if (set.has(id)) set.delete(id); else set.add(id); state.anchor = id; }
    else { set.clear(); set.add(id); state.anchor = id; }
  }

  root.addEventListener('click', async event => {
    const target = event.target.closest('button,[data-item],[data-entry],[data-job]');
    if (!target || target.disabled) return;
    const act = target.dataset.act;
    if (target.dataset.tab) { state.tab = target.dataset.tab; render(); return; }
    if (act === 'close') { close(); return; }
    if (act === 'files') { await add(desktop.convertPick('files')); return; }
    if (act === 'folder') { await add(desktop.convertPick('folder')); return; }
    if (act === 'composition') {
      const paths = compositionPaths();
      if (!paths.length) { toast('This composition has no video files to convert.'); return; }
      const added = await add(desktop.convertAdd(paths));
      for (const item of added) item.fromComposition = true;
      render();
      return;
    }
    if (act === 'convert') { toConvert([...state.selected]); return; }
    if (act === 'queue') { await queue([...state.selectedEntries]); return; }
    if (act === 'clear') { await desktop.convertClear(); return; }
    if (act === 'browse') { const folder = await desktop.convertChooseFolder(); if (folder) apply(settings => { settings.output = { mode: 'folder', folder }; }); return; }
    if (act === 'save-preset') {
      const name = await prompt('Save preset as', selectedEntryList()[0]?.preset || '');
      if (!name) return;
      if (BUILT_IN.some(preset => preset.name === name)) { toast('Built-in presets cannot be replaced. Choose another name.', true); return; }
      const settings = clone(selectedEntryList()[0].settings);
      delete settings.trim; settings.fileName = '';
      state.presets = [...state.presets.filter(preset => preset.name !== name), { name, settings }];
      writePresets(storage, state.presets);
      for (const entry of selectedEntryList()) entry.preset = name;
      state.presetName = name;
      render();
      return;
    }
    if (act === 'delete-preset') {
      const name = selectedEntryList()[0]?.preset;
      state.presets = state.presets.filter(preset => preset.name !== name);
      writePresets(storage, state.presets);
      for (const entry of state.entries) if (entry.preset === name) entry.preset = '';
      render();
      return;
    }
    if (target.dataset.jobFirst) { await desktop.convertPrioritize([target.dataset.jobFirst]); return; }
    if (target.dataset.jobCancel) { await desktop.convertCancel(target.dataset.jobCancel); return; }
    if (target.dataset.jobReveal) { const job = state.jobs.find(item => item.id === target.dataset.jobReveal); if (job) await desktop.convertReveal(job.output); return; }
    if (target.dataset.jobImport) { const job = state.jobs.find(item => item.id === target.dataset.jobImport); if (job) await onImport?.(job.output); return; }
    if (target.dataset.step) {
      const key = target.dataset.step, delta = Number(target.dataset.delta);
      apply(settings => { settings.trim[key] = Math.max(0, Math.round((settings.trim[key] + delta) * 100) / 100); });
      return;
    }
    if (target.dataset.mark) { const time = video.src ? video.currentTime : 0; apply(settings => { settings.trim[target.dataset.mark] = Math.round(time * 100) / 100; }); return; }
    if (target.dataset.pv === 'start') { video.currentTime = 0; return; }
    if (target.dataset.pv === 'pause') { video.pause(); return; }
    if (target.dataset.pv === 'play') { video.play().catch(() => {}); return; }
    if (target.dataset.item) {
      selectRow(state.selected, target.dataset.item, event, state.items.map(item => item.id));
      selectPreview(target.dataset.item); render();
      return;
    }
    if (target.dataset.entry) {
      selectRow(state.selectedEntries, target.dataset.entry, event, state.entries.map(entry => entry.id));
      const entry = state.entries.find(item => item.id === target.dataset.entry);
      if (entry) selectPreview(entry.itemId);
      render();
      return;
    }
    if (target.dataset.job) {
      state.selectedJob = target.dataset.job;
      const job = state.jobs.find(item => item.id === target.dataset.job);
      if (job) selectPreview(job.itemId);
      render();
    }
  });

  root.addEventListener('dblclick', event => {
    const row = event.target.closest('[data-item]');
    if (row) toConvert([row.dataset.item]);
  });

  root.addEventListener('change', event => {
    const input = event.target.closest('[data-set]');
    if (!input) return;
    const key = input.dataset.set, value = input.value;
    if (key === 'preset') {
      if (!value) return;
      for (const entry of selectedEntryList()) { const trim = entry.settings.trim; entry.settings = { ...presetSettings(value), trim }; entry.preset = value; }
      state.presetName = value;
      render();
      return;
    }
    if (key === 'replace') { for (const entry of selectedEntryList()) entry.replace = input.checked; render(); return; }
    apply((settings, entry) => {
      const item = itemFor(entry.itemId);
      if (key === 'format') settings.format = value;
      else if (key === 'size') settings.size = value === 'source' ? { mode: 'source' } : value === 'custom' ? { mode: 'custom', width: item.width, height: item.height, custom: true } : { mode: 'custom', width: Number(value.split('x')[0]), height: Number(value.split('x')[1]) };
      else if (key === 'width' || key === 'height') settings.size = { ...settings.size, mode: 'custom', custom: true, [key]: Math.max(4, Math.round(Number(value) / 4) * 4 || 4) };
      else if (key === 'scaling') settings.scaling = value;
      else if (key === 'fps') settings.fps = Number(value);
      else if (key === 'trim') settings.trim.enabled = input.checked;
      else if (key === 'start' || key === 'end') settings.trim[key] = Math.max(0, Number(value) || 0);
      else if (key === 'audio') settings.audio.enabled = input.checked;
      else if (key === 'rate') settings.audio.sampleRate = Number(value);
      else if (key === 'depth') settings.audio.bitDepth = Number(value);
      else if (key === 'output') { if (value === 'folder' && !settings.output.folder) { pendingBrowse = true; } settings.output = { ...settings.output, mode: value }; }
      else if (key === 'fileName') settings.fileName = value.trim();
    });
    if (pendingBrowse) { pendingBrowse = false; desktop.convertChooseFolder().then(folder => { if (folder) apply(settings => { settings.output = { mode: 'folder', folder }; }); }); }
  });
  let pendingBrowse = false;

  root.addEventListener('input', event => {
    if (event.target.dataset.pv === 'seek' && video.src) video.currentTime = Number(event.target.value);
  });
  video.addEventListener('timeupdate', () => {
    const seek = root.querySelector('[data-pv="seek"]'), time = root.querySelector('[data-pv-time]');
    if (seek && document.activeElement !== seek) seek.value = video.currentTime;
    if (time) time.textContent = video.currentTime.toFixed(2);
  });

  root.addEventListener('keydown', event => {
    if (event.target.closest('input,select,textarea')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      if (state.tab === 'view') state.selected = new Set(state.items.map(item => item.id));
      if (state.tab === 'convert') state.selectedEntries = new Set(state.entries.map(entry => entry.id));
      render();
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (state.tab === 'view' && state.selected.size) { desktop.convertForget([...state.selected]); state.items = state.items.filter(item => !state.selected.has(item.id)); state.selected.clear(); render(); }
      if (state.tab === 'convert' && state.selectedEntries.size) { state.entries = state.entries.filter(entry => !state.selectedEntries.has(entry.id)); state.selectedEntries.clear(); render(); }
    }
  });
  root.tabIndex = 0;

  // Drag and drop files and folders onto the converter.
  root.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); root.classList.add('cv-dropping'); } });
  root.addEventListener('dragleave', event => { if (event.target === root) root.classList.remove('cv-dropping'); });
  root.addEventListener('drop', event => {
    event.preventDefault();
    root.classList.remove('cv-dropping');
    const paths = [...(event.dataTransfer?.files || [])].map(file => desktop.getPathForFile?.(file)).filter(Boolean);
    if (paths.length) { state.tab = 'view'; add(desktop.convertAdd(paths)); }
  });

  // Live queue state from the main process; finished composition conversions replace their clips.
  const unsubscribe = desktop.onConvertState(next => {
    state.jobs = next.jobs;
    for (const job of next.jobs) {
      if (job.status !== 'done' || !state.replaced.has(`pending:${job.id}`)) continue;
      state.replaced.delete(`pending:${job.id}`);
      const item = itemFor(job.itemId);
      if (item?.source?.path) Promise.resolve(onReplace(item.source.path, job.output)).catch(error => toast(`Could not replace clips: ${error.message}`, true));
    }
    if (state.tab === 'queue') {
      const list = root.querySelector('.cv-list'), footer = root.querySelector('.cv-footer');
      if (list) list.innerHTML = listHTML();
      if (footer) footer.innerHTML = footerHTML();
      const queueTab = root.querySelector('[data-tab="queue"]'), waiting = state.jobs.filter(job => job.status !== 'done').length;
      if (queueTab) queueTab.textContent = `Queue${waiting ? ` (${waiting})` : ''}`;
    } else {
      const queueTab = root.querySelector('[data-tab="queue"]'), waiting = state.jobs.filter(job => job.status !== 'done').length;
      if (queueTab) queueTab.textContent = `Queue${waiting ? ` (${waiting})` : ''}`;
    }
  });
  desktop.convertState().then(next => { state.jobs = next.jobs; render(); }).catch(() => {});

  function close() {
    if (state.closed) return;
    state.closed = true;
    unsubscribe?.();
    video.pause(); video.removeAttribute('src'); video.load();
    root.remove();
    onClose();
  }

  render();
  root.focus();
  if (initialPaths.length) add(desktop.convertAdd(initialPaths));
  return { close, add: paths => add(desktop.convertAdd(paths)), state };
}