// Resolume 4 OSC address tree, from the supplied manual pp. 43–48.
// Return false for an unsupported address or invalid payload, without mutating.
// This layer receives decoded messages; UDP framing belongs to the desktop host.
import { visibleSlot } from './persistent-clips.js';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const scalar = args => args.length === 1 && finite(args[0]);
const integer = (args, values) => args.length === 1 && Number.isInteger(args[0]) && values.includes(args[0]);
const triggered = args => integer(args, [1]);
const toggle = args => integer(args, [0, 1]);
const numericText = value => typeof value === 'string' && value.length <= 64 && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()) && Number.isFinite(Number(value));

function values(message) {
  const args = message.args === undefined ? (message.value === undefined ? [] : [message.value]) : message.args;
  if (!Array.isArray(args) || args.length > 3) return null;
  return args.map(arg => arg && typeof arg === 'object' && Object.hasOwn(arg, 'value') ? arg.value : arg);
}

function parameter(target, key, args, property, fromNormalized, fromText) {
  if (property === 'values' && scalar(args)) {
    target[key] = fromNormalized(clamp(args[0])); return true;
  }
  if (property === 'textvalue' && args.length === 1 && numericText(args[0]) && fromText) {
    target[key] = fromText(Number(args[0])); return true;
  }
  return false;
}

function activeClipVoices(context, clip) {
  if (!context.transport) return [];
  // OSC addresses identify the source slot. A routed clip can be playing on
  // several destination layers while its source layer plays something else.
  return context.project.layers.filter(layer => layer.activeClipId === clip.id)
    .map(layer => ({ layer, state: context.transport.getState(layer.id) }))
    .filter(({ state }) => state?.clipId === clip.id);
}

function resumeCompletedVoices(context, clip) {
  for (const { layer, state } of activeClipVoices(context, clip)) {
    if (state.completed) context.transport.seek(layer.id, state.position);
  }
}

function position(context, layer, clip, property, args) {
  const transport = context.transport;
  if (property === 'values' || property === 'textvalue') {
    const voices = activeClipVoices(context, clip);
    if (!voices.length) return false;
    const seek = position => {
      let moved = false;
      for (const { layer } of voices) moved = transport.seek(layer.id, position) || moved;
      return moved;
    };
    if (property === 'textvalue') {
      if (args.length !== 1 || !numericText(args[0])) return false;
      return seek(clamp(Number(args[0]) / (clip.duration * 1000)));
    }
    if ((args.length !== 1 && args.length !== 3) || !args.every(finite)) return false;
    const normalized = args.map(value => clamp(value));
    if (normalized.length === 3) {
      const [start, current, end] = normalized;
      if (start >= end || current < start || current > end) return false;
      clip.inPoint = start; clip.outPoint = end;
      return seek(current);
    }
    return seek(normalized[0]);
  }
  if (property === 'direction' && integer(args, [0, 1, 2, 3])) {
    const value = args[0];
    if (value === 2) clip.paused = true;
    else {
      clip.paused = false;
      clip.random = value === 3;
      if (value === 3 && clip.direction === 0) clip.direction = 1;
      if (value !== 3) {
        clip.direction = value === 0 ? -1 : 1;
        if (clip.loop === 'random') clip.loop = 'loop';
      }
      resumeCompletedVoices(context, clip);
    }
    return true;
  }
  if (property === 'speed' && scalar(args)) {
    // The manual documents this property's normalized range, but gives no
    // transfer curve. The current transport uses that value as its multiplier.
    clip.speed = clamp(args[0]); return true;
  }
  if (property === 'playmode' && integer(args, [0, 1, 2])) {
    clip.loop = ['once', 'loop', 'pingpong'][args[0]];
    if (args[0] !== 0) resumeCompletedVoices(context, clip);
    return true;
  }
  if (property === 'playmodeaway' && integer(args, [0, 1])) {
    clip.trigger = args[0] === 0 ? 'restart' : 'continue'; return true;
  }
  return false;
}

function mediaParameter(context, target, scope, layer, group, name, property, args) {
  if (scope === 'clip' && name === 'position') return position(context, layer, target, property, args);
  if (group === 'audio') {
    if (name === 'pan') return parameter(target, 'pan', args, property, value => 2 * value - 1, value => clamp(value, -1, 1));
    if (name === 'volume') {
      if (scope === 'layer') return parameter(target, 'volume', args, property, value => value, value => clamp(value));
      return parameter(target, scope === 'composition' ? 'masterVolume' : 'volume', args, property,
        value => 10 ** ((-40 + 52 * value) / 20), value => 10 ** (clamp(value, -40, 12) / 20));
    }
    return false;
  }
  if (scope === 'composition' && name === 'fadeout') return parameter(target, 'masterOpacity', args, property, value => value, value => clamp(value));
  if (scope !== 'composition' && name === 'opacity') return parameter(target, 'opacity', args, property, value => value, value => clamp(value));
  if (name === 'scale') return parameter(target, 'scale', args, property, value => value * 10, value => clamp(value, 0, 1000) / 100);
  if (['rotatex','rotatey','rotatez'].includes(name)) return parameter(target, {rotatex:'rotationX',rotatey:'rotationY',rotatez:'rotation'}[name], args, property, value => value * 360 - 180, value => clamp(value, -180, 180));
  if (scope !== 'composition' && ['anchorx','anchory','anchorz'].includes(name)) {
    return parameter(target, {anchorx:'anchorX',anchory:'anchorY',anchorz:'anchorZ'}[name], args, property,
      value => value * 4096 - 2048, value => clamp(value, -2048, 2048));
  }
  if (scope === 'clip' && ['width','height'].includes(name)) {
    return parameter(target, name, args, property, value => value * 4096, value => clamp(value, 0, 4096));
  }
  if (scope !== 'composition' && (name === 'positionx' || name === 'positiony')) {
    const dimension = name === 'positionx' ? context.project.width : context.project.height;
    return parameter(target, name === 'positionx' ? 'x' : 'y', args, property,
      value => (value * 8192 - 4096) / dimension, value => clamp(value, -4096, 4096) / dimension);
  }
  return false;
}

