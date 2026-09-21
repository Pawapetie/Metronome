import { Engine, ACCENT, NORMAL, MUTE } from './engine.js';
import { KITS } from './sounds.js';
import { createWheel } from './wheel.js';
import {
  MIN_BPM, MAX_BPM, COMMON, clampBpm, clampBeats, stepDenom,
  defaultAccents, isCompound, tempoName, noteName, beatUnitLabel,
} from './timesig.js';
import { SUBS, PULSES, renderBeatButtons, holdRepeat, chipGroup } from './ui.js';
import * as store from './presets.js';
import { createSongView } from './song-ui.js';

const $ = (id) => document.getElementById(id);

// ---------- State ----------
const DEFAULTS = {
  bpm: 120, beats: 4, denom: 4, accents: defaultAccents(4, 4),
  sub: 1, kit: 'click', volume: 0.8, pulse: 'dotted',
};

function sanitize(s) {
  const out = { ...DEFAULTS, ...(s || {}) };
  out.bpm = clampBpm(Number(out.bpm) || DEFAULTS.bpm);
  out.beats = clampBeats(Math.round(Number(out.beats)) || 4);
  out.denom = [1, 2, 4, 8, 16, 32].includes(out.denom) ? out.denom : 4;
  out.sub = SUBS.some((x) => x.n === out.sub) ? out.sub : 1;
  out.pulse = out.pulse === 'note' ? 'note' : 'dotted';
  out.kit = KITS.some((k) => k.id === out.kit) ? out.kit : 'click';
  out.volume = Math.min(1, Math.max(0, Number(out.volume)));
  if (!Number.isFinite(out.volume)) out.volume = DEFAULTS.volume;
  if (!Array.isArray(out.accents) || out.accents.length !== out.beats ||
      out.accents.some((a) => ![ACCENT, NORMAL, MUTE].includes(a))) {
    out.accents = defaultAccents(out.beats, out.denom);
  }
  return out;
}

const state = sanitize(store.loadState());

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.saveState(state), 300);
}

// One engine for both screens: it follows the song while the Songs view is open.
let songView = null;
const engine = new Engine(
  (bar) => (songView?.isOpen ? songView.stateFor(bar) : state),
  (beat, sub, bar) => (songView?.isOpen ? songView.onTick(beat, sub, bar) : onTick(beat, sub, bar)),
);
engine.setVolume(state.volume);

// ---------- BPM ----------
const bpmInput = $('bpm');
const wheelEl = $('wheel');
const wheel = createWheel(wheelEl, {
  min: MIN_BPM, max: MAX_BPM,
  getValue: () => state.bpm,
  onChange: (v) => setBpm(v, { fromWheel: true }),
});

function setBpm(v, { fromWheel = false } = {}) {
  state.bpm = clampBpm(v);
  renderBpm();
  if (!fromWheel) wheel.sync();
  persist();
}

function renderBpm() {
  if (document.activeElement !== bpmInput) bpmInput.value = state.bpm;
  $('tempoName').textContent = tempoName(state.bpm);
  $('bpmUnit').textContent = `BPM · ${beatUnitLabel(state.beats, state.denom, state.pulse)}`;
  wheelEl.setAttribute('aria-valuenow', state.bpm);
}

// On focus the field empties and shows the current BPM as a placeholder, so
// whatever is typed replaces it; leaving it empty keeps the old value.
bpmInput.addEventListener('focus', () => {
  bpmInput.placeholder = state.bpm;
  bpmInput.value = '';
});
bpmInput.addEventListener('input', () => {
  bpmInput.value = bpmInput.value.replace(/\D/g, '').slice(0, 3);
});
function commitTyped() {
  const n = parseInt(bpmInput.value, 10);
  if (Number.isFinite(n)) setBpm(n);
  bpmInput.value = state.bpm;
  bpmInput.placeholder = '';
}
bpmInput.addEventListener('blur', commitTyped);
bpmInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { bpmInput.blur(); }
  else if (e.key === 'Escape') { bpmInput.value = state.bpm; bpmInput.blur(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    setBpm(state.bpm + (e.key === 'ArrowUp' ? 1 : -1));
    bpmInput.value = '';
    bpmInput.placeholder = state.bpm;
  }
});

holdRepeat($('bpmDown'), (n) => setBpm(state.bpm - n));
holdRepeat($('bpmUp'), (n) => setBpm(state.bpm + n));

