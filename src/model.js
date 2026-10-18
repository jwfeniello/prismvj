// Composition data and a clock-driven transport. No DOM or media decoders live here.
import { BLEND_IDS, TRANSITION_IDS, normalizeBlend } from './blends.js';
import { normalizeDashboard } from './dashboard.js';
import { normalizeAnimations, BPM_SPEEDS } from './animation.js';
import './fx/builtins.js';
import { effectDefinition, audioEffectDefinition, sourceDefinition, normalizeDefinitionParams, isDefinitionId, EFFECT_MIX_PARAMS } from './fx/registry.js';
import { ownerParam } from './params.js';
export const LIMITS = Object.freeze({ layers: 32, decks: 32, columns: 64, clips: 4096, effects: 32, mappings: 256, cues: 6, groups: 16, shortcuts: 1024 });
// 'effect' clips carry only effects and act as adjustment layers (manual p. 85).
const KINDS = ['video', 'audio', 'image', 'source', 'effect'];
const SHORTCUT_SOURCES = ['key', 'midi', 'osc', 'dmx'];
// Crossfader (manual pp. 47–49): how A/B buses mix and what the A/B buttons do.
export const CROSSFADER_CURVES = ['overlap', 'linear', 'smooth', 'cut'];
export const CROSSFADER_BEHAVIOURS = ['fade', 'jump', 'jump-return', 'cut'];
const SHORTCUT_MODES = ['toggle', 'momentary', 'trigger', 'value', 'relative', 'set'];
const DIRECTIONS = ['forward', 'backward', 'pause', 'random'];
const TARGETS = ['own', 'selected', 'free'];
const AUTO = ['off', 'next', 'previous', 'random'];
const BEAT_LOOPS = [0, 0.25, 0.5, 1, 2, 4];
const EPS = 1e-9;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const choice = (value, values, fallback) => values.includes(value) ? value : fallback;
const string = (value, fallback = '', max = 256) => typeof value === 'string' ? value.slice(0, max) : fallback;
const bool = (value, fallback = false) => typeof value === 'boolean' ? value : fallback;
const mod = (value, range) => {
  const result = ((value % range) + range) % range;
  const tolerance = 1e-10 * Math.min(1, range);
  return result < tolerance || range - result < tolerance ? 0 : result;
};
let idCounter = 0;
const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${(++idCounter).toString(36)}`}`;
const safeId = (value, prefix) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) ? value : uid(prefix);

function array(value, label, max, fallback = []) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  if (value.length > max) throw new RangeError(`${label} exceeds the limit of ${max}.`);
  return value;
}

// Video effects carry Resolume's per-effect Opacity and Blend Mode. Unknown
// (not yet loaded, e.g. ISF) types keep their values instead of disappearing.
function effects(value, audio = false) {
  const definitionFor = audio ? audioEffectDefinition : effectDefinition;
  // Imported (isf:) effects may not be loaded yet; keep them. Drop unknown built-ins.
  return array(value, audio ? 'Audio effects' : 'Effects', LIMITS.effects).filter(item => record(item) && isDefinitionId(item.type) && (definitionFor(item.type) || item.type.startsWith('isf:'))).map(item => {
    const definition = definitionFor(item.type);
    const values = record(item.params) ? item.params : own(item, 'amount') ? { amount: item.amount } : {};
    const effect = { id: safeId(item.id, 'effect'), type: item.type, enabled: bool(item.enabled, true) };
    if (!audio) { effect.opacity = number(item.opacity, 1, 0, 1); effect.blend = normalizeBlend(item.blend, 'normal'); }
    effect.params = normalizeDefinitionParams(definition, values);
    effect.animations = normalizeAnimations(item.animations, key => ownerParam(audio ? 'audiofx' : 'effect', effect, key));
    return effect;
  });
}

function sourceParams(source, values, color) {
  const definition = sourceDefinition(source);
  const input = record(values) ? { ...values } : {};
  if (definition?.params.some(param => param.key === 'color' && param.type === 'color') && typeof input.color !== 'string') input.color = color;
  return normalizeDefinitionParams(definition, input);
}

function mediaReference(value, prefix) {
  if (!record(value)) return null;
  return { id: safeId(value.id, prefix), path: string(value.path, '', 32768), url: string(value.url, '', 32768) };
}

function mask(value) {
  const media = mediaReference(value, 'mask');
  return media ? { ...media, enabled: bool(value.enabled, true), invert: bool(value.invert) } : null;
}

function renderOrder(value) {
  const stages = ['effects', 'mask', 'transform'];
  const selected = Array.isArray(value) ? [...new Set(value.filter(item => stages.includes(item)))] : [];
  return [...selected, ...stages.filter(item => !selected.includes(item))];
}

function transform3D(input = {}) {
  return {
    rotationX: number(input.rotationX, 0, -36000, 36000), rotationY: number(input.rotationY, 0, -36000, 36000),
    anchorX: number(input.anchorX, 0, -65536, 65536), anchorY: number(input.anchorY, 0, -65536, 65536), anchorZ: number(input.anchorZ, 0, -65536, 65536),
  };
}

const dimension = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(65536, value) : null;
const favorites = value => [...new Set((Array.isArray(value) ? value : ['normal', 'add', 'screen']).map(item => normalizeBlend(item, '')).filter(item => BLEND_IDS.includes(item)))].slice(0, 3);

export function effectiveTriggerStyle(project, clip) {
  if (clip?.triggerStyle === 'normal' || clip?.triggerStyle === 'piano') return clip.triggerStyle;
  if (clip?.trigger === 'piano') return 'piano';
  return project?.triggerStyle === 'piano' ? 'piano' : 'normal';
}

