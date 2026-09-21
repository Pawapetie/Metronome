// Tap mode: play the recording, tap along with the beat, mark section starts,
// then review a quantized draft (js/tapmap.js) and apply it to the song.

import { fitTempo, buildDraft, meterKey } from './tapmap.js';
import { isCompound } from './timesig.js';
import { chipGroup, el } from './ui.js';

// Meters offered in the review. Compound meters count BPM in dotted quarters
// (the felt beat you tap) unless marked with the eighth-note pulse.
const METERS = [
  [4, 4], [3, 4], [2, 4], [5, 4],
  [6, 8, 'dotted'], [9, 8, 'dotted'], [12, 8, 'dotted'],
  [6, 8, 'note'], [7, 8], [5, 8],
].map(([beats, denom, pulse = 'dotted']) => ({ beats, denom, pulse }));
const meterLabel = (m) => `${m.beats}/${m.denom}` +
  (isCompound(m.beats, m.denom) ? (m.pulse === 'dotted' ? ' (tap ♩.)' : ' (tap ♪)') : '');

const ROUNDING = [
  { value: 1, label: 'Whole BPM' },
  { value: 0.5, label: '0.5' },
  { value: 0, label: 'Exact' },
];

const fmt = (sec) => {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(2).padStart(5, '0')}`;
};

// ctx: { getSong(), getTrack(), getAudioContext(), onApply(draft) }
export function createTapView(ctx) {
  const $ = (id) => document.getElementById(id);
  const root = $('tapView');
  const wave = $('tapWave');

  const sessions = new Map(); // song id -> { taps, marks, history } kept while the app is open
  let sess = null;
  let isOpen = false;
  let paused = 0;             // track position while paused
  let raf = 0;
  let rounding = 1;
  let meters = [];
  let bpms = [];

  const track = () => ctx.getTrack();
  const playing = () => !!track()?.playing;

  // ---------- Transport ----------
  function play(from = paused) {
    const t = track();
    if (!t) return;
    const ac = ctx.getAudioContext();
    if (ac.state !== 'running') ac.resume();
    if (from >= t.duration - 0.05) from = 0;
    t.onended = () => { paused = 0; renderTransport(); };
    t.play(ac.currentTime + 0.02, from);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    renderTransport();
  }
  function pause() {
    const t = track();
    if (!t) return;
    if (t.playing) paused = t.position();
    t.stop();
    cancelAnimationFrame(raf);
    renderTransport();
  }
  const toggle = () => (playing() ? pause() : play());

  function loop() {
    renderTransport();
    draw();
    if (playing()) raf = requestAnimationFrame(loop);
  }

  function renderTransport() {
    const t = track();
    const pos = t ? (t.playing ? t.position() : paused) : 0;
    $('tapPlay').textContent = playing() ? '❚❚' : '▶';
    $('tapPlay').setAttribute('aria-label', playing() ? 'Pause' : 'Play');
    $('tapTime').textContent = `${fmt(pos)} / ${fmt(t?.duration || 0)}`;
    if (!playing()) draw();
  }

  // Position in the track that the listener is hearing at event time.
  function heardPosition(e) {
    const t = track();
    const ac = ctx.getAudioContext();
    let when = ac.currentTime - (ac.outputLatency || 0) - (ac.baseLatency || 0);
    const ts = ac.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0 && e?.timeStamp) {
      when = ts.contextTime + (e.timeStamp - ts.performanceTime) / 1000;
    }
    return t.position(when);
  }

  // ---------- Tapping ----------
  function flash(elm) {
    elm.classList.add('flash');
    setTimeout(() => elm.classList.remove('flash'), 80);
  }
  function needPlay() {
    $('tapHint').textContent = 'Press ▶ first, then tap along with the song.';
    $('tapHint').classList.add('warn');
  }

  function tap(e) {
    if (!playing()) return needPlay();
    sess.taps.push(heardPosition(e));
    sess.history.push('tap');
    flash($('tapPad'));
    renderStats();
  }
  function mark(e) {
    if (!playing()) return needPlay();
    sess.marks.push(heardPosition(e));
    sess.history.push('mark');
    flash($('tapSection'));
    renderStats();
  }

  $('tapPad').addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); tap(e); } });
  $('tapSection').addEventListener('pointerdown', (e) => { if (e.button === 0) { e.preventDefault(); mark(e); } });
  $('tapPlay').addEventListener('click', toggle);
  $('tapRewind').addEventListener('click', () => { const was = playing(); pause(); paused = 0; if (was) play(0); else renderTransport(); });
  $('tapUndo').addEventListener('click', () => {
    const last = sess.history.pop();
    if (last === 'tap') sess.taps.pop();
    else if (last === 'mark') sess.marks.pop();
    renderStats();
  });
  $('tapClear').addEventListener('click', () => {
    if (!sess.taps.length && !sess.marks.length) return;
    if (!confirm('Clear all taps and section marks?')) return;
    sess.taps = []; sess.marks = []; sess.history = [];
    renderStats();
  });

  wave.addEventListener('click', (e) => {
    const t = track();
    if (!t) return;
    const r = wave.getBoundingClientRect();
    const pos = Math.max(0, Math.min(t.duration, ((e.clientX - r.left) / r.width) * t.duration));
    if (playing()) play(pos); else { paused = pos; renderTransport(); }
  });
  new ResizeObserver(() => draw()).observe(wave);

  function renderStats() {
    const lastMark = sess.marks.length ? Math.max(...sess.marks) : -Infinity;
    const recent = sess.taps.filter((x) => x >= lastMark);
    const fit = fitTempo(recent.length >= 4 ? recent : sess.taps);
    $('tapBpm').textContent = fit ? (60 / fit.period).toFixed(1) : '–';
    $('tapCount').textContent = sess.taps.length;
    $('tapSecs').textContent = sess.marks.length;
    $('tapUndo').disabled = !sess.history.length;
    $('tapReview').disabled = sess.taps.length < 4;
    if (!$('tapHint').classList.contains('warn') || playing()) {
      $('tapHint').classList.remove('warn');
      $('tapHint').textContent = sess.marks.length
        ? 'Keep tapping for at least 8 beats after each section start. You don’t need to tap the whole song.'
        : 'Press ▶, tap along with the beat, and press New section on bar 1 and on the first beat of each new section.';
    }
    draw();
  }

  function draw() {
    const t = track();
    const dpr = window.devicePixelRatio || 1;
    const w = wave.clientWidth, h = wave.clientHeight;
    if (!w || !t) return;
    if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
    const g = wave.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const X = (s) => (s / t.duration) * w;
    const peaks = t.peaks(Math.floor(w));
    g.fillStyle = css.getPropertyValue('--muted').trim();
    for (let x = 0; x < peaks.length; x++) {
      const a = Math.max(1, peaks[x] * (h / 2 - 6));
      g.fillRect(x, h / 2 - a, 1, a * 2);
    }
    g.fillStyle = css.getPropertyValue('--normal').trim();
    for (const s of sess?.taps || []) g.fillRect(X(s), 0, 1, 7);
    g.fillStyle = css.getPropertyValue('--accent').trim();
    for (const s of sess?.marks || []) g.fillRect(X(s) - 1, 0, 2, h);
    g.fillStyle = css.getPropertyValue('--text').trim();
    g.fillRect(X(t.playing ? t.position() : paused) - 1, 0, 2, h);
  }

  // ---------- Review ----------
  const renderRounding = chipGroup($('roundChips'), ROUNDING, (v) => { rounding = v; bpms = []; renderDraft(); });

  function showStep(n) {
    $('tapStep1').hidden = n !== 1;
    $('tapStep2').hidden = n !== 2;
    $('tapTitle').textContent = n === 1 ? 'Tap tempo map' : 'Review draft';
    root.scrollTop = 0;
  }

  let draft = null;
  function renderDraft() {
    const song = ctx.getSong();
    draft = buildDraft({ taps: sess.taps, marks: sess.marks, duration: track()?.duration || song.audio?.duration || 0 },
      { rounding, meters, bpms });
    renderRounding(rounding);
    $('draftError').textContent = draft.error || '';
    $('draftApply').disabled = !!draft.error;
    if (draft.error) { $('draftRows').replaceChildren(); $('draftOffset').textContent = ''; return; }
    $('draftOffset').textContent = `Bar 1 starts at ${fmt(draft.offset)} · ${draft.sections.length} section${draft.sections.length > 1 ? 's' : ''} · ${draft.sections.reduce((n, s) => n + s.bars, 0)} bars`;

    $('draftRows').replaceChildren(...draft.rows.map((row, k) => {
      const sec = draft.sections[k];
      const select = el('select', { 'aria-label': `Section ${k + 1} time signature` },
        ...METERS.map((m, i) => el('option', { value: i, selected: meterKey(m) === meterKey(row.meter) }, meterLabel(m))));
      select.addEventListener('change', () => { meters[k] = METERS[Number(select.value)]; renderDraft(); });

      const bpmIn = el('input', {
        type: 'number', inputmode: 'decimal', step: 'any', min: 20, max: 300, value: sec.bpm,
        class: 'text-input bpm-edit', 'aria-label': `Section ${k + 1} BPM`,
      });
      bpmIn.addEventListener('change', () => {
        const v = Number(bpmIn.value);
        if (v >= 20 && v <= 300) bpms[k] = v; else delete bpms[k];
        renderDraft();
      });

      const fitted = row.rawBpm != null
        ? `Tapped ${row.rawBpm.toFixed(2)} BPM from ${row.taps} taps` : 'No tempo tapped here';
      return el('div', { class: 'card draft-row', style: `--c:${['#ff9f1c', '#5b9dff', '#3ecf8e', '#c77dff', '#ff6b8b', '#2ec4d6'][k % 6]}` },
        el('div', { class: 'draft-head' },
          el('span', { class: 'swatch' }),
          el('b', {}, `Section ${k + 1}`),
          el('span', { class: 'draft-when' }, `from ${fmt(row.start)} · ${sec.bars} bar${sec.bars > 1 ? 's' : ''}`)),
        el('div', { class: 'draft-fields' },
          el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'BPM'), bpmIn),
          el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Time signature'), select)),
        el('p', { class: 'hint' }, fitted),
        ...row.warnings.map((w) => el('p', { class: 'draft-warn' }, `⚠ ${w}`)),
        row.suggestions.length ? el('div', { class: 'chips draft-sugg' },
          el('span', { class: 'hint' }, 'Fits:'),
          ...row.suggestions.map((m) => el('button', {
            type: 'button', class: 'chip',
            onclick: () => { meters[k] = METERS.find((x) => meterKey(x) === meterKey(m)) || m; renderDraft(); },
          }, meterLabel(m)))) : null,
      );
    }));
  }

  $('tapReview').addEventListener('click', () => {
    pause();
    meters = []; bpms = [];
    showStep(2);
    renderDraft();
  });
  $('draftBack').addEventListener('click', () => showStep(1));
  $('draftApply').addEventListener('click', () => {
    if (!draft || draft.error) return;
    const song = ctx.getSong();
    if (song.sections.length > 1 && !confirm(`Replace the ${song.sections.length} sections in "${song.name}" with this draft?`)) return;
    ctx.onApply(draft);
    close();
  });

  // Keys while open (capture phase, so the main screen's shortcuts don't fire):
  // J / F = tap, S = new section, Space = play/pause, Esc = close.
  document.addEventListener('keydown', (e) => {
    if (!isOpen || e.target.matches('input, select')) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat && !$('tapStep1').hidden) toggle(); }
    else if ((k === 'j' || k === 'f') && !e.repeat && !$('tapStep1').hidden) tap(e);
    else if (k === 's' && !e.repeat && !$('tapStep1').hidden) mark(e);
    else if (e.key === 'Escape') close();
    else return;
    e.stopImmediatePropagation();
  }, true);
  document.addEventListener('keyup', (e) => {
    if (isOpen && e.code === 'Space' && !e.target.matches('input, select')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  $('tapBack').addEventListener('click', () => close());

  function open() {
    const song = ctx.getSong();
    if (!track()) return;
    if (!sessions.has(song.id)) sessions.set(song.id, { taps: [], marks: [], history: [] });
    sess = sessions.get(song.id);
    isOpen = true;
    paused = 0;
    root.hidden = false;
    $('songView').inert = true;
    document.body.classList.add('tap-open');
    showStep(1);
    renderStats();
    renderTransport();
    $('tapPlay').focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen) return;
    pause();
    isOpen = false;
    root.hidden = true;
    $('songView').inert = false;
    document.body.classList.remove('tap-open');
    $('tapMapBtn')?.focus({ preventScroll: true });
  }

  return { open, close, get isOpen() { return isOpen; } };
}
