// localStorage persistence. Every access is guarded: private mode or blocked
// storage must never break the metronome itself.

const KEY_STATE = 'metronome.state';
const KEY_PRESETS = 'metronome.presets';
const KEY_THEME = 'metronome.theme';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export const loadState = () => read(KEY_STATE, null);
export const saveState = (s) => write(KEY_STATE, s);

export const loadTheme = () => read(KEY_THEME, 'dark');
export const saveTheme = (t) => write(KEY_THEME, t);

export function loadPresets() {
  const list = read(KEY_PRESETS, []);
  return Array.isArray(list) ? list : [];
}

// Saving under an existing name overwrites it.
export function savePreset(name, settings) {
  const list = loadPresets().filter((p) => p.name !== name);
  list.push({ name, ...settings });
  list.sort((a, b) => a.name.localeCompare(b.name));
  write(KEY_PRESETS, list);
  return list;
}

export function deletePreset(name) {
  const list = loadPresets().filter((p) => p.name !== name);
  write(KEY_PRESETS, list);
  return list;
}

// Songs: { songs: Song[], currentId }. Validation happens in song.js.
const KEY_SONGS = 'metronome.songs';
export function loadSongs() {
  const data = read(KEY_SONGS, null);
  return data && Array.isArray(data.songs) ? data : { songs: [], currentId: null };
}
export const saveSongs = (data) => write(KEY_SONGS, data);

const KEY_TRACK_VOL = 'metronome.trackVolume';
export function loadTrackVolume() {
  const v = Number(read(KEY_TRACK_VOL, 0.8));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}
export const saveTrackVolume = (v) => write(KEY_TRACK_VOL, v);

const KEY_SONG_CLICK_VOL = 'metronome.songClickVolume';
export function loadSongClickVolume() {
  const v = Number(read(KEY_SONG_CLICK_VOL, 0.8));
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}
export const saveSongClickVolume = (v) => write(KEY_SONG_CLICK_VOL, v);