export function createClip(kind = 'source', options = {}) {
  const input = record(options) ? options : {};
  kind = choice(kind, KINDS, 'source');
  const inPoint = number(input.inPoint, 0, 0, 0.999999);
  const outPoint = number(input.outPoint, 1, inPoint + 0.000001, 1);
  const audioMedia = mediaReference(input.audio, 'audio');
  const audio = audioMedia ? { ...audioMedia, duration: number(input.audio.duration, 8, 0.01, 86400) } : null;
  const duration = number(input.duration, kind === 'source' || kind === 'image' ? 5 : 8, 0.01, 86400);
  const cues = array(input.cues, 'Cue points', LIMITS.cues, [0, 0.25, 0.5, 0.75, null, null])
    .map(value => value === null ? null : number(value, 0, 0, 1));
  while (cues.length < LIMITS.cues) cues.push(null);
  const source = isDefinitionId(input.source) ? input.source : 'plasma';
  const color = typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#ff6a38';
  const clip = {
    id: safeId(input.id, 'clip'), name: string(input.name, kind === 'source' ? 'New source' : kind === 'effect' ? 'Effect clip' : 'New clip'), kind,
    path: string(input.path, '', 32768), url: string(input.url, '', 32768), source, params: kind === 'source' ? sourceParams(source, input.params, color) : {},
    color,
    labelColor: typeof input.labelColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.labelColor) ? input.labelColor : null,
    persistent: bool(input.persistent),
    dashboard: normalizeDashboard(input.dashboard, 'clip'),
    duration: audio ? audio.duration : duration, videoDuration: number(input.videoDuration, duration, 0.01, 86400), audio,
    useVideo: bool(input.useVideo, kind !== 'audio'), useAudio: bool(input.useAudio, kind === 'video' || kind === 'audio' || !!audio),
    fit: choice(input.fit, ['contain', 'cover', 'width', 'height', 'stretch', 'original'], 'contain'), mask: mask(input.mask), renderOrder: renderOrder(input.renderOrder),
    width: dimension(input.width), height: dimension(input.height), nativeWidth: number(input.nativeWidth, 0, 0, 65536), nativeHeight: number(input.nativeHeight, 0, 0, 65536),
    red: bool(input.red, true), green: bool(input.green, true), blue: bool(input.blue, true), alpha: bool(input.alpha, true), hasAlpha: bool(input.hasAlpha),
    speed: number(input.speed, 1, 0, 16), bpmSpeed: choice(input.bpmSpeed, BPM_SPEEDS, 1), stretch: number(input.stretch, 1, 0.0001, 10000), direction: choice(input.direction, [-1, 0, 1], 1),
    loop: choice(input.loop, ['loop', 'once', 'once-clear', 'pingpong', 'random'], 'loop'), random: bool(input.random),
    beatSync: bool(input.beatSync), beats: number(input.beats, 16, 0.03125, 4096), beatLoop: choice(input.beatLoop, BEAT_LOOPS, 0), paused: bool(input.paused),
    inPoint, outPoint, opacity: number(input.opacity, 1, 0, 1), volume: number(input.volume, 1, 0, 4), pan: number(input.pan, 0, -1, 1),
    scale: number(input.scale, 1, 0, 20), x: number(input.x, 0, -64, 64), y: number(input.y, 0, -64, 64),
    rotation: number(input.rotation, 0, -36000, 36000), trigger: choice(input.trigger, ['restart', 'continue', 'relative', 'piano'], 'restart'),
    // Random play mode (manual p. 61): jump every Interval by up to Distance,
    // in seconds or beats. Unset keeps the original continuous random scrub.
    // SMPTE transport (Arena, manual p. 60): the clip follows incoming LTC from its offset.
    sequenceFps: typeof input.sequenceFps === 'number' && input.sequenceFps > 0 && input.sequenceFps <= 240 ? input.sequenceFps : null,
    smpte: bool(input.smpte), smpteOffset: number(input.smpteOffset, 0, 0, 86400), smpteEnd: choice(input.smpteEnd, ['hold', 'loop', 'stop'], 'hold'),
    randomInterval: input.randomInterval == null ? null : number(input.randomInterval, 1, 0.01, 86400),
    randomDistance: input.randomDistance == null ? null : number(input.randomDistance, 1, 0, 86400),
    thumbnail: typeof input.thumbnail === 'string' && input.thumbnail.length <= 131072 && /^data:image\/(jpeg|png|webp);base64,[a-zA-Z0-9+/=]+$/.test(input.thumbnail) ? input.thumbnail : '',
    ...transform3D(input), triggerStyle: choice(input.triggerStyle, ['inherit', 'normal', 'piano'], 'inherit'), clipTarget: choice(input.clipTarget, ['inherit', ...TARGETS], 'inherit'),
    quantize: input.quantize === null || input.quantize === undefined ? null : number(input.quantize, 0, 0, 128),
    autoPilot: choice(input.autoPilot, ['inherit', ...AUTO], 'inherit'), ignoreColumn: bool(input.ignoreColumn),
    cues,
    effects: effects(input.effects), audioEffects: effects(input.audioEffects, true),
  };
  clip.animations = normalizeAnimations(input.animations, key => ownerParam('clip', clip, key));
  return clip;
}

const groupDefaults = () => ({ opacity: 1, volume: 1, pan: 0, speed: 1, blend: 'normal', bypass: false, solo: false, crossfader: 'none',
  ignoreColumn: false, locked: false, collapsed: false, scale: 1, x: 0, y: 0, rotation: 0, ...transform3D(), mask: null, renderOrder: renderOrder(),
  effects: [], audioEffects: [], dashboard: normalizeDashboard(null, 'group'), animations: {} });

// Groups are sub-compositions of contiguous layers (manual pp. 41–44).
export function createGroup(name = 'Group') {
  return { id: uid('group'), name: string(name, 'Group'), ...groupDefaults() };
}

function group(item, index, unique) {
  if (!record(item)) throw new TypeError(`Group ${index + 1} is invalid.`);
  const result = { id: unique(item.id, 'group'), name: string(item.name, `Group ${index + 1}`), opacity: number(item.opacity, 1, 0, 1), volume: number(item.volume, 1, 0, 1),
    pan: number(item.pan, 0, -1, 1), speed: number(item.speed, 1, 0, 16), blend: normalizeBlend(item.blend), bypass: bool(item.bypass), solo: bool(item.solo),
    crossfader: choice(item.crossfader, ['A', 'B', 'none'], 'none'), ignoreColumn: bool(item.ignoreColumn), locked: bool(item.locked), collapsed: bool(item.collapsed),
    scale: number(item.scale, 1, 0, 20), x: number(item.x, 0, -64, 64), y: number(item.y, 0, -64, 64), rotation: number(item.rotation, 0, -36000, 36000), ...transform3D(item),
    mask: mask(item.mask), renderOrder: renderOrder(item.renderOrder), effects: effects(item.effects), audioEffects: effects(item.audioEffects, true),
    dashboard: normalizeDashboard(item.dashboard, 'group') };
  if (result.mask) result.mask.id = unique(result.mask.id, 'mask');
  result.animations = normalizeAnimations(item.animations, key => ownerParam('group', result, key));
  return result;
}

