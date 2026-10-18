// Parameter metadata and addressing shared by animation, the dashboard,
// shortcuts and OSC. A path names one controllable value:
//   composition/<key>             layer/<layerId>/<key>
//   group/<groupId>/<key>         clip/<clipId>/<key>
//   clip/<clipId>/source.<param>  effect/<effectId>/<param|opacity|enabled>
//   audiofx/<effectId>/<param|enabled>
// Action paths (trigger-style, no stored value) start with `action/`.
import { effectDefinition, audioEffectDefinition, sourceDefinition, EFFECT_MIX_PARAMS } from './fx/registry.js';

const p = (key, label, min, max, extra = {}) => Object.freeze({ key, label, type: 'float', min, max, ...extra });
const toggle = (key, label) => Object.freeze({ key, label, type: 'bool', min: 0, max: 1 });
const transform = [p('scale', 'Scale', 0, 10, { default: 1 }), p('x', 'Position X', -1, 1, { default: 0 }), p('y', 'Position Y', -1, 1, { default: 0 }),
  p('rotation', 'Rotate Z', -180, 180, { default: 0 }), p('rotationX', 'Rotate X', -180, 180, { default: 0 }), p('rotationY', 'Rotate Y', -180, 180, { default: 0 }),
  p('anchorX', 'Anchor X', -4096, 4096, { default: 0 }), p('anchorY', 'Anchor Y', -4096, 4096, { default: 0 }), p('anchorZ', 'Anchor Z', -4096, 4096, { default: 0 })];

export const PROPERTY_PARAMS = Object.freeze({
  clip: Object.freeze([p('opacity', 'Opacity', 0, 1, { default: 1 }), p('volume', 'Volume', 0, 4, { default: 1 }), p('pan', 'Pan', -1, 1, { default: 0 }),
    p('speed', 'Speed', 0, 4, { default: 1 }), p('inPoint', 'In point', 0, 0.999, { default: 0 }), p('outPoint', 'Out point', 0.001, 1, { default: 1 }),
    ...transform, toggle('paused', 'Pause')]),
  layer: Object.freeze([p('opacity', 'Video', 0, 1, { default: 1 }), p('volume', 'Audio', 0, 1, { default: 1 }), p('av', 'Master', 0, 1, { default: 1 }),
    p('pan', 'Pan', -1, 1, { default: 0 }), p('transition', 'Transition', 0, 10, { default: 0 }), ...transform, toggle('bypass', 'Bypass'), toggle('solo', 'Solo')]),
  group: Object.freeze([p('opacity', 'Video', 0, 1, { default: 1 }), p('volume', 'Audio', 0, 1, { default: 1 }), p('pan', 'Pan', -1, 1, { default: 0 }),
    p('speed', 'Speed', 0, 4, { default: 1 }), ...transform, toggle('bypass', 'Bypass'), toggle('solo', 'Solo')]),
  composition: Object.freeze([p('masterOpacity', 'Video', 0, 1, { default: 1 }), p('masterVolume', 'Audio', 0, 4, { default: 1 }), p('av', 'Master', 0, 1, { default: 1 }),
    p('crossfader', 'Crossfader', 0, 1, { default: 0.5 }), p('speed', 'Speed', 0, 4, { default: 1 }), p('bpm', 'BPM', 20, 300, { default: 120 }),
    p('pan', 'Pan', -1, 1, { default: 0 }), ...transform.filter(item => !item.key.startsWith('anchor') && item.key !== 'x' && item.key !== 'y'),
    toggle('bypass', 'Bypass'), toggle('blackout', 'Blackout'), toggle('paused', 'Pause')]),
});

export const propertyParam = (scope, key) => PROPERTY_PARAMS[scope]?.find(item => item.key === key) || null;

// Metadata for an animation key on an owner of the given scope.
export function ownerParam(scope, owner, key) {
  if (scope === 'effect') {
    if (key === 'opacity') return EFFECT_MIX_PARAMS[0];
    if (key === 'enabled') return toggle('enabled', 'Enabled');
    return effectDefinition(owner?.type)?.params.find(item => item.key === key) || null;
  }
  if (scope === 'audiofx') {
    if (key === 'enabled') return toggle('enabled', 'Enabled');
    return audioEffectDefinition(owner?.type)?.params.find(item => item.key === key) || null;
  }
  if (scope === 'clip' && key.startsWith('source.')) {
    return sourceDefinition(owner?.source)?.params.find(item => item.key === key.slice(7)) || null;
  }
  return propertyParam(scope, key);
}

