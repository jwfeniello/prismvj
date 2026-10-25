// Node-API bridge for video sharing between applications: Spout (GPU texture
// sharing on Windows, https://spout.zeal.co, BSD-2-Clause, via SpoutDX) and
// NDI® (network video, https://ndi.video). The NDI runtime is not part of
// PrismVJ: it is loaded at run time from the NDI Runtime the user installed.
//
// Every sender and receiver owns a worker thread, so JavaScript only ever
// copies a frame into or out of a buffer. A sender keeps the newest frame and
// drops older ones it had no time for; a receiver keeps the newest frame.
#include <node_api.h>

#include "SpoutDX.h"
#include "Processing.NDI.Lib.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }

// ---- N-API helpers ---------------------------------------------------------

napi_value number(napi_env env, double value) { napi_value result; napi_create_double(env, value, &result); return result; }
napi_value boolean(napi_env env, bool value) { napi_value result; napi_get_boolean(env, value, &result); return result; }
napi_value string(napi_env env, const std::string& value) { napi_value result; napi_create_string_utf8(env, value.c_str(), value.size(), &result); return result; }
napi_value null(napi_env env) { napi_value result; napi_get_null(env, &result); return result; }
napi_value object(napi_env env) { napi_value result; napi_create_object(env, &result); return result; }
void set(napi_env env, napi_value target, const char* key, napi_value value) { napi_set_named_property(env, target, key, value); }

void fail(napi_env env, const std::string& message) { napi_throw_error(env, nullptr, message.c_str()); }

size_t args(napi_env env, napi_callback_info info, size_t wanted, napi_value* values, void** data = nullptr) {
  size_t count = wanted;
  for (size_t i = 0; i < wanted; i++) napi_get_undefined(env, &values[i]);
  napi_get_cb_info(env, info, &count, values, nullptr, data);
  return count;
}

double toNumber(napi_env env, napi_value value, double fallback) {
  double result;
  return napi_get_value_double(env, value, &result) == napi_ok && std::isfinite(result) ? result : fallback;
}

bool toBool(napi_env env, napi_value value, bool fallback = false) {
  bool result;
  return napi_get_value_bool(env, value, &result) == napi_ok ? result : fallback;
}

std::string toString(napi_env env, napi_value value, size_t limit = 255) {
  char buffer[1024] = {};
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, buffer, sizeof(buffer), &length) != napi_ok) return {};
  return std::string(buffer, std::min(length, limit));
}

// Bytes of a TypedArray, DataView or ArrayBuffer argument.
bool bytes(napi_env env, napi_value value, uint8_t** data, size_t* length) {
  bool is = false;
  if (napi_is_typedarray(env, value, &is) == napi_ok && is) {
    napi_typedarray_type type; napi_value buffer; size_t offset, count;
    if (napi_get_typedarray_info(env, value, &type, &count, reinterpret_cast<void**>(data), &buffer, &offset) != napi_ok) return false;
    size_t size = type == napi_uint8_array || type == napi_int8_array || type == napi_uint8_clamped_array ? 1
      : type == napi_uint16_array || type == napi_int16_array ? 2 : type == napi_float64_array || type == napi_bigint64_array || type == napi_biguint64_array ? 8 : 4;
    *length = count * size;
    return true;
  }
  if (napi_is_arraybuffer(env, value, &is) == napi_ok && is) return napi_get_arraybuffer_info(env, value, reinterpret_cast<void**>(data), length) == napi_ok;
  if (napi_is_dataview(env, value, &is) == napi_ok && is) { napi_value buffer; size_t offset; return napi_get_dataview_info(env, value, length, reinterpret_cast<void**>(data), &buffer, &offset) == napi_ok; }
  return false;
}

// ---- NDI runtime -----------------------------------------------------------

struct NdiRuntime {
  std::mutex lock;
  bool tried = false;
  HMODULE module = nullptr;
  const NDIlib_v6* lib = nullptr;
  std::string path, error, version;
  NDIlib_find_instance_t finder = nullptr;
};
NdiRuntime ndi;

