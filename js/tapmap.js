// Tap mapping: turn imprecise taps along a recording into a quantized song draft.
// Pure functions (no DOM) so the maths can be unit-tested.
//
// Input: beat taps and "new section" marks, both in seconds from the start of
// the recording. Taps are human, so everything is fitted and snapped:
//   - tempo: robust least-squares fit per section, rounded (whole BPM default)
//   - bar 1: the fitted beat nearest the first section mark
//   - later section starts: rounded to whole bars, laid end to end

import { MIN_BPM, MAX_BPM, isCompound } from './timesig.js';

export const MIN_TAPS = 4;
const MIN_GAP = 0.12;          // gaps shorter than this are double taps (500 BPM)
const OUTLIER = 0.25;          // drop taps more than this fraction of a beat off the fit
const AMBIGUOUS = 0.35;        // a gap this far between whole beats is a stray tap
const MIN_MARK_GAP = 0.5;      // marks closer than this are treated as one

export const METER_CHOICES = [
  { beats: 4, denom: 4, pulse: 'dotted' },
  { beats: 3, denom: 4, pulse: 'dotted' },
  { beats: 2, denom: 4, pulse: 'dotted' },
  { beats: 6, denom: 8, pulse: 'dotted' },
];
const DEFAULT_METER = METER_CHOICES[0];

export const meterKey = (m) => `${m.beats}/${m.denom}${m.pulse === 'note' && isCompound(m.beats, m.denom) ? '♪' : ''}`;

// How many felt beats (taps) are in one bar of this meter.
export function tapsPerBar({ beats, denom, pulse }) {
  return pulse === 'dotted' && isCompound(beats, denom) ? beats / 3 : beats;
}

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function linearFit(pts) {
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { slope, intercept: (sy - slope * sx) / n };
}

// Fit a steady beat to taps. Returns { period, phase, count, spread, points }
// where points are [beatIndex, time] pairs actually used, or null.
export function fitTempo(taps) {
  if (taps.length < MIN_TAPS) return null;
  const t = [...taps].sort((a, b) => a - b);
  const gaps = t.slice(1).map((x, i) => x - t[i]).filter((g) => g >= MIN_GAP);
  if (gaps.length < MIN_TAPS - 1) return null;
  const guess = median(gaps);

  // Number the beats, measuring each gap from the last accepted tap so a
  // missed beat (gap ≈ 2 beats) is absorbed and stray taps are skipped.
  let pts = [[0, t[0]]];
  let idx = 0, last = t[0];
  for (let i = 1; i < t.length; i++) {
    const g = t[i] - last;
    if (g < MIN_GAP) continue; // double tap
    const steps = g / guess;
    const whole = Math.round(steps);
    if (whole < 1 || Math.abs(steps - whole) > AMBIGUOUS) continue;
    idx += whole;
    pts.push([idx, t[i]]);
    last = t[i];
  }
  if (pts.length < MIN_TAPS) return null;

  let fit = linearFit(pts);
  const resid = (p) => p[1] - (fit.intercept + fit.slope * p[0]);
  const kept = pts.filter((p) => Math.abs(resid(p)) <= OUTLIER * fit.slope);
  if (kept.length >= MIN_TAPS && kept.length < pts.length) {
    pts = kept;
    fit = linearFit(pts);
  }
  const spread = Math.sqrt(pts.reduce((s, p) => s + resid(p) ** 2, 0) / pts.length);
  return { period: fit.slope, phase: fit.intercept, count: pts.length, spread, points: pts };
}

export function roundBpm(bpm, step) {
  const r = step ? Math.round(bpm / step) * step : Math.round(bpm * 100) / 100;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, r));
}

// Build a song draft.
//   input: { taps: number[], marks: number[], duration }
//   opts:  { rounding: 1 | 0.5 | 0, meters: [meter per section], bpms: [override per section] }
// Returns { offset, sections, rows } or { error }.
export function buildDraft({ taps = [], marks = [], duration = 0 }, { rounding = 1, meters = [], bpms = [] } = {}) {
  const t = [...taps].sort((a, b) => a - b);
  let m = [...marks].sort((a, b) => a - b).filter((x, i, a) => i === 0 || x - a[i - 1] >= MIN_MARK_GAP);
  if (!m.length && t.length) m = [t[0]]; // no marks: bar 1 is the first tap
  if (!m.length) return { error: 'Tap along with the song first.' };

  const sections = [];
  const rows = [];
  let start = 0, offset = 0, prevBpm = null;

  for (let k = 0; k < m.length; k++) {
    const from = k === 0 ? -Infinity : m[k];
    const to = k + 1 < m.length ? m[k + 1] : Infinity;
    const fit = fitTempo(t.filter((x) => x >= from && x < to));
    const rawBpm = fit ? 60 / fit.period : null;
    const warnings = [];
    let bpm;
    if (bpms[k] != null) bpm = roundBpm(bpms[k], 0);
    else if (rawBpm != null) bpm = roundBpm(rawBpm, rounding);
    else if (prevBpm != null) {
      bpm = prevBpm;
      warnings.push(`Fewer than ${MIN_TAPS} usable taps here, so the previous tempo is used.`);
    } else {
      return { error: `Tap at least ${MIN_TAPS} steady beats around the first section mark.` };
    }
    if (fit && fit.spread > 0.2 * fit.period) warnings.push('Taps were uneven here; check this tempo.');

    const meter = meters[k] || DEFAULT_METER;
    const per = tapsPerBar(meter);
    const P = 60 / bpm;

    if (k === 0) {
      // Bar 1 = the fitted beat nearest the first mark (phase re-fitted to the rounded tempo).
      const phase = fit ? fit.points.reduce((s, [i, x]) => s + (x - i * P), 0) / fit.points.length : m[0];
      start = offset = Math.max(0, phase + Math.round((m[0] - phase) / P) * P);
    }

    let bars, beatCount, suggestions = [];
    if (k + 1 < m.length) {
      beatCount = Math.max(1, Math.round((m[k + 1] - start) / P));
      bars = Math.max(1, Math.round(beatCount / per));
      const off = beatCount - bars * per;
      if (off) {
        warnings.push(`The next section mark is ${Math.abs(off)} beat${Math.abs(off) > 1 ? 's' : ''} ${off > 0 ? 'after' : 'before'} a bar line.`);
        suggestions = METER_CHOICES.filter((c) => meterKey(c) !== meterKey(meter) && beatCount % tapsPerBar(c) === 0);
      }
    } else {
      beatCount = Math.max(0, Math.floor((duration - start) / P + 1e-6));
      bars = Math.max(1, Math.floor(beatCount / per));
    }

    sections.push({ bars, bpm, beats: meter.beats, denom: meter.denom, pulse: meter.pulse });
    rows.push({ start, rawBpm, bpm, taps: fit ? fit.count : 0, beatCount, meter, warnings, suggestions });
    start += bars * per * P;
    prevBpm = bpm;
  }
  return { offset, sections, rows };
}