function effectParameter(target, group, index, property, args) {
  // Current built-ins are video effects. Their parameter layouts are not the
  // original plugin layouts, so never map legacy paramN to an invented control.
  if (group !== 'video') return false;
  const effect = target.effects?.[index];
  if (!effect || property !== 'bypassed' || !toggle(args)) return false;
  effect.enabled = args[0] === 0; return true;
}

export function applyOSC(context, message) {
  if (!context?.project || !message || typeof message !== 'object') return false;
  const address = message.address ?? message.path;
  if (typeof address !== 'string' || address.length > 512 || !/^\/(?:composition|layer[1-9]\d*|track[1-9]\d*)(?:\/[a-z0-9]+)+$/.test(address)) return false;
  const args = values(message);
  if (!args) return false;
  const parts = address.slice(1).split('/');
  const { project, transport } = context;
  const track = parts[0].match(/^track([1-9]\d*)$/);
  if (track) {
    const index = Number(track[1]) - 1;
    if (parts.length !== 2 || parts[1] !== 'connect' || !triggered(args) || index >= 64 || typeof context.triggerColumn !== 'function') return false;
    if (!project.layers.some(layer => visibleSlot(project, layer, project.selectedDeckId, index).clip)) return false;
    context.triggerColumn(index); return true;
  }
  let target = project, layer = null, scope = 'composition', offset = 1;
  if (parts[0] !== 'composition') {
    const match = parts[0].match(/^layer([1-9]\d*)$/);
    if (!match) return false;
    layer = project.layers[Number(match[1]) - 1];
    if (!layer) return false;
    target = layer; scope = 'layer';
    const clip = parts[1]?.match(/^clip([1-9]\d*)$/);
    if (clip) {
      target = visibleSlot(project, layer, project.selectedDeckId, Number(clip[1]) - 1).clip;
      if (!target) return false;
      scope = 'clip'; offset = 2;
    }
  }
  const tail = parts.slice(offset);
  if (tail.length === 1) {
    const property = tail[0];
    if (property === 'name' && scope !== 'composition' && args.length === 1 && typeof args[0] === 'string' && args[0].length <= 256) {
      target.name = args[0]; return true;
    }
    if (property === 'bypassed' && scope !== 'clip' && toggle(args)) { target.bypass = args[0] === 1; return true; }
    if (scope === 'composition' && property === 'disconnectall' && triggered(args) && transport) {
      for (const item of project.layers) (context.stopLayer || (id => transport.stop(id)))(item.id);
      return true;
    }
    if (scope === 'layer') {
      if (property === 'solo' && toggle(args)) { layer.solo = args[0] === 1; return true; }
      if (property === 'group' && integer(args, [0, 1, 2])) { layer.group = ['none', 'A', 'B'][args[0]]; return true; }
      if (!triggered(args)) return false;
      if (property === 'select' && typeof context.selectLayer === 'function') { context.selectLayer(layer.id); return true; }
      if (property === 'clear' && transport) { (context.stopLayer || (id => transport.stop(id)))(layer.id); return true; }
      if (property === 'moveup' || property === 'movedown') {
        const index = project.layers.indexOf(layer), next = index + (property === 'moveup' ? 1 : -1);
        if (next >= 0 && next < project.layers.length) [project.layers[index], project.layers[next]] = [project.layers[next], project.layers[index]];
        return true;
      }
    }
    if (scope === 'clip') {
      if (property === 'preview' && triggered(args) && typeof context.selectClip === 'function') { context.selectClip(target.id); return true; }
      if (property === 'connect' && toggle(args)) {
        if (args[0] === 1 && typeof context.triggerClip === 'function') { context.triggerClip(layer, target); return true; }
        if (args[0] === 0 && transport) {
          // A zero is the release edge of the connect button. Piano clips stop;
          // normal clips retain their normal trigger behavior on release.
          if (context.releaseClip) context.releaseClip(layer, target);
          else transport.release(layer.id, target.id);
          return true;
        }
      }
    }
    return false;
  }
  if (tail[0] !== 'audio' && tail[0] !== 'video') return false;
  const effect = tail[1]?.match(/^effect([1-9]\d*)$/);
  if (effect) return tail.length === 3 ? effectParameter(target, tail[0], Number(effect[1]) - 1, tail[2], args) : false;
  if (tail.length !== 3) return false;
  return mediaParameter(context, target, scope, layer, tail[0], tail[1], tail[2], args);
}