std::string environment(const char* name) {
  char value[MAX_PATH * 2] = {};
  DWORD length = GetEnvironmentVariableA(name, value, sizeof(value));
  return length && length < sizeof(value) ? std::string(value, length) : std::string();
}

// PRISM_NDI_LIBRARY names a DLL explicitly; otherwise the NDI 6 and NDI 5
// runtime folders the NDI installers register, then the DLL search path.
const NDIlib_v6* loadNdi() {
  std::lock_guard<std::mutex> guard(ndi.lock);
  if (ndi.tried) return ndi.lib;
  ndi.tried = true;
  std::vector<std::string> candidates;
  if (auto explicitPath = environment("PRISM_NDI_LIBRARY"); !explicitPath.empty()) candidates.push_back(explicitPath);
  for (const char* folder : { NDILIB_REDIST_FOLDER, "NDI_RUNTIME_DIR_V5" })
    if (auto directory = environment(folder); !directory.empty()) candidates.push_back(directory + "\\" NDILIB_LIBRARY_NAME);
  candidates.push_back(NDILIB_LIBRARY_NAME);
  for (const auto& candidate : candidates) {
    HMODULE module = LoadLibraryExA(candidate.c_str(), nullptr, candidate.find('\\') != std::string::npos ? LOAD_WITH_ALTERED_SEARCH_PATH : 0);
    if (!module) continue;
    using Loader = const NDIlib_v6* (*)(void);
    auto load = reinterpret_cast<Loader>(GetProcAddress(module, "NDIlib_v6_load"));
    if (!load) load = reinterpret_cast<Loader>(GetProcAddress(module, "NDIlib_v5_load"));
    const NDIlib_v6* lib = load ? load() : nullptr;
    if (!lib || !lib->initialize || !lib->initialize()) {
      ndi.error = lib ? "This CPU is not supported by NDI." : "The NDI library has no loader entry point.";
      FreeLibrary(module);
      continue;
    }
    char resolved[MAX_PATH] = {};
    GetModuleFileNameA(module, resolved, MAX_PATH);
    ndi.module = module; ndi.lib = lib; ndi.path = resolved; ndi.error.clear();
    ndi.version = lib->version ? lib->version() : "";
    return lib;
  }
  if (ndi.error.empty()) ndi.error = "The NDI Runtime is not installed.";
  return nullptr;
}

// ---- Shared frame slot -----------------------------------------------------

// The newest frame plus a sequence number; a reader copies it out.
struct FrameSlot {
  std::mutex lock;
  std::vector<uint8_t> data;
  uint32_t width = 0, height = 0;
  uint64_t sequence = 0;
  bool alpha = true;
  Clock::time_point arrived;
};

struct Stats {
  std::atomic<uint64_t> frames{0}, dropped{0};
  std::atomic<double> workMs{0};
  void add(double ms) { workMs = workMs * 0.9 + ms * 0.1; frames++; }
};

// ---- Senders ---------------------------------------------------------------

struct Sender {
  enum Kind { Spout, Ndi } kind;
  std::string requested, name, error;
  std::mutex lock;
  std::condition_variable wake;
  std::vector<uint8_t> pending, working;
  uint32_t width = 0, height = 0;
  bool hasPending = false, stopping = false, ready = false, alpha = false;
  double fps = 60;
  std::thread thread;
  Stats stats;

  void run();
  void runSpout();
  void runNdi();
  // Wait for the next frame; false when the sender is closing.
  bool next(uint32_t& w, uint32_t& h, bool& withAlpha) {
    std::unique_lock<std::mutex> guard(lock);
    wake.wait(guard, [&] { return hasPending || stopping; });
    if (stopping) return false;
    std::swap(pending, working);
    hasPending = false; w = width; h = height; withAlpha = alpha;
    return true;
  }
  void started(const std::string& actual, const std::string& problem = {}) {
    std::lock_guard<std::mutex> guard(lock);
    name = actual; error = problem; ready = problem.empty();
  }
};

