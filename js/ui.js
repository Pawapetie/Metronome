// Small DOM helpers shared by the main screen and the song editor.

import { ACCENT, NORMAL, MUTE } from './engine.js';

export const SUBS = [
  { n: 1, label: '1', note: 'none' },
  { n: 2, label: '2', note: '8ths' },
  { n: 3, label: '3', note: 'triplets' },
  { n: 4, label: '4', note: '16ths' },
  { n: 5, label: '5', note: 'quint.' },
  { n: 6, label: '6', note: 'sext.' },
];

export const PULSES = [
  { value: 'dotted', label: '♩. dotted quarter' },
  { value: 'note', label: '♪ eighth' },
];

const NEXT_LEVEL = { [ACCENT]: NORMAL, [NORMAL]: MUTE, [MUTE]: ACCENT };
const LEVEL_NAME = { [ACCENT]: 'accent', [NORMAL]: 'normal', [MUTE]: 'muted' };

// One circle per beat; tapping cycles accent -> normal -> mute.
// onChange(index, newLevel) is called after the level changes.
export function renderBeatButtons(container, accents, onChange) {
  container.replaceChildren(...accents.map((lvl, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'beat';
    b.dataset.level = lvl;
    b.textContent = i + 1;
    b.setAttribute('aria-label', `Beat ${i + 1}: ${LEVEL_NAME[lvl]}`);
    if (onChange) {
      b.addEventListener('click', () => onChange(i, NEXT_LEVEL[accents[i]]));
    } else {
      b.disabled = true;
    }
    return b;
  }));
}

// Press-and-hold repeat that speeds up the longer it is held.
export function holdRepeat(btn, fn) {
  let timer = 0, start = 0;
  const tick = () => {
    const held = performance.now() - start;
    fn(held > 2000 ? 5 : 1);
    timer = setTimeout(tick, held > 1000 ? 50 : 110);
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    start = performance.now();
    fn(1);
    timer = setTimeout(tick, 400);
  });
  const stop = () => clearTimeout(timer);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(1); } });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// A group of toggle chips. items: [{ value, html | label }]. Returns render(value).
export function chipGroup(container, items, onPick, extraClass = '') {
  container.replaceChildren(...items.map((it) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = `chip ${extraClass}`.trim();
    c.dataset.value = String(it.value);
    if (it.html) c.innerHTML = it.html; else c.textContent = it.label;
    c.addEventListener('click', () => onPick(it.value));
    return c;
  }));
  return (value) => {
    for (const c of container.children) c.setAttribute('aria-pressed', String(c.dataset.value === String(value)));
  };
}

export const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...children.filter((c) => c != null && c !== false));
  return n;
};