function shortcuts(value) {
  return array(value, 'Shortcuts', LIMITS.shortcuts, []).filter(item => record(item) && SHORTCUT_SOURCES.includes(item.source) && typeof item.target === 'string').map(item => {
    const input = record(item.input) ? item.input : {};
    return { id: safeId(item.id, 'shortcut'), source: item.source, target: string(item.target, '', 300), mode: choice(item.mode, SHORTCUT_MODES, 'value'),
      input: { code: string(input.code, '', 64), shift: bool(input.shift), ctrl: bool(input.ctrl), alt: bool(input.alt),
        type: choice(input.type, ['note', 'cc', 'pitch'], 'cc'), channel: Math.round(number(input.channel, 0, 0, 15)), number: Math.round(number(input.number, 0, 0, 127)),
        device: string(input.device, '', 128), address: string(input.address, '', 256), universe: Math.round(number(input.universe, 0, 0, 32767)), dmxChannel: Math.round(number(input.dmxChannel, 1, 1, 512)) },
      min: number(item.min, 0, 0, 1), max: number(item.max, 1, 0, 1), invert: bool(item.invert), feedback: bool(item.feedback, true),
      value: number(item.value, 1, 0, 1), group: string(item.group, '', 64), enabled: bool(item.enabled, true),
      // 'selected' retargets the shortcut to whatever layer/clip is selected (manual p. 152).
      targetMode: choice(item.targetMode, ['fixed', 'selected'], 'fixed') };
  });
}

export function createLayer(name = 'Layer') {
  return { id: uid('layer'), name: string(name, 'Layer'), opacity: 1, volume: 1, av: 1, pan: 0, scale: 1, x: 0, y: 0, rotation: 0, blend: 'normal', group: 'none', bypass: false, solo: false,
    dashboard: normalizeDashboard(null, 'layer'),
    ...transform3D(), width: null, height: null, widthEnabled: false, heightEnabled: false, blendFavorites: favorites(), transitionMode: 'normal',
    ignoreColumn: false, mask: null, renderOrder: renderOrder(), groupId: null, maskMode: 'none', locked: false,
    transition: 0, autoPilot: 'off', clips: Object.create(null), activeClipId: null, effects: [], audioEffects: [], animations: {} };
}

export function createProject() {
  const decks = [{ id: uid('deck'), name: 'Neon study' }, { id: uid('deck'), name: 'After hours' }];
  const layers = [createLayer('Foundation'), createLayer('Geometry'), createLayer('Atmosphere')];
  const sources = [['plasma', 'solid', 'noise', 'rings'], ['rings', 'grid', 'plasma', 'solid'], ['grid', 'noise', 'rings', 'plasma']];
  const colors = ['#ff6a38', '#46d9c4', '#8c6cff'];
  for (let i = 0; i < layers.length; i++) {
    for (let d = 0; d < decks.length; d++) {
      layers[i].clips[decks[d].id] = Array.from({ length: 8 }, (_, column) => column < 4 ? createClip('source', {
        name: `${sources[i][(column + d) % 4][0].toUpperCase()}${sources[i][(column + d) % 4].slice(1)} ${column + 1}`,
        source: sources[i][(column + d) % 4], color: colors[(i + d) % colors.length],
      }) : null);
    }
    layers[i].activeClipId = layers[i].clips[decks[0].id][0].id;
  }
  // Every demo layer is at full opacity, so a clip triggered on an upper
  // layer shows at full strength; Screen keeps the stack visibly mixed.
  layers[1].blend = 'screen';
  layers[2].blend = 'screen';
  return { version: 1, id: uid('project'), name: 'Untitled performance', description: '', columns: 8, width: 1280, height: 720, bpm: 120, av: 1, mask: null, renderOrder: renderOrder(),
    dashboard: normalizeDashboard(null, 'composition'),
    ...transform3D(), triggerStyle: 'normal', clipTarget: 'own', directionPin: null,
    masterOpacity: 1, masterVolume: 1, pan: 0, scale: 1, x: 0, y: 0, rotation: 0, crossfader: 0.5, speed: 1, paused: false, blackout: false, bypass: false, quantize: 0,
    selectedDeckId: decks[0].id, decks, layers, groups: [], effects: [], audioEffects: [], animations: {}, mappings: [], shortcuts: [], output: {} };
}