void Sender::runSpout() {
  spoutDX spout;
  if (!spout.OpenDirectX11()) { started("", "DirectX 11 is not available for Spout."); return; }
  spout.SetSenderName(requested.c_str());
  started(spout.GetName());
  uint32_t w, h; bool withAlpha;
  while (next(w, h, withAlpha)) {
    auto start = Clock::now();
    if (spout.SendImage(working.data(), w, h)) stats.add(msSince(start));
    else stats.dropped++;
    { std::lock_guard<std::mutex> guard(lock); name = spout.GetName(); }
  }
  spout.ReleaseSender();
  spout.CloseDirectX11();
}

void Sender::runNdi() {
  const NDIlib_v6* lib = loadNdi();
  if (!lib) { started("", ndi.error); return; }
  NDIlib_send_create_t create = {};
  create.p_ndi_name = requested.c_str();
  create.clock_video = false; create.clock_audio = false;
  NDIlib_send_instance_t send = lib->send_create(&create);
  if (!send) { started("", "The NDI sender could not be created."); return; }
  started(requested);
  uint32_t w, h; bool withAlpha;
  while (next(w, h, withAlpha)) {
    auto start = Clock::now();
    NDIlib_video_frame_v2_t frame = {};
    frame.xres = static_cast<int>(w); frame.yres = static_cast<int>(h);
    frame.FourCC = withAlpha ? NDIlib_FourCC_video_type_BGRA : NDIlib_FourCC_video_type_BGRX;
    frame.frame_rate_N = static_cast<int>(fps * 1000 + 0.5); frame.frame_rate_D = 1000;
    frame.picture_aspect_ratio = 0;
    frame.frame_format_type = NDIlib_frame_format_type_progressive;
    frame.timecode = NDIlib_send_timecode_synthesize;
    frame.p_data = working.data();
    frame.line_stride_in_bytes = static_cast<int>(w * 4);
    frame.timestamp = 0;
    // Synchronous send on this thread: the buffer is free again on return.
    lib->send_send_video_v2(send, &frame);
    stats.add(msSince(start));
  }
  lib->send_destroy(send);
}

void Sender::run() { if (kind == Spout) runSpout(); else runNdi(); }

// ---- Receivers -------------------------------------------------------------

struct Receiver {
  enum Kind { Spout, Ndi } kind;
  std::string source, url, error;
  std::mutex lock;
  std::atomic<bool> stopping{false}, connected{false};
  std::thread thread;
  FrameSlot slot;
  Stats stats;
  uint64_t delivered = 0;

  void run();
  void runSpout();
  void runNdi();
  void publish(const uint8_t* data, uint32_t width, uint32_t height, size_t stride, bool alpha) {
    std::lock_guard<std::mutex> guard(slot.lock);
    size_t row = static_cast<size_t>(width) * 4;
    slot.data.resize(row * height);
    if (stride == row) std::memcpy(slot.data.data(), data, row * height);
    else for (uint32_t y = 0; y < height; y++) std::memcpy(slot.data.data() + row * y, data + stride * y, row);
    slot.width = width; slot.height = height; slot.alpha = alpha;
    slot.sequence++; slot.arrived = Clock::now();
  }
  // Hands over a tightly packed frame without copying; `buffer` gets the old one.
  void publish(std::vector<uint8_t>& buffer, uint32_t width, uint32_t height, bool alpha) {
    std::lock_guard<std::mutex> guard(slot.lock);
    std::swap(slot.data, buffer);
    slot.width = width; slot.height = height; slot.alpha = alpha;
    slot.sequence++; slot.arrived = Clock::now();
  }
};

