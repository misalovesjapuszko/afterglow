import { api } from './api.js';
import { player } from './player.js';
import { bus, store } from './util.js';

const heard = new Set();
let busy = false;
let lastSeed = null;

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

async function searchTracks(q, maxOffset) {
  const offset = Math.floor(Math.random() * maxOffset);
  const r = await api('/search', { query: { q, type: 'track', limit: 10, offset } }).catch(() => null);
  return (r?.tracks?.items || []).filter((t) => t?.uri && !t.is_local);
}

async function candidates(track) {
  const artist = track.artists?.[0];
  const own = artist?.name ? [...(await searchTracks(`artist:"${artist.name}"`, 1)), ...(await searchTracks(`artist:"${artist.name}"`, 40))] : [];
  const counts = new Map();
  for (const t of [...own, track]) {
    for (const a of t.artists || []) {
      if (!a?.name || a.name === artist?.name) continue;
      counts.set(a.name, (counts.get(a.name) || 0) + 1);
    }
  }
  const collabs = shuffle([...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([n]) => n)).slice(0, 3);
  const pools = [shuffle(own).slice(0, 4), ...(await Promise.all(collabs.map((n) => searchTracks(`artist:"${n}"`, 20).then((r) => shuffle(r).slice(0, 3)))))];
  if (pools.flat().length < 6) {
    const top = await api('/me/top/tracks', { query: { limit: 30, time_range: 'short_term' } }).catch(() => null);
    pools.push(shuffle(top?.items || []).slice(0, 5));
  }
  const seen = new Set();
  return shuffle(pools.flat().filter((t) => t?.uri && t.uri !== track.uri && !heard.has(t.uri) && !seen.has(t.uri) && seen.add(t.uri)));
}

async function check(track) {
  if (!track?.uri || busy || !store.get('autoplay', true)) return;
  if (player.state.repeat !== 'off') return;
  busy = true;
  try {
    await new Promise((r) => setTimeout(r, 1500));
    if (player.state.track?.uri !== track.uri) return;
    const q = await api('/me/player/queue').catch(() => null);
    const upcoming = (q?.queue || []).filter((t) => t?.uri && t.uri !== track.uri);
    if (upcoming.length >= 2 || lastSeed === track.uri) return;
    lastSeed = track.uri;
    const picks = (await candidates(track)).slice(0, 8);
    for (const t of picks) {
      heard.add(t.uri);
      await player.queue(t.uri, { silent: true }).catch(() => {});
    }
    if (picks.length) bus.emit('autoplay', picks.length);
  } finally {
    busy = false;
  }
}

bus.on('track', (t) => {
  if (t?.uri) heard.add(t.uri);
  check(t);
});
