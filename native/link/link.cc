// Node-API bridge to Ableton Link (https://github.com/Ableton/link, GPLv2+).
// One Link instance per process. All calls are cheap and thread-safe: Link
// guards its own state, and nothing here calls back into JavaScript.
#include <node_api.h>
#include <ableton/Link.hpp>

#include <chrono>
#include <cmath>


namespace {

// Deliberately never destroyed: Link's destructor joins its network threads,
// which deadlocks if it runs during process teardown. Exit ends the threads.
ableton::Link* link = nullptr;

ableton::Link& instance() {
  if (!link) link = new ableton::Link(120.0);
  return *link;
}

napi_value number(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

napi_value boolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

bool args(napi_env env, napi_callback_info info, size_t wanted, napi_value* values) {
  size_t count = wanted;
  return napi_get_cb_info(env, info, &count, values, nullptr, nullptr) == napi_ok && count >= wanted;
}

double toNumber(napi_env env, napi_value value, double fallback) {
  double result;
  return napi_get_value_double(env, value, &result) == napi_ok && std::isfinite(result) ? result : fallback;
}

bool toBool(napi_env env, napi_value value) {
  bool result = false;
  napi_get_value_bool(env, value, &result);
  return result;
}

void set(napi_env env, napi_value object, const char* key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

// enable(on)
napi_value Enable(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (args(env, info, 1, argv)) instance().enable(toBool(env, argv[0]));
  return boolean(env, instance().isEnabled());
}

// startStopSync(on)
napi_value StartStopSync(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (args(env, info, 1, argv)) instance().enableStartStopSync(toBool(env, argv[0]));
  return boolean(env, instance().isStartStopSyncEnabled());
}

// state(quantum) -> { enabled, peers, tempo, beat, phase, playing, micros }
napi_value State(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  const double quantum = args(env, info, 1, argv) ? std::fmax(1.0, toNumber(env, argv[0], 4.0)) : 4.0;
  auto& link = instance();
  const auto now = link.clock().micros();
  const auto state = link.captureAppSessionState();
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "enabled", boolean(env, link.isEnabled()));
  set(env, result, "startStopSync", boolean(env, link.isStartStopSyncEnabled()));
  set(env, result, "peers", number(env, static_cast<double>(link.numPeers())));
  set(env, result, "tempo", number(env, state.tempo()));
  set(env, result, "beat", number(env, state.beatAtTime(now, quantum)));
  set(env, result, "phase", number(env, state.phaseAtTime(now, quantum)));
  set(env, result, "playing", boolean(env, state.isPlaying()));
  set(env, result, "micros", number(env, static_cast<double>(now.count())));
  return result;
}

// setTempo(bpm)
napi_value SetTempo(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!args(env, info, 1, argv)) return nullptr;
  const double bpm = toNumber(env, argv[0], 0);
  if (bpm < 20 || bpm > 999) return boolean(env, false);
  auto& link = instance();
  auto state = link.captureAppSessionState();
  state.setTempo(bpm, link.clock().micros());
  link.commitAppSessionState(state);
  return boolean(env, true);
}

// setPlaying(playing, quantum): start on the next bar like Live does.
napi_value SetPlaying(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!args(env, info, 2, argv)) return nullptr;
  auto& link = instance();
  auto state = link.captureAppSessionState();
  const bool playing = toBool(env, argv[0]);
  const double quantum = std::fmax(1.0, toNumber(env, argv[1], 4.0));
  if (playing) state.setIsPlayingAndRequestBeatAtTime(true, link.clock().micros(), 0.0, quantum);
  else state.setIsPlaying(false, link.clock().micros());
  link.commitAppSessionState(state);
  return boolean(env, playing);
}

// requestBeat(beat, quantum): align our beat with the session (resync).
napi_value RequestBeat(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!args(env, info, 2, argv)) return nullptr;
  auto& link = instance();
  auto state = link.captureAppSessionState();
  state.requestBeatAtTime(toNumber(env, argv[0], 0), link.clock().micros(), std::fmax(1.0, toNumber(env, argv[1], 4.0)));
  link.commitAppSessionState(state);
  return boolean(env, true);
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor methods[] = {
    { "enable", nullptr, Enable, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "startStopSync", nullptr, StartStopSync, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "state", nullptr, State, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setTempo", nullptr, SetTempo, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "setPlaying", nullptr, SetPlaying, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "requestBeat", nullptr, RequestBeat, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