void Receiver::runSpout() {
  spoutDX spout;
  if (!spout.OpenDirectX11()) { std::lock_guard<std::mutex> guard(lock); error = "DirectX 11 is not available for Spout."; return; }
  spout.SetReceiverName(source.empty() ? nullptr : source.c_str());
  std::vector<uint8_t> pixels;
  unsigned int width = 0, height = 0;
  while (!stopping) {
    auto start = Clock::now();
    bool ok = spout.ReceiveImage(pixels.empty() ? nullptr : pixels.data(), width, height, false, false);
    if (ok && spout.IsUpdated()) {
      width = spout.GetSenderWidth(); height = spout.GetSenderHeight();
      DXGI_FORMAT format = spout.GetSenderFormat();
      // WebGL uploads RGBA; most senders share BGRA textures.
      spout.SetSwap(format == DXGI_FORMAT_B8G8R8A8_UNORM || format == DXGI_FORMAT_B8G8R8X8_UNORM || format == 0);
      pixels.assign(static_cast<size_t>(width) * height * 4, 0);
      continue;
    }
    connected = ok && spout.IsConnected();
    if (ok && !pixels.empty() && spout.IsFrameNew()) {
      publish(pixels, width, height, true);
      pixels.resize(static_cast<size_t>(width) * height * 4);
      stats.add(msSince(start));
    } else Sleep(ok ? 1 : 20);
  }
  spout.ReleaseReceiver();
  spout.CloseDirectX11();
}

void Receiver::runNdi() {
  const NDIlib_v6* lib = loadNdi();
  if (!lib) { std::lock_guard<std::mutex> guard(lock); error = ndi.error; return; }
  NDIlib_recv_create_v3_t create = {};
  create.source_to_connect_to.p_ndi_name = source.c_str();
  create.source_to_connect_to.p_url_address = url.empty() ? nullptr : url.c_str();
  create.color_format = NDIlib_recv_color_format_RGBX_RGBA;
  create.bandwidth = NDIlib_recv_bandwidth_highest;
  create.allow_video_fields = false;
  create.p_ndi_recv_name = "PrismVJ";
  NDIlib_recv_instance_t recv = lib->recv_create_v3(&create);
  if (!recv) { std::lock_guard<std::mutex> guard(lock); error = "The NDI receiver could not be created."; return; }
  while (!stopping) {
    NDIlib_video_frame_v2_t frame = {};
    NDIlib_frame_type_e type = lib->recv_capture_v2(recv, &frame, nullptr, nullptr, 100);
    if (type == NDIlib_frame_type_video) {
      auto start = Clock::now();
      connected = true;
      if (frame.p_data && (frame.FourCC == NDIlib_FourCC_video_type_RGBA || frame.FourCC == NDIlib_FourCC_video_type_RGBX)) {
        publish(frame.p_data, frame.xres, frame.yres, frame.line_stride_in_bytes, frame.FourCC == NDIlib_FourCC_video_type_RGBA);
        stats.add(msSince(start));
      } else stats.dropped++;
      lib->recv_free_video_v2(recv, &frame);
    } else if (type == NDIlib_frame_type_error) connected = false;
    else if (type == NDIlib_frame_type_none) connected = lib->recv_get_no_connections ? lib->recv_get_no_connections(recv) > 0 : connected.load();
  }
  lib->recv_destroy(recv);
}

void Receiver::run() { if (kind == Spout) runSpout(); else runNdi(); }

// ---- JavaScript objects ----------------------------------------------------

template <typename T> T* unwrap(napi_env env, napi_callback_info info, size_t wanted, napi_value* argv) {
  napi_value self; size_t count = wanted; void* native = nullptr;
  for (size_t i = 0; i < wanted; i++) napi_get_undefined(env, &argv[i]);
  napi_get_cb_info(env, info, &count, argv, &self, nullptr);
  if (napi_unwrap(env, self, &native) != napi_ok || !native) { fail(env, "This video share is closed."); return nullptr; }
  return static_cast<T*>(native);
}

void stopSender(Sender* sender) {
  if (!sender) return;
  { std::lock_guard<std::mutex> guard(sender->lock); sender->stopping = true; }
  sender->wake.notify_all();
  if (sender->thread.joinable()) sender->thread.join();
}

