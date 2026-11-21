import { player, skipDirection } from './player.js';
import { getLyrics, prefetchLyrics } from './lyrics.js';
import { createLyrics } from './lyricsview.js';
import { api, areLiked, setLiked, normTrack } from './api.js';
import { icons, setIcon } from './icons.js';
import { $, bus, esc, fmt, img, invoke, menu, slider, store, toast } from './util.js';

const np = $('#np');
const box = $('#lyrics');
const inner = $('#lyrics-inner');
let raf = 0;
let loadingFor = null;
let lastRes = null;
let hideTimer = 0;
const bgCanvas = $('#np-canvas');
const bctx = bgCanvas.getContext('2d', { alpha: false });
let blobImg = null;
let focused = document.hasFocus();
let lastBg = 0;
window.addEventListener('focus', () => (focused = true));
window.addEventListener('blur', () => (focused = false));

const lyrics = createLyrics(box, inner, {
  onSeek: (ms) => {
    player.seek(ms);
    if (!player.state.playing) player.resume();
  },
});
lyrics.setBlur(store.get('lyricBlur', true));

function resizeBg() {
  const scale = 1 / 5;
  bgCanvas.width = Math.max(16, Math.ceil(innerWidth * scale));
  bgCanvas.height = Math.max(16, Math.ceil(innerHeight * scale));
  lastBg = 0;
}

const BLOBS = [
  { x: 0.12, y: 0.12, size: 0.95, period: 48, kind: 1, dir: 1 },
  { x: 0.88, y: 0.18, size: 0.95, period: 62, kind: 2, dir: 1 },
  { x: 0.35, y: 0.95, size: 0.95, period: 55, kind: 3, dir: 1 },
  { x: 0.86, y: 0.92, size: 0.75, period: 70, kind: 1, dir: -1 },
];

let palette = null;

function computePalette(px, N) {
  const buckets = new Map();
  for (let i = 0; i < N * N; i += 3) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const key = `${r >> 5},${g >> 5},${b >> 5}`;
    const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, sat: 0, lum: 0 };
    e.r += r; e.g += g; e.b += b; e.n++; e.sat += max ? (max - min) / max : 0; e.lum += (max + min) / 510;
    buckets.set(key, e);
  }
  const list = [...buckets.values()].map((e) => ({ c: [e.r / e.n, e.g / e.n, e.b / e.n], score: e.n * (0.25 + e.sat / e.n), lum: e.lum / e.n })).sort((a, b) => b.score - a.score);
  const out = [];
  for (const it of list) {
    if (out.every((o) => Math.hypot(o[0] - it.c[0], o[1] - it.c[1], o[2] - it.c[2]) > 60)) out.push(it.c);
    if (out.length === 5) break;
  }
  while (out.length && out.length < 5) out.push(out[out.length % out.length]);
  return out.map(([r, g, b]) => {
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const k = 1.35;
    let c = [l + (r - l) * k, l + (g - l) * k, l + (b - l) * k];
    const m = Math.max(...c);
    if (m < 120) c = c.map((v) => (v * 120) / Math.max(1, m));
    return c.map((v) => Math.round(Math.max(0, Math.min(255, v))));
  });
}

const COLOR_PATHS = [
  { ax: 0.32, ay: 0.28, sx: 0.23, sy: 0.17, p: 31, r: 0.75 },
  { ax: 0.75, ay: 0.3, sx: 0.19, sy: 0.24, p: 43, r: 0.7 },
  { ax: 0.5, ay: 0.75, sx: 0.27, sy: 0.16, p: 37, r: 0.8 },
  { ax: 0.18, ay: 0.82, sx: 0.15, sy: 0.2, p: 53, r: 0.6 },
  { ax: 0.86, ay: 0.85, sx: 0.18, sy: 0.15, p: 47, r: 0.65 },
];

