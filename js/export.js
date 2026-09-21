// MP3 export: render the click (and optionally the recording) offline with the
// same scheduling rules as playback, then encode to MP3 in a worker.

import { playSound } from './sounds.js';
import { tickLevel, tickSeconds, clickChain, softClipper } from './engine.js';
import * as model from './song.js';

const RATE = 44100;
const TAIL = 0.25; // let the last click ring out in click-only files
export const KBPS = { mix: 192, click: 128 };

// Timeline of an export (seconds in the output file).
//   what: 'mix' (whole recording + click) | 'click' (click only, starting at the
//   first click: the count-in if any, else bar 1).
export function exportPlan(song, trackDuration, what) {
  const offset = song.audio.offset;
  const countIn = song.countIn;
  const countInSec = countIn * model.barSeconds(song.sections[0]);
  const total = model.totalBars(song);
  // Where the song map ends in the recording (endless last section: never).
  const mapEnd = Number.isFinite(total) ? offset + model.timeAtBar(song, total + 1) : Infinity;
  const firstClick = offset - countInSec; // in recording time
  const clickStop = Math.min(mapEnd, trackDuration);
  if (what === 'mix') {
    // If the count-in starts before the recording does, pad the start with silence.
    const lead = Math.max(0, -firstClick);
    return { countIn, trackAt: lead, clickStart: lead + firstClick, clickEnd: lead + clickStop, length: lead + trackDuration };
  }
  const end = Math.max(0, clickStop - firstClick);
  return { countIn, trackAt: null, clickStart: 0, clickEnd: end, length: end + TAIL };
}

// Every click in the file: [{ t, level }], mirroring Engine.schedule().
export function clickEvents(song, plan) {
  const out = [];
  let t = plan.clickStart;
  const end = plan.clickEnd - 1e-6;
  for (let bar = 1 - plan.countIn; t < end; bar++) {
    const s = model.stateForBar(song, bar, 1);
    if (!s) break;
    for (let beat = 0; beat < s.beats; beat++) {
      for (let sub = 0; sub < s.sub; sub++) {
        if (t >= end) return out;
        const level = tickLevel(s, beat, sub);
        if (level) out.push({ t, level });
        t += tickSeconds(s);
      }
    }
  }
  return out;
}

// opts: { what, split, clickVol, trackVol, kit }. Returns { buffer, plan }.
export async function renderExport(song, recording, opts) {
  const plan = exportPlan(song, recording.duration, opts.what);
  const mix = opts.what === 'mix';
  const ctx = new OfflineAudioContext(mix ? 2 : 1, Math.max(1, Math.ceil(plan.length * RATE)), RATE);

  // Soft limiter on the whole mix so a loud track plus accents can't clip the
  // MP3. Zero latency, so the click stays exactly where playback puts it.
  const limiter = softClipper(ctx, ctx.destination);

  let clickOut = limiter, trackOut = limiter;
  if (mix && opts.split) {
    // Stereo split: click alone in the left channel, the song (mono) in the right.
    const merger = ctx.createChannelMerger(2);
    merger.connect(limiter);
    const mono = (channel) => {
      const g = ctx.createGain();
      g.channelCount = 1;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers';
      g.connect(merger, 0, channel);
      return g;
    };
    clickOut = mono(0);
    trackOut = mono(1);
  }

  const click = clickChain(ctx, clickOut);
  click.gain.value = opts.clickVol * opts.clickVol; // same curve as playback
  for (const { t, level } of clickEvents(song, plan)) playSound(ctx, click, opts.kit, level, t);

  if (mix) {
    const src = ctx.createBufferSource();
    src.buffer = recording;
    const g = ctx.createGain();
    g.gain.value = opts.trackVol * opts.trackVol;
    src.connect(g);
    g.connect(trackOut);
    src.start(plan.trackAt);
  }
  return { buffer: await ctx.startRendering(), plan };
}

// Encode an AudioBuffer to MP3 in a worker. Returns { promise, cancel }.
export function encodeMp3(buffer, kbps, onProgress) {
  const worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice());
  let cancel;
  const promise = new Promise((resolve, reject) => {
    cancel = () => { worker.terminate(); reject(new DOMException('Cancelled', 'AbortError')); };
    worker.onmessage = (e) => {
      if (e.data.error) { worker.terminate(); reject(new Error(e.data.error)); }
      else if (e.data.done) { worker.terminate(); resolve(new Blob(e.data.parts, { type: 'audio/mpeg' })); }
      else onProgress?.(e.data.progress);
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Encoder failed to load')); };
    worker.postMessage({ channels, sampleRate: buffer.sampleRate, kbps }, channels.map((c) => c.buffer));
  });
  return { promise, cancel };
}

export const safeFileName = (s) => (s || 'Song').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60) || 'Song';

// Hand the file to the user: share sheet on phones (Save to Files, AirDrop...),
// a normal download elsewhere. Must run inside a user gesture for sharing.
export async function saveFile(blob, name) {
  const file = new File([blob], name, { type: 'audio/mpeg' });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      // fall through to a download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