void stopReceiver(Receiver* receiver) {
  if (!receiver) return;
  receiver->stopping = true;
  if (receiver->thread.joinable()) receiver->thread.join();
}

napi_value methods(napi_env env, napi_value target, std::initializer_list<std::pair<const char*, napi_callback>> list) {
  for (auto& [key, callback] : list) { napi_value fn; napi_create_function(env, key, NAPI_AUTO_LENGTH, callback, nullptr, &fn); set(env, target, key, fn); }
  return target;
}

// sender.send(bytes, width, height[, { alpha, fps }]) copies a top-down BGRA frame.
napi_value SenderSend(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  Sender* sender = unwrap<Sender>(env, info, 4, argv);
  if (!sender) return nullptr;
  uint8_t* data; size_t length;
  double w = toNumber(env, argv[1], 0), h = toNumber(env, argv[2], 0);
  if (!bytes(env, argv[0], &data, &length) || w < 1 || h < 1 || w > 16384 || h > 16384) { fail(env, "send(bytes, width, height) needs a frame."); return nullptr; }
  size_t size = static_cast<size_t>(w) * static_cast<size_t>(h) * 4;
  if (length < size) { fail(env, "The frame is smaller than width × height × 4 bytes."); return nullptr; }
  napi_valuetype type; napi_typeof(env, argv[3], &type);
  bool alpha = false; double fps = 60;
  if (type == napi_object) {
    napi_value value;
    if (napi_get_named_property(env, argv[3], "alpha", &value) == napi_ok) alpha = toBool(env, value);
    if (napi_get_named_property(env, argv[3], "fps", &value) == napi_ok) fps = std::min(240.0, std::max(1.0, toNumber(env, value, 60)));
  }
  {
    std::lock_guard<std::mutex> guard(sender->lock);
    if (sender->hasPending) sender->stats.dropped++;
    sender->pending.resize(size);
    std::memcpy(sender->pending.data(), data, size);
    sender->width = static_cast<uint32_t>(w); sender->height = static_cast<uint32_t>(h);
    sender->alpha = alpha; sender->fps = fps; sender->hasPending = true;
  }
  sender->wake.notify_one();
  return boolean(env, true);
}

napi_value SenderInfo(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  Sender* sender = unwrap<Sender>(env, info, 0, argv);
  if (!sender) return nullptr;
  napi_value result = object(env);
  std::lock_guard<std::mutex> guard(sender->lock);
  set(env, result, "name", string(env, sender->name));
  set(env, result, "ready", boolean(env, sender->ready));
  set(env, result, "error", sender->error.empty() ? null(env) : string(env, sender->error));
  set(env, result, "frames", number(env, static_cast<double>(sender->stats.frames)));
  set(env, result, "dropped", number(env, static_cast<double>(sender->stats.dropped)));
  set(env, result, "sendMs", number(env, sender->stats.workMs));
  set(env, result, "width", number(env, sender->width));
  set(env, result, "height", number(env, sender->height));
  return result;
}

napi_value SenderClose(napi_env env, napi_callback_info info) {
  napi_value self; size_t count = 0; void* native = nullptr;
  napi_get_cb_info(env, info, &count, nullptr, &self, nullptr);
  if (napi_remove_wrap(env, self, &native) == napi_ok && native) { auto* sender = static_cast<Sender*>(native); stopSender(sender); delete sender; }
  return nullptr;
}

napi_value createSender(napi_env env, napi_callback_info info, Sender::Kind kind) {
  napi_value argv[1];
  args(env, info, 1, argv);
  std::string name = toString(env, argv[0], kind == Sender::Spout ? 255 : 200);
  if (name.empty()) name = "PrismVJ";
  if (kind == Sender::Ndi && !loadNdi()) { fail(env, ndi.error); return nullptr; }
  auto* sender = new Sender();
  sender->kind = kind; sender->requested = name;
  sender->thread = std::thread([sender] { sender->run(); });
  napi_value result = methods(env, object(env), { { "send", SenderSend }, { "info", SenderInfo }, { "close", SenderClose } });
  napi_wrap(env, result, sender, [](napi_env, void* data, void*) { auto* sender = static_cast<Sender*>(data); stopSender(sender); delete sender; }, nullptr, nullptr);
  return result;
}

