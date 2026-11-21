// Apple Music style lyrics renderer.
// - every line rides its own spring, started with a small per-line delay → the "wave" scroll
// - sung words fill left→right with a soft edge and float up a little
// - long held words glow and their letters fill one by one
// - interlude dots breathe and fill across instrumental gaps
// - wheel/drag to look around, click a line to jump there
import { esc } from './util.js';

const DIM = 0.32; // brightness of lines that aren't being sung
const ANCHOR = 0.3; // active line sits at 30% of the panel height
const K = 135; // spring stiffness
const C = 24; // spring damping (≈ critically damped → no wobble)
const STAGGER = 42; // ms between neighbouring lines starting to move
const LEAD = 240; // lines start moving a bit before they're sung so they arrive on time
const GAP_MIN = 3800; // instrumental gaps longer than this get the dots

const syllables = (w) => {
  if (/[぀-ヿ㐀-鿿가-힯]/.test(w)) return [...w].length; // CJK/Korean: per character
  const m = w.toLowerCase().match(/[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿąęóěůа-яё]+/giu);
  return Math.max(1, m ? m.length : 1);
};

// Spread a line's duration over its words, weighted by syllables
function estimateWords(text, start, end) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const weights = words.map((w) => syllables(w) + 0.35);
  const total = weights.reduce((a, b) => a + b, 0);
  const room = Math.max(300, end - start - 120);
  const dur = Math.min(room, Math.max(Math.min(room, 650), total * 215 + 150));
  let t = start;
  return words.map((w, k) => {
    const d = (weights[k] / total) * dur;
    const out = { text: w, time: t, end: t + d };
    t += d;
    return out;
  });
}

