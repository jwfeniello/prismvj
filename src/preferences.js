// Booleans are interface switches; strings name audio devices by id.
const defaults = Object.freeze({ clipPanelFollowsTrigger:true, showAudioControls:true, showLayerTransport:false, showTransitions:true, midiClockSync:false, linkEnabled:false, linkStartStop:false });
const devices = Object.freeze({ audioInputDevice:'', audioOutputDevice:'', smpteInputDevice:'' });
export function normalizePreferences(value) {
  return { ...Object.fromEntries(Object.entries(defaults).map(([key,fallback]) => [key,typeof value?.[key]==='boolean'?value[key]:fallback])),
    ...Object.fromEntries(Object.entries(devices).map(([key,fallback]) => [key,typeof value?.[key]==='string'?value[key].slice(0,256):fallback])),
    isfFolders: Array.isArray(value?.isfFolders) ? value.isfFolders.filter(item => typeof item === 'string' && item.length < 4096).slice(0,16) : [],
    oscOutEnabled: value?.oscOutEnabled === true, oscOutHost: typeof value?.oscOutHost === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(value.oscOutHost) ? value.oscOutHost : '127.0.0.1',
    oscOutPort: Number.isInteger(value?.oscOutPort) && value.oscOutPort > 0 && value.oscOutPort < 65536 ? value.oscOutPort : 7001,
    smpteChannel: Number.isInteger(value?.smpteChannel) && value.smpteChannel >= 0 && value.smpteChannel < 8 ? value.smpteChannel : 0,
    smpteFps: ['auto','23.976','24','25','29.97','30'].includes(String(value?.smpteFps)) ? String(value.smpteFps) : 'auto' };
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
