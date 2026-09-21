// Timing core: "A Tale of Two Clocks" lookahead scheduler.
// A coarse timer (in a Web Worker, so tab throttling doesn't stall it) wakes up
// every LOOKAHEAD_MS and books every tick falling within SCHEDULE_AHEAD seconds
// onto the sample-accurate AudioContext clock. The timer only needs to be
// roughly on time; the audio hardware fires each click exactly.

import { playSound } from './sounds.js';
import { isCompound } from './timesig.js';

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.1;

export const ACCENT = 2;
export const NORMAL = 1;
export const MUTE = 0;

const WORKER_SRC = `
let id = null;
onmessage = (e) => {
  clearInterval(id); id = null;
  if (e.data === 'start') id = setInterval(() => postMessage(0), ${LOOKAHEAD_MS});
};`;

export class Engine {
  // getState(bar) -> { bpm, beats, denom, pulse, sub, accents: number[], kit } for that
  // bar, or null to end playback (song finished). Settings are fetched per tick,
  // but song mode returns the same settings for a whole bar, so changes land on bar lines.
  // onTick(beatIndex, subIndex, bar) is called in sync with what is heard.
  // onEnd() fires after the last scheduled click of a finished song has played.
  constructor(getState, onTick) {
    this.getState = getState;
    this.onTick = onTick;
    this.ctx = null;
    this.master = null;
    this.playing = false;
    this.queue = [];
    this.worker = null;
    this.raf = 0;
    this.ending = false;
    this.onEnd = null;
    this.volume = 0.8;
  }

  ensureContext() {
    if (this.ctx) return;
    // iOS 17+: route through the "playback" session so the silent switch doesn't mute clicks.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.connect(comp);
    this.setVolume(this.volume);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v * v; // perceptual curve
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch {}
    }
  }

  async start({ startBar = 1 } = {}) {
    if (this.playing) return;
    this.ensureContext();
    await this.resume();
    this.playing = true;
    this.ending = false;
    this.beat = 0;
    this.subIdx = 0;
    this.bar = startBar;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.queue = [];
    if (!this.worker) {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      this.worker.onmessage = () => this.schedule();
    }
    this.worker.postMessage('start');
    this.schedule();
    this.raf = requestAnimationFrame(() => this.drawLoop());
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.ending = false;
    this.worker?.postMessage('stop');
    cancelAnimationFrame(this.raf);
    this.queue = [];
  }

  schedule() {
    if (!this.playing || this.ending) return;
    const ctx = this.ctx;
    // After a suspension (phone call, backgrounding) don't burst out missed ticks.
    if (this.nextTime < ctx.currentTime - 0.05) this.nextTime = ctx.currentTime + 0.05;

    while (this.nextTime < ctx.currentTime + SCHEDULE_AHEAD) {
      const s = this.getState(this.bar);
      if (!s) { this.ending = true; break; }
      // Settings may have shrunk since the last tick; wrap safely, and if that
      // moved us into a new bar, fetch that bar's settings first.
      const bar = this.bar;
      if (this.subIdx >= s.sub) { this.subIdx = 0; this.advanceBeat(s); }
      if (this.beat >= s.beats) { this.beat = 0; this.bar++; }
      if (this.bar !== bar) continue;

      // Dotted pulse: BPM counts dotted quarters in compound meters (6/8 at 80 =
      // two felt beats per bar at 80); eighths inside each group play softer.
      const dotted = s.pulse === 'dotted' && isCompound(s.beats, s.denom);
      const accent = s.accents[this.beat] ?? NORMAL;
      if (accent !== MUTE) {
        let level = 'normal';
        if (this.subIdx > 0) level = 'sub';
        else if (accent === ACCENT) level = 'accent';
        else if (dotted && this.beat % 3 !== 0) level = 'sub';
        playSound(ctx, this.master, s.kit, level, this.nextTime);
      }
      this.queue.push({ time: this.nextTime, beat: this.beat, sub: this.subIdx, bar: this.bar });

      this.nextTime += 60 / s.bpm / (dotted ? 3 : 1) / s.sub;
      this.subIdx++;
      if (this.subIdx >= s.sub) { this.subIdx = 0; this.advanceBeat(s); }
    }
  }

  advanceBeat(s) {
    this.beat++;
    if (this.beat >= s.beats) { this.beat = 0; this.bar++; }
  }

  drawLoop() {
    if (!this.playing) return;
    const ctx = this.ctx;
    // Flash when the click actually reaches the speaker, not when it is rendered.
    const now = ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
    while (this.queue.length && this.queue[0].time <= now) {
      const t = this.queue.shift();
      this.onTick(t.beat, t.sub, t.bar);
    }
    if (this.ending && !this.queue.length) {
      this.stop();
      this.onEnd?.();
      return;
    }
    this.raf = requestAnimationFrame(() => this.drawLoop());
  }

  // One-off sound for previews and tap feedback.
  preview(kit, level = 'accent') {
    this.ensureContext();
    this.resume();
    playSound(this.ctx, this.master, kit, level, this.ctx.currentTime + 0.01);
  }
}