function drawColors(t, w, h) {
  const vmax = Math.max(w, h);
  const [base] = palette;
  bctx.fillStyle = `rgb(${base.map((v) => Math.round(v * 0.35)).join(',')})`;
  bctx.fillRect(0, 0, w, h);
  palette.forEach((c, i) => {
    const P = COLOR_PATHS[i];
    const a = (2 * Math.PI * t) / P.p;
    const x = (P.ax + Math.sin(a + i) * P.sx) * w;
    const y = (P.ay + Math.cos(a * 0.8 + i * 1.7) * P.sy) * h;
    const r = P.r * vmax * (1 + 0.12 * Math.sin(a * 1.3 + i));
    const g = bctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${c.join(',')},0.95)`);
    g.addColorStop(0.55, `rgba(${c.join(',')},0.45)`);
    g.addColorStop(1, `rgba(${c.join(',')},0)`);
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, w, h);
  });
}

function drawBg(now) {
  const w = bgCanvas.width;
  const h = bgCanvas.height;
  const kind = store.get('lyricsBg', 'cover');
  const t0 = document.body.classList.contains('still') ? 0 : now / 1000;
  if (kind !== 'cover' && palette) {
    if (kind === 'colors') return drawColors(t0, w, h);
    bctx.fillStyle = `rgb(${palette[0].map((v) => Math.round(v * 0.45)).join(',')})`;
    bctx.fillRect(0, 0, w, h);
    return;
  }
  bctx.fillStyle = '#000';
  bctx.fillRect(0, 0, w, h);
  if (!blobImg) return;
  const vmax = Math.max(w, h);
  const t = document.body.classList.contains('still') ? 0 : now / 1000;
  bctx.globalAlpha = 0.95;
  for (const b of BLOBS) {
    const a = (b.dir * 2 * Math.PI * t) / b.period;
    const S = b.size * vmax;
    let cx = b.x * w;
    let cy = b.y * h;
    let rot = 0;
    let sc = 1;
    if (b.kind === 1) {
      cx += Math.cos(a) * S * 0.06;
      cy += Math.sin(a) * S * 0.06;
    } else if (b.kind === 2) {
      rot = a;
      sc = 1 + 0.1 * Math.cos(a);
    } else {
      const k = (1 - Math.cos(a)) / 2;
      cx += k * S * 0.08;
      cy -= k * S * 0.06;
      rot = a;
    }
    bctx.save();
    bctx.translate(cx, cy);
    bctx.rotate(rot);
    bctx.scale(sc, sc);
    bctx.drawImage(blobImg, -S / 2, -S / 2, S, S);
    bctx.restore();
  }
  bctx.globalAlpha = 1;
}

let blobFor = null;
function makeBlob(url) {
  blobFor = url;
  if (!url) {
    blobImg = null;
    lastBg = 0;
    return;
  }
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    if (blobFor !== url) return;
    try {
      const N = 160;
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, N, N);
      const data = g.getImageData(0, 0, N, N);
      const px = data.data;
      const pal = computePalette(px, N);
      const tmp = new Float32Array(N * N * 3);
      for (let i = 0; i < N * N; i++) {
        tmp[i * 3] = px[i * 4];
        tmp[i * 3 + 1] = px[i * 4 + 1];
        tmp[i * 3 + 2] = px[i * 4 + 2];
      }
      const blur = (src, r) => {
        const out = new Float32Array(src.length);
        for (let pass = 0; pass < 2; pass++) {
          const a = pass === 0 ? src : out.slice();
          const horiz = pass === 0;
          for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
              let sr = 0, sg = 0, sb = 0, n = 0;
              for (let k = -r; k <= r; k++) {
                const xx = horiz ? x + k : x;
                const yy = horiz ? y : y + k;
                if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
                const j = (yy * N + xx) * 3;
                sr += a[j]; sg += a[j + 1]; sb += a[j + 2]; n++;
              }
              const o = (y * N + x) * 3;
              out[o] = sr / n; out[o + 1] = sg / n; out[o + 2] = sb / n;
            }
          }
        }
        return out;
      };
      let b = blur(tmp, 9);
      b = blur(b, 9);
      b = blur(b, 9);
      const mid = N / 2;
      for (let i = 0; i < N * N; i++) {
        let r = b[i * 3], gg = b[i * 3 + 1], bb = b[i * 3 + 2];
        const l = 0.299 * r + 0.587 * gg + 0.114 * bb;
        r = (l + (r - l) * 1.7) * 0.85;
        gg = (l + (gg - l) * 1.7) * 0.85;
        bb = (l + (bb - l) * 1.7) * 0.85;
        const x = i % N, y = (i / N) | 0;
        const d = Math.hypot(x - mid + 0.5, y - mid + 0.5) / mid;
        const alpha = d >= 1 ? 0 : Math.pow(1 - d * d, 1.6);
        px[i * 4] = Math.max(0, Math.min(255, r));
        px[i * 4 + 1] = Math.max(0, Math.min(255, gg));
        px[i * 4 + 2] = Math.max(0, Math.min(255, bb));
        px[i * 4 + 3] = alpha * 255;
      }
      g.putImageData(data, 0, 0);
      if (blobFor === url) {
        blobImg = c;
        palette = pal.length ? pal : null;
        lastBg = 0;
        bus.emit('palette', palette);
      }
    } catch (e) {
      console.warn('blob failed', e);
    }
  };
  im.src = url;
}

function extractAccent(url) {
  if (!url || !store.get('accentFromArt', true)) {
    document.documentElement.style.removeProperty('--art');
    document.documentElement.style.removeProperty('--art-rgb');
    return;
  }
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data;
      let best = null;
      let bestScore = -1;
      const buckets = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const [r, gr, b] = [d[i], d[i + 1], d[i + 2]];
        const max = Math.max(r, gr, b);
        const min = Math.min(r, gr, b);
        const sat = max ? (max - min) / max : 0;
        const lum = (max + min) / 510;
        if (lum < 0.15 || lum > 0.92) continue;
        const key = `${r >> 5},${gr >> 5},${b >> 5}`;
        const e = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, sat: 0 };
        e.r += r; e.g += gr; e.b += b; e.n++; e.sat += sat;
        buckets.set(key, e);
      }
      for (const e of buckets.values()) {
        const score = e.n * (0.3 + e.sat / e.n) ** 2;
        if (score > bestScore) {
          bestScore = score;
          best = e;
        }
      }
      if (!best) return;
      let [r, gr, b] = [best.r / best.n, best.g / best.n, best.b / best.n];
      const max = Math.max(r, gr, b);
      if (max < 170) {
        const k = 170 / max;
        r *= k; gr *= k; b *= k;
      }
      const rgb = [r, gr, b].map((v) => Math.round(Math.min(255, v)));
      document.documentElement.style.setProperty('--art', `rgb(${rgb.join(',')})`);
      document.documentElement.style.setProperty('--art-rgb', rgb.join(','));
    } catch {}
  };
  im.src = url;
}


window.addEventListener('resize', () => nowPlaying.open && (resizeBg(), sizeViz()));

// ───────────────────────── lyrics timing offsets ─────────────────────────
// positive = lyrics earlier. Per-song offset + one global offset.
const offsets = store.get('lyricOffsets', {});
const curUri = () => player.state.track?.uri || '';
export function lyricOffset(uri = curUri()) {
  return store.get('lyricOffset', 0) + (offsets[uri] || 0);
}
export function nudgeOffset(d, { global = false } = {}) {
  if (global) {
    const v = d === 0 ? 0 : clampOff(store.get('lyricOffset', 0) + d);
    store.set('lyricOffset', v);
  } else {
    const uri = curUri();
    if (!uri) return;
    const v = d === 0 ? 0 : clampOff((offsets[uri] || 0) + d);
    if (v) offsets[uri] = v;
    else delete offsets[uri];
    const keys = Object.keys(offsets);
    if (keys.length > 600) delete offsets[keys[0]];
    store.set('lyricOffsets', offsets);
  }
  renderSync();
  const total = lyricOffset();
  return total;
}
const clampOff = (v) => Math.max(-10000, Math.min(10000, Math.round(v / 50) * 50));
const fmtOff = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + (Math.abs(v) / 1000).toFixed(Math.abs(v) % 100 ? 2 : 1) + 's';

const syncPop = $('#np-sync-pop');
function renderSync() {
  const all = $('#sync-all').checked;
  const v = all ? store.get('lyricOffset', 0) : offsets[curUri()] || 0;
  $('#sync-val').textContent = fmtOff(v);
  $('#np-sync').classList.toggle('on', lyricOffset() !== 0);
}
$('#np-sync').addEventListener('click', (e) => {
  e.stopPropagation();
  syncPop.hidden = !syncPop.hidden;
  renderSync();
});
syncPop.addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('.sync-btn');
  if (!b) return;
  nudgeOffset(+b.dataset.d, { global: $('#sync-all').checked });
});
$('#sync-all').addEventListener('change', renderSync);
document.addEventListener('click', (e) => {
  if (!syncPop.hidden && !e.target.closest('#np-sync-pop, #np-sync')) syncPop.hidden = true;
});

// ───────────────────────── ring visualizer ─────────────────────────
const B = 64;
const viz = {
  canvas: $('#np-viz'),
  ctx: null,
  bands: new Float32Array(B),
  slow: new Float32Array(B),
  target: new Float32Array(B),
  last: 0,
  capture: false,
  amp: 0,
  size: 0,
  dpr: 1,
};
viz.ctx = viz.canvas.getContext('2d');
window.__TAURI__?.event?.listen('viz', ({ payload }) => {
  const gain = 2 ** ((store.get('vizSensitivity', 0.5) - 0.5) * 4);
  for (let i = 0; i < B; i++) viz.target[i] = Math.min(1, ((payload[i] || 0) / 255) * gain);
  viz.last = performance.now();
});
const vizOn = () => store.get('visualizer', true);
function vizStart() {
  if (!vizOn() || viz.capture) return;
  invoke('viz_start').then(() => (viz.capture = true)).catch(() => (viz.capture = false));
}
function vizStop() {
  if (!viz.capture) return;
  viz.capture = false;
  invoke('viz_stop').catch(() => {});
}
function sizeViz() {
  const art = $('#np-art');
  const S = art.clientWidth;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(S * 1.7);
  if (viz.size === W && viz.dpr === dpr) return;
  viz.size = W;
  viz.dpr = dpr;
  viz.canvas.width = W * dpr;
  viz.canvas.height = W * dpr;
}
// smooth pseudo-noise for when there's no captured audio
const noise = (i, t) => 0.5 + 0.25 * Math.sin(i * 0.71 + t * 1.9) + 0.15 * Math.sin(i * 1.37 - t * 3.1) + 0.1 * Math.sin(i * 0.23 + t * 0.7);

function bandAt(arr, pos) {
  const i = Math.floor(pos);
  const f = pos - i;
  const a = arr[Math.max(0, Math.min(B - 1, i))];
  const b = arr[Math.max(0, Math.min(B - 1, i + 1))];
  return a + (b - a) * f;
}

// a point on the rounded-rect perimeter (u in 0..1, clockwise from top centre) + outward normal
function perimeter(u, h, r) {
  const e = h - r;
  const q = (Math.PI / 2) * r;
  const segs = [
    [e, (d) => [d, -h, 0, -1]],
    [q, (d) => arcPt(e, -e, -Math.PI / 2 + (r ? d / r : 0), r)],
    [2 * e, (d) => [h, -e + d, 1, 0]],
    [q, (d) => arcPt(e, e, r ? d / r : 0, r)],
    [2 * e, (d) => [e - d, h, 0, 1]],
    [q, (d) => arcPt(-e, e, Math.PI / 2 + (r ? d / r : 0), r)],
    [2 * e, (d) => [-h, e - d, -1, 0]],
    [q, (d) => arcPt(-e, -e, Math.PI + (r ? d / r : 0), r)],
    [e, (d) => [-e + d, -h, 0, -1]],
  ];
  let d = (((u % 1) + 1) % 1) * (8 * e + 4 * q);
  for (const [len, f] of segs) {
    if (d <= len) return f(d);
    d -= len;
  }
  return [0, -h, 0, -1];
}
const arcPt = (cx, cy, a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.cos(a), Math.sin(a)];

const N_PTS = 200;
const pts = new Float32Array(N_PTS * 2);
function wavePath(ctx, cx, cy, h, r, scale, src, base) {
  for (let j = 0; j < N_PTS; j++) {
    const u = j / N_PTS;
    const [x, y, nx, ny] = perimeter(u, h, r);
    const pos = (1 - Math.abs(Math.sin(2 * Math.PI * u))) * (B - 1) * 0.9;
    const v = bandAt(src, pos);
    // keep the bottom edge calm so it never reaches the title underneath
    const d = base + v * scale * (ny > 0 ? 1 - 0.6 * ny : 1);
    pts[j * 2] = cx + x + nx * d;
    pts[j * 2 + 1] = cy + y + ny * d;
  }
  ctx.beginPath();
  const mx = (i) => (pts[(i % N_PTS) * 2] + pts[((i + 1) % N_PTS) * 2]) / 2;
  const my = (i) => (pts[(i % N_PTS) * 2 + 1] + pts[((i + 1) % N_PTS) * 2 + 1]) / 2;
  ctx.moveTo(mx(0), my(0));
  for (let j = 1; j <= N_PTS; j++) ctx.quadraticCurveTo(pts[(j % N_PTS) * 2], pts[(j % N_PTS) * 2 + 1], mx(j), my(j));
  ctx.closePath();
}

function drawViz(now) {
  const ctx = viz.ctx;
  const W = viz.canvas.width;
  if (!vizOn() || !W) {
    if (viz.amp) {
      ctx.clearRect(0, 0, W, W);
      viz.amp = 0;
    }
    return;
  }
  const playing = player.state.playing;
  viz.amp += ((playing ? 1 : 0.0) - viz.amp) * 0.06;
  const live = viz.capture && now - viz.last < 500;
  const t = now / 1000;
  let energy = 0;
  for (let i = 0; i < B; i++) {
    const want = live ? viz.target[i] : playing ? 0.16 + 0.22 * noise(i, t) * (0.7 + 0.3 * Math.sin(t * 2.2)) : 0;
    viz.bands[i] += (want - viz.bands[i]) * (live ? 0.55 : 0.12);
    viz.slow[i] += (viz.bands[i] - viz.slow[i]) * 0.07;
    if (i < 10) energy += viz.bands[i] / 10;
  }
  const dpr = viz.dpr;
  const S = (W / 1.7);
  const cx = W / 2;
  const cy = W / 2;
  const disc = np.classList.contains('disc');
  const h = S / 2 + 3 * dpr;
  const r = disc ? h : S * 0.035 + 3 * dpr;
  const amp = viz.amp;
  ctx.clearRect(0, 0, W, W);
  if (amp < 0.01) return;
  const pal = palette || [[255, 255, 255], [255, 255, 255], [255, 255, 255]];
  const c0 = pal[0].join(',');
  const c1 = (pal[1] || pal[0]).join(',');
  const c2 = (pal[2] || pal[0]).join(',');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // soft outer aura, follows the slow envelope
  wavePath(ctx, cx, cy, h, r, S * 0.085 * amp, viz.slow, 5 * dpr);
  ctx.shadowColor = `rgba(${c0},${0.55 * amp})`;
  ctx.shadowBlur = 34 * dpr;
  ctx.fillStyle = `rgba(${c0},${0.22 * amp})`;
  ctx.fill();
  // middle layer
  wavePath(ctx, cx, cy, h, r, S * 0.065 * amp, viz.bands, 3 * dpr);
  ctx.shadowBlur = 18 * dpr;
  ctx.shadowColor = `rgba(${c1},${0.7 * amp})`;
  ctx.fillStyle = `rgba(${c1},${0.28 * amp})`;
  ctx.fill();
  // bright crisp edge
  ctx.shadowBlur = 12 * dpr;
  ctx.shadowColor = `rgba(${c2},${0.9 * amp})`;
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = `rgba(255,255,255,${0.7 * amp})`;
  ctx.stroke();
  ctx.restore();
  // a gentle thump on the cover with the bass
  const pulse = live ? 1 + Math.min(0.025, energy * energy * 0.03) * amp : 1;
  if (Math.abs(pulse - (viz.pulse || 1)) > 0.0005) {
    viz.pulse = pulse;
    $('#np-art').style.setProperty('--pulse', pulse.toFixed(4));
  }
}

// ───────────────────────── now playing panel ─────────────────────────
export const nowPlaying = {
  get open() { return np.classList.contains('open'); },
  show() {
    bus.emit('resync');
    flyCover();
    np.classList.add('open', 'entering');
    $('#pl-lyrics').classList.add('active');
    setTimeout(() => np.classList.remove('entering'), 1100);
    np.setAttribute('aria-hidden', 'false');
    lyrics.reset();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => np.classList.contains('open') && document.body.classList.add('np-open'), 650);
    resizeBg();
    requestAnimationFrame(sizeViz);
    vizStart();
    if (phone.matches && tab !== 'none') setTab('none', false);
    if (tab === 'queue') loadQueue();
    loop();
    spinDisc();
  },
  hide() {
    clearTimeout(hideTimer);
    document.body.classList.remove('np-open');
    np.classList.remove('open');
    np.setAttribute('aria-hidden', 'true');
    $('#pl-lyrics').classList.remove('active');
    syncPop.hidden = true;
    cancelAnimationFrame(raf);
    raf = 0;
    vizStop();
  },
  toggle() { this.open ? this.hide() : this.show(); },
  get lyrics() { return { mode: lyrics.mode, lines: lyrics.lines }; },
};

// the little cover in the top bar flies up and grows into the big one
function flyCover() {
  const mini = $('#pl-art');
  const cover = $('#np-cover');
  if (document.body.classList.contains('no-anim') || !cover.getAttribute('src') || !mini.offsetWidth) return;
  const a = mini.getBoundingClientRect();
  const b = cover.getBoundingClientRect(); // panel is still parked below the screen
  const top = b.top - np.getBoundingClientRect().top;
  const left = b.left;
  const s = a.width / b.width;
  cover.animate(
    [
      { transform: `translate(${a.left - left}px, ${a.top - top - innerHeight}px) scale(${s})`, borderRadius: `${9 / s}px`, transformOrigin: '0 0' },
      { transform: 'none', transformOrigin: '0 0' },
    ],
    { duration: 720, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  );
}

function applyLook() {
  np.classList.toggle('disc', store.get('coverShape', 'square') === 'disc');
  np.classList.toggle('no-viz', !vizOn());
  spinDisc();
}

// Spinning disc: one turn per 24 s while playing. The angle lives here instead of in a CSS
// animation, which restarted from 0° whenever the player was hidden, reopened or restyled,
// and it slows down / speeds up smoothly instead of stopping dead on pause.
const disc = { angle: 0, speed: 0, last: 0, raf: 0 };
const DISC_SPEED = 360 / 24000; // degrees per ms
function spinDisc() {
  if (disc.raf || !np.classList.contains('disc')) return;
  const tick = (now) => {
    const dt = disc.last ? Math.min(100, now - disc.last) : 0;
    disc.last = now;
    const target = np.classList.contains('paused') || !player.state.playing ? 0 : DISC_SPEED;
    disc.speed += (target - disc.speed) * Math.min(1, dt / 350);
    if (Math.abs(disc.speed) < 1e-5) disc.speed = target;
    disc.angle = (disc.angle + disc.speed * dt) % 360;
    $('#np-cover')?.style.setProperty('--disc-rot', `${disc.angle.toFixed(2)}deg`);
    // keep running only while it's visible and still turning
    if (np.classList.contains('disc') && nowPlaying.open && !document.hidden && (disc.speed || target)) disc.raf = requestAnimationFrame(tick);
    else disc.raf = disc.last = 0;
  };
  disc.raf = requestAnimationFrame(tick);
}
applyLook();

const SPRING = 'cubic-bezier(0.16, 1.22, 0.3, 1)';
const animOK = () => !document.body.classList.contains('no-anim') && !matchMedia('(prefers-reduced-motion: reduce)').matches;

// Song change: the old cover tilts away like a card in the skip direction, the new one
// springs in from the other side and a glint of light runs across it.
function swapCover(cover, url) {
  const art = $('#np-art');
  if (!animOK() || !nowPlaying.open || !cover.getAttribute('src')) {
    cover.src = url;
    return;
  }
  const d = skipDirection();
  for (const g of art.querySelectorAll('.np-ghost')) g.remove();
  const ghost = cover.cloneNode();
  ghost.removeAttribute('id');
  ghost.classList.add('np-ghost');
  ghost.style.transform = getComputedStyle(cover).transform; // freeze pause-shrink / disc angle
  art.appendChild(ghost);
  const out = { duration: 560, easing: 'cubic-bezier(0.55, 0, 0.8, 0.25)', fill: 'forwards' };
  ghost.animate(
    [{ transform: 'perspective(1000px) translateX(0) rotateY(0) scale(1)' }, { transform: `perspective(1000px) translateX(${-d * 75}%) rotateY(${d * 42}deg) scale(0.7)` }],
    { ...out, composite: 'add' },
  );
  ghost
    .animate([{ opacity: 1, filter: 'none' }, { opacity: 0, filter: 'blur(16px) brightness(0.55)' }], out)
    .finished.then(() => ghost.remove(), () => ghost.remove());
  cover.src = url;
  // transform adds on top of the CSS one (pause shrink, disc spin), so nothing jumps at the end
  cover.animate(
    [{ transform: `perspective(1000px) translateX(${d * 75}%) rotateY(${-d * 42}deg) scale(0.7)` }, { transform: 'perspective(1000px) translateX(0) rotateY(0) scale(1)' }],
    { duration: 950, delay: 110, easing: SPRING, fill: 'backwards', composite: 'add' },
  );
  cover.animate([{ opacity: 0, filter: 'blur(16px) brightness(1.4)' }, { opacity: 1, filter: 'none' }], { duration: 600, delay: 110, easing: 'ease-out', fill: 'backwards' });
  let glint = art.querySelector('.np-glint');
  if (!glint) {
    glint = document.createElement('div');
    glint.className = 'np-glint';
    art.appendChild(glint);
  }
  glint.animate(
    [{ opacity: 0, backgroundPosition: d > 0 ? '130% 0' : '-30% 0' }, { opacity: 1, offset: 0.35 }, { opacity: 0, backgroundPosition: d > 0 ? '-30% 0' : '130% 0' }],
    { duration: 1100, delay: 420, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'backwards' },
  );
}

function setArt(track) {
  const url = img(track?.album?.images, 640);
  const small = img(track?.album?.images, 300);
  const cover = $('#np-cover');
  if (!url) cover.removeAttribute('src');
  else if (cover.getAttribute('src') !== url) {
    const pre = new Image();
    pre.src = url;
    (pre.decode ? pre.decode() : Promise.resolve()).catch(() => {}).then(() => {
      if (player.state.track && img(player.state.track.album?.images, 640) === url) swapCover(cover, url);
    });
  }
  makeBlob(img(track?.album?.images, 64) || small);
  if (animOK() && nowPlaying.open && track) {
    const d = skipDirection();
    $('.np-info').animate(
      [{ opacity: 0, transform: `translateX(${d * 46}px)`, filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
      { duration: 700, delay: 160, easing: SPRING, fill: 'backwards' },
    );
  }
  $('#np-title').textContent = track?.name || '';
  $('#np-artist').innerHTML = (track?.artists || []).map((a) => (a.id ? `<span class="link" data-artist="${esc(a.id)}">${esc(a.name)}</span>` : esc(a.name))).join(', ') + (track?.album?.name ? `<span class="np-album"> — ${esc(track.album.name)}</span>` : '');
  extractAccent(small);
}

$('#np-artist').addEventListener('click', (e) => {
  const a = e.target.closest('[data-artist]');
  if (!a) return;
  nowPlaying.hide();
  import('./views.js').then((v) => v.navigate('artist', a.dataset.artist));
});

export const STYLES = { auto: 'Automatic', word: 'Word by word', line: 'Line by line', static: 'Static' };
export const BACKGROUNDS = { cover: 'Album art', colors: 'Moving colors', solid: 'Solid' };
const styleNow = () => {
  const s = store.get('lyricStyle', 'auto');
  return STYLES[s] ? s : 'auto'; // old "letter" setting → automatic
};

function show(res, track) {
  lastRes = res;
  const credit = res.source ? `Lyrics from ${res.source}` : '';
  $('#np-src').textContent = res.source || '';
  lyrics.set(res, { style: styleNow(), duration: player.state.duration || track?.duration || 0, credit });
  bus.emit('lyrics', { track, mode: lyrics.mode, style: styleNow(), lines: lyrics.lines });
}

async function loadLyrics(track) {
  loadingFor = track?.uri || null;
  lastRes = null;
  np.classList.remove('no-lyrics');
  $('#np-src').textContent = '';
  if (!track) return lyrics.message('');
  lyrics.message('');
  box.classList.add('ly-loading');
  const res = await getLyrics(track);
  box.classList.remove('ly-loading');
  if (loadingFor !== track.uri) return;
  if (!res) {
    np.classList.add('no-lyrics');
    return lyrics.message('No lyrics for this song');
  }
  if (res.instrumental) {
    np.classList.add('no-lyrics');
    return lyrics.message('♪ Instrumental');
  }
  show(res, track);
  renderSync();
}

export function setLyricStyle(s) {
  store.set('lyricStyle', s);
  if (lastRes) show(lastRes, player.state.track);
}
export function setLyricsBg(k) {
  store.set('lyricsBg', k);
  lastBg = 0;
}
export function setLyricBlur(on) {
  lyrics.setBlur(on);
}

// ───────────────────────── queue tab ─────────────────────────
let tab = store.get('npTab', 'lyrics');
const queueEl = $('#np-queue');
// on a phone the lyrics / queue replace the cover instead of sitting next to it
const phone = matchMedia('(max-width: 700px)');
function setTab(t, keep = true) {
  tab = t;
  if (keep && !phone.matches) store.set('npTab', t);
  $('#np-tab-lyrics').classList.toggle('on', t === 'lyrics');
  $('#np-tab-queue').classList.toggle('on', t === 'queue');
  np.classList.toggle('show-queue', t === 'queue');
  np.classList.toggle('hide-lyrics', t === 'none');
  queueEl.hidden = t !== 'queue';
  box.hidden = t === 'queue';
  if (t === 'queue') loadQueue();
  else lyrics.reset();
}
$('#np-tab-lyrics').onclick = () => setTab(tab === 'lyrics' ? 'none' : 'lyrics');
$('#np-tab-queue').onclick = () => setTab(tab === 'queue' ? 'lyrics' : 'queue');

let queueTracks = [];
let jumping = false;
async function loadQueue() {
  queueEl.innerHTML = '<div class="npq-head">Up Next</div><div class="spinner"></div>';
  try {
    const q = await api('/me/player/queue');
    const next = (q?.queue || []).map(normTrack).filter(Boolean).slice(0, 40);
    queueTracks = next;
    prefetchLyrics(next[0]);
    queueEl.innerHTML = `<div class="npq-head">Up Next</div>` + (next.length
      ? next.map((t, i) => `<div class="npq-item" style="--i:${i}" data-i="${i}" title="Play now"><div class="npq-art"><img src="${esc(img(t.album?.images, 64))}" alt="">${icons.play}</div><div class="npq-text"><div class="npq-name">${esc(t.name)}</div><div class="npq-artist">${esc(t.artists.map((a) => a.name).join(', '))}</div></div><div class="npq-dur">${fmt(t.duration)}</div></div>`).join('')
      : '<div class="npq-empty">Nothing queued. Autoplay will pick something similar.</div>');
  } catch (e) {
    queueEl.innerHTML = `<div class="npq-head">Up Next</div><div class="npq-empty">${esc(e.message)}</div>`;
  }
}

// Click a song in Up Next to jump to it. Spotify's API can't reorder the queue, so we skip
// forward to it (keeps the rest of the queue), or for far-away songs in a playlist/album,
// restart that playlist/album at the song.
queueEl.addEventListener('click', async (e) => {
  const item = e.target.closest('.npq-item');
  if (!item || jumping) return;
  const i = +item.dataset.i;
  const t = queueTracks[i];
  if (!t) return;
  jumping = true;
  item.classList.add('jumping');
  try {
    const ctx = player.state.context;
    if (i >= 4 && !player.state.shuffle && /^spotify:(playlist|album):/.test(ctx || '')) {
      await player.playContext(ctx, null, t.uri);
    } else {
      for (let k = 0; k <= i; k++) await player.next();
    }
  } catch (err) {
    toast('Could not play: ' + err.message);
  } finally {
    jumping = false;
    setTimeout(() => nowPlaying.open && tab === 'queue' && loadQueue(), 900);
  }
});

// ───────────────────────── like / more / volume ─────────────────────────
function setNpLike(on) {
  const b = $('#np-like');
  b.classList.toggle('on', on);
  setIcon(b, on ? 'heartFill' : 'heart');
}
$('#np-like').onclick = () => {
  const t = player.state.track;
  if (!t) return;
  const on = !$('#np-like').classList.contains('on');
  setNpLike(on);
  if (on) {
    $('#np-like').classList.remove('pop');
    void $('#np-like').offsetWidth;
    $('#np-like').classList.add('pop');
  }
  setLiked(t.uri, on).catch((e) => {
    setNpLike(!on);
    toast(e.message);
  });
};
bus.on('liked-changed', ({ uri, on }) => uri === curUri() && setNpLike(on));

$('#np-more').onclick = (e) => {
  const t = player.state.track;
  if (!t) return;
  e.stopPropagation();
  import('./views.js').then((v) =>
    menu(e, [
      { label: 'Add to playlist…', onClick: () => v.addToPlaylistMenu(e, [t.uri]) },
      ...(t.album?.id ? [{ label: 'Go to album', onClick: () => (nowPlaying.hide(), v.navigate('album', t.album.id)) }] : []),
      ...(t.artists?.[0]?.id ? [{ label: 'Go to artist', onClick: () => (nowPlaying.hide(), v.navigate('artist', t.artists[0].id)) }] : []),
      '-',
      ...v.trackMenuItems.map((m) => ({ label: m.label, onClick: () => m.onClick(t) })),
      { label: 'Copy song link', onClick: () => navigator.clipboard.writeText(`https://open.spotify.com/track/${t.id}`).then(() => toast('Link copied')) },
      ...(lastRes?.synced ? [{ label: 'Copy lyrics', onClick: () => navigator.clipboard.writeText(lastRes.synced.map((l) => l.text).join('\n')).then(() => toast('Lyrics copied')) }] : []),
    ]),
  );
};

