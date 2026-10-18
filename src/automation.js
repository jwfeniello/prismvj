// Applies every animation on the composition, groups, layers, playing clips
// and their effects once per frame (manual pp. 141–145, 218–224).
import { writeOwner } from './params.js';

export function applyAnimations(project, frames, animator, { dt = 0, beat = 0, spectrum = () => null } = {}) {
  let count = 0;
  const run = (scope, owner, panel, context) => {
    const animations = owner?.animations;
    if (!animations) return;
    for (const key in animations) {
      const value = animator.evaluate(animations[key], {
        dt, beat, clipPosition: context.position,
        dial: index => panel?.dashboard?.[index]?.value ?? 0,
        spectrum: source => spectrum(source, source === 'clip' ? context.clipId : source === 'layer' ? context.layerId : source === 'group' ? context.groupId : null),
      });
      writeOwner(scope, owner, key, value);
      count++;
    }
  };
  const runOwner = (scope, owner, context) => {
    run(scope, owner, owner, context);
    for (const effect of owner.effects || []) run('effect', effect, owner, context);
    for (const effect of owner.audioEffects || []) run('audiofx', effect, owner, context);
  };
  runOwner('composition', project, {});
  for (const group of project.groups || []) runOwner('group', group, { groupId: group.id });
  for (const layer of project.layers) runOwner('layer', layer, { layerId: layer.id, groupId: layer.groupId });
  const seen = new Set();
  for (const frame of frames) {
    if (!frame.clip || seen.has(frame.clip.id) || frame.transitionIncoming === false) continue;
    seen.add(frame.clip.id);
    runOwner('clip', frame.clip, { position: frame.position, clipId: frame.clip.id, layerId: frame.layer?.id, groupId: frame.layer?.groupId });
  }
  return count;
}
