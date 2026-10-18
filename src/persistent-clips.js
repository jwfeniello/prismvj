// Persistent clips stay in their home deck and cover the same layer/column in
// every other deck. The covered clip remains stored and can be moved away.
export function persistentAt(project, layer, column) {
  for (const deck of project.decks) {
    const clip = layer.clips[deck.id]?.[column];
    if (clip?.persistent) return { clip, deckId: deck.id };
  }
  return null;
}

export function visibleSlot(project, layer, deckId, column) {
  const stored = layer.clips[deckId]?.[column] || null;
  const persistent = persistentAt(project, layer, column);
  return {
    clip: persistent?.clip || stored,
    covered: persistent && stored && stored.id !== persistent.clip.id ? stored : null,
    persistentFrom: persistent?.deckId || null,
  };
}

export function visibleClips(project, layer, deckId) {
  return Array.from({ length: project.columns || 8 }, (_, column) => visibleSlot(project, layer, deckId, column).clip);
}

export function setPersistent(project, clipId, enabled) {
  for (const layer of project.layers) for (const deck of project.decks) {
    const column = layer.clips[deck.id]?.findIndex(clip => clip?.id === clipId) ?? -1;
    if (column < 0) continue;
    const clip = layer.clips[deck.id][column];
    if (enabled) for (const otherDeck of project.decks) {
      const other = layer.clips[otherDeck.id]?.[column];
      if (other && other !== clip) other.persistent = false;
    }
    clip.persistent = Boolean(enabled);
    return clip;
  }
  return null;
}

export function reconcilePersistent(project, preferredClip) {
  if (!preferredClip?.persistent) return;
  setPersistent(project, preferredClip.id, true);
}
