import { invoke, sleep, bus } from './util.js';

let cached = null;

export async function getToken(force = false) {
  if (!force && cached && cached.expires_at * 1000 - Date.now() > 90000) return cached.token;
  try {
    cached = await invoke('get_token', { force });
  } catch (e) {
    if (String(e) === 'LOGIN' || String(e) === 'SCOPES') bus.emit('logged-out', String(e));
    throw new Error(String(e));
  }
  return cached.token;
}

// When Spotify says "too many requests", everyone waits until this time instead of retrying
// on their own (which only keeps the limit going). Background polls skip instead of waiting.
// Player control and page data cool down separately: with the Spotify-account logins pages
// come from the web player's API, and a busy player endpoint must not stall them.
const coolUntil = { player: 0, data: 0 };
const groupOf = (url) => (/\/me\/player(?!\/recently-played)/.test(url) ? 'player' : 'data');
// Short-lived cache for page data, so going back to a page is instant. Any change (PUT/POST/
// DELETE) clears it; the live player endpoints are never cached.
const CACHE_MS = 120000;
const cache = new Map();
const inflight = new Map();
const cacheable = (url) => !/\/me\/player/.test(url);

export async function api(path, { method = 'GET', body, query, background = false, fresh = false } = {}) {
  let url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  if (query) {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''));
    url += (url.includes('?') ? '&' : '?') + q;
  }
  if (method !== 'GET') cache.clear();
  else if (cacheable(url)) {
    const hit = cache.get(url);
    if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.data;
    if (inflight.has(url)) return inflight.get(url);
    const p = request(url, method, body, background).then((data) => {
      cache.set(url, { at: Date.now(), data });
      return data;
    });
    inflight.set(url, p);
    return p.finally(() => inflight.delete(url));
  }
  return request(url, method, body, background);
}

function quotaError(ms) {
  const h = Math.ceil(ms / 3600000);
  const when = ms > 3600000 ? `${h} hour${h > 1 ? 's' : ''}` : `${Math.ceil(ms / 60000)} minutes`;
  const e = new Error(`Spotify paused this login for about ${when} because it got too many requests. Log out in Settings and sign in again to get going right away.`);
  e.status = 429;
  e.quota = true;
  bus.emit('quota', e.message);
  return e;
}

async function request(url, method, body, background) {
  const group = groupOf(url);
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = coolUntil[group] - Date.now();
    if (wait > 60000) throw quotaError(wait);
    if (wait > 0) {
      if (background) throw new Error('rate limited');
      await sleep(wait);
    }
    let res;
    try {
      res = await invoke('spotify', { method, url, body: body !== undefined ? JSON.stringify(body) : null });
    } catch (e) {
      const msg = String(e);
      if (msg === 'LOGIN' || msg === 'SCOPES') bus.emit('logged-out', msg);
      if (attempt < 2 && !/LOGIN|SCOPES|bad url/.test(msg)) {
        await sleep(600);
        continue;
      }
      throw new Error(msg);
    }
    if (res.status === 429) {
      const secs = res.retry_after || 2;
      coolUntil[group] = Math.max(coolUntil[group], Date.now() + secs * 1000);
      // a long block (Spotify's daily quota, up to 24 h): stop asking and say so right away
      if (secs > 60) throw quotaError(secs * 1000);
      if (background) throw new Error('rate limited');
      continue;
    }
    let data = null;
    try {
      data = res.text ? JSON.parse(res.text) : null;
    } catch {}
    if (res.status >= 400) {
      const err = new Error(data?.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('Spotify is busy, try again');
}

export async function pages(path, { max = 2000, query, onPage } = {}) {
  let out = [];
  let next = path;
  let first = true;
  while (next && out.length < max) {
    const data = await api(next, first ? { query } : {});
    first = false;
    if (!data) break;
    const block = data.items ? data : data.tracks?.items ? data.tracks : data;
    const items = block?.items || [];
    out = out.concat(items);
    onPage?.(out, block);
    next = block?.next || null;
  }
  return out;
}

export function normTrack(t) {
  if (!t || !t.uri || t.is_local) return null;
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => ({ name: a.name, uri: a.uri, id: a.id })),
    album: t.album ? { name: t.album.name, uri: t.album.uri, id: t.album.id, images: t.album.images || [] } : null,
    duration: t.duration_ms || 0,
    explicit: !!t.explicit,
  };
}

let me = null;
export async function getMe() {
  if (!me) me = await api('/me');
  return me;
}

const likedCache = new Map();
export async function areLiked(uris) {
  const missing = uris.filter((u) => u && !likedCache.has(u));
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    try {
      const res = await api('/me/library/contains', { query: { uris: chunk.join(',') } });
      chunk.forEach((u, k) => likedCache.set(u, !!res?.[k]));
    } catch {
      const ids = chunk.map((u) => u.split(':').pop());
      try {
        const res = await api('/me/tracks/contains', { query: { ids: ids.join(',') } });
        chunk.forEach((u, k) => likedCache.set(u, !!res?.[k]));
      } catch {}
    }
  }
  return uris.map((u) => likedCache.get(u) || false);
}

export function markLiked(uri, on) {
  likedCache.set(uri, on);
}

export async function setLiked(uri, on) {
  const method = on ? 'PUT' : 'DELETE';
  try {
    await api('/me/library', { method, query: { uris: uri } });
  } catch {
    await api('/me/tracks', { method, query: { ids: uri.split(':').pop() } });
  }
  likedCache.set(uri, on);
  bus.emit('liked-changed', { uri, on });
}

export const inLibrary = areLiked;

export async function saveToLibrary(uri, on) {
  await api('/me/library', { method: on ? 'PUT' : 'DELETE', query: { uris: uri } });
  markLiked(uri, on);
  bus.emit('library-changed', { uri, on });
}

export async function createPlaylist(name, description = '') {
  return api('/me/playlists', { method: 'POST', body: { name, description, public: false } });
}

export async function updatePlaylist(id, fields) {
  return api(`/playlists/${id}`, { method: 'PUT', body: fields });
}

export async function addToPlaylist(id, uris) {
  return api(`/playlists/${id}/items`, { method: 'POST', body: { uris } });
}

export async function removeFromPlaylist(id, uris, snapshot) {
  const body = { items: uris.map((uri) => ({ uri })) };
  if (snapshot) body.snapshot_id = snapshot;
  return api(`/playlists/${id}/items`, { method: 'DELETE', body });
}