// Reject incompatible structure; normalize safe numeric and optional settings. Build
// an allow-listed object instead of copying caller properties or object prototypes.
export function validateProject(input) {
  if (!record(input)) throw new TypeError('The project must be an object.');
  if (input.version !== 1) throw new TypeError('Unsupported project version. Expected version 1.');
  const rawDecks = array(input.decks, 'Decks', LIMITS.decks);
  const rawLayers = array(input.layers, 'Layers', LIMITS.layers);
  if (!rawDecks.length) throw new TypeError('A project needs at least one deck.');
  if (!rawLayers.length) throw new TypeError('A project needs at least one layer.');
  const rawGroups = array(input.groups, 'Groups', LIMITS.groups, []);
  let inferredColumns = 0;
  for (const layer of rawLayers) for (const deck of rawDecks) {
    const slots = record(layer?.clips) && own(layer.clips, deck?.id) ? layer.clips[deck.id] : undefined;
    if (slots !== undefined) inferredColumns = Math.max(inferredColumns, array(slots, 'Clip slots', LIMITS.columns).length);
  }
  // Earlier compositions had no column count. Preserve their widest row and
  // never silently truncate content when an explicit count is out of date.
  const columns = Math.max(inferredColumns, Math.round(number(input.columns, inferredColumns || 8, 1, LIMITS.columns)));
  const usedIds = new Set();
  const unique = (value, prefix) => {
    const id = safeId(value, prefix);
    if (usedIds.has(id)) throw new TypeError(`Duplicate ${prefix} identifier: ${id}`);
    usedIds.add(id); return id;
  };
  const decks = rawDecks.map((item, index) => {
    if (!record(item)) throw new TypeError(`Deck ${index + 1} is invalid.`);
    return { id: unique(item.id, 'deck'), name: string(item.name, `Deck ${index + 1}`) };
  });
  const groups = rawGroups.map((item, index) => group(item, index, unique));
  const groupIds = new Set(groups.map(item => item.id));
  let clipCount = 0;
  const layers = rawLayers.map((item, index) => {
    if (!record(item) || (item.clips !== undefined && !record(item.clips))) throw new TypeError(`Layer ${index + 1} is invalid.`);
    const layer = { id: unique(item.id, 'layer'), name: string(item.name, `Layer ${index + 1}`), dashboard: normalizeDashboard(item.dashboard, 'layer'),
      opacity: number(item.opacity, 1, 0, 1), volume: number(item.volume, 1, 0, 1), av: number(item.av, 1, 0, 1), pan: number(item.pan, 0, -1, 1),
      ignoreColumn: bool(item.ignoreColumn), mask: mask(item.mask), renderOrder: renderOrder(item.renderOrder),
      scale: number(item.scale, 1, 0, 20), x: number(item.x, 0, -64, 64), y: number(item.y, 0, -64, 64),
      rotation: number(item.rotation, 0, -36000, 36000), ...transform3D(item), blend: normalizeBlend(item.blend),
      width: dimension(item.width), height: dimension(item.height), widthEnabled: bool(item.widthEnabled), heightEnabled: bool(item.heightEnabled),
      blendFavorites: favorites(item.blendFavorites), transitionMode: item.transitionMode === 'random' ? 'random' : choice(normalizeBlend(item.transitionMode), TRANSITION_IDS, 'normal'),
      group: choice(item.group, ['A', 'B', 'none'], 'none'), bypass: bool(item.bypass), solo: bool(item.solo),
      transition: number(item.transition, 0, 0, 60), autoPilot: choice(item.autoPilot, AUTO, 'off'),
      groupId: groupIds.has(item.groupId) ? item.groupId : null, maskMode: choice(item.maskMode, ['none', 'luma', 'alpha', 'luma-invert', 'alpha-invert'], 'none'), locked: bool(item.locked),
      clips: Object.create(null), activeClipId: null, effects: effects(item.effects), audioEffects: effects(item.audioEffects, true) };
    layer.animations = normalizeAnimations(item.animations, key => ownerParam('layer', layer, key));
    if (layer.mask) layer.mask.id = unique(layer.mask.id, 'mask');
    for (let d = 0; d < decks.length; d++) {
      const rawKey = rawDecks[d].id;
      const slots = item.clips && own(item.clips, rawKey) ? item.clips[rawKey] : undefined;
      layer.clips[decks[d].id] = Array.from(array(slots, 'Clip slots', LIMITS.columns, []), raw => {
        if (raw === null || raw === undefined) return null;
        if (!record(raw) || !KINDS.includes(raw.kind)) throw new TypeError('A clip has an invalid kind or structure.');
        if (++clipCount > LIMITS.clips) throw new RangeError(`Project exceeds the limit of ${LIMITS.clips} clips.`);
        const clip = createClip(raw.kind, raw);
        clip.id = unique(raw.id, 'clip');
        if (clip.audio) clip.audio.id = unique(clip.audio.id, 'audio');
        if (clip.mask) clip.mask.id = unique(clip.mask.id, 'mask');
        return clip;
      });
      while (layer.clips[decks[d].id].length < columns) layer.clips[decks[d].id].push(null);
    }
    for (let column = 0; column < columns; column++) {
      let seenPersistent = false;
      for (const deck of decks) {
        const clip = layer.clips[deck.id][column];
        if (clip?.persistent) {
          if (seenPersistent) clip.persistent = false;
          else seenPersistent = true;
        }
      }
    }
    return layer;
  });
  // A group must hold at least one layer; empty groups are dropped.
  const usedGroups = groups.filter(item => layers.some(layer => layer.groupId === item.id));
  // Routed clips remain stored in their original slots. Active destinations may
  // therefore refer to any clip in the composition, including another layer.
  const allClipIds = new Set(layers.flatMap(layer => Object.values(layer.clips).flat()).filter(Boolean).map(clip => clip.id));
  for (let index = 0; index < layers.length; index++) if (allClipIds.has(rawLayers[index].activeClipId)) layers[index].activeClipId = rawLayers[index].activeClipId;
  const projectMask = mask(input.mask);
  if (projectMask) projectMask.id = unique(projectMask.id, 'mask');
  const output = record(input.output) ? input.output : {};
  const mappings = array(input.mappings, 'Control mappings', LIMITS.mappings).filter(record).map(item => {
    // Mapping formats may evolve, but arbitrary nested payloads must never survive.
    const mapping = {};
    for (const key of ['id', 'type', 'source', 'target', 'action', 'key', 'code', 'address', 'layerId', 'clipId', 'deckId', 'parameter']) {
      if (typeof item[key] === 'string') mapping[key] = string(item[key], '', 256);
    }
    for (const key of ['channel', 'number', 'note', 'controller', 'column', 'min', 'max', 'value']) {
      if (typeof item[key] === 'number' && Number.isFinite(item[key])) mapping[key] = number(item[key], 0, -65536, 65536);
    }
    if (typeof item.enabled === 'boolean') mapping.enabled = item.enabled;
    return mapping;
  });
  const result = {
    version: 1, id: safeId(input.id, 'project'), name: string(input.name, 'Untitled performance'), description: string(input.description, '', 8192), columns,
    ...transform3D(input), triggerStyle: choice(input.triggerStyle, ['normal', 'piano'], 'normal'), clipTarget: choice(input.clipTarget, TARGETS, 'own'), directionPin: choice(input.directionPin, DIRECTIONS, null),
    av: number(input.av, 1, 0, 1), mask: projectMask, renderOrder: renderOrder(input.renderOrder), dashboard: normalizeDashboard(input.dashboard, 'composition'),
    width: Math.round(number(input.width, 1280, 64, 8192)), height: Math.round(number(input.height, 720, 64, 8192)),
    bpm: number(input.bpm, 120, 20, 999), masterOpacity: number(input.masterOpacity, 1, 0, 1), masterVolume: number(input.masterVolume, 1, 0, 4),
    pan: number(input.pan, 0, -1, 1), scale: number(input.scale, 1, 0, 20), x: number(input.x, 0, -64, 64), y: number(input.y, 0, -64, 64),
    rotation: number(input.rotation, 0, -36000, 36000),
    crossfader: number(input.crossfader, 0.5, 0, 1), crossfaderBlend: normalizeBlend(input.crossfaderBlend), crossfaderCurve: choice(input.crossfaderCurve, CROSSFADER_CURVES, 'overlap'),
    crossfaderBehaviour: choice(input.crossfaderBehaviour, CROSSFADER_BEHAVIOURS, 'fade'), speed: number(input.speed, 1, 0, 16), paused: bool(input.paused), blackout: bool(input.blackout), bypass: bool(input.bypass),
    quantize: number(input.quantize, 0, 0, 128), selectedDeckId: decks.some(deck => deck.id === input.selectedDeckId) ? input.selectedDeckId : decks[0].id,
    decks, layers, groups: usedGroups, effects: effects(input.effects), audioEffects: effects(input.audioEffects, true), mappings, shortcuts: shortcuts(input.shortcuts),
    output: Object.fromEntries(['displayId', 'fullscreen', 'width', 'height'].filter(key =>
      own(output, key) && (typeof output[key] === 'boolean' || typeof output[key] === 'string' || (typeof output[key] === 'number' && Number.isFinite(output[key]))))
      .map(key => [key, typeof output[key] === 'string' ? output[key].slice(0, 256) : output[key]])),
  };
  result.animations = normalizeAnimations(input.animations, key => ownerParam('composition', result, key));
  for (const [key, normalize] of extensions) if (own(input, key)) result[key] = normalize(input[key], result);
  return result;
}

