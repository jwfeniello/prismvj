'use strict';
// Ableton Link session (tempo, beat phase, start/stop) via the native bridge
// in native/link (Ableton's own Link library). Missing builds degrade to
// "unavailable" rather than breaking startup.
const path = require('node:path');

const QUANTUM = 4;
let native = null, loadError = null, timer = null;

// Packaged builds ship the module beside app.asar (extra resource); a
// development checkout loads it from electron/native.
function bridge() {
  if (native || loadError) return native;
  const candidates = [process.resourcesPath && path.join(process.resourcesPath, 'prism_link.node'), path.join(__dirname, 'native', 'prism_link.node')].filter(Boolean);
  for (const candidate of candidates) {
    try { native = require(candidate); loadError = null; break; }
    catch (error) { loadError = error; }
  }
  return native;
}

function status() {
  const link = bridge();
  if (!link) return { available: false, error: loadError?.message || 'Link is not built.' };
  return { available: true, quantum: QUANTUM, ...link.state(QUANTUM) };
}

// send(state) is called ~30×/s while Link is enabled.
function setEnabled(enabled, send) {
  const link = bridge();
  if (!link) throw new Error(`Ableton Link is unavailable: ${loadError?.message || 'not built'}`);
  link.enable(!!enabled);
  clearInterval(timer); timer = null;
  if (enabled) {
    timer = setInterval(() => send(status()), 33);
    timer.unref?.();
  }
  send(status());
  return status();
}

function setTempo(bpm) {
  const link = bridge();
  if (!link || !Number.isFinite(bpm)) return false;
  return link.setTempo(Math.min(999, Math.max(20, bpm)));
}

function setPlaying(playing) { return !!bridge()?.setPlaying(!!playing, QUANTUM); }
function setStartStopSync(enabled) { return !!bridge()?.startStopSync(!!enabled); }
function stop() { clearInterval(timer); timer = null; try { native?.enable(false); } catch { /* shutting down */ } }

module.exports = { status, setEnabled, setTempo, setPlaying, setStartStopSync, stop, QUANTUM };