// Tap tempo: average of the last few intervals; resets after a 2 s pause.
let taps = [];
$('tap').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 6) taps.shift();
  if (taps.length >= 2) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setBpm(60000 / avg);
  }
  const btn = $('tap');
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 90);
  btn.textContent = taps.length < 2 ? 'Keep tapping…' : `Tap tempo (${taps.length})`;
  clearTimeout(btn._reset);
  btn._reset = setTimeout(() => { btn.textContent = 'Tap tempo'; }, 2000);
});

// ---------- Time signature ----------
function setTimeSig(beats, denom) {
  state.beats = clampBeats(beats);
  state.denom = denom;
  state.accents = defaultAccents(state.beats, state.denom);
  if (!$('stress').checked) state.accents[0] = NORMAL;
  renderTimeSig();
  renderBeats();
  renderBpm();
  persist();
}

document.querySelectorAll('[data-ts]').forEach((btn) => {
  holdRepeat(btn, () => {
    const dir = Number(btn.dataset.dir);
    if (btn.dataset.ts === 'beats') setTimeSig(state.beats + dir, state.denom);
    else setTimeSig(state.beats, stepDenom(state.denom, dir));
  });
});

const tsChips = $('tsChips');
COMMON.forEach(([b, d]) => {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'chip';
  c.textContent = `${b}/${d}`;
  c.dataset.b = b;
  c.dataset.d = d;
  c.addEventListener('click', () => setTimeSig(b, d));
  tsChips.append(c);
});

const renderPulse = chipGroup($('pulseChips'), PULSES, (v) => {
  state.pulse = v;
  renderTimeSig();
  renderBpm();
  persist();
});

function renderTimeSig() {
  const compound = isCompound(state.beats, state.denom);
  $('pulseRow').hidden = !compound;
  renderPulse(state.pulse);
  $('tsBeats').textContent = state.beats;
  $('tsDenom').textContent = state.denom;
  for (const c of tsChips.children) {
    c.setAttribute('aria-pressed', String(+c.dataset.b === state.beats && +c.dataset.d === state.denom));
  }
  let hint = `${state.beats} ${noteName(state.denom)} note${state.beats > 1 ? 's' : ''} per bar.`;
  if (compound) {
    hint += ` Compound meter: felt in ${state.beats / 3} groups of 3.`;
  } else if (state.denom >= 8 && state.beats > 4) {
    hint += ' Odd meter: tap beats to set your grouping (e.g. 2+2+3).';
  }
  $('tsHint').textContent = hint;
}

// ---------- Beats / accents ----------
const beatsEl = $('beats');
function renderBeats() {
  renderBeatButtons(beatsEl, state.accents, (i, level) => {
    state.accents[i] = level;
    renderBeats();
    persist();
  });
  $('stress').checked = state.accents[0] === ACCENT;
}

$('stress').addEventListener('change', (e) => {
  state.accents[0] = e.target.checked ? ACCENT : NORMAL;
  renderBeats();
  persist();
});

let litBeat = null;
function onTick(beat, sub, bar) {
  if (sub !== 0) return;
  litBeat?.classList.remove('on');
  litBeat = beatsEl.children[beat] || null;
  litBeat?.classList.add('on');
  $('barCount').textContent = `Bar ${bar}`;
}

// ---------- Subdivision ----------
const renderSubChips = chipGroup(
  $('subChips'),
  SUBS.map(({ n, label, note }) => ({ value: n, html: `${label}<small>${note}</small>` })),
  (n) => { state.sub = n; renderSubs(); persist(); },
  'sub',
);
const renderSubs = () => renderSubChips(state.sub);

// ---------- Sound ----------
const kitChips = $('kitChips');
KITS.forEach(({ id, name }) => {
  const c = document.createElement('button');
  c.type = 'button';
  c.className = 'chip';
  c.dataset.kit = id;
  c.textContent = name;
  c.addEventListener('click', () => {
    state.kit = id;
    renderKits();
    persist();
    if (!engine.playing) engine.preview(id);
  });
  kitChips.append(c);
});
function renderKits() {
  for (const c of kitChips.children) c.setAttribute('aria-pressed', String(c.dataset.kit === state.kit));
}

const volumeEl = $('volume');
volumeEl.addEventListener('input', () => {
  state.volume = Number(volumeEl.value);
  engine.setVolume(state.volume);
  persist();
});

// ---------- Presets ----------
function presetSummary(p) {
  const dotted = p.pulse === 'dotted' && isCompound(p.beats, p.denom);
  return `${p.bpm} BPM${dotted ? ' (♩.)' : ''} · ${p.beats}/${p.denom}` +
    (p.sub > 1 ? ` · ÷${p.sub}` : '') +
    ` · ${KITS.find((k) => k.id === p.kit)?.name || ''}`;
}

