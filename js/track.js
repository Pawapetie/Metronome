// A decoded recording played on the metronome's AudioContext, so it can be
// started at an exact audio-clock time and stay sample-locked to the click.

export class Track {
  static async decode(ctx, blob) {
    const data = await blob.arrayBuffer();
    const buffer = await ctx.decodeAudioData(data);
    return new Track(ctx, buffer);
  }

  constructor(ctx, buffer) {
    this.ctx = ctx;
    this.buffer = buffer;
    // Own gain straight to the speakers: track volume is separate from the click.
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.src = null;
    this.startedAt = 0;   // audio-clock time playback (re)started
    this.startOffset = 0; // position in the track at that moment
    this.onended = null;  // called when the track plays to its end (not on stop())
    this.peakCache = new Map();
  }

  get duration() { return this.buffer.duration; }
  get playing() { return !!this.src; }

  setVolume(v) { this.gain.gain.value = v * v; }

  // Start playing `from` seconds into the track at audio-clock time `when`.
  play(when, from = 0) {
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      if (this.src !== src) return; // stopped or replaced
      this.src = null;
      this.onended?.();
    };
    const at = Math.max(when, this.ctx.currentTime);
    src.start(at, Math.min(from, this.duration));
    this.src = src;
    this.startedAt = at;
    this.startOffset = from;
  }

  stop() {
    const src = this.src;
    if (!src) return;
    this.src = null;
    try { src.stop(); } catch {}
    src.disconnect();
  }

  // Position in the track (seconds) at audio-clock time t.
  position(t = this.ctx.currentTime) {
    return Math.min(this.duration, this.startOffset + Math.max(0, t - this.startedAt));
  }

  // Waveform overview: n values in 0..1 (peak level per column), cached per n.
  peaks(n) {
    if (this.peakCache.has(n)) return this.peakCache.get(n);
    const chans = Array.from({ length: this.buffer.numberOfChannels }, (_, i) => this.buffer.getChannelData(i));
    const len = this.buffer.length;
    const per = len / n;
    const stride = Math.max(1, Math.floor(per / 400)); // sample ~400 points per column
    const out = new Float32Array(n);
    let max = 0;
    for (let x = 0; x < n; x++) {
      let peak = 0;
      const end = Math.min(len, Math.floor((x + 1) * per));
      for (let i = Math.floor(x * per); i < end; i += stride) {
        for (const c of chans) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
      }
      out[x] = peak;
      if (peak > max) max = peak;
    }
    if (max > 0) for (let x = 0; x < n; x++) out[x] /= max;
    this.peakCache.set(n, out);
    return out;
  }

  dispose() {
    this.stop();
    this.gain.disconnect();
    this.peakCache.clear();
  }
}