let lastVol = 0;
const npVol = slider($('#np-volume'), {
  onInput: (v) => {
    const now = performance.now();
    if (now - lastVol > 60) {
      lastVol = now;
      player.setVolume(v);
    }
  },
  onChange: (v) => {
    player.setVolume(v);
    store.set('volume', v);
  },
});
$('#np-vol-down').onclick = () => player.setVolume(player.state.volume - 0.1);
$('#np-vol-up').onclick = () => player.setVolume(player.state.volume + 0.1);

// ───────────────────────── frame loop ─────────────────────────
let lastSec = -1;
let lastDur = -1;
let lastSeek = 0;
const posEl = $('#np-pos');
const durEl = $('#np-dur');

function loop() {
  cancelAnimationFrame(raf);
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    const now = performance.now();
    const still = document.body.classList.contains('still');
    const bgEvery = still ? Infinity : focused ? 1000 / 30 : 1000 / 12;
    if (!lastBg || now - lastBg >= bgEvery) {
      lastBg = now;
      drawBg(now);
    }
    if (focused || now - (viz.drawn || 0) > 60) {
      viz.drawn = now;
      drawViz(now);
    }
    const pos = player.pos();
    const dur = player.state.duration || 0;
    const sec = Math.floor(pos / 1000);
    if (sec !== lastSec || dur !== lastDur) {
      lastSec = sec;
      lastDur = dur;
      posEl.textContent = fmt(pos);
      durEl.textContent = dur ? '−' + fmt(Math.max(0, dur - pos)) : '0:00';
    }
    if (now - lastSeek > 100) {
      lastSeek = now;
      npSeek?.set(dur ? pos / dur : 0);
    }
    if (tab !== 'queue') lyrics.frame(pos + lyricOffset(), now);
  };
  tick();
}

