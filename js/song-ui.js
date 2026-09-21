// Song view: a full-screen panel for building songs out of sections with their
// own tempo/meter, and following them during playback.

import { COMMON, clampBpm, clampBeats, stepDenom, defaultAccents, isCompound, beatUnitLabel } from './timesig.js';
import { SUBS, PULSES, renderBeatButtons, holdRepeat, chipGroup, el } from './ui.js';
import * as model from './song.js';
import * as store from './presets.js';
import * as audioStore from './audiostore.js';
import { Track } from './track.js';
import { createTapView } from './tap-ui.js';

const COLORS = ['#ff9f1c', '#5b9dff', '#3ecf8e', '#c77dff', '#ff6b8b', '#2ec4d6'];
const color = (i) => COLORS[i % COLORS.length];

const sectionName = (s, i) => s.label.trim() || `Section ${i + 1}`;
const meterText = (s) =>
  `${s.beats}/${s.denom} · ${s.bpm} BPM${s.pulse === 'dotted' && isCompound(s.beats, s.denom) ? ' (♩.)' : ''}`;

// ctx: { getMainSettings(), getKit(), getAudioContext(), play({ section } | { bar }), stop(), isPlaying() }
export function createSongView(ctx) {
  const $ = (id) => document.getElementById(id);
  const root = $('songView');

  // ---------- Data ----------
  const saved = store.loadSongs();
  let songs = saved.songs.map(model.sanitizeSong);
  if (!songs.length) songs = [model.exampleSong()];
  let song = songs.find((s) => s.id === saved.currentId) || songs[0];
  let openId = null;      // expanded section id
  let playStart = 1;      // song bar playback began at (count-in bars come before it)
  let isOpen = false;

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.saveSongs({ songs, currentId: song.id }), 300);
  }
  const stopIfPlaying = () => { if (ctx.isPlaying()) ctx.stop(); };

  // Only the last section may repeat forever.
  function fixEndless() {
    const n = song.sections.length;
    song.sections.forEach((s, i) => { if (s.bars === null && i < n - 1) s.bars = 8; });
  }

  function rangeText(i) {
    const start = model.startBars(song)[i];
    const s = song.sections[i];
    return s.bars === null ? `Bars ${start}–∞ (repeats)` : `Bars ${start}–${start + s.bars - 1} (${s.bars})`;
  }

  // ---------- Song picker ----------
  const select = $('songSelect');
  const nameInput = $('songName');

  function renderPicker() {
    select.replaceChildren(...songs.map((s) =>
      el('option', { value: s.id, selected: s.id === song.id }, s.name || 'Untitled song')));
    if (document.activeElement !== nameInput) nameInput.value = song.name;
  }

  select.addEventListener('change', () => {
    stopIfPlaying();
    song = songs.find((s) => s.id === select.value) || songs[0];
    openId = null;
    renderAll();
    save();
    loadTrack();
  });
  nameInput.addEventListener('input', () => {
    song.name = nameInput.value.slice(0, 40);
    const opt = select.selectedOptions[0];
    if (opt) opt.textContent = song.name || 'Untitled song';
    save();
  });
  nameInput.addEventListener('blur', () => {
    if (!song.name.trim()) { song.name = 'Untitled song'; renderPicker(); save(); }
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  $('songNew').addEventListener('click', () => {
    stopIfPlaying();
    const s = model.newSong(`Song ${songs.length + 1}`, ctx.getMainSettings());
    songs.push(s);
    song = s;
    openId = s.sections[0].id;
    renderAll();
    save();
    loadTrack();
    nameInput.focus();
    nameInput.select();
  });
  $('songDup').addEventListener('click', () => {
    stopIfPlaying();
    const copy = model.sanitizeSong({ ...structuredClone(song), id: undefined, name: `${song.name} (copy)` });
    if (copy.audio) audioStore.copyAudio(song.id, copy.id);
    songs.push(copy);
    song = copy;
    openId = null;
    renderAll();
    save();
  });
  $('songDel').addEventListener('click', () => {
    if (!confirm(`Delete song "${song.name}"?`)) return;
    stopIfPlaying();
    audioStore.deleteAudio(song.id);
    songs = songs.filter((s) => s !== song);
    if (!songs.length) songs = [model.newSong('Song 1', ctx.getMainSettings())];
    song = songs[0];
    openId = null;
    renderAll();
    save();
    loadTrack();
  });

  // ---------- Timeline ----------
  const timeline = $('timeline');
  function renderTimeline() {
    timeline.replaceChildren(...song.sections.map((s, i) => el('button', {
      type: 'button',
      class: `tl-block${s.bars === null ? ' endless' : ''}`,
      style: `flex-grow:${s.bars ?? 8};--c:${color(i)}`,
      title: `${sectionName(s, i)}: ${meterText(s)}`,
      'aria-label': `${sectionName(s, i)}, ${rangeText(i)}, ${meterText(s)}`,
      dataset: { index: i },
      onclick: () => { openId = s.id; renderSections(); },
    }, el('span', { class: 'tl-fill' }), el('span', { class: 'tl-label' }, `${s.beats}/${s.denom}`),
       el('small', {}, s.bars === null ? `${s.bpm} ∞` : String(s.bpm)))));
    const total = model.totalBars(song);
    const fixed = song.sections.reduce((n, s) => n + (s.bars ?? 0), 0);
    $('songTotal').textContent = Number.isFinite(total)
      ? `${total} bars total`
      : `${fixed} bars, then the last section repeats until you stop`;
  }

  // ---------- Sections ----------
  const list = $('sectionList');
  let cards = [];

  // Something changed inside a section: update summaries without rebuilding editors.
  function changed() {
    cards.forEach((c) => c.refreshHead());
    renderTimeline();
    renderOptions();
    drawWave();
    save();
  }

  function renderSections() {
    cards = song.sections.map((s, i) => buildCard(s, i));
    list.replaceChildren(...cards.map((c) => c.el));
    const openCard = cards.find((c) => c.id === openId);
    if (openCard) openCard.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function structural() {
    fixEndless();
    renderTimeline();
    renderSections();
    renderOptions();
    drawWave();
    save();
  }

  function buildCard(sec, i) {
    const n = song.sections.length;
    const isLast = i === n - 1;
    const open = sec.id === openId;
    const card = el('div', { class: `card section-card${open ? ' open' : ''}`, dataset: { id: sec.id } });
    card.style.setProperty('--c', color(i));

    const title = el('span', { class: 'sec-title' });
    const range = el('small');
    const meta = el('small', { class: 'sec-meta' });
    const head = el('button', {
      type: 'button', class: 'sec-head', 'aria-expanded': String(open),
      onclick: () => { openId = open ? null : sec.id; renderSections(); },
    }, el('span', { class: 'swatch' }), el('span', { class: 'sec-text' }, title, range, meta),
       el('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'));
    card.append(head);
    const refreshHead = () => {
      title.textContent = sectionName(sec, i);
      range.textContent = rangeText(i);
      meta.textContent = meterText(sec);
    };
    refreshHead();
    if (!open) return { id: sec.id, el: card, refreshHead };

    // ---- Editor ----
    const edit = (fn) => { fn(); refresh(); changed(); };

    const label = el('input', {
      type: 'text', class: 'text-input', maxlength: 30, placeholder: `Section ${i + 1}`,
      value: sec.label, 'aria-label': 'Section name', autocomplete: 'off',
    });
    label.addEventListener('input', () => { sec.label = label.value; changed(); });

    // Bars
    const barsOut = el('output', { class: 'num' });
    const barsDown = el('button', { type: 'button', class: 'round small', 'aria-label': 'Fewer bars' }, '−');
    const barsUp = el('button', { type: 'button', class: 'round small', 'aria-label': 'More bars' }, '+');
    holdRepeat(barsDown, (k) => { if (sec.bars !== null) edit(() => { sec.bars = Math.max(1, sec.bars - k); }); });
    holdRepeat(barsUp, (k) => { if (sec.bars !== null) edit(() => { sec.bars = Math.min(model.MAX_BARS, sec.bars + k); }); });
    let endless = null;
    if (isLast) {
      endless = el('input', { type: 'checkbox' });
      endless.addEventListener('change', () => edit(() => { sec.bars = endless.checked ? null : 8; }));
    }

    // BPM: same typing behaviour as the main screen.
    const bpmIn = el('input', {
      type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 3, class: 'num-input',
      'aria-label': 'Section BPM', autocomplete: 'off',
    });
    bpmIn.addEventListener('focus', () => { bpmIn.placeholder = sec.bpm; bpmIn.value = ''; });
    bpmIn.addEventListener('input', () => { bpmIn.value = bpmIn.value.replace(/\D/g, '').slice(0, 3); });
    bpmIn.addEventListener('blur', () => {
      const v = parseInt(bpmIn.value, 10);
      bpmIn.placeholder = '';
      if (Number.isFinite(v)) edit(() => { sec.bpm = clampBpm(v); }); else refresh();
    });
    bpmIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') bpmIn.blur();
      else if (e.key === 'Escape') { bpmIn.value = ''; bpmIn.blur(); }
    });
    const bpmDown = el('button', { type: 'button', class: 'round small', 'aria-label': 'Decrease BPM' }, '−');
    const bpmUp = el('button', { type: 'button', class: 'round small', 'aria-label': 'Increase BPM' }, '+');
    holdRepeat(bpmDown, (k) => edit(() => { sec.bpm = clampBpm(sec.bpm - k); }));
    holdRepeat(bpmUp, (k) => edit(() => { sec.bpm = clampBpm(sec.bpm + k); }));
    const bpmUnit = el('small', { class: 'unit' });

    // Time signature
    const setMeter = (b, d) => edit(() => {
      sec.beats = clampBeats(b);
      sec.denom = d;
      sec.accents = defaultAccents(sec.beats, sec.denom);
    });
    const tsBeats = el('output', { class: 'num' });
    const tsDenom = el('output', { class: 'num' });
    const tsBtn = (label, sym, fn) => {
      const b = el('button', { type: 'button', class: 'round small', 'aria-label': label }, sym);
      holdRepeat(b, fn);
      return b;
    };
    const tsChipsEl = el('div', { class: 'chips compact' });
    const renderTsChips = chipGroup(tsChipsEl, COMMON.map(([b, d]) => ({ value: `${b}/${d}`, label: `${b}/${d}` })),
      (v) => { const [b, d] = v.split('/').map(Number); setMeter(b, d); });

    const pulseChipsEl = el('div', { class: 'chips' });
    const renderPulse = chipGroup(pulseChipsEl, PULSES, (v) => edit(() => { sec.pulse = v; }));
    const pulseRow = el('div', { class: 'pulse-row' }, el('span', {}, 'BPM counts'), pulseChipsEl);

    const beatsEl = el('div', { class: 'beats' });
    const subChipsEl = el('div', { class: 'chips' });
    const renderSubs = chipGroup(subChipsEl,
      SUBS.map(({ n: v, label: l, note }) => ({ value: v, html: `${l}<small>${note}</small>` })),
      (v) => edit(() => { sec.sub = v; }), 'sub');

    // Actions
    const move = (dir) => {
      const j = i + dir;
      [song.sections[i], song.sections[j]] = [song.sections[j], song.sections[i]];
      structural();
    };
    const actions = el('div', { class: 'sec-actions' },
      el('button', { type: 'button', class: 'primary', onclick: () => ctx.play({ section: i }) }, '▶ Start here'),
      el('button', {
        type: 'button', onclick: () => {
          const copy = model.newSection(sec);
          copy.label = sec.label;
          copy.bars = sec.bars; // an endless last section stays endless as the copy
          if (sec.bars === null) sec.bars = 8;
          song.sections.splice(i + 1, 0, copy);
          openId = copy.id;
          structural();
        },
      }, 'Duplicate'),
      el('button', { type: 'button', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(-1) }, '↑'),
      el('button', { type: 'button', 'aria-label': 'Move down', disabled: isLast, onclick: () => move(1) }, '↓'),
      el('button', {
        type: 'button', class: 'danger', disabled: n === 1, onclick: () => {
          if (!confirm(`Delete ${sectionName(sec, i)}?`)) return;
          song.sections.splice(i, 1);
          openId = null;
          structural();
        },
      }, 'Delete'),
    );

    const field = (name, ...kids) => el('div', { class: 'field' }, el('span', { class: 'field-label' }, name), ...kids);
    card.append(el('div', { class: 'sec-editor' },
      field('Name', label),
      field('Bars',
        el('div', { class: 'stepper' }, barsDown, barsOut, barsUp),
        endless && el('label', { class: 'switch inline' }, endless, el('span', { class: 'track' }), el('span', {}, 'Repeat until stopped'))),
      field('Tempo', el('div', { class: 'stepper' }, bpmDown, bpmIn, bpmUp), bpmUnit),
      field('Time signature',
        el('div', { class: 'ts-inline' },
          el('div', { class: 'stepper' }, tsBtn('Fewer beats', '−', () => setMeter(sec.beats - 1, sec.denom)), tsBeats,
            tsBtn('More beats', '+', () => setMeter(sec.beats + 1, sec.denom))),
          el('span', { class: 'slash' }, '/'),
          el('div', { class: 'stepper' }, tsBtn('Longer beat note', '−', () => setMeter(sec.beats, stepDenom(sec.denom, -1))), tsDenom,
            tsBtn('Shorter beat note', '+', () => setMeter(sec.beats, stepDenom(sec.denom, 1))))),
        tsChipsEl, pulseRow),
      field('Accents', beatsEl),
      field('Subdivision', subChipsEl),
      actions,
    ));

    function refresh() {
      barsOut.textContent = sec.bars ?? '∞';
      barsDown.disabled = barsUp.disabled = sec.bars === null;
      if (endless) endless.checked = sec.bars === null;
      if (document.activeElement !== bpmIn) bpmIn.value = sec.bpm;
      bpmUnit.textContent = `BPM · ${beatUnitLabel(sec.beats, sec.denom, sec.pulse)}`;
      tsBeats.textContent = sec.beats;
      tsDenom.textContent = sec.denom;
      renderTsChips(`${sec.beats}/${sec.denom}`);
      pulseRow.hidden = !isCompound(sec.beats, sec.denom);
      renderPulse(sec.pulse);
      renderBeatButtons(beatsEl, sec.accents, (k, lvl) => edit(() => { sec.accents[k] = lvl; }));
      renderSubs(sec.sub);
    }
    refresh();
    return { id: sec.id, el: card, refreshHead };
  }

  $('addSection').addEventListener('click', () => {
    const last = song.sections[song.sections.length - 1];
    if (last.bars === null) last.bars = 8;
    const s = model.newSection(last);
    song.sections.push(s);
    openId = s.id;
    structural();
  });

  // ---------- Options ----------
  const renderCountIn = chipGroup($('countInChips'),
    [{ value: 0, label: 'Off' }, { value: 1, label: '1 bar' }, { value: 2, label: '2 bars' }],
    (v) => { song.countIn = v; renderOptions(); save(); });
  const renderEnd = chipGroup($('endChips'),
    [{ value: 'stop', label: 'Stop' }, { value: 'loop', label: 'Loop song' }],
    (v) => { song.end = v; renderOptions(); save(); });

  function renderOptions() {
    renderCountIn(song.countIn);
    renderEnd(song.end);
    const endless = model.isEndless(song);
    for (const c of $('endChips').children) c.disabled = endless || !!song.audio;
    if (song.audio) renderEnd('stop');
    $('endHint').textContent = song.audio
      ? 'Loop is off while a recording is attached. Playback stops when the recording ends.'
      : endless ? 'The last section repeats until you press Stop.' : '';
  }

  // ---------- Recording ----------
  let track = null;       // decoded Track for the current song, or null
  let loadToken = 0;      // guards against a slow decode finishing after a song switch
  let playheadRaf = 0;
  const wave = $('wave');
  const recStatus = (msg) => { $('recStatus').textContent = msg || ''; };

  const fmtTime = (sec) => {
    const m = Math.floor(sec / 60);
    return `${m}:${(sec - m * 60).toFixed(2).padStart(5, '0')}`;
  };

  function disposeTrack() {
    loadToken++;
    cancelAnimationFrame(playheadRaf);
    track?.dispose();
    track = null;
  }

  // Decode the current song's recording from IndexedDB.
  async function loadTrack() {
    disposeTrack();
    renderRecording();
    if (!song.audio || !isOpen) return;
    const token = loadToken;
    recStatus('Loading recording…');
    const blob = await audioStore.getAudio(song.id);
    if (token !== loadToken) return;
    if (!blob) { recStatus('The recording file is missing on this device. Add it again.'); return; }
    try {
      const t = await Track.decode(ctx.getAudioContext(), blob);
      if (token !== loadToken) { t.dispose(); return; }
      track = t;
      track.setVolume(Number(trackVol.value));
      recStatus('');
    } catch {
      if (token === loadToken) recStatus('Could not decode the saved recording. Try adding it again.');
    }
    renderRecording();
  }

  async function addRecording(file) {
    if (!file) return;
    stopIfPlaying();
    const target = song;
    recStatus('Reading file…');
    let t;
    try {
      t = await Track.decode(ctx.getAudioContext(), file);
    } catch {
      recStatus("Couldn't read this file. Try an MP3, M4A or WAV.");
      return;
    }
    if (target !== song) { t.dispose(); return; }
    disposeTrack();
    track = t;
    track.setVolume(Number(trackVol.value));
    const stored = await audioStore.putAudio(song.id, file);
    song.audio = { name: file.name, duration: track.duration, offset: song.audio?.offset ?? 0 };
    recStatus(stored ? '' : "Couldn't save the recording on this device; it works until you close the app.");
    renderRecording();
    renderOptions();
    save();
  }

  function renderRecording() {
    const has = !!song.audio;
    $('recEmpty').hidden = has;
    $('recLoaded').hidden = !has;
    $('recName').textContent = has ? song.audio.name : '';
    if (has) $('offsetOut').textContent = fmtTime(song.audio.offset);
    $('tapMapBtn').disabled = !track;
    drawWave();
  }

  function sectionTimes() {
    const starts = model.startBars(song);
    return song.sections.map((s, i) => {
      const t0 = song.audio.offset + model.timeAtBar(song, starts[i]);
      const t1 = s.bars === null ? Infinity : song.audio.offset + model.timeAtBar(song, starts[i] + s.bars);
      return [t0, t1];
    });
  }

  function drawWave() {
    if (!song.audio || !isOpen) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wave.clientWidth, h = wave.clientHeight;
    if (!w) return;
    if (wave.width !== Math.round(w * dpr)) { wave.width = Math.round(w * dpr); wave.height = Math.round(h * dpr); }
    const g = wave.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const dur = track?.duration || song.audio.duration || 1;
    const X = (t) => (t / dur) * w;
    const css = getComputedStyle(document.documentElement);

    // Section bands and bar lines
    sectionTimes().forEach(([t0, t1], i) => {
      const x0 = X(t0), x1 = Math.min(w, X(Math.min(t1, dur)));
      if (x1 <= x0) return;
      g.fillStyle = color(i) + '38';
      g.fillRect(x0, 0, x1 - x0, h);
      g.fillStyle = color(i);
      g.fillRect(x0, 0, 2, h);
      const barPx = X(model.barSeconds(song.sections[i]));
      if (barPx >= 4) {
        g.fillStyle = color(i) + '88';
        for (let x = x0 + barPx; x < x1 - 1; x += barPx) g.fillRect(x, h - 8, 1, 8);
      }
    });

    // Waveform
    g.fillStyle = css.getPropertyValue('--muted').trim();
    if (track) {
      const cols = Math.floor(w);
      const peaks = track.peaks(cols);
      for (let x = 0; x < cols; x++) {
        const a = Math.max(1, peaks[x] * (h / 2 - 4));
        g.fillRect(x, h / 2 - a, 1, a * 2);
      }
      if (track.playing) {
        g.fillStyle = css.getPropertyValue('--text').trim();
        g.fillRect(X(track.position()) - 1, 0, 2, h);
      }
    } else {
      g.fillRect(0, h / 2, w, 1);
    }
  }

  function playheadLoop() {
    drawWave();
    if (track?.playing) playheadRaf = requestAnimationFrame(playheadLoop);
  }

  // Tap the waveform: play from the start of the bar at that point.
  wave.addEventListener('click', (e) => {
    if (!song.audio) return;
    const rect = wave.getBoundingClientRect();
    const dur = track?.duration || song.audio.duration;
    const t = ((e.clientX - rect.left) / rect.width) * dur - song.audio.offset;
    let bar = model.barAtTime(song, t);
    const total = model.totalBars(song);
    if (Number.isFinite(total)) bar = Math.min(bar, total);
    ctx.play({ bar });
  });
  new ResizeObserver(() => drawWave()).observe(wave);

  const trackVol = $('trackVol');
  trackVol.value = store.loadTrackVolume();
  trackVol.addEventListener('input', () => {
    track?.setVolume(Number(trackVol.value));
    store.saveTrackVolume(Number(trackVol.value));
  });

  $('recFile').addEventListener('change', (e) => { addRecording(e.target.files[0]); e.target.value = ''; });
  $('recReplace').addEventListener('change', (e) => { addRecording(e.target.files[0]); e.target.value = ''; });
  $('recRemove').addEventListener('click', () => {
    if (!confirm('Remove the recording from this song? The sections are kept.')) return;
    stopIfPlaying();
    audioStore.deleteAudio(song.id);
    disposeTrack();
    song.audio = null;
    recStatus('');
    renderRecording();
    renderOptions();
    save();
  });

  // Nudge where bar 1 sits in the recording.
  root.querySelectorAll('[data-nudge]').forEach((b) => holdRepeat(b, () => {
    if (!song.audio) return;
    const dur = track?.duration || song.audio.duration;
    const next = Math.round((song.audio.offset + Number(b.dataset.nudge)) * 1000) / 1000;
    song.audio.offset = Math.min(dur, Math.max(0, next));
    renderRecording();
    save();
  }));

  // ---------- Tap mode ----------
  const tapView = createTapView({
    getSong: () => song,
    getTrack: () => track,
    getAudioContext: ctx.getAudioContext,
    onApply(draft) {
      song.sections = draft.sections.map((s) => model.sanitizeSection(s));
      song.audio.offset = Math.round(draft.offset * 1000) / 1000;
      song.end = 'stop';
      openId = null;
      structural();
      renderRecording();
      recStatus('Draft applied. Press Play song to check it against the recording.');
    },
  });
  $('tapMapBtn').addEventListener('click', () => { stopIfPlaying(); tapView.open(); });

  // ---------- Now playing ----------
  const now = $('nowPlaying');
  const nowBeats = $('nowBeats');
  let lit = null;
  let curIndex = null;

  function highlight(index) {
    for (const b of timeline.children) {
      b.classList.toggle('current', Number(b.dataset.index) === index);
      if (Number(b.dataset.index) !== index) b.querySelector('.tl-fill').style.width = '0';
    }
    for (const c of cards) c.el.classList.toggle('playing', c.id === song.sections[index]?.id);
  }

  function onTick(beat, sub, bar) {
    if (sub !== 0) return;
    if (bar < playStart) {
      // Count-in
      if (beat === 0 || curIndex !== 'count') {
        const s = model.stateForBar(song, bar, playStart);
        renderBeatButtons(nowBeats, s.accents, null);
        $('nowTitle').textContent = 'Count-in';
        $('nowMeter').textContent = meterText(s);
        $('nowBar').textContent = `${playStart - bar} bar${playStart - bar > 1 ? 's' : ''} to go`;
        $('nowSongBar').textContent = '';
        $('nowNext').textContent = `Starts at bar ${playStart}`;
        now.style.setProperty('--c', 'var(--muted)');
        curIndex = 'count';
        highlight(-1);
      }
    } else {
      const sb = model.songBar(song, bar);
      const info = model.sectionAt(song, sb);
      if (!info) return;
      const s = info.section;
      if (beat === 0 || curIndex !== info.index) {
        renderBeatButtons(nowBeats, s.accents, null);
        if (curIndex !== info.index) highlight(info.index);
        curIndex = info.index;
        now.style.setProperty('--c', color(info.index));
        $('nowTitle').textContent = sectionName(s, info.index);
        $('nowMeter').textContent = meterText(s);
        $('nowBar').textContent = info.bars === null
          ? `Bar ${info.barInSection}` : `Bar ${info.barInSection} of ${info.bars}`;
        const total = model.totalBars(song);
        $('nowSongBar').textContent = Number.isFinite(total) ? `Song bar ${sb} of ${total}` : `Song bar ${sb}`;
        $('nowNext').textContent = nextText(info);
        const block = timeline.children[info.index];
        if (block) {
          const pct = info.bars === null ? 100 : (info.barInSection / info.bars) * 100;
          block.querySelector('.tl-fill').style.width = `${pct}%`;
        }
      }
    }
    lit?.classList.remove('on');
    lit = nowBeats.children[beat] || null;
    lit?.classList.add('on');
  }

  function nextText(info) {
    if (info.bars === null) return 'Last section: repeats until you stop';
    const inBars = info.bars - info.barInSection + 1;
    const when = inBars === 1 ? 'next bar' : `in ${inBars} bars`;
    const next = song.sections[info.index + 1];
    if (next) return `Next: ${meterText(next)}, ${when}`;
    return model.loops(song) ? `Back to the start ${when}` : `Ends ${when}`;
  }

  // ---------- Public ----------
  function renderAll() {
    renderPicker();
    renderTimeline();
    renderSections();
    renderOptions();
    renderRecording();
  }
  renderAll();

  const background = () => document.querySelectorAll('.topbar, main');
  return {
    get isOpen() { return isOpen; },
    open() {
      isOpen = true;
      root.classList.add('open');
      root.inert = false;
      root.setAttribute('aria-hidden', 'false');
      background().forEach((n) => { n.inert = true; });
      document.body.classList.add('song-open');
      renderAll();
      loadTrack();
      $('songBack').focus({ preventScroll: true });
    },
    close() {
      isOpen = false;
      root.classList.remove('open');
      root.inert = true;
      root.setAttribute('aria-hidden', 'true');
      background().forEach((n) => { n.inert = false; });
      document.body.classList.remove('song-open');
      tapView.close();
      disposeTrack(); // free the decoded audio while the view is closed
    },
    // Called when playback starts; returns the engine's first bar (count-in included).
    // from: { section: index } or { bar: songBar }.
    beginPlay(from = {}) {
      playStart = from.bar ?? model.startBars(song)[from.section ?? 0] ?? 1;
      curIndex = null;
      now.hidden = false;
      return playStart - song.countIn;
    },
    // startTime: audio-clock time of the first click. Start the recording so the
    // song's playStart bar lines up with it (the count-in plays over the lead-up).
    afterStart(startTime) {
      if (!track || !song.audio || startTime == null) return;
      const first = (model.sectionAt(song, playStart) || model.sectionAt(song, 1)).section;
      const pos = song.audio.offset + model.timeAtBar(song, playStart) - song.countIn * model.barSeconds(first);
      if (pos >= track.duration) return;
      track.onended = () => { if (ctx.isPlaying()) ctx.stop(); };
      track.play(startTime + Math.max(0, -pos), Math.max(0, pos));
      cancelAnimationFrame(playheadRaf);
      playheadRaf = requestAnimationFrame(playheadLoop);
    },
    get track() { return track; },
    stateFor(bar) {
      const s = model.stateForBar(song, bar, playStart);
      return s && { ...s, kit: ctx.getKit() };
    },
    onTick,
    onStop() {
      track?.stop();
      cancelAnimationFrame(playheadRaf);
      drawWave();
      now.hidden = true;
      lit = null;
      curIndex = null;
      highlight(-1);
    },
  };
}
