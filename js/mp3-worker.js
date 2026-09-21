// MP3 encoding off the main thread, using the vendored lamejs build.
// In:  { channels: Float32Array[] (1 or 2), sampleRate, kbps }
// Out: { progress: 0..1 } messages, then { done: true, parts: Uint8Array[] } or { error }.

importScripts('vendor/lame.min.js');

const toInt16 = (f) => {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
};

onmessage = (e) => {
  try {
    const { channels, sampleRate, kbps } = e.data;
    const enc = new lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
    const left = toInt16(channels[0]);
    const right = channels[1] ? toInt16(channels[1]) : null;
    const parts = [];
    const block = 1152 * 16;
    for (let i = 0, n = 0; i < left.length; i += block, n++) {
      const chunk = right
        ? enc.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block))
        : enc.encodeBuffer(left.subarray(i, i + block));
      if (chunk.length) parts.push(new Uint8Array(chunk)); // copy: lamejs reuses its buffer
      if (n % 16 === 0) postMessage({ progress: i / left.length });
    }
    const tail = enc.flush();
    if (tail.length) parts.push(new Uint8Array(tail));
    postMessage({ done: true, parts }, parts.map((p) => p.buffer));
  } catch (err) {
    postMessage({ error: String(err && err.message || err) });
  }
};
