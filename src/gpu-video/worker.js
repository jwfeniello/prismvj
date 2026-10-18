// GPU video decoder worker: demuxing, Snappy/DXV decompression and frame reads
// run here so the compositor's render loop never waits for them.
import { handle } from './decode.js';

self.onmessage = async ({ data }) => {
  try {
    const { result, transfer } = await handle(data);
    self.postMessage({ id: data.id, result }, transfer);
  } catch (error) { self.postMessage({ id: data.id, error: error?.message || String(error) }); }
};