// Read/write a value addressed by `key` on an owner.
export function readOwner(scope, owner, key) {
  if (!owner) return undefined;
  if ((scope === 'effect' || scope === 'audiofx') && key !== 'opacity' && key !== 'enabled') return owner.params?.[key];
  if (scope === 'clip' && key.startsWith('source.')) return owner.params?.[key.slice(7)];
  return owner[key];
}

export function writeOwner(scope, owner, key, value) {
  if (!owner) return false;
  if ((scope === 'effect' || scope === 'audiofx') && key !== 'opacity' && key !== 'enabled') { (owner.params ||= {})[key] = value; return true; }
  if (scope === 'clip' && key.startsWith('source.')) {
    (owner.params ||= {})[key.slice(7)] = value;
    if (key === 'source.color' && typeof value === 'string') owner.color = value.slice(0, 7);
    return true;
  }
  owner[key] = value;
  return true;
}

function* effectOwners(project) {
  yield project;
  for (const group of project.groups || []) yield group;
  for (const layer of project.layers) {
    yield layer;
    for (const clips of Object.values(layer.clips)) for (const clip of clips) if (clip) yield clip;
  }
}

export function findEffect(project, effectId, audio = false) {
  for (const owner of effectOwners(project)) {
    const effect = (audio ? owner.audioEffects : owner.effects)?.find(item => item.id === effectId);
    if (effect) return { effect, owner };
  }
  return null;
}

function findClip(project, clipId) {
  for (const layer of project.layers) for (const clips of Object.values(layer.clips)) for (const clip of clips) if (clip?.id === clipId) return clip;
  return null;
}

// Resolve a path to { scope, owner, key, param } or null.
export function resolvePath(project, path) {
  if (typeof path !== 'string' || path.length > 300) return null;
  const parts = path.split('/');
  let scope = parts[0], owner = null, key = parts.at(-1);
  if (scope === 'composition' && parts.length === 2) owner = project;
  else if (parts.length !== 3) return null;
  else if (scope === 'layer') owner = project.layers.find(item => item.id === parts[1]);
  else if (scope === 'group') owner = project.groups?.find(item => item.id === parts[1]);
  else if (scope === 'clip') owner = findClip(project, parts[1]);
  else if (scope === 'effect' || scope === 'audiofx') owner = findEffect(project, parts[1], scope === 'audiofx')?.effect;
  if (!owner) return null;
  const param = ownerParam(scope, owner, key);
  return param ? { scope, owner, key, param } : null;
}

export const getPath = (project, path) => { const target = resolvePath(project, path); return target ? readOwner(target.scope, target.owner, target.key) : undefined; };

// Normalized 0..1 access, used by MIDI/OSC/DMX/dashboard controllers.
export function normalizedValue(param, value) {
  if (param.type === 'bool') return value ? 1 : 0;
  if (param.type === 'choice') return (param.options?.length || 1) > 1 ? value / (param.options.length - 1) : 0;
  const min = param.min ?? 0, max = param.max ?? 1;
  return max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
}

export function denormalizedValue(param, normalized) {
  const value = Math.min(1, Math.max(0, Number.isFinite(normalized) ? normalized : 0));
  if (param.type === 'bool') return value >= 0.5;
  if (param.type === 'choice') return Math.round(value * Math.max(0, (param.options?.length || 1) - 1));
  const result = (param.min ?? 0) + ((param.max ?? 1) - (param.min ?? 0)) * value;
  return param.type === 'int' ? Math.round(result) : result;
}

export function setPathNormalized(project, path, normalized) {
  const target = resolvePath(project, path);
  if (!target || ['color', 'point', 'text'].includes(target.param.type)) return false;
  return writeOwner(target.scope, target.owner, target.key, denormalizedValue(target.param, normalized));
}

export function getPathNormalized(project, path) {
  const target = resolvePath(project, path);
  if (!target || ['color', 'point', 'text'].includes(target.param.type)) return null;
  return normalizedValue(target.param, readOwner(target.scope, target.owner, target.key));
}

// Readable label for UI lists.
export function describePath(project, path) {
  const target = resolvePath(project, path);
  if (!target) return path;
  const ownerName = target.scope === 'composition' ? 'Composition' : target.scope === 'effect' || target.scope === 'audiofx'
    ? (effectDefinition(target.owner.type) || audioEffectDefinition(target.owner.type))?.name || target.owner.type : target.owner.name || target.scope;
  return `${ownerName} › ${target.param.label || target.key}`;
}