export function prepare(synced, { wordMode, duration = 0 }) {
  const src = synced.filter((l) => l && Number.isFinite(l.time));
  const real = src.filter((l) => l.text);
  const out = [];
  if (!real.length) return out;
  if (real[0].time > GAP_MIN) out.push({ gap: true, start: 0, end: real[0].time });
  for (let i = 0; i < src.length; i++) {
    const l = src[i];
    const nextReal = src.slice(i + 1).find((x) => x.text);
    const nextT = src[i + 1]?.time ?? (duration || l.time + 6000);
    if (!l.text) {
      // empty line = break; dots if the break is long
      if (nextReal && nextReal.time - l.time >= GAP_MIN) out.push({ gap: true, start: l.time, end: nextReal.time });
      continue;
    }
    let end = Math.min(l.end || Infinity, nextT);
    if (!Number.isFinite(end)) end = l.time + 5000;
    let words = null;
    let estimated = false;
    if (l.words?.length) {
      words = l.words.map((w, k) => ({ text: w.text, time: w.time, end: w.end ?? l.words[k + 1]?.time ?? Math.min(end, w.time + 650) }));
      end = Math.max(end, words[words.length - 1].end);
    } else if (wordMode) {
      words = estimateWords(l.text, l.time, end);
      estimated = true;
    }
    out.push({ start: l.time, end, text: l.text, words, estimated });
    // word-timed lines tell us when singing stops → dots in the silence
    if (l.words?.length && nextReal) {
      const quiet = words[words.length - 1].end + 250;
      if (nextReal.time - quiet >= GAP_MIN) out.push({ gap: true, start: quiet, end: nextReal.time });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export function createLyrics(box, inner, { onSeek } = {}) {
  let lines = [];
  let mode = 'none';
  let active = -2;
  let anchorIdx = -1;
  let H = 0;
  let manual = 0;
  let freeUntil = 0;
  let lastNow = 0;
  let moving = false;
  let blurOn = true;

  const measure = () => {
    H = box.clientHeight;
    for (const l of lines) {
      l.top = l.el.offsetTop;
      l.h = l.el.offsetHeight;
    }
    if (lines.credit) {
      lines.credit.top = lines.credit.el.offsetTop;
      lines.credit.h = lines.credit.el.offsetHeight;
    }
  };

  const targetFor = () => {
    const a = lines[Math.max(anchorIdx, 0)];
    return a ? H * ANCHOR - a.top - (a.gap ? 0 : a.h * 0.15) + manual : 0;
  };

  function retarget(now, { instant = false, stagger = true } = {}) {
    const tgt = targetFor();
    const from = Math.max(anchorIdx - 1, 0);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      l.pending = tgt;
      l.startAt = now + (stagger && i >= from ? Math.min(i - from, 14) * STAGGER : 0);
      if (instant) {
        l.y = l.tgt = tgt;
        l.v = 0;
        l.startAt = 0;
      }
    }
    moving = true;
  }

  function setActive(idx, now) {
    if (idx === active) return;
    const prev = active;
    active = idx;
    lines.forEach((l, i) => {
      const on = i === idx;
      if (l.on !== on) {
        l.on = on;
        l.el.classList.toggle('on', on);
        if (!on && l.words) {
          // back to "fully lit" so the dimmed line looks even (see CSS)
          l.wordEls.forEach((w, k) => setP(l, k, 1));
          l.lift = false;
        }
      }
      const d = Math.abs(i - Math.max(idx, 0));
      const blur = blurOn && d > 0 ? Math.min(0.5 + d * 0.6, 3.2) : 0;
      if (l.blur !== blur) {
        l.blur = blur;
        l.el.style.setProperty('--b', blur.toFixed(2) + 'px');
      }
    });
    if (idx >= 0 && lines[idx]?.words && prev !== idx) lines[idx].wordEls.forEach((w, k) => setP(lines[idx], k, 0));
  }

  function setP(l, k, p) {
    if (l.wp[k] === p) return;
    l.wp[k] = p;
    const el = l.wordEls[k];
    el.style.setProperty('--p', p.toFixed(3));
    const letters = l.letterEls[k];
    if (letters) {
      const n = letters.length;
      letters.forEach((c, j) => c.style.setProperty('--p', Math.max(0, Math.min(1, p * n - j)).toFixed(3)));
      const glow = l.on && p > 0 && p < 1 ? Math.sin(Math.PI * Math.min(1, p * 1.15)) : 0;
      el.style.setProperty('--g', glow.toFixed(3));
    }
  }

  function findIndex(t) {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  function wordHTML(w, i, k, emph) {
    if (!emph) return `<span class="ly-w" data-k="${k}">${esc(w.text)}</span>`;
    return `<span class="ly-w ly-emph" data-k="${k}">${[...w.text].map((c) => `<span class="ly-c">${esc(c)}</span>`).join('')}</span>`;
  }

  function set(res, { style = 'auto', duration = 0, credit = '' } = {}) {
    const synced = res?.synced?.length ? res.synced : null;
    box.classList.remove('ly-plain', 'ly-msg', 'ly-mode-word', 'ly-mode-line', 'ly-free');
    box.scrollTop = 0;
    active = -2;
    anchorIdx = -1;
    manual = 0;
    freeUntil = 0;
    if (!synced || style === 'static') {
      mode = 'plain';
      box.classList.add('ly-plain');
      const text = synced ? synced.map((l) => l.text) : res.plain || [];
      lines = [];
      inner.innerHTML = text.map((t) => `<div class="ly-pline">${esc(t) || '&nbsp;'}</div>`).join('') + (credit ? `<div class="ly-credit">${esc(credit)}</div>` : '');
      return;
    }
    const wordMode = style === 'word' || (style === 'auto' && res.wordSynced);
    mode = 'synced';
    box.classList.add(wordMode ? 'ly-mode-word' : 'ly-mode-line');
    lines = prepare(synced, { wordMode, duration });
    inner.innerHTML =
      lines
        .map((l, i) => {
          if (l.gap) return `<div class="ly-line ly-gap" data-i="${i}"><div class="ly-dots"><i></i><i></i><i></i></div></div>`;
          if (!l.words) return `<div class="ly-line" data-i="${i}"><div class="ly-text">${esc(l.text)}</div></div>`;
          const html = l.words.map((w, k) => wordHTML(w, i, k, !l.estimated && w.end - w.time >= 1000 && [...w.text].length <= 12)).join(' ');
          return `<div class="ly-line" data-i="${i}"><div class="ly-text">${html}</div></div>`;
        })
        .join('') + (credit ? `<div class="ly-line ly-credit-line"><div class="ly-credit">${esc(credit)}</div></div>` : '');
    const els = inner.querySelectorAll('.ly-line[data-i]');
    lines.forEach((l, i) => {
      l.el = els[i];
      l.y = l.tgt = l.pending = 0;
      l.v = 0;
      l.on = false;
      l.blur = -1;
      if (l.words) {
        l.wordEls = [...l.el.querySelectorAll('.ly-w')];
        l.letterEls = l.wordEls.map((w) => (w.classList.contains('ly-emph') ? [...w.querySelectorAll('.ly-c')] : null));
        l.wp = new Array(l.words.length).fill(-1);
        l.wordEls.forEach((w, k) => setP(l, k, 1));
      }
      if (l.gap) l.dots = l.el.querySelector('.ly-dots');
    });
    const credEl = inner.querySelector('.ly-credit-line');
    if (credEl) lines.credit = { el: credEl, y: 0, v: 0, tgt: 0, pending: 0, startAt: 0 };
    measure();
    anchorIdx = 0;
    retarget(performance.now(), { instant: true });
  }

  function message(text, credit = '') {
    mode = 'msg';
    lines = [];
    box.classList.remove('ly-plain', 'ly-mode-word', 'ly-mode-line', 'ly-free');
    box.classList.add('ly-msg');
    inner.innerHTML = `<div class="ly-message">${esc(text)}</div>${credit ? `<div class="ly-credit">${esc(credit)}</div>` : ''}`;
  }

  // called every animation frame with the lyrics clock (ms)
  function frame(t, now = performance.now()) {
    if (mode !== 'synced' || !lines.length) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - (lastNow || now)) / 1000));
    lastNow = now;

    // which line is being sung
    let idx = findIndex(t + LEAD);
    // a gap that's over (or a word-line that ended long ago) shouldn't stay active
    if (idx >= 0 && lines[idx].gap && t >= lines[idx].end) idx = Math.min(idx + 1, lines.length - 1);
    setActive(idx, now);
    const anchor = Math.max(idx, 0);
    if (anchor !== anchorIdx) {
      const jump = Math.abs(anchor - anchorIdx) > 6;
      anchorIdx = anchor;
      if (now > freeUntil) {
        manual = 0;
        retarget(now, { stagger: !jump });
      }
    }
    if (freeUntil && now > freeUntil) {
      freeUntil = 0;
      manual = 0;
      box.classList.remove('ly-free');
      retarget(now);
    }

    // springs
    if (moving) {
      let still = true;
      const all = lines.credit ? [...lines, lines.credit] : lines;
      if (lines.credit) lines.credit.pending = lines[lines.length - 1]?.pending ?? 0;
      for (const l of all) {
        if (now >= l.startAt) l.tgt = l.pending;
        const a = -K * (l.y - l.tgt) - C * l.v;
        l.v += a * dt;
        l.y += l.v * dt;
        if (Math.abs(l.y - l.tgt) < 0.25 && Math.abs(l.v) < 2 && l.tgt === l.pending) {
          l.y = l.tgt;
          l.v = 0;
        } else still = false;
        const top = (l.top || 0) + l.y;
        const vis = top + (l.h || 80) > -H * 0.6 && top < H * 1.6;
        if (vis !== l.vis) {
          l.vis = vis;
          l.el.classList.toggle('ly-off', !vis);
        }
        const ty = Math.round(l.y * 10) / 10;
        if (ty !== l.ty) {
          l.ty = ty;
          l.el.style.transform = `translate3d(0,${ty}px,0)`;
        }
      }
      moving = !still;
    }

    // word fill on the sung line
    const L = lines[idx];
    if (L?.words && t >= L.start - LEAD) {
      for (let k = 0; k < L.words.length; k++) {
        const w = L.words[k];
        const p = t <= w.time ? 0 : t >= w.end ? 1 : (t - w.time) / Math.max(1, w.end - w.time);
        setP(L, k, Math.round(p * 1000) / 1000);
      }
    }
    // interlude dots
    if (L?.gap) {
      const g = Math.max(0, Math.min(1, (t - L.start) / Math.max(1, L.end - L.start)));
      const left = L.end - t;
      const out = left < 700 ? Math.max(0, left / 700) : 1;
      const breathe = 1 + 0.07 * Math.sin((now / 1000) * Math.PI * 1.25);
      const intro = Math.min(1, (t - L.start + LEAD) / 500);
      L.dots.style.transform = `scale(${(breathe * (0.6 + 0.4 * out) * Math.max(0, intro)).toFixed(3)})`;
      L.dots.style.opacity = (out * Math.max(0, intro)).toFixed(3);
      [...L.dots.children].forEach((d, k) => d.style.setProperty('--f', Math.max(0, Math.min(1, g * 3 - k)).toFixed(3)));
    }
  }

  function scrollBy(dy) {
    if (mode !== 'synced') return;
    manual -= dy;
    // keep it within the lyrics
    const a = lines[Math.max(anchorIdx, 0)];
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (a && first && last) {
      const base = H * ANCHOR - a.top;
      manual = Math.min(manual, H * 0.45 - first.top - base);
      manual = Math.max(manual, H * 0.15 - last.top - base);
    }
    freeUntil = performance.now() + 3200;
    box.classList.add('ly-free');
    retarget(performance.now(), { stagger: false });
    for (const l of lines) l.tgt = l.pending;
  }

  box.addEventListener('wheel', (e) => {
    if (mode !== 'synced') return;
    e.preventDefault();
    scrollBy(e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY);
  }, { passive: false });

  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (mode !== 'synced' || e.pointerType === 'mouse') return;
    drag = { y: e.clientY, moved: 0 };
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    drag.y = e.clientY;
    drag.moved += Math.abs(dy);
    scrollBy(dy);
  });
  box.addEventListener('pointerup', () => (drag = null));

  inner.addEventListener('click', (e) => {
    const el = e.target.closest('.ly-line[data-i]');
    if (!el || mode !== 'synced') return;
    const l = lines[+el.dataset.i];
    if (!l) return;
    freeUntil = 0;
    manual = 0;
    box.classList.remove('ly-free');
    onSeek?.(l.gap ? l.start : Math.max(0, l.start - 30));
  });

  new ResizeObserver(() => {
    if (mode !== 'synced') return;
    measure();
    retarget(performance.now(), { instant: true });
  }).observe(box);

  return {
    set,
    message,
    frame,
    reset() {
      active = -2;
      anchorIdx = -1;
    },
    setBlur(on) {
      blurOn = on;
      lines.forEach((l) => (l.blur = -1));
      active = -2;
    },
    get mode() { return mode; },
    get lines() { return lines.filter((l) => !l.gap).map((l) => ({ time: l.start, text: l.text })); },
  };
}

export { DIM };