function renderPresets(list = store.loadPresets()) {
  const ul = $('presetList');
  $('presetCount').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) {
    ul.innerHTML = '<li class="preset-empty">No presets yet. Set things up, name it, save.</li>';
    return;
  }
  ul.replaceChildren(...list.map((p) => {
    const li = document.createElement('li');
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'preset-load';
    const name = document.createElement('span');
    name.textContent = p.name;
    const sum = document.createElement('small');
    sum.textContent = presetSummary(p);
    load.append(name, sum);
    load.addEventListener('click', () => applySettings(p));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-del';
    del.setAttribute('aria-label', `Delete ${p.name}`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      if (confirm(`Delete preset "${p.name}"?`)) renderPresets(store.deletePreset(p.name));
    });
    li.append(load, del);
    return li;
  }));
}

$('presetForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('presetName').value.trim();
  if (!name) return;
  const { bpm, beats, denom, pulse, accents, sub, kit } = state;
  renderPresets(store.savePreset(name, { bpm, beats, denom, pulse, accents: [...accents], sub, kit }));
  $('presetName').value = '';
  $('presetName').blur();
});

function applySettings(p) {
  const s = sanitize({ ...state, ...p, volume: state.volume });
  Object.assign(state, s);
  renderAll();
  wheel.sync();
  persist();
}

// ---------- Theme ----------
const THEMES = ['dark', 'light', 'system'];
const THEME_LABEL = { dark: 'Dark', light: 'Light', system: 'System' };
let theme = THEMES.includes(store.loadTheme()) ? store.loadTheme() : 'dark';
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('theme').textContent = THEME_LABEL[theme];
  $('theme').setAttribute('aria-label', `Theme: ${THEME_LABEL[theme]}. Tap to change.`);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
}
$('theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  store.saveTheme(theme);
  applyTheme();
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

// ---------- Play / stop ----------
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function renderPlay() {
  $('play').setAttribute('aria-pressed', String(engine.playing));
  $('playLabel').textContent = engine.playing ? 'Stop' : songView.isOpen ? 'Play song' : 'Start';
}

// fromSection: song view only, the section index to start at.
async function startPlayback(fromSection = 0) {
  if (engine.playing) stopPlayback();
  if (songView.isOpen) await engine.start({ startBar: songView.beginPlay(fromSection) });
  else await engine.start();
  requestWakeLock();
  renderPlay();
}

function stopPlayback() {
  engine.stop();
  releaseWakeLock();
  litBeat?.classList.remove('on');
  litBeat = null;
  $('barCount').textContent = '';
  songView.onStop();
  renderPlay();
}

// A song set to stop at the end finishes on its own.
engine.onEnd = stopPlayback;

const togglePlay = () => (engine.playing ? stopPlayback() : startPlayback());
$('play').addEventListener('click', togglePlay);

// ---------- Song view ----------
songView = createSongView({
  getMainSettings: () => {
    const { bpm, beats, denom, pulse, accents, sub } = state;
    return { bpm, beats, denom, pulse, accents: [...accents], sub };
  },
  getKit: () => state.kit,
  play: (fromSection) => startPlayback(fromSection),
  stop: stopPlayback,
  isPlaying: () => engine.playing,
});

// Switching screens stops playback so it's always clear what is playing.
function setSongView(open) {
  if (open === songView.isOpen) return;
  if (engine.playing) stopPlayback();
  if (open) songView.open(); else songView.close();
  renderPlay();
  if (!open) $('songsBtn').focus({ preventScroll: true });
}
$('songsBtn').addEventListener('click', () => setSongView(true));
$('songBack').addEventListener('click', () => setSongView(false));

// Space always means start/stop (except while typing). Buttons and switches
// activate on Space keyup, so suppress that too; Enter still activates them.
const isTyping = (e) => e.target.matches('input[type="text"], select');
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && songView.isOpen && !isTyping(e)) { setSongView(false); return; }
  if (e.code !== 'Space' || isTyping(e)) return;
  e.preventDefault();
  if (!e.repeat) togglePlay();
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !isTyping(e)) e.preventDefault();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && engine.playing) {
    engine.resume();
    requestWakeLock(); // the lock is dropped automatically when the page is hidden
  }
});

// ---------- Init ----------
function renderAll() {
  renderBpm();
  renderTimeSig();
  renderBeats();
  renderSubs();
  renderKits();
  volumeEl.value = state.volume;
}
renderAll();
renderPresets();
applyTheme();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
