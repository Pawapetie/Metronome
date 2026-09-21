// Song view: a full-screen panel for building songs out of sections with their
// own tempo/meter, and following them during playback.

import { COMMON, clampBpm, clampBeats, stepDenom, defaultAccents, isCompound, beatUnitLabel } from './timesig.js';
import { SUBS, PULSES, renderBeatButtons, holdRepeat, chipGroup, el } from './ui.js';
import * as model from './song.js';
import * as store from './presets.js';

const COLORS = ['#ff9f1c', '#5b9dff', '#3ecf8e', '#c77dff', '#ff6b8b', '#2ec4d6'];
const color = (i) => COLORS[i % COLORS.length];

const sectionName = (s, i) => s.label.trim() || `Section ${i + 1}`;
const meterText = (s) =>
  `${s.beats}/${s.denom} · ${s.bpm} BPM${s.pulse === 'dotted' && isCompound(s.beats, s.denom) ? ' (♩.)' : ''}`;

// ctx: { getMainSettings(), getKit(), play(fromIndex), stop(), isPlaying() }
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
    nameInput.focus();
    nameInput.select();
  });
  $('songDup').addEventListener('click', () => {
    stopIfPlaying();
    const copy = model.sanitizeSong({ ...structuredClone(song), id: undefined, name: `${song.name} (copy)` });
    songs.push(copy);
    song = copy;
    openId = null;
    renderAll();
    save();
  });
  $('songDel').addEventListener('click', () => {
    if (!confirm(`Delete song "${song.name}"?`)) return;
    stopIfPlaying();
    songs = songs.filter((s) => s !== song);
    if (!songs.length) songs = [model.newSong('Song 1', ctx.getMainSettings())];
    song = songs[0];
    openId = null;
    renderAll();
    save();
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
      el('button', { type: 'button', class: 'primary', onclick: () => ctx.play(i) }, '▶ Start here'),
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
    for (const c of $('endChips').children) c.disabled = endless;
    $('endHint').textContent = endless ? 'The last section repeats until you press Stop.' : '';
  }

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
    return song.end === 'loop' ? `Back to the start ${when}` : `Ends ${when}`;
  }

  // ---------- Public ----------
  function renderAll() {
    renderPicker();
    renderTimeline();
    renderSections();
    renderOptions();
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
      $('songBack').focus({ preventScroll: true });
    },
    close() {
      isOpen = false;
      root.classList.remove('open');
      root.inert = true;
      root.setAttribute('aria-hidden', 'true');
      background().forEach((n) => { n.inert = false; });
      document.body.classList.remove('song-open');
    },
    // Called when playback starts; returns the engine's first bar (count-in included).
    beginPlay(fromIndex = 0) {
      playStart = model.startBars(song)[fromIndex] ?? 1;
      curIndex = null;
      now.hidden = false;
      return playStart - song.countIn;
    },
    stateFor(bar) {
      const s = model.stateForBar(song, bar, playStart);
      return s && { ...s, kit: ctx.getKit() };
    },
    onTick,
    onStop() {
      now.hidden = true;
      lit = null;
      curIndex = null;
      highlight(-1);
    },
  };
}
