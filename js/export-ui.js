// Export MP3 dialog: pick "song + click" or "click only" (and the mix for the
// former), render + encode, then save/share the file.

import { renderExport, encodeMp3, saveFile, safeFileName, exportPlan, KBPS } from './export.js';
import { chipGroup } from './ui.js';

const fmt = (sec) => {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec - m * 60)).padStart(2, '0')}`;
};
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// ctx: { getSong(), getTrack(), getKit(), getClickVolume(), getTrackVolume(), stop() }
export function createExportView(ctx) {
  const $ = (id) => document.getElementById(id);
  const root = $('exportView');
  let what = 'mix';
  let split = false;
  let job = null;     // { cancel } while working
  let runId = 0;      // results from a cancelled run are ignored
  let result = null;  // { blob, name } when ready
  let isOpen = false;

  const renderWhat = chipGroup($('exWhat'), [
    { value: 'mix', label: 'Song + click' },
    { value: 'click', label: 'Click only' },
  ], (v) => { what = v; reset(); });
  const renderMix = chipGroup($('exMix'), [
    { value: 'normal', label: 'Normal' },
    { value: 'split', label: 'Stereo split' },
  ], (v) => { split = v === 'split'; reset(); });

  function fileName() {
    const song = ctx.getSong();
    return `${safeFileName(song.name)} - ${what === 'mix' ? 'with click' : 'click'}.mp3`;
  }

  function render() {
    const song = ctx.getSong();
    const track = ctx.getTrack();
    renderWhat(what);
    renderMix(split ? 'split' : 'normal');
    $('exMixField').hidden = what !== 'mix';
    $('exMixHint').textContent = split
      ? 'Click only in the left channel, the song only in the right (for in-ear monitoring).'
      : 'Click and song together in both channels.';
    if (track) {
      const plan = exportPlan(song, track.duration, what);
      const pct = (v) => `${Math.round(v * 100)}%`;
      const bits = [
        what === 'mix' ? 'Whole recording' : song.countIn ? 'Starts at the count-in' : 'Starts at bar 1',
        fmt(plan.length),
        `about ${mb((KBPS[what] * 1000 / 8) * plan.length)}`,
      ];
      const levels = [`Click volume ${pct(ctx.getClickVolume())}`];
      if (what === 'mix') levels.push(`Track volume ${pct(ctx.getTrackVolume())}`);
      levels.push(song.countIn ? `Count-in ${song.countIn} bar${song.countIn > 1 ? 's' : ''}` : 'No count-in');
      $('exSummary').textContent = `${bits.join(' · ')}\n${levels.join(' · ')}`;
    }
    const busy = !!job;
    $('exGo').disabled = busy || !track;
    $('exGo').textContent = result ? `Save MP3 (${mb(result.blob.size)})` : busy ? 'Working…' : 'Export';
    $('exCancel').textContent = busy ? 'Cancel' : result ? 'Close' : 'Cancel';
    for (const b of root.querySelectorAll('.chip')) b.disabled = busy;
  }

  function reset() {
    result = null;
    status('');
    progress(null);
    render();
  }

  const status = (msg) => { $('exStatus').textContent = msg; };
  function progress(p) {
    $('exProgress').hidden = p == null;
    if (p != null) $('exProgress').firstElementChild.style.width = `${Math.round(p * 100)}%`;
  }

  async function run() {
    const song = ctx.getSong();
    const track = ctx.getTrack();
    if (!track || job) return;
    const id = ++runId;
    let enc = null;
    // Cancel resets the dialog at once; offline rendering can't be interrupted,
    // so its result is simply dropped when it arrives.
    job = { cancel: () => { runId++; enc?.cancel(); job = null; progress(null); status(''); render(); } };
    result = null;
    render();
    try {
      status('Rendering audio…');
      progress(0.02);
      const { buffer } = await renderExport(song, track.buffer, {
        what, split, kit: ctx.getKit(), clickVol: ctx.getClickVolume(), trackVol: ctx.getTrackVolume(),
      });
      if (id !== runId) return;
      status('Encoding MP3…');
      enc = encodeMp3(buffer, KBPS[what], (p) => { if (id === runId) progress(0.05 + p * 0.95); });
      const blob = await enc.promise;
      if (id !== runId) return;
      result = { blob, name: fileName() };
      progress(1);
      status(`Ready: ${result.name}`);
    } catch (e) {
      if (id !== runId) return;
      progress(null);
      status(e.name === 'AbortError' ? '' : `Export failed: ${e.message}`);
    }
    if (id === runId) { job = null; render(); }
  }

  $('exGo').addEventListener('click', async () => {
    if (result) {
      // A fresh tap, so the share sheet is allowed to open.
      const how = await saveFile(result.blob, result.name);
      if (how === 'downloaded') status(`Downloaded ${result.name}`);
      else if (how === 'shared') status(`Shared ${result.name}`);
    } else {
      run();
    }
  });
  $('exCancel').addEventListener('click', () => { if (job) job.cancel(); else close(); });
  root.addEventListener('click', (e) => { if (e.target === root && !job) close(); });
  document.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') { e.stopImmediatePropagation(); if (job) job.cancel(); else close(); }
  }, true);

  function open() {
    ctx.stop();
    isOpen = true;
    root.hidden = false;
    $('songView').inert = true;
    document.body.classList.add('tap-open');
    reset();
    $('exGo').focus({ preventScroll: true });
  }
  function close() {
    if (!isOpen) return;
    job?.cancel();
    isOpen = false;
    root.hidden = true;
    $('songView').inert = false;
    document.body.classList.remove('tap-open');
    $('exportBtn')?.focus({ preventScroll: true });
  }
  return { open, close, get isOpen() { return isOpen; } };
}
