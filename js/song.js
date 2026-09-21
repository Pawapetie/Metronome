// Song model: a sequence of sections, each with its own tempo and meter.
// Pure functions only (no DOM), so the bar maths is easy to test.
//
// Song    = { id, name, sections: Section[], countIn: 0|1|2, end: 'stop'|'loop' }
// Section = { id, label, bars: number|null, bpm, beats, denom, pulse, accents, sub }
// bars: null means "repeat until stopped" and is only allowed on the last section.

import { ACCENT, NORMAL, MUTE } from './engine.js';
import { clampBpm, clampBeats, DENOMS, defaultAccents } from './timesig.js';

export const MAX_BARS = 999;
const SUB_VALUES = [1, 2, 3, 4, 5, 6];

export const uid = () => Math.random().toString(36).slice(2, 10);

const clampBars = (n) => Math.min(MAX_BARS, Math.max(1, Math.round(Number(n)) || 1));

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
    bpm: clampBpm(Number(s.bpm) || 120),
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

// Map the engine's ever-increasing bar number onto the song (wrapping when looping).
export function songBar(song, bar) {
  const total = totalBars(song);
  if (song.end === 'loop' && Number.isFinite(total) && bar > total) return ((bar - 1) % total) + 1;
  return bar;
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
