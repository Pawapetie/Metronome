// Horizontal "ruler" wheel for fine BPM changes: drag or flick it,
// one notch = one BPM. Ticks are drawn with CSS gradients and moved via
// background-position, so there is no DOM per tick. Major ticks mark tens.

const SPACING = 14; // px per BPM

export function createWheel(el, { min, max, getValue, onChange }) {
  let pos = getValue() * SPACING; // continuous position in px
  let dragging = false;
  let lastX = 0, lastT = 0, velocity = 0;
  let raf = 0;

  function render() {
    const offset = el.clientWidth / 2 - pos - 1; // centre the 2px tick line
    el.style.backgroundPositionX = `${offset}px, ${offset}px`;
  }

  function applyPos() {
    const lo = min * SPACING, hi = max * SPACING;
    if (pos < lo) { pos = lo; velocity = 0; }
    if (pos > hi) { pos = hi; velocity = 0; }
    const v = Math.round(pos / SPACING);
    if (v !== getValue()) onChange(v);
    render();
  }

  function snap() {
    const target = Math.round(pos / SPACING) * SPACING;
    const animate = () => {
      pos += (target - pos) * 0.35;
      if (Math.abs(target - pos) < 0.5) { pos = target; render(); return; }
      render();
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
  }

  function coast() {
    let prev = performance.now();
    const step = (now) => {
      const dt = Math.min(50, now - prev);
      prev = now;
      pos += velocity * dt;
      velocity *= Math.pow(0.94, dt / 16);
      applyPos();
      if (Math.abs(velocity) > 0.03) raf = requestAnimationFrame(step);
      else snap();
    };
    raf = requestAnimationFrame(step);
  }

  el.addEventListener('pointerdown', (e) => {
    cancelAnimationFrame(raf);
    dragging = true;
    pos = getValue() * SPACING;
    lastX = e.clientX; lastT = e.timeStamp; velocity = 0;
    el.setPointerCapture(e.pointerId);
    el.classList.add('grabbing');
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dt = Math.max(1, e.timeStamp - lastT);
    pos -= dx; // drag left -> higher numbers slide in from the right
    velocity = 0.7 * (-dx / dt) + 0.3 * velocity;
    lastX = e.clientX; lastT = e.timeStamp;
    applyPos();
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('grabbing');
    if (e.timeStamp - lastT > 80) velocity = 0; // finger rested before lifting
    Math.abs(velocity) > 0.05 ? coast() : snap();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // Mouse wheel / trackpad: accumulate so trackpads don't race.
  let acc = 0;
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : -e.deltaY;
    // A mouse notch (large delta or line mode) = 1 BPM; small trackpad deltas accumulate.
    if (e.deltaMode !== 0 || Math.abs(d) >= 50) { acc = 0; set(getValue() + Math.sign(d)); return; }
    acc += d;
    if (Math.abs(acc) >= 25) { set(getValue() + Math.sign(acc)); acc = 0; }
  }, { passive: false });

  el.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (d) { e.preventDefault(); set(getValue() + d); }
  });

  function set(v) {
    cancelAnimationFrame(raf);
    pos = Math.min(max, Math.max(min, v)) * SPACING;
    applyPos();
  }

  new ResizeObserver(render).observe(el);

  // Call when the value changed elsewhere (typed, tap tempo, preset...).
  return {
    sync() {
      if (dragging) return;
      cancelAnimationFrame(raf);
      pos = getValue() * SPACING;
      render();
    },
  };
}

export const WHEEL_SPACING = SPACING;
