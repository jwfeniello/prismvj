// Definition registry for video effects, audio effects and sources. Built-in
// catalogs register through ./builtins.js; imported ISF shaders register at
// runtime. The model only consults this registry, so projects keep unknown
// (not yet loaded) effect types intact instead of dropping them.
import { normalizeParams } from './shader-template.js';

const video = new Map(), audio = new Map(), sources = new Map(), transitions = new Map();
const listeners = new Set();
const ID = /^[a-zA-Z0-9_:.-]{1,120}$/;
export const isDefinitionId = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

function register(map, definition) {
  if (!definition || !isDefinitionId(definition.id)) throw new TypeError('Definitions need a valid id.');
  map.set(definition.id, Object.freeze({ category: 'Other', params: [], ...definition, name: definition.name || definition.id }));
  for (const listener of listeners) listener(definition);
}

export const registerEffect = definition => register(video, definition);
export const registerAudioEffect = definition => register(audio, definition);
export const registerSource = definition => register(sources, definition);
// ISF transitions: usable as layer blend modes, clip transitions and the crossfader mix.
export const registerTransition = definition => register(transitions, definition);
export const unregisterEffect = id => video.delete(id);
export const effectDefinition = id => video.get(id) || null;
export const audioEffectDefinition = id => audio.get(id) || null;
export const sourceDefinition = id => sources.get(id) || null;
export const transitionDefinition = id => transitions.get(id) || null;
export const unregisterSource = id => sources.delete(id);
export const unregisterTransition = id => transitions.delete(id);
export const listEffects = () => [...video.values()];
export const listAudioEffects = () => [...audio.values()];
export const listSources = () => [...sources.values()];
export const listTransitions = () => [...transitions.values()];
export function onRegistryChange(callback) { listeners.add(callback); return () => listeners.delete(callback); }

// Parameter metadata for an effect instance's controls, including the
// Resolume-style mix controls every video effect has.
export const EFFECT_MIX_PARAMS = Object.freeze([
  Object.freeze({ key: 'opacity', label: 'Opacity', type: 'float', min: 0, max: 1, default: 1 }),
]);

// Values that survive for definitions not loaded in this session.
function looseParams(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const result = {};
  for (const [key, value] of Object.entries(values).slice(0, 64)) {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = Math.min(1e6, Math.max(-1e6, value));
    else if (typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'string') result[key] = value.slice(0, 4096);
    else if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) result[key] = [...value];
  }
  return result;
}

export function normalizeDefinitionParams(definition, values) {
  return definition ? { ...looseParams(values), ...normalizeParams(definition, values) } : looseParams(values);
}

// Non-shader sources. Their rendering is provided by the engine.
export const SPECIAL_SOURCES = Object.freeze([
  { id: 'capture', name: 'Capture Device', category: 'Live', kind: 'capture', params: [
    { key: 'device', label: 'Device', type: 'text', default: '' },
    { key: 'width', label: 'Width', type: 'int', min: 160, max: 3840, default: 1280 },
    { key: 'height', label: 'Height', type: 'int', min: 120, max: 2160, default: 720 },
    { key: 'mirror', label: 'Mirror', type: 'bool', default: false },
  ] },
  { id: 'screen', name: 'Screen Capture', category: 'Live', kind: 'screen', params: [
    { key: 'device', label: 'Screen or window', type: 'text', default: '' },
    { key: 'cursor', label: 'Show cursor', type: 'bool', default: true },
  ] },
  { id: 'router', name: 'Video Router', category: 'Routing', kind: 'router', params: [
    { key: 'input', label: 'Input', type: 'text', default: 'below' },
    { key: 'inputOpacity', label: 'Input opacity', type: 'bool', default: true },
    { key: 'inputBypass', label: 'Input bypass/solo', type: 'bool', default: true },
  ] },
]);
for (const definition of SPECIAL_SOURCES) registerSource(definition);

// Not listed in the browser: the live composition as a canvas, used to
// preview an effect over what is playing (manual p. 80, double-click).
export function compositionFeed(canvas) {
  return { id: 'composition-feed', name: 'Composition', category: 'Hidden', kind: 'canvas', hidden: true, params: [], create: () => ({ render: () => canvas, dispose() {} }) };
}