// Optional project sections owned by other modules (advanced output, DMX).
// Each normalizer must return an allow-listed copy and never throw for bad data.
const extensions = new Map();
export function registerProjectExtension(key, normalize) {
  if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key) || typeof normalize !== 'function') throw new TypeError('Invalid project extension.');
  extensions.set(key, (value, project) => { try { return normalize(value, project); } catch { return undefined; } });
}

export function serializeProject(project) {
  const serialized = validateProject(project);
  const stripURL = media => { if (media && (media.path || media.url.startsWith('blob:'))) media.url = ''; };
  stripURL(serialized.mask);
  for (const layer of serialized.layers) {
    stripURL(layer.mask);
    for (const deck of serialized.decks) for (const clip of layer.clips[deck.id]) {
      if (!clip) continue;
      stripURL(clip); stripURL(clip.audio); stripURL(clip.mask);
    }
  }
  return serialized;
}

// Gain of bus A or B at a crossfader position. 'overlap' keeps both buses at
// full strength in the middle; 'linear' is a classic mix (both at 50% in the
// middle); 'smooth' is equal power; 'cut' switches at the centre.
export function crossfadeGain(group, value, curve = 'overlap') {
  const position = number(value, 0.5, 0, 1);
  if (group !== 'A' && group !== 'B') return 1;
  const toward = group === 'A' ? 1 - position : position;
  if (curve === 'linear') return toward;
  if (curve === 'smooth') return Math.sin(toward * Math.PI / 2);
  if (curve === 'cut') return toward >= 0.5 ? 1 : 0;
  return Math.min(1, 2 * toward);
}