napi_value CreateSpoutSender(napi_env env, napi_callback_info info) { return createSender(env, info, Sender::Spout); }
napi_value CreateNdiSender(napi_env env, napi_callback_info info) { return createSender(env, info, Sender::Ndi); }

// receiver.read(bytes[, flipY]) copies the newest frame (RGBA, top row first,
// or bottom row first with flipY as WebGL expects) when it is new and fits.
// Returns { width, height, sequence, alpha, copied, ageMs } or null.
napi_value ReceiverRead(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  Receiver* receiver = unwrap<Receiver>(env, info, 2, argv);
  if (!receiver) return nullptr;
  uint8_t* data = nullptr; size_t length = 0;
  bytes(env, argv[0], &data, &length);
  std::lock_guard<std::mutex> guard(receiver->slot.lock);
  auto& slot = receiver->slot;
  if (!slot.sequence || slot.sequence == receiver->delivered) return null(env);
  size_t size = static_cast<size_t>(slot.width) * slot.height * 4;
  bool copied = data && length >= size;
  if (copied) {
    if (toBool(env, argv[1])) {
      size_t row = static_cast<size_t>(slot.width) * 4;
      for (uint32_t y = 0; y < slot.height; y++) std::memcpy(data + row * y, slot.data.data() + row * (slot.height - 1 - y), row);
    } else std::memcpy(data, slot.data.data(), size);
    receiver->delivered = slot.sequence;
  }
  napi_value result = object(env);
  set(env, result, "width", number(env, slot.width));
  set(env, result, "height", number(env, slot.height));
  set(env, result, "sequence", number(env, static_cast<double>(slot.sequence)));
  set(env, result, "alpha", boolean(env, slot.alpha));
  set(env, result, "copied", boolean(env, copied));
  set(env, result, "ageMs", number(env, msSince(slot.arrived)));
  return result;
}

napi_value ReceiverInfo(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  Receiver* receiver = unwrap<Receiver>(env, info, 0, argv);
  if (!receiver) return nullptr;
  napi_value result = object(env);
  std::string error;
  { std::lock_guard<std::mutex> guard(receiver->lock); error = receiver->error; }
  uint32_t width, height;
  { std::lock_guard<std::mutex> guard(receiver->slot.lock); width = receiver->slot.width; height = receiver->slot.height; }
  set(env, result, "source", string(env, receiver->source));
  set(env, result, "connected", boolean(env, receiver->connected));
  set(env, result, "error", error.empty() ? null(env) : string(env, error));
  set(env, result, "frames", number(env, static_cast<double>(receiver->stats.frames)));
  set(env, result, "dropped", number(env, static_cast<double>(receiver->stats.dropped)));
  set(env, result, "receiveMs", number(env, receiver->stats.workMs));
  set(env, result, "width", number(env, width));
  set(env, result, "height", number(env, height));
  return result;
}

napi_value ReceiverClose(napi_env env, napi_callback_info info) {
  napi_value self; size_t count = 0; void* native = nullptr;
  napi_get_cb_info(env, info, &count, nullptr, &self, nullptr);
  if (napi_remove_wrap(env, self, &native) == napi_ok && native) { auto* receiver = static_cast<Receiver*>(native); stopReceiver(receiver); delete receiver; }
  return nullptr;
}

