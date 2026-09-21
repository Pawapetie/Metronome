// Song model: a sequence of sections, each with its own tempo and meter.
// Pure functions only (no DOM), so the bar maths is easy to test.
//
// Song    = { id, name, sections: Section[], countIn: 0|1|2, end: 'stop'|'loop',
//             audio: { name, duration, offset } | null }   (offset = where bar 1 starts in the recording, s)
// Section = { id, label, bars: number|null, bpm, beats, denom, pulse, accents, sub }
// bars: null means "repeat until stopped" and is only allowed on the last section.

import { ACCENT, NORMAL, MUTE } from './engine.js';
import { MIN_BPM, MAX_BPM, clampBeats, DENOMS, defaultAccents, isCompound } from './timesig.js';

export const MAX_BARS = 999;
const SUB_VALUES = [1, 2, 3, 4, 5, 6];

export const uid = () => Math.random().toString(36).slice(2, 10);

const clampBars = (n) => Math.min(MAX_BARS, Math.max(1, Math.round(Number(n)) || 1));
// Songs may hold fractional tempos (e.g. 119.5 from tap mapping); keep 2 decimals.
const clampSongBpm = (n) => Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, n)) * 100) / 100;

export function sanitizeSection(s = {}) {
  const beats = clampBeats(Math.round(Number(s.beats)) || 4);
  const denom = DENOMS.includes(s.denom) ? s.denom : 4;
  const accents = Array.isArray(s.accents) && s.accents.length === beats &&
    s.accents.every((a) => [ACCENT, NORMAL, MUTE].includes(a))
    ? [...s.accents] : defaultAccents(beats, denom);
  return {
    id: typeof s.id === 'string' && s.id ? s.id : uid(),
    label: typeof s.label === 'string' ? s.label.slice(0, 30) : '',
    bars: s.bars === null ? null : clampBars(s.bars ?? 8),
    bpm: clampSongBpm(Number(s.bpm) || 120),
    beats,
    denom,
    pulse: s.pulse === 'note' ? 'note' : 'dotted',
    accents,
    sub: SUB_VALUES.includes(s.sub) ? s.sub : 1,
  };
}

// A new section copies tempo/meter from `from` (usually the previous section).
export function newSection(from = {}) {
  return sanitizeSection({ ...from, id: undefined, label: '', bars: from.bars ?? 8 });
}

export function sanitizeSong(song = {}) {
  let sections = Array.isArray(song.sections) ? song.sections.map(sanitizeSection) : [];
  if (!sections.length) sections = [sanitizeSection({})];
  // Only the last section may be endless.
  sections.forEach((s, i) => { if (s.bars === null && i < sections.length - 1) s.bars = 8; });
  return {
    id: typeof song.id === 'string' && song.id ? song.id : uid(),
    name: typeof song.name === 'string' && song.name.trim() ? song.name.slice(0, 40) : 'Untitled song',
    sections,
    countIn: [0, 1, 2].includes(song.countIn) ? song.countIn : 0,
    end: song.end === 'loop' ? 'loop' : 'stop',
    audio: sanitizeAudio(song.audio),
  };
}

function sanitizeAudio(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    name: String(a.name || 'Recording').slice(0, 80),
    duration: Math.max(0, Number(a.duration) || 0),
    offset: Math.max(0, Number(a.offset) || 0),
  };
}

export function newSong(name, fromSettings = {}) {
  return sanitizeSong({ name, sections: [newSection({ ...fromSettings, bars: 8 })] });
}

// The example from the feature request: 4/4 -> 6/8 -> 4/4 at 80 BPM.
export function exampleSong() {
  return sanitizeSong({
    name: 'Example: 4/4 → 6/8 → 4/4',
    sections: [
      { label: 'Intro', bars: 8, bpm: 80, beats: 4, denom: 4 },
      { label: 'Bridge', bars: 8, bpm: 80, beats: 6, denom: 8, pulse: 'dotted' },
      { label: 'Rest of song', bars: null, bpm: 80, beats: 4, denom: 4 },
    ],
  });
}

export const isEndless = (song) => song.sections[song.sections.length - 1].bars === null;

// Total bars, or Infinity when the last section repeats until stopped.
export function totalBars(song) {
  return isEndless(song) ? Infinity : song.sections.reduce((n, s) => n + s.bars, 0);
}

// First bar of each section: [1, 9, 17, ...].
export function startBars(song) {
  let bar = 1;
  return song.sections.map((s) => { const start = bar; bar += s.bars ?? 0; return start; });
}

// Which section a (1-based) song bar falls in, or null past the end.
export function sectionAt(song, bar) {
  const starts = startBars(song);
  for (let i = song.sections.length - 1; i >= 0; i--) {
    if (bar >= starts[i]) {
      const section = song.sections[i];
      const barInSection = bar - starts[i] + 1;
      if (section.bars !== null && barInSection > section.bars) return null;
      return { index: i, section, barInSection, startBar: starts[i], bars: section.bars };
    }
  }
  return null;
}

// Looping is off while a recording is attached (the audio can't loop yet).
export const loops = (song) => song.end === 'loop' && !song.audio;

// Map the engine's ever-increasing bar number onto the song (wrapping when looping).
export function songBar(song, bar) {
  const total = totalBars(song);
  if (loops(song) && Number.isFinite(total) && bar > total) return ((bar - 1) % total) + 1;
  return bar;
}

// ---------- Timing (seconds) ----------

// Length of one bar. Dotted pulse: BPM counts dotted quarters, so a bar is
// beats/3 felt beats long.
export function barSeconds(s) {
  const dotted = s.pulse === 'dotted' && isCompound(s.beats, s.denom);
  return (s.beats * 60) / s.bpm / (dotted ? 3 : 1);
}

// Seconds from the start of bar 1 to the start of `bar`. Past the end of the
// song, bars continue at the last section's length.
export function timeAtBar(song, bar) {
  let t = 0, b = 1;
  for (const s of song.sections) {
    const take = Math.min(s.bars ?? Infinity, bar - b);
    if (take > 0) { t += take * barSeconds(s); b += take; }
    if (b >= bar) return t;
  }
  return t + (bar - b) * barSeconds(song.sections[song.sections.length - 1]);
}

// The bar playing `sec` seconds after the start of bar 1 (bar 1 for negative times).
export function barAtTime(song, sec) {
  if (sec < 0) return 1;
  const EPS = 1e-6;
  let t = 0, b = 1;
  for (const s of song.sections) {
    const len = barSeconds(s);
    const n = s.bars ?? Infinity;
    if (sec < t + n * len - EPS) return b + Math.floor((sec - t) / len + EPS);
    t += n * len;
    b += n;
  }
  return b + Math.floor((sec - t) / barSeconds(song.sections[song.sections.length - 1]) + EPS);
}

// Settings the engine plays for one bar. Bars before `startBar` are the count-in:
// the starting section's meter with only beat 1 accented.
export function stateForBar(song, bar, startBar = 1) {
  if (bar < startBar) {
    const s = (sectionAt(song, startBar) || sectionAt(song, 1)).section;
    return { ...s, sub: 1, accents: s.accents.map((_, i) => (i === 0 ? ACCENT : NORMAL)) };
  }
  const info = sectionAt(song, songBar(song, bar));
  return info ? info.section : null;
}
