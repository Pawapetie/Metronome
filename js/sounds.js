// Synthesized sound kits. No audio files: everything is built from oscillators,
// filtered noise and envelopes, so the app is tiny and works offline.
// Each kit plays one of three levels: 'accent', 'normal', 'sub' (subdivision).

export const KITS = [
  { id: 'click', name: 'Click' },
  { id: 'beep', name: 'Beep' },
  { id: 'wood', name: 'Woodblock' },
  { id: 'cowbell', name: 'Cowbell' },
  { id: 'hihat', name: 'Hi-hat' },
  { id: 'rim', name: 'Rimshot' },
  { id: 'soft', name: 'Soft' },
];

const LEVEL_GAIN = { accent: 1.0, normal: 0.6, sub: 0.32 };

const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

// Percussive envelope: near-instant attack, exponential decay.
function env(ctx, dest, t, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  g.connect(dest);
  return g;
}

function tone(ctx, dest, t, { type = 'sine', freq, peak, decay, drop = 0 }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (drop) osc.frequency.exponentialRampToValueAtTime(freq * (1 - drop), t + decay);
  osc.connect(env(ctx, dest, t, peak, decay));
  osc.start(t);
  osc.stop(t + decay + 0.02);
}

function noise(ctx, dest, t, { filter = 'highpass', freq, q = 1, peak, decay }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  src.connect(f);
  f.connect(env(ctx, dest, t, peak, decay));
  src.start(t);
  src.stop(t + decay + 0.02);
}

// Pitch multipliers per level so accents are clearly distinguishable by ear.
const PITCH = { accent: 1.0, normal: 0.75, sub: 0.6 };

const PLAYERS = {
  click(ctx, d, t, lv, g) {
    tone(ctx, d, t, { type: 'triangle', freq: 2600 * PITCH[lv], peak: g, decay: 0.03 });
    noise(ctx, d, t, { freq: 4000, peak: g * 0.3, decay: 0.01 });
  },
  beep(ctx, d, t, lv, g) {
    const f = { accent: 1760, normal: 880, sub: 660 }[lv];
    tone(ctx, d, t, { type: 'sine', freq: f, peak: g * 0.8, decay: 0.09 });
  },
  wood(ctx, d, t, lv, g) {
    tone(ctx, d, t, { type: 'sine', freq: 1250 * PITCH[lv], peak: g, decay: 0.07, drop: 0.08 });
    noise(ctx, d, t, { filter: 'bandpass', freq: 2500 * PITCH[lv], q: 3, peak: g * 0.4, decay: 0.015 });
  },
  cowbell(ctx, d, t, lv, g) {
    const k = PITCH[lv] / 0.75; // normal level = classic 808 pitch
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2640 * k;
    bp.Q.value = 1;
    bp.connect(d);
    const decay = lv === 'sub' ? 0.12 : 0.25;
    tone(ctx, bp, t, { type: 'square', freq: 540 * k, peak: g * 0.5, decay });
    tone(ctx, bp, t, { type: 'square', freq: 800 * k, peak: g * 0.5, decay });
  },
  hihat(ctx, d, t, lv, g) {
    const freq = { accent: 6000, normal: 7500, sub: 9000 }[lv];
    noise(ctx, d, t, { filter: 'highpass', freq, peak: g * 1.2, decay: lv === 'accent' ? 0.09 : 0.05 });
  },
  rim(ctx, d, t, lv, g) {
    tone(ctx, d, t, { type: 'triangle', freq: 1700 * PITCH[lv], peak: g * 0.8, decay: 0.03 });
    tone(ctx, d, t, { type: 'square', freq: 450 * PITCH[lv], peak: g * 0.2, decay: 0.02 });
    noise(ctx, d, t, { filter: 'highpass', freq: 3000, peak: g * 0.5, decay: 0.025 });
  },
  soft(ctx, d, t, lv, g) {
    const f = { accent: 880, normal: 660, sub: 440 }[lv];
    tone(ctx, d, t, { type: 'sine', freq: f, peak: g * 0.9, decay: 0.14 });
  },
};

export function playSound(ctx, dest, kitId, level, time) {
  const play = PLAYERS[kitId] || PLAYERS.click;
  play(ctx, dest, time, level, LEVEL_GAIN[level]);
}
