// Time-signature rules and tempo helpers.
// Top number: how many beats per bar. Bottom number: which note gets the beat,
// which must be a power of two (whole, half, quarter, eighth, ...).

import { ACCENT, NORMAL } from './engine.js';

export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const MIN_BEATS = 1;
export const MAX_BEATS = 16;
export const DENOMS = [1, 2, 4, 8, 16, 32];

export const COMMON = [
  [2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [7, 8], [9, 8], [12, 8],
];

export const clampBpm = (n) => Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(n)));
export const clampBeats = (n) => Math.min(MAX_BEATS, Math.max(MIN_BEATS, n));

export function stepDenom(d, dir) {
  const i = DENOMS.indexOf(d);
  const next = Math.min(DENOMS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir));
  return DENOMS[next];
}

// Compound meters (6/8, 9/8, 12/8, 15/16 ...) are felt in groups of three.
export function isCompound(beats, denom) {
  return denom >= 8 && beats > 3 && beats % 3 === 0;
}

export function defaultAccents(beats, denom) {
  const a = Array.from({ length: beats }, () => NORMAL);
  if (isCompound(beats, denom)) {
    for (let i = 0; i < beats; i += 3) a[i] = ACCENT;
  } else {
    a[0] = ACCENT;
  }
  return a;
}

// Traditional Italian tempo markings (approximate ranges).
const MARKINGS = [
  [40, 'Grave'], [60, 'Largo'], [66, 'Larghetto'], [76, 'Adagio'],
  [108, 'Andante'], [120, 'Moderato'], [156, 'Allegro'], [176, 'Vivace'],
  [200, 'Presto'], [Infinity, 'Prestissimo'],
];
export function tempoName(bpm) {
  return MARKINGS.find(([max]) => bpm < max)[1];
}

const NOTE_NAMES = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd' };
export const noteName = (d) => NOTE_NAMES[d];

// What one BPM "beat" is. With a dotted pulse in compound meters the felt beat
// is a group of three bottom-number notes: 3 eighths = dotted quarter, etc.
const DOTTED_NAMES = { 8: 'dotted quarter', 16: 'dotted eighth', 32: 'dotted 16th' };
export function beatUnitLabel(beats, denom, pulse) {
  if (pulse === 'dotted' && isCompound(beats, denom)) return `${DOTTED_NAMES[denom]} note`;
  return `${noteName(denom)} note`;
}