function seedFor(id) {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return seed >>> 0;
}
function randomAt(seed, step) {
  let value = (seed + Math.imul(step + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}

export class Transport {
  constructor(project) {
    this.project = project;
    this._project = project;
    this._entries = new Map();
    this._memory = new Map();
    this._lastTime = null;
    this._beat = 0;
  }

  get beat() { return this._beat; }

  _sync() {
    if (this._project !== this.project) {
      this._project = this.project; this._entries.clear(); this._memory.clear(); this._lastTime = null; this._beat = 0;
    }
    const layerById = new Map(this.project.layers.map(layer => [layer.id, layer]));
    const clips = new Map();
    for (const layer of this.project.layers) for (const deck of this.project.decks) {
      for (const clip of layer.clips[deck.id] || []) if (clip) clips.set(clip.id, { clip, layer });
    }
    this._clips = clips;
    // Group master speed scales every layer in the group (manual p. 43).
    const groupSpeed = new Map((this.project.groups || []).map(item => [item.id, number(item.speed, 1, 0, 16)]));
    this._speeds = new Map(this.project.layers.map(layer => [layer.id, groupSpeed.get(layer.groupId) ?? 1]));
    // Snapshot before reconciling either layer so moving/swapping playing clips
    // preserves their playheads regardless of the order of the layer stack.
    const activeStates = [];
    const pendingMoves = [];
    const adopted = new Set();
    for (const entry of this._entries.values()) {
      if (entry.current) activeStates.push({ state: entry.current, layerId: entry.layer.id });
    }
    for (const layer of this.project.layers) {
      let entry = this._entries.get(layer.id);
      if (!entry) {
        entry = { layer, current: null, outgoing: null, pending: null, elapsed: 0, fade: 0, sequence: 0, transitionSequence: 0, transitionMode: 'normal' };
        this._entries.set(layer.id, entry);
      }
      entry.layer = layer;
      if (entry.current && !clips.has(entry.current.clip.id)) {
        const removedId = entry.current.clip.id;
        this._remember(entry.current); entry.current = null; entry.outgoing = null;
        if (layer.activeClipId === removedId) layer.activeClipId = null;
      }
      if (entry.outgoing && !clips.has(entry.outgoing.clip.id)) entry.outgoing = null;
      if (entry.pending) {
        const source = clips.get(entry.pending.clip.id);
        if (!source) entry.pending = null;
        else if (entry.pending.target === 'own' && source.layer.id !== layer.id) {
          pendingMoves.push({ pending: entry.pending, layerId: source.layer.id }); entry.pending = null;
        } else { entry.pending.clip = source.clip; entry.pending.sourceLayerId = source.layer.id; }
      }
      if (layer.activeClipId !== entry.current?.clip.id && layer.activeClipId) {
        const source = clips.get(layer.activeClipId);
        const moved = activeStates.find(item => item.state.clip.id === layer.activeClipId && item.layerId !== layer.id && !adopted.has(item.state)
          && layerById.get(item.layerId)?.activeClipId !== layer.activeClipId);
        if (source && moved) {
          if (entry.current) this._remember(entry.current);
          adopted.add(moved.state); entry.current = moved.state; entry.current.clip = source.clip; entry.outgoing = null; entry.elapsed = 0; entry.fade = 0;
        } else if (source) this._activate(entry, source.clip, { sourceLayerId: source.layer.id, target: source.layer.id === layer.id ? 'own' : 'selected' });
        else { layer.activeClipId = null; entry.current = null; entry.outgoing = null; }
      } else if (!layer.activeClipId && entry.current) {
        this._remember(entry.current); entry.current = null; entry.outgoing = null;
      }
      // Direct media replacement with the same identifier should update the
      // decoder-facing data while retaining the running transport position.
      for (const state of [entry.current, entry.outgoing]) if (state) {
        const source = clips.get(state.clip.id);
        state.clip = source.clip; state.sourceLayerId = source.layer.id; state.voiceId = `${layer.id}:${state.clip.id}`; state.layerId = layer.id;
      }
    }
    for (const moved of pendingMoves) {
      const destination = this._entries.get(moved.layerId);
      if (destination && !destination.pending) { destination.pending = moved.pending; destination.pending.sourceLayerId = moved.layerId; destination.pending.voiceId = `${moved.layerId}:${moved.pending.clip.id}`; }
    }
    for (const id of this._entries.keys()) if (!layerById.has(id)) this._entries.delete(id);
    for (const id of this._memory.keys()) if (!clips.has(id)) this._memory.delete(id);
  }

  _remember(state) {
    this._memory.set(state.clip.id, { position: state.position, direction: state.direction, randomPhase: state.randomPhase, travel: state.travel });
  }

  _activate(entry, clip, request = {}) {
    if (DIRECTIONS.includes(this.project.directionPin)) this._applyDirection(clip, this.project.directionPin);
    const previous = entry.current;
    if (previous) this._remember(previous);
    const saved = clip.trigger === 'continue' && !clip.beatSync ? this._memory.get(clip.id) : null;
    // Relative pick-up (manual p. 62): start where the previous clip was, proportionally.
    const relative = clip.trigger === 'relative' && previous && previous.clip.id !== clip.id
      ? Math.min(1, Math.max(0, (previous.position - previous.clip.inPoint) / Math.max(EPS, previous.clip.outPoint - previous.clip.inPoint))) : null;
    entry.outgoing = previous && previous.clip.id !== clip.id && entry.layer.transition > 0 ? previous : null;
    entry.elapsed = 0; entry.fade = number(entry.layer.transition, 0, 0, 60);
    entry.transitionMode = entry.layer.transitionMode === 'random'
      ? TRANSITION_IDS[Math.floor(randomAt(seedFor(clip.id), ++entry.transitionSequence) * TRANSITION_IDS.length)] || 'normal'
      : choice(entry.layer.transitionMode, TRANSITION_IDS, 'normal');
    entry.current = { clip, position: relative !== null ? clip.inPoint + relative * (clip.outPoint - clip.inPoint)
      : saved ? number(saved.position, clip.inPoint, clip.inPoint, clip.outPoint) : clip.direction < 0 ? clip.outPoint : clip.inPoint,
      direction: this.project.directionPin && this.project.directionPin !== 'pause' ? (clip.direction < 0 ? -1 : 1) : saved?.direction || (clip.direction < 0 ? -1 : 1), directionInput: clip.direction,
      randomPhase: saved?.randomPhase || 0, travel: saved?.travel || 0, completed: false, seed: seedFor(clip.id), beatLoopWindow: null,
      sourceLayerId: request.sourceLayerId || this._clips.get(clip.id)?.layer.id || entry.layer.id,
      originLayerId: request.originLayerId || request.sourceLayerId || this._clips.get(clip.id)?.layer.id || entry.layer.id,
      voiceId: `${entry.layer.id}:${clip.id}`, layerId: entry.layer.id, inputId: request.inputId ?? null, target: request.target || 'own',
      triggerStyle: request.triggerStyle || effectiveTriggerStyle(this.project, clip) };
    entry.pending = null; entry.layer.activeClipId = clip.id;
  }

  _request(entry, clip, beat, request = {}) {
    const quantum = number(clip.quantize, this.project.quantize || 0, 0, 128);
    const target = quantum > EPS ? Math.ceil((beat - EPS) / quantum) * quantum : beat;
    const sourceLayerId = request.sourceLayerId || this._clips.get(clip.id)?.layer.id || entry.layer.id;
    const options = { sourceLayerId, originLayerId: request.originLayerId || sourceLayerId, target: request.target || 'own',
      triggerStyle: request.triggerStyle || effectiveTriggerStyle(this.project, clip), inputId: request.inputId ?? null };
    if (target <= beat + EPS) this._activate(entry, clip, options);
    else entry.pending = { clip, beat: target, ...options, voiceId: `${entry.layer.id}:${clip.id}` };
  }

  trigger(layerId, clipId, nowSeconds, options = {}) { return !!this.triggerRouted(layerId, clipId, nowSeconds, options); }

  triggerRouted(sourceLayerId, clipId, nowSeconds, options = {}) {
    this.tick(nowSeconds);
    const source = this._clips.get(clipId);
    if (!source || source.layer.id !== sourceLayerId) return null;
    const clip = source.clip;
    const target = choice(options.target, TARGETS, choice(clip.clipTarget, TARGETS, choice(this.project.clipTarget, TARGETS, 'own')));
    let destination = target === 'selected' ? this._entries.get(options.selectedLayerId) : this._entries.get(sourceLayerId);
    if (target === 'free') destination = this.project.layers.map(layer => this._entries.get(layer.id)).find(entry => !entry.current && !entry.pending);
    else if (!destination) destination = this._entries.get(sourceLayerId);
    if (!destination) return null;
    const inputId = typeof options.inputId === 'string' ? options.inputId : null;
    this._request(destination, clip, this._beat, { sourceLayerId, target, inputId });
    return { layerId: destination.layer.id, sourceLayerId, clipId, voiceId: `${destination.layer.id}:${clipId}`, inputId };
  }

  isPiano(clip) { return effectiveTriggerStyle(this.project, clip) === 'piano'; }

  _applyDirection(clip, mode) {
    if (mode === 'pause') { clip.paused = true; return; }
    clip.paused = false; clip.direction = mode === 'backward' ? -1 : 1; clip.random = mode === 'random';
    if (mode !== 'random' && clip.loop === 'random') clip.loop = 'loop';
  }

  setGlobalDirection(mode, { pin = false } = {}) {
    if (!DIRECTIONS.includes(mode)) throw new RangeError('Invalid global playback direction.');
    this._sync();
    if (pin) this.project.directionPin = mode;
    for (const entry of this._entries.values()) for (const state of [entry.current, entry.outgoing]) if (state) {
      this._applyDirection(state.clip, mode);
      if (mode !== 'pause') state.completed = false;
      this._direction(state);
    }
    return mode;
  }

  stop(layerId) {
    this._sync();
    const entry = this._entries.get(layerId);
    if (!entry) return false;
    if (entry.current) this._remember(entry.current);
    entry.current = null; entry.outgoing = null; entry.pending = null; entry.layer.activeClipId = null;
    return true;
  }

  release(layerId, clipId, { inputId } = {}) {
    this._sync();
    let released = false;
    for (const entry of this._entries.values()) {
      const matches = state => state && state.clip.id === clipId && state.triggerStyle === 'piano'
        && (state.sourceLayerId === layerId || state.originLayerId === layerId || entry.layer.id === layerId) && (inputId === undefined || inputId === state.inputId);
      if (matches(entry.pending)) { entry.pending = null; released = true; }
      if (matches(entry.outgoing)) { entry.outgoing = null; released = true; }
      if (matches(entry.current)) {
        this._remember(entry.current); entry.current = null; entry.outgoing = null; entry.layer.activeClipId = null; released = true;
      }
    }
    return released;
  }

  seek(layerId, normalized) {
    this._sync();
    const state = this._entries.get(layerId)?.current;
    if (!state || !Number.isFinite(normalized)) return false;
    state.position = number(normalized, state.clip.inPoint, state.clip.inPoint, state.clip.outPoint);
    state.completed = false; state.travel = 0; state.beatLoopWindow = null; this._remember(state); return true;
  }

  cue(layerId, index) {
    this._sync();
    const clip = this._entries.get(layerId)?.current?.clip;
    if (!clip || !Number.isInteger(index) || typeof clip.cues[index] !== 'number') return false;
    clip.beatLoop = 0;
    return this.seek(layerId, clip.cues[index]);
  }

  setCue(layerId, index) {
    this._sync();
    const state = this._entries.get(layerId)?.current;
    if (!state || !Number.isInteger(index) || index < 0 || index >= LIMITS.cues) return false;
    while (state.clip.cues.length <= index) state.clip.cues.push(null);
    state.clip.cues[index] = state.position; return true;
  }

  // Ableton Link: keep the beat clock in phase with the session within a bar
  // (quantum). Only the phase matters, not the absolute beat number. Small
  // drift is eased out; a larger offset jumps so quantized launches stay on the grid.
  syncBeat(beat, quantum = 4, nowSeconds) {
    if (!Number.isFinite(beat)) return 0;
    this.tick(nowSeconds);
    const q = number(quantum, 4, 1, 64);
    const offset = mod(beat - this._beat + q / 2, q) - q / 2;
    this._beat += Math.abs(offset) > 0.25 ? offset : offset * 0.2;
    return offset;
  }

  resync(nowSeconds) { this.tick(nowSeconds); this._beat = 0; for (const entry of this._entries.values()) if (entry.pending) this._request(entry, entry.pending.clip, 0, entry.pending); }

  getState(layerId) {
    this._sync();
    const entry = this._entries.get(layerId);
    const state = entry?.current;
    return entry ? { clipId: state?.clip.id || null, clip: state?.clip || null, position: state?.position || 0,
      sourceLayerId: state?.sourceLayerId || null, voiceId: state?.voiceId || null, inputId: state?.inputId || null,
      time: state ? state.position * state.clip.duration : 0, direction: state?.direction || 0,
      paused: this.project.paused || !!state?.clip.paused || state?.clip.direction === 0,
      completed: !!state?.completed, pendingClipId: entry.pending?.clip.id || null } : null;
  }

  _rate(state) {
    const clip = state.clip;
    if (clip.paused || clip.direction === 0) return 0;
    // BPM Sync has its own power-of-two speed (manual p. 60), separate from
    // the Timeline speed; Timeline playback also applies the Duration stretch.
    return clip.beatSync ? number(this.project.bpm, 120, 20, 999) / 60 / number(clip.beats, 16, 0.03125, 4096) * (BPM_SPEEDS.includes(clip.bpmSpeed) ? clip.bpmSpeed : 1)
      : number(clip.speed, 1, 0, 16) * number(clip.stretch, 1, 0.0001, 10000) * number(this.project.speed, 1, 0, 16) * (this._speeds?.get(state.layerId) ?? 1) / number(clip.duration, 8, 0.01, 86400);
  }

  _direction(state) {
    if (state.directionInput !== state.clip.direction) {
      if (state.clip.direction) state.direction = state.clip.direction < 0 ? -1 : 1;
      state.directionInput = state.clip.direction;
    }
    return state.direction;
  }

  _bounds(state) {
    const clip = state.clip;
    const length = clip.beatSync && BEAT_LOOPS.includes(clip.beatLoop) ? clip.beatLoop : 0;
    if (!length) {
      state.beatLoopWindow = null;
      return { lo: clip.inPoint, hi: clip.outPoint, looping: false };
    }
    const key = `${length}:${clip.beats}:${clip.inPoint}:${clip.outPoint}`;
    if (state.beatLoopWindow?.key !== key) {
      // Capture the subdivision containing the playhead, on a beat grid anchored
      // at the clip's in point. Later frames stay inside this captured window.
      const width = length / clip.beats;
      const position = Math.min(clip.outPoint - EPS, Math.max(clip.inPoint, state.position - (this._direction(state) < 0 ? EPS : 0)));
      const subdivision = Math.floor(Math.max(0, position - clip.inPoint) / width + EPS);
      const lo = clip.inPoint + subdivision * width;
      state.beatLoopWindow = { key, lo, hi: Math.min(clip.outPoint, lo + width), looping: true };
      state.completed = false;
      state.travel = 0;
    }
    return state.beatLoopWindow;
  }

  _advanceState(state, seconds, forceLoop = false) {
    if (!state || seconds <= 0) return;
    const clip = state.clip;
    const bounds = this._bounds(state);
    const rate = this._rate(state);
    const direction = this._direction(state);
    if (!rate || state.completed) return;
    state.travel += seconds * rate;
    const { lo, hi } = bounds; const span = Math.max(0.000001, hi - lo);
    state.position = number(state.position, lo, lo, hi);
    if (clip.random || clip.loop === 'random') {
      if (clip.randomInterval) {
        // Play normally between jumps; every Interval jump up to Distance away.
        const perSecond = clip.beatSync ? number(this.project.bpm, 120, 20, 999) / 60 / clip.randomInterval
          : number(clip.speed, 1, 0, 16) * number(this.project.speed, 1, 0, 16) / clip.randomInterval;
        state.randomPhase += seconds * perSecond;
        const step = Math.floor(state.randomPhase + EPS);
        if (step !== state.randomStep) {
          state.randomStep = step;
          const unit = clip.beatSync ? 1 / number(clip.beats, 16, 0.03125, 4096) : 1 / number(clip.duration, 8, 0.01, 86400);
          const reach = Math.min(span, clip.randomDistance == null ? span : clip.randomDistance * unit);
          state.position = lo + mod(state.position - lo + (randomAt(state.seed, step) * 2 - 1) * reach, span);
        } else state.position = lo + mod(state.position - lo + rate * seconds * direction, span);
        return;
      }
      if (clip.beatSync) {
        state.randomPhase += seconds * this.project.bpm / 60;
        const beatIndex = Math.floor(state.randomPhase + EPS);
        const count = Math.max(1, Math.ceil(span * clip.beats));
        const offset = Math.floor(randomAt(state.seed, beatIndex) * count) + mod(state.randomPhase, 1) * direction;
        state.position = lo + mod(offset / clip.beats, span);
      } else {
        state.randomPhase += seconds * clip.speed * this.project.speed * 25;
        state.position = lo + randomAt(state.seed, Math.floor(state.randomPhase + EPS)) * span;
      }
      return;
    }
    const next = state.position - lo + rate * seconds * direction;
    if (clip.loop === 'pingpong') {
      const phase = direction > 0 ? state.position - lo : 2 * span - (state.position - lo);
      const progress = mod(phase + rate * seconds, 2 * span);
      state.position = lo + (progress <= span ? progress : 2 * span - progress);
      state.direction = progress < span ? 1 : -1;
    } else if ((clip.loop === 'once' || clip.loop === 'once-clear') && !forceLoop && !bounds.looping) {
      state.position = lo + Math.min(span, Math.max(0, next));
    } else {
      state.position = lo + mod(next, span);
    }
  }

  _autoMode(entry) {
    const mode = entry.current?.clip.autoPilot;
    return !mode || mode === 'inherit' ? entry.layer.autoPilot : mode;
  }

  _nextClip(entry, mode) {
    const current = entry.current.clip;
    const sourceLayer = this._clips.get(current.id)?.layer || entry.layer;
    const deck = this.project.decks.find(item => sourceLayer.clips[item.id]?.some(clip => clip?.id === current.id));
    const clips = deck ? sourceLayer.clips[deck.id].filter(Boolean) : [];
    if (!clips.length) return null;
    const index = clips.findIndex(clip => clip.id === current.id);
    if (mode === 'random') {
      const alternatives = clips.filter(clip => clip.id !== current.id);
      return alternatives[Math.floor(randomAt(entry.current.seed, ++entry.sequence) * alternatives.length)] || current;
    }
    return clips[mod(index + (mode === 'previous' ? -1 : 1), clips.length)];
  }

  _advanceLayer(entry, seconds, beat) {
    const beatRate = number(this.project.bpm, 120, 20, 999) / 60;
    let remaining = seconds;
    // A bad project or suspended machine must never lock the performance thread.
    // Ordinary loops are analytic; only actual clip changes consume this budget.
    for (let events = 0; remaining > EPS && events < 512; events++) {
      const state = entry.current;
      const mode = this._autoMode(entry);
      const auto = AUTO.includes(mode) && mode !== 'off';
      const looping = state && this._bounds(state).looping;
      let endTime = Infinity;
      if (state && !looping && !state.completed && !entry.pending && (auto || state.clip.loop === 'once' || state.clip.loop === 'once-clear')) {
        const rate = this._rate(state);
        const distance = state.clip.random || state.clip.loop === 'random' ? state.clip.outPoint - state.clip.inPoint - state.travel
          : this._direction(state) < 0 ? state.position - state.clip.inPoint : state.clip.outPoint - state.position;
        if (rate > 0) endTime = Math.max(0, distance / rate);
      }
      const queueTime = entry.pending ? Math.max(0, (entry.pending.beat - beat) / beatRate) : Infinity;
      const step = Math.min(remaining, endTime, queueTime);
      this._advanceState(state, step, !!entry.pending || auto);
      this._advanceState(entry.outgoing, step, true);
      entry.elapsed += step;
      if (entry.elapsed >= entry.fade) entry.outgoing = null;
      remaining = Math.max(0, remaining - step); beat += step * beatRate;
      if (queueTime <= step + EPS && entry.pending) {
        this._activate(entry, entry.pending.clip, entry.pending);
      } else if (endTime <= step + EPS && state) {
        if (auto) {
          const next = this._nextClip(entry, mode);
          if (next) this._request(entry, next, beat, { target: 'selected' });
          else state.completed = true;
        } else if (state.clip.loop === 'once-clear') {
          this._remember(state); entry.current = null; entry.outgoing = null; entry.layer.activeClipId = null;
        } else {
          state.position = this._direction(state) < 0 ? state.clip.inPoint : state.clip.outPoint;
          state.completed = true;
        }
      } else break;
    }
    if (remaining > EPS) {
      this._advanceState(entry.current, remaining, true); this._advanceState(entry.outgoing, remaining, true);
      entry.elapsed += remaining; if (entry.elapsed >= entry.fade) entry.outgoing = null;
    }
  }

  tick(nowSeconds = globalThis.performance.now() / 1000) {
    this._sync();
    if (!Number.isFinite(nowSeconds)) nowSeconds = this._lastTime ?? 0;
    if (this._lastTime === null) {
      this._lastTime = nowSeconds; this._beat = nowSeconds * number(this.project.bpm, 120, 20, 999) / 60;
    }
    const now = Math.max(this._lastTime, nowSeconds);
    const delta = this.project.paused ? 0 : now - this._lastTime;
    this._lastTime = now;
    if (delta > 0) {
      for (const entry of this._entries.values()) this._advanceLayer(entry, delta, this._beat);
      this._beat += delta * number(this.project.bpm, 120, 20, 999) / 60;
    }
    const frames = [];
    const frame = (entry, state, weight, incoming) => {
      const rate = this.project.paused || state.completed ? 0 : this._rate(state) * state.clip.duration;
      return { layer: entry.layer, clip: state.clip, voiceId: state.voiceId, sourceLayerId: state.sourceLayerId,
        position: state.position, time: state.position * state.clip.duration, weight,
        transitionMode: entry.outgoing ? entry.transitionMode : 'normal',
        ...(entry.outgoing ? { transitionProgress: Math.min(1, entry.elapsed / entry.fade), transitionIncoming: incoming } : {}),
        direction: this._direction(state), rate, playing: rate > 0 && ((!state.clip.random && state.clip.loop !== 'random') || state.clip.beatSync) };
    };
    for (const entry of this._entries.values()) {
      if (!entry.current) continue;
      const weight = entry.outgoing && entry.fade > 0 ? Math.min(1, entry.elapsed / entry.fade) : 1;
      if (entry.outgoing) frames.push(frame(entry, entry.outgoing, 1 - weight, false));
      frames.push(frame(entry, entry.current, weight, true));
    }
    return frames;
  }
}
