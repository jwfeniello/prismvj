// Registers the built-in catalogs. Import once for its side effects.
import { registerEffect, registerSource, registerAudioEffect, effectDefinition, sourceDefinition, audioEffectDefinition } from './registry.js';
import { VIDEO_EFFECTS } from './video-effects.js';
import { SOURCES } from './sources.js';
import { TEXT_ANIMATOR, TextAnimator } from './text-animator.js';
import { AUDIO_EFFECTS } from '../audio-fx.js';

for (const definition of VIDEO_EFFECTS) if (!effectDefinition(definition.id)) registerEffect(definition);
for (const definition of SOURCES) if (!sourceDefinition(definition.id)) registerSource(definition);
if (!sourceDefinition(TEXT_ANIMATOR.id)) registerSource({ ...TEXT_ANIMATOR, kind: 'canvas', create: () => new TextAnimator() });
for (const definition of AUDIO_EFFECTS) if (!audioEffectDefinition(definition.id)) registerAudioEffect(definition);