let npSeek = null;
export function bindNowPlaying(seekSlider) {
  npSeek = seekSlider;
}

bus.on('track', (t) => {
  setArt(t);
  loadLyrics(t);
  if (t?.uri) areLiked([t.uri]).then(([on]) => player.state.track?.uri === t.uri && setNpLike(on));
  else setNpLike(false);
  if (nowPlaying.open && tab === 'queue') loadQueue();
  // the next song's lyrics, so they're ready instantly
  setTimeout(() => api('/me/player/queue').then((q) => prefetchLyrics(normTrack(q?.queue?.[0]))).catch(() => {}), 4000);
});

let pauseTimer = 0;
bus.on('state', (s) => {
  clearTimeout(pauseTimer);
  if (s.playing) np.classList.remove('paused');
  else pauseTimer = setTimeout(() => !player.state.playing && np.classList.add('paused'), 500);
  if (s.playing) spinDisc();
  npVol.set(s.volume);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && nowPlaying.open) lyrics.reset();
  if (!document.hidden) spinDisc();
});

$('#np-close').addEventListener('click', () => nowPlaying.hide());

$('#np-style').addEventListener('click', (e) => {
  const cur = styleNow();
  const bg = store.get('lyricsBg', 'cover');
  const tick = (on) => (on ? '✓  ' : '     ');
  menu(e, [
    { label: 'Lyrics', disabled: true },
    ...Object.entries(STYLES).map(([k, v]) => ({ label: tick(k === cur) + v, onClick: () => setLyricStyle(k) })),
    { label: tick(store.get('lyricBlur', true)) + 'Blur other lines', onClick: () => { const on = !store.get('lyricBlur', true); store.set('lyricBlur', on); lyrics.setBlur(on); } },
    '-',
    { label: 'Cover', disabled: true },
    { label: tick(store.get('coverShape', 'square') === 'square') + 'Square', onClick: () => { store.set('coverShape', 'square'); applyLook(); } },
    { label: tick(store.get('coverShape', 'square') === 'disc') + 'Spinning disc', onClick: () => { store.set('coverShape', 'disc'); applyLook(); } },
    { label: tick(vizOn()) + 'Sound ring', onClick: () => { store.set('visualizer', !vizOn()); applyLook(); vizOn() ? vizStart() : vizStop(); } },
    '-',
    { label: 'Background', disabled: true },
    ...Object.entries(BACKGROUNDS).map(([k, v]) => ({ label: tick(k === bg) + v, onClick: () => setLyricsBg(k) })),
  ]);
});

setTab(tab === 'queue' ? 'lyrics' : tab);
