// Track triggers: "when this song plays on a CDJ, play this clip in sync".
// Pure logic shared by the app and tests. A trigger matches a player by track
// title and artist (so it works with any USB export of the song), or by the
// rekordbox track id when no title was available.
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const finite = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const TRIGGER_LIMIT = 256;

export function normalizeTrackTriggers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, TRIGGER_LIMIT).map(item => {
    if (!item || typeof item !== 'object' || !ID.test(item.id || '') || !ID.test(item.clipId || '') || seen.has(item.id)) return null;
    seen.add(item.id);
    const title = text(item.title, 200), artist = text(item.artist, 200);
    const trackId = Number.isInteger(item.trackId) && item.trackId > 0 ? item.trackId : 0;
    if (!title && !trackId) return null;
    return { id: item.id, title, artist, trackId, clipId: item.clipId, sync: item.sync !== false, offset: finite(item.offset, 0, -3600, 3600), stopWithTrack: item.stopWithTrack !== false };
  }).filter(Boolean);
}

const fold = value => text(value, 200).toLowerCase().replace(/\s+/g, ' ');

export function triggerMatches(trigger, player) {
  if (!player?.trackId) return false;
  if (trigger.title) return !!player.track?.title && fold(player.track.title) === fold(trigger.title) && (!trigger.artist || fold(player.track.artist) === fold(trigger.artist));
  return trigger.trackId === player.trackId;
}

// The player a trigger follows: the one with its track loaded, preferring a
// player that is live (playing, and on air when that is required), then the
// tempo master. Returns { player, live } or null.
export function playerFor(trigger, players, { requireOnAir = false } = {}) {
  const live = player => player.playing && (!requireOnAir || player.onAir);
  const candidates = (players || []).filter(player => triggerMatches(trigger, player));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (live(b) - live(a)) || (b.master - a.master) || (a.number - b.number));
  return { player: candidates[0], live: live(candidates[0]) };
}

// Normalized clip position for a track playhead (seconds), looping the clip's
// in/out range. `elapsed` extrapolates a snapshot that is `elapsed` s old.
export function clipPosition(trigger, player, clip, elapsed = 0) {
  const duration = Math.max(0.01, Number(clip?.duration) || 0.01);
  const rate = 1 + (Number(player.pitch) || 0) / 100;
  const seconds = (Number(player.position) || 0) + (player.playing ? Math.max(0, elapsed) * rate : 0) + trigger.offset;
  const lo = Number.isFinite(clip?.inPoint) ? clip.inPoint : 0, hi = Number.isFinite(clip?.outPoint) ? clip.outPoint : 1;
  const span = Math.max(1e-6, hi - lo);
  const normalized = seconds / duration;
  return lo + (((normalized - lo) % span) + span) % span;
}

export const trackLabel = trigger => trigger.title ? `${trigger.title}${trigger.artist ? ` — ${trigger.artist}` : ''}` : `Track #${trigger.trackId}`;