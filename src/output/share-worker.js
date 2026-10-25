// Reads Spout/NDI output frames back from the GPU off the editor's main
// thread. Receives VideoFrames of a canvas and returns top-down BGRA pixels;
// buffers come back through `release` and are reused.
//
// WebGPU copies each frame into a BGRA texture and then into a mappable
// buffer, and the map completes asynchronously: about 1 ms of this thread per
// 1080p frame. VideoFrame.copyTo, the fallback without WebGPU, reads back on
// the GPU process's main thread (about 15 ms per 1080p frame there).
const SLOTS = 8;
const outputs = new Map();
let gpu = null;

const ready = (async () => {
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    gpu = adapter ? await adapter.requestDevice() : null;
    gpu?.lost.then(() => { gpu = null; outputs.clear(); });
  } catch { gpu = null; }
})();

function output(id) {
  if (!outputs.has(id)) outputs.set(id, { pool: [], width: 0, height: 0, texture: null, slots: [] });
  return outputs.get(id);
}

// Rows of a copyTextureToBuffer target are padded to 256 bytes.
function resize(state, width, height) {
  state.texture?.destroy();
  for (const slot of state.slots) slot.buffer.destroy();
  const stride = Math.ceil(width * 4 / 256) * 256;
  state.texture = gpu.createTexture({ size: [width, height], format: 'bgra8unorm', usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  state.slots = Array.from({ length: SLOTS }, () => ({ buffer: gpu.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false }));
  Object.assign(state, { width, height, stride, pool: [] });
}

function take(state, size) {
  let buffer = state.pool.pop();
  while (buffer && buffer.byteLength !== size) buffer = state.pool.pop();
  return buffer || new ArrayBuffer(size);
}

async function readGpu(state, frame, width, height) {
  if (state.width !== width || state.height !== height || !state.texture) resize(state, width, height);
  const slot = state.slots.find(item => !item.busy);
  if (!slot) throw new Error('busy');
  slot.busy = true;
  try {
    gpu.queue.copyExternalImageToTexture({ source: frame }, { texture: state.texture }, [width, height]);
    const encoder = gpu.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: state.texture }, { buffer: slot.buffer, bytesPerRow: state.stride }, [width, height]);
    gpu.queue.submit([encoder.finish()]);
    frame.close();
    // Waiting on the queue as well makes Chromium deliver the map promptly
    // (about 20 ms instead of 70 ms at 1080p).
    gpu.queue.onSubmittedWorkDone().catch(() => {});
    await slot.buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(slot.buffer.getMappedRange()), row = width * 4;
    const pixels = new Uint8Array(take(state, row * height));
    if (state.stride === row) pixels.set(mapped);
    else for (let y = 0; y < height; y++) pixels.set(mapped.subarray(y * state.stride, y * state.stride + row), y * row);
    slot.buffer.unmap();
    return pixels.buffer;
  } finally { slot.busy = false; }
}

async function readCopy(state, frame) {
  const buffer = take(state, frame.allocationSize({ format: 'BGRA' }));
  await frame.copyTo(buffer, { format: 'BGRA' });
  return buffer;
}

self.onmessage = async ({ data }) => {
  if (data.release) { const state = output(data.id); if (state.pool.length < 3) state.pool.push(data.release); return; }
  if (data.forget) { const state = outputs.get(data.id); state?.texture?.destroy(); for (const slot of state?.slots || []) slot.buffer.destroy(); outputs.delete(data.id); return; }
  const { id, frame } = data;
  try {
    await ready;
    const { width, height } = frame.visibleRect, state = output(id);
    const buffer = gpu ? await readGpu(state, frame, width, height) : await readCopy(state, frame);
    self.postMessage({ id, buffer, width, height, started: data.started }, [buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message, started: data.started });
  } finally {
    frame.close();
  }
};
