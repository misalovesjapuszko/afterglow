import { invoke } from './util.js';

// Lyrics come back as one shape no matter the source:
// { synced: [{ time, end?, text, words?: [{ text, time, end }] }], source, wordSynced }
// { plain: [string], source } | { instrumental: true, source }
const providers = [];
const cache = new Map();

export function addProvider(fn, { priority = 0 } = {}) {
  providers.push({ fn, priority });
  providers.sort((a, b) => b.priority - a.priority);
}

const ts = (m, s) => (+m * 60 + +s) * 1000;

export function parseLRC(text) {
  const lines = [];
  let offset = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) offset = +off[1];
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const body = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '');
    let words = null;
    if (/<\d+:\d+(?:\.\d+)?>/.test(body)) {
      // Enhanced LRC: <mm:ss.xx>word <mm:ss.xx>word ... <mm:ss.xx> (trailing tag = end of last word)
      const parts = [...body.matchAll(/<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g)].map((m) => ({ time: ts(m[1], m[2]), text: m[3] }));
      words = [];
      parts.forEach((p, k) => {
        const t = p.text.trim();
        if (!t) return;
        words.push({ text: t, time: p.time, end: parts[k + 1]?.time ?? null });
      });
      if (!words.length) words = null;
    }
    const text = (words ? words.map((w) => w.text).join(' ') : body).trim();
    for (const t of tags) lines.push({ time: ts(t[1], t[2]), text, words: words && words.map((w) => ({ ...w })) });
  }
  // LRC offset: positive means lyrics should show earlier
  if (offset) lines.forEach((l) => { l.time -= offset; l.words?.forEach((w) => { w.time -= offset; if (w.end != null) w.end -= offset; }); });
  return lines.sort((a, b) => a.time - b.time);
}

async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: { 'Lrclib-Client': 'Afterglow 0.2' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch {
    const text = await invoke('http_get', { url }).catch(() => null);
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }
}

// "Song - Remastered 2011", "Song (feat. X)", "Song - From the Movie" → "Song"
export function cleanTitle(name) {
  return String(name || '')
    .replace(/\s*[([](?:feat|ft|with|prod)\.?\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(?:.*\b(?:remaster(?:ed)?|remix(?:ed)?|version|edit|mix|live|mono|stereo|acoustic|demo|radio|single|from|bonus|deluxe|anniversary|recorded|sped up|slowed)\b.*)$/i, '')
    .replace(/\s*[([](?:.*\b(?:remaster(?:ed)?|version|edit|mono|stereo|deluxe|anniversary|bonus)\b.*)[)\]]/gi, '')
    .trim() || String(name || '');
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function scoreLrclib(r, track, title) {
  if (!r) return -Infinity;
  const dur = (track.duration || 0) / 1000;
  const dd = dur && r.duration ? Math.abs(r.duration - dur) : 0;
  if (dur && r.duration && dd > 8) return -Infinity; // different version, timings would be off
  let s = 0;
  if (r.syncedLyrics) s += 10;
  if (/<\d+:\d+/.test(r.syncedLyrics || '')) s += 4; // word timings
  else if (r.plainLyrics) s += 1;
  if (r.instrumental) s += 0.5;
  s -= dd * 1.2;
  const a = norm(track.artists?.[0]?.name);
  if (a && norm(r.artistName).includes(a)) s += 2;
  if (norm(r.trackName) === norm(title)) s += 2;
  if (track.album?.name && norm(r.albumName) === norm(track.album.name)) s += 1;
  return s;
}

function fromLrclib(d) {
  if (!d) return null;
  if (d.instrumental) return { instrumental: true, source: 'LRCLIB' };
  if (d.syncedLyrics) {
    const synced = parseLRC(d.syncedLyrics);
    if (synced.length) return { synced, source: 'LRCLIB', wordSynced: synced.some((l) => l.words?.length) };
  }
  if (d.plainLyrics) return { plain: d.plainLyrics.split(/\r?\n/), source: 'LRCLIB' };
  return null;
}

async function lrclib(track) {
  const artist = track.artists?.[0]?.name || '';
  const title = cleanTitle(track.name);
  const base = 'https://lrclib.net/api';
  const q = new URLSearchParams({ track_name: title, artist_name: artist });
  if (track.album?.name) q.set('album_name', track.album.name);
  if (track.duration) q.set('duration', Math.round(track.duration / 1000));
  const [exact, results, loose] = await Promise.all([
    getJSON(`${base}/get?${q}`),
    getJSON(`${base}/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`),
    title !== track.name ? getJSON(`${base}/search?${new URLSearchParams({ q: `${title} ${artist}` })}`) : null,
  ]);
  const all = [exact, ...(Array.isArray(results) ? results : []), ...(Array.isArray(loose) ? loose : [])].filter(Boolean);
  let best = null;
  let bestScore = -Infinity;
  for (const r of all) {
    const s = scoreLrclib(r, track, title);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return bestScore > -Infinity ? fromLrclib(best) : null;
}

// Spotify's own lyrics (Musixmatch), through the librespot session in the Rust side
async function spotify(track) {
  const id = track.id || track.uri?.split(':').pop();
  if (!id || !track.uri?.startsWith('spotify:track:')) return null;
  let d;
  try {
    d = await invoke('spotify_lyrics', { id });
  } catch (e) {
    return null; // not logged into the extra session, or no lyrics
  }
  const L = d?.lyrics;
  if (!L?.lines?.length) return null;
  const source = L.providerDisplayName ? `Spotify · ${L.providerDisplayName}` : 'Spotify';
  const lines = L.lines.map((l) => ({ time: +l.startTimeMs || 0, end: +l.endTimeMs || null, text: String(l.words || '').trim(), syllables: l.syllables || [] }));
  if (L.syncType === 'UNSYNCED') return { plain: lines.map((l) => l.text), source };
  const synced = lines.map((l) => {
    const text = l.text === '♪' ? '' : l.text;
    let words = null;
    // Syllable synced lines: each syllable has startTimeMs + numChars
    if (L.syncType === 'SYLLABLE_SYNCED' && l.syllables.length) {
      words = [];
      let at = 0;
      for (const sy of l.syllables) {
        const n = +sy.numChars || 0;
        const piece = text.slice(at, at + n);
        at += n;
        if (piece.trim()) words.push({ text: piece.trim(), time: +sy.startTimeMs, end: +sy.endTimeMs || null });
      }
      if (!words.length) words = null;
    }
    return { time: l.time, end: l.end || null, text, words };
  });
  return { synced, source, wordSynced: synced.some((l) => l.words?.length) };
}

addProvider(spotify, { priority: 50 });
addProvider(lrclib, { priority: -100 });

const good = (r) => r && (r.synced?.length || r.plain?.length || r.instrumental);

export async function getLyrics(track) {
  if (!track?.uri) return null;
  if (cache.has(track.uri)) return cache.get(track.uri);
  const job = (async () => {
    let fallback = null;
    for (const { fn } of providers) {
      try {
        const r = await fn(track);
        if (!good(r)) continue;
        if (r.synced?.length) return r; // best kind, stop here
        fallback = fallback || r; // plain or instrumental: keep looking for synced
      } catch (e) {
        console.warn('lyrics provider failed', e);
      }
    }
    return fallback;
  })();
  if (cache.size > 200) cache.clear();
  cache.set(track.uri, job);
  const res = await job;
  if (!res) cache.delete(track.uri); // retry next time (network hiccup)
  return res;
}

// Warm the cache for the next song so it's ready the moment it starts
export function prefetchLyrics(track) {
  if (track?.uri && !cache.has(track.uri)) getLyrics(track).catch(() => {});
}