// createSpoutReceiver(senderName) — empty name follows Spout's active sender.
// createNdiReceiver(sourceName[, url])
napi_value createReceiver(napi_env env, napi_callback_info info, Receiver::Kind kind) {
  napi_value argv[2];
  args(env, info, 2, argv);
  std::string source = toString(env, argv[0]);
  napi_valuetype type; napi_typeof(env, argv[1], &type);
  if (kind == Receiver::Ndi) {
    if (source.empty()) { fail(env, "Choose an NDI source."); return nullptr; }
    if (!loadNdi()) { fail(env, ndi.error); return nullptr; }
  }
  auto* receiver = new Receiver();
  receiver->kind = kind; receiver->source = source;
  if (type == napi_string) receiver->url = toString(env, argv[1]);
  receiver->thread = std::thread([receiver] { receiver->run(); });
  napi_value result = methods(env, object(env), { { "read", ReceiverRead }, { "info", ReceiverInfo }, { "close", ReceiverClose } });
  napi_wrap(env, result, receiver, [](napi_env, void* data, void*) { auto* receiver = static_cast<Receiver*>(data); stopReceiver(receiver); delete receiver; }, nullptr, nullptr);
  return result;
}

napi_value CreateSpoutReceiver(napi_env env, napi_callback_info info) { return createReceiver(env, info, Receiver::Spout); }
napi_value CreateNdiReceiver(napi_env env, napi_callback_info info) { return createReceiver(env, info, Receiver::Ndi); }

// ---- Discovery -------------------------------------------------------------

// spoutSenders() → [{ name, width, height, format }]
napi_value SpoutSenders(napi_env env, napi_callback_info) {
  spoutSenderNames names;
  std::set<std::string> list;
  names.GetSenderNames(&list);
  napi_value result; napi_create_array(env, &result);
  uint32_t index = 0;
  for (const auto& name : list) {
    unsigned int width = 0, height = 0; HANDLE handle = nullptr; DWORD format = 0;
    if (!names.GetSenderInfo(name.c_str(), width, height, handle, format)) continue;
    napi_value item = object(env);
    set(env, item, "name", string(env, name));
    set(env, item, "width", number(env, width));
    set(env, item, "height", number(env, height));
    set(env, item, "format", number(env, format));
    napi_set_element(env, result, index++, item);
  }
  return result;
}

// ndiStatus() → { available, version, path, error, runtimeURL }
napi_value NdiStatus(napi_env env, napi_callback_info) {
  loadNdi();
  napi_value result = object(env);
  std::lock_guard<std::mutex> guard(ndi.lock);
  set(env, result, "available", boolean(env, ndi.lib != nullptr));
  set(env, result, "version", ndi.version.empty() ? null(env) : string(env, ndi.version));
  set(env, result, "path", ndi.path.empty() ? null(env) : string(env, ndi.path));
  set(env, result, "error", ndi.error.empty() ? null(env) : string(env, ndi.error));
  set(env, result, "runtimeURL", string(env, NDILIB_REDIST_URL));
  return result;
}

// ndiSources() → [{ name, url }]. Discovery runs in the background once
// started, so the first call usually returns an empty list.
napi_value NdiSources(napi_env env, napi_callback_info) {
  napi_value result; napi_create_array(env, &result);
  const NDIlib_v6* lib = loadNdi();
  if (!lib) return result;
  std::lock_guard<std::mutex> guard(ndi.lock);
  if (!ndi.finder) {
    NDIlib_find_create_t create = {};
    create.show_local_sources = true;
    ndi.finder = lib->find_create_v2(&create);
    if (!ndi.finder) return result;
  }
  uint32_t count = 0;
  const NDIlib_source_t* sources = lib->find_get_current_sources(ndi.finder, &count);
  for (uint32_t i = 0; i < count; i++) {
    napi_value item = object(env);
    set(env, item, "name", string(env, sources[i].p_ndi_name ? sources[i].p_ndi_name : ""));
    set(env, item, "url", sources[i].p_url_address ? string(env, sources[i].p_url_address) : null(env));
    napi_set_element(env, result, i, item);
  }
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  return methods(env, exports, {
    { "spoutSenders", SpoutSenders }, { "createSpoutSender", CreateSpoutSender }, { "createSpoutReceiver", CreateSpoutReceiver },
    { "ndiStatus", NdiStatus }, { "ndiSources", NdiSources }, { "createNdiSender", CreateNdiSender }, { "createNdiReceiver", CreateNdiReceiver },
  });
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
