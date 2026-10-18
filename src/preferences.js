const defaults = Object.freeze({ clipPanelFollowsTrigger:true, showAudioControls:true, showLayerTransport:false, showTransitions:true });
export function normalizePreferences(value) {
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback]) => [key,typeof value?.[key]==='boolean'?value[key]:fallback]));
}
export function readPreferences(storage = localStorage) {
  try { return normalizePreferences(JSON.parse(storage.getItem('prism-preferences')||'null')); }
  catch { return normalizePreferences(null); }
}
export function writePreferences(value, storage = localStorage) {
  const normalized=normalizePreferences(value);
  storage.setItem('prism-preferences',JSON.stringify(normalized));
  return normalized;
}
