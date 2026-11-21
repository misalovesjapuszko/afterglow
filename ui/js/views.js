import { api, pages, normTrack, getMe, areLiked, setLiked, inLibrary, saveToLibrary, createPlaylist, updatePlaylist, addToPlaylist, removeFromPlaylist } from './api.js';
import { player } from './player.js';
import { hydrateIcons, icons } from './icons.js';
import { $, $$, bus, dialog, esc, fmt, img, invoke, log, menu, slider, store, toast } from './util.js';

const main = $('#main');
export const library = { playlists: [], albums: null, artists: null, meId: null, filter: store.get('libFilter', 'playlists') };
export const pluginPages = new Map();
export const trackMenuItems = [];
// Extension points for optional modules: extra pages and playlist "…" menu items
export const extraRoutes = {};
export const playlistMenuItems = [];
export const onLeave = (fn) => cleanups.push(fn);
export const currentRoute = () => current?.route;
const historyStack = [];
let current = null;
let renderToken = 0;
let cleanups = [];

export function setTitle(t) {
  $('#topbar-title').textContent = t || '';
}

export function navigate(route, param = null, { push = true } = {}) {
  if (push && current) historyStack.push(current);
  current = { route, param };
  $('#back-btn').disabled = historyStack.length === 0;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === route));
  $$('#plugin-nav .nav-item').forEach((b) => b.classList.toggle('active', route === 'plugin' && b.dataset.page === param));
  render();
  bus.emit('page', { route, param });
}

export function refresh() {
  if (current) render();
}

export function back() {
  const prev = historyStack.pop();
  if (prev) navigate(prev.route, prev.param, { push: false });
}

function render() {
  cleanups.forEach((f) => f());
  cleanups = [];
  const token = ++renderToken;
  const old = $('#view');
  const fresh = old.cloneNode(false);
  old.replaceWith(fresh);
  fresh.id = 'view';
  main.scrollTop = 0;
  setTitle('');
  const ctx = { el: fresh, alive: () => token === renderToken };
  const { route, param } = current;
  const fn = { home, search, liked, playlist, album, artist, settings, plugin, library: libraryPage }[route] || extraRoutes[route] || home;
  Promise.resolve(fn(ctx, param)).catch((e) => {
    console.error(`page ${route} failed`, e);
    if (!ctx.alive()) return;
    fresh.innerHTML = `<div class="empty">Something went wrong.<br>${esc(e.message)}</div>`;
  });
}

const spinner = '<div class="spinner"></div>';

function owns(p) {
  return !!p && (p.owner?.id === library.meId || p.collaborative);
}

export function ownedPlaylists() {
  return library.playlists.filter(owns);
}

export async function newPlaylistFlow() {
  const v = await dialog({
    title: 'Create playlist',
    fields: [
      { key: 'name', label: 'Name', value: `My Playlist #${ownedPlaylists().length + 1}` },
      { key: 'description', label: 'Description', placeholder: 'Add an optional description', multiline: true },
    ],
    confirm: 'Create',
  });
  if (!v?.name) return null;
  try {
    const p = await createPlaylist(v.name, v.description);
    await loadPlaylists();
    toast(`Created ${v.name}`);
    return p;
  } catch (e) {
    toast('Could not create playlist: ' + e.message);
    return null;
  }
}

export async function editPlaylistFlow(p) {
  const v = await dialog({
    title: 'Edit details',
    fields: [
      { key: 'name', label: 'Name', value: p.name },
      { key: 'description', label: 'Description', value: p.description ? new DOMParser().parseFromString(p.description, 'text/html').body.textContent : '', multiline: true },
    ],
  });
  if (!v?.name) return;
  try {
    await updatePlaylist(p.id, { name: v.name, description: v.description });
    toast('Saved');
    await loadPlaylists();
    if (current?.route === 'playlist' && current.param === p.id) refresh();
  } catch (e) {
    toast('Could not save: ' + e.message);
  }
}

export async function deletePlaylistFlow(p) {
  const mine = owns(p);
  const ok = await dialog({
    title: mine ? 'Delete from Your Library?' : 'Remove from Your Library?',
    text: mine ? `This will delete ${p.name} from Your Library.` : `${p.name} will be removed from Your Library.`,
    confirm: mine ? 'Delete' : 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    await saveToLibrary(p.uri, false);
    toast(mine ? 'Playlist deleted' : 'Removed from Your Library');
    await loadPlaylists();
    if (current?.route === 'playlist' && current.param === p.id) navigate('home', null, { push: false });
  } catch (e) {
    toast('Could not delete: ' + e.message);
  }
}

async function addTo(p, uris) {
  try {
    await addToPlaylist(p.id, uris);
    toast(`Added to ${p.name}`);
    bus.emit('playlist-changed', p.id);
    if (current?.route === 'playlist' && current.param === p.id) refresh();
  } catch (e) {
    toast('Could not add: ' + e.message);
  }
}

export function addToPlaylistMenu(e, uris) {
  menu(e, [
    { label: '+  New playlist', onClick: async () => { const p = await newPlaylistFlow(); if (p) addTo(p, uris); } },
    '-',
    ...ownedPlaylists().map((p) => ({ label: p.name, onClick: () => addTo(p, uris) })),
  ]);
}

async function libraryToggle(uri, label) {
  const [saved] = await inLibrary([uri]);
  try {
    await saveToLibrary(uri, !saved);
    toast(saved ? `Removed from Your Library` : `Added to Your Library`);
    if (uri.includes(':playlist:')) return loadPlaylists();
    const kind = uri.includes(':artist:') ? 'artists' : 'albums';
    const id = uri.split(':').pop();
    if (saved && library[kind]) {
      library[kind] = library[kind].filter((x) => x.id !== id);
      if (library.filter === kind) renderLibrary();
    } else {
      api(`/${kind}/${id}`).then((obj) => {
        if (library[kind] && obj && !library[kind].some((x) => x.id === id)) {
          library[kind].unshift(obj);
          if (library.filter === kind) renderLibrary();
        }
      }).catch(() => {});
    }
  } catch (e) {
    toast('Could not update: ' + e.message);
  }
}
const playIcon = icons.play;

function artistsHTML(artists) {
  return (artists || []).map((a) => (a.id ? `<span class="link" data-artist="${esc(a.id)}">${esc(a.name)}</span>` : esc(a.name))).join(', ');
}

function card({ image, title, sub, round, route, param, play }) {
  return `<div class="card${round ? ' round' : ''}" data-route="${route}" data-param="${esc(param)}" ${play ? `data-play="${esc(play)}"` : ''}>
    <div class="cover-wrap">${image ? `<img loading="lazy" src="${esc(image)}" alt="">` : ''}${play ? `<button class="card-play" title="Play">${playIcon}</button>` : ''}</div>
    <div class="card-title">${esc(title)}</div>${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}</div>`;
}

function bindCards(root) {
  root.addEventListener('contextmenu', async (e) => {
    const c = e.target.closest('.card');
    if (!c || !c.dataset.play) return;
    e.preventDefault();
    const uri = c.dataset.play;
    const [saved] = await inLibrary([uri]);
    const isArtist = uri.includes(':artist:');
    const p = library.playlists.find((x) => x.uri === uri);
    menu(e, [
      { label: 'Play', onClick: () => player.playContext(uri) },
      { label: 'Open', onClick: () => navigate(c.dataset.route, c.dataset.param) },
      '-',
      p && owns(p) ? { label: 'Delete', onClick: () => deletePlaylistFlow(p) } : { label: isArtist ? (saved ? 'Unfollow' : 'Follow') : saved ? 'Remove from Your Library' : 'Add to Your Library', onClick: () => libraryToggle(uri) },
      { label: 'Copy link', onClick: () => navigator.clipboard.writeText(`https://open.spotify.com/${uri.split(':')[1]}/${uri.split(':').pop()}`).then(() => toast('Link copied')) },
    ]);
  });
  root.addEventListener('click', (e) => {
    const pb = e.target.closest('.card-play');
    const c = e.target.closest('.card');
    if (!c) return;
    if (pb) {
      e.stopPropagation();
      player.playContext(c.dataset.play);
      return;
    }
    navigate(c.dataset.route, c.dataset.param);
  });
}

function playlistCard(p) {
  return card({ image: img(p.images, 300), title: p.name, sub: p.owner?.display_name ? `By ${p.owner.display_name}` : 'Playlist', route: 'playlist', param: p.id, play: p.uri });
}
function albumCard(a) {
  return card({ image: img(a.images, 300), title: a.name, sub: `${(a.release_date || '').slice(0, 4)}${a.artists?.length ? ' · ' + a.artists.map((x) => x.name).join(', ') : ''}`, route: 'album', param: a.id, play: a.uri });
}
function artistCard(a) {
  return card({ image: img(a.images, 300), title: a.name, sub: 'Artist', round: true, route: 'artist', param: a.id, play: a.uri });
}

export function trackList(el, tracks, { onPlay, showAlbum = true, numbers = null, onRemove = null } = {}) {
  el.classList.add('tracks');
  el.classList.toggle('no-album', !showAlbum);
  el.innerHTML = `<div class="tracks-head"><div style="text-align:center">#</div><div>Title</div>${showAlbum ? '<div>Album</div>' : ''}<div></div><div class="r">${'<i data-icon="music" style="width:15px;height:15px"></i>'}</div></div><div class="rows"></div><div class="sentinel"></div>`;
  hydrateIcons(el);
  const rows = el.querySelector('.rows');
  let shown = 0;
  let query = '';
  let view = tracks.map((_, i) => i);
  const matches = (t) => !query || [t.name, ...(t.artists || []).map((a) => a.name), t.album?.name || ''].join(' ').toLowerCase().includes(query);
  const recompute = () => {
    view = [];
    tracks.forEach((t, i) => matches(t) && view.push(i));
  };
  const curUri = () => player.state.track?.uri;
  const rowHTML = (t, i) => {
    const playing = t.uri === curUri();
    return `<div class="track${playing ? ' playing' : ''}" data-i="${i}" data-uri="${esc(t.uri)}">
      <div class="num">${playing ? `<span class="n"><span class="eq${player.state.playing ? '' : ' paused'}"><span></span><span></span><span></span></span></span>` : `<span class="n">${numbers ? numbers[i] : i + 1}</span>`}<span class="play-hover">${playIcon}</span></div>
      <div class="t-main">${showAlbum ? `<img loading="lazy" src="${esc(img(t.album?.images, 64))}" alt="">` : ''}<div class="t-text"><div class="t-name">${t.explicit ? '<span class="explicit">E</span>' : ''}${esc(t.name)}</div><div class="t-artist">${artistsHTML(t.artists)}</div></div></div>
      ${showAlbum ? `<div class="t-album">${t.album?.id ? `<span class="link" data-album="${esc(t.album.id)}">${esc(t.album.name)}</span>` : esc(t.album?.name || '')}</div>` : ''}
      <button class="t-like" title="Like">${icons.heart}</button>
      <div class="t-dur r">${fmt(t.duration)}</div></div>`;
  };
  const more = () => {
    if (shown >= view.length) return;
    const idxs = view.slice(shown, shown + 120);
    rows.insertAdjacentHTML('beforeend', idxs.map((i) => rowHTML(tracks[i], i)).join(''));
    const from = shown;
    shown += idxs.length;
    areLiked(idxs.map((i) => tracks[i].uri)).then((res) => {
      res.forEach((on, k) => {
        const btn = rows.children[from + k]?.querySelector('.t-like');
        if (btn) {
          btn.classList.toggle('on', on);
          btn.innerHTML = on ? icons.heartFill : icons.heart;
        }
      });
    });
  };
  more();
  const io = new IntersectionObserver((ents) => ents.some((e) => e.isIntersecting) && more(), { root: main, rootMargin: '600px' });
  io.observe(el.querySelector('.sentinel'));
  rows.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.track');
    if (r && !e.target.closest('.link,.t-like')) onPlay?.(+r.dataset.i);
  });
  rows.addEventListener('click', (e) => {
    const r = e.target.closest('.track');
    if (!r) return;
    const t = tracks[+r.dataset.i];
    if (e.target.closest('[data-artist]')) return navigate('artist', e.target.closest('[data-artist]').dataset.artist);
    if (e.target.closest('[data-album]')) return navigate('album', e.target.closest('[data-album]').dataset.album);
    const like = e.target.closest('.t-like');
    if (like) {
      const on = !like.classList.contains('on');
      like.classList.toggle('on', on);
      like.innerHTML = on ? icons.heartFill : icons.heart;
      if (on) {
        like.classList.remove('pop');
        void like.offsetWidth;
        like.classList.add('pop');
      }
      setLiked(t.uri, on).catch((err) => toast('Could not update: ' + err.message));
      return;
    }
    if (e.target.closest('.play-hover')) return onPlay?.(+r.dataset.i);
    $$('.track.selected', rows).forEach((x) => x.classList.remove('selected'));
    r.classList.add('selected');
  });
  rows.addEventListener('contextmenu', async (e) => {
    const r = e.target.closest('.track');
    if (!r) return;
    e.preventDefault();
    const i = +r.dataset.i;
    const t = tracks[i];
    const [isLiked] = await areLiked([t.uri]);
    const setLike = (on) => {
      setLiked(t.uri, on).then(() => toast(on ? 'Added to Liked Songs' : 'Removed from Liked Songs')).catch((err) => toast(err.message));
      const btn = r.querySelector('.t-like');
      btn.classList.toggle('on', on);
      btn.innerHTML = on ? icons.heartFill : icons.heart;
    };
    menu(e, [
      { label: 'Play', onClick: () => onPlay?.(i) },
      { label: 'Add to queue', onClick: () => player.queue(t.uri).catch((err) => toast(err.message)) },
      '-',
      { label: 'Add to playlist…', onClick: () => addToPlaylistMenu(e, [t.uri]) },
      ...(onRemove ? [{ label: 'Remove from this playlist', onClick: () => onRemove(i, t) }] : []),
      { label: isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs', onClick: () => setLike(!isLiked) },
      '-',
      ...(t.album?.id ? [{ label: 'Go to album', onClick: () => navigate('album', t.album.id) }] : []),
      ...(t.artists?.[0]?.id ? [{ label: 'Go to artist', onClick: () => navigate('artist', t.artists[0].id) }] : []),
      { label: 'Copy song link', onClick: () => navigator.clipboard.writeText(`https://open.spotify.com/track/${t.id}`).then(() => toast('Link copied')) },
      '-',
      ...(trackMenuItems.length ? ['-'] : []),
      ...trackMenuItems.map((m) => ({ label: m.label, onClick: () => m.onClick(t) })),
    ]);
  });
  const sync = () => {
    $$('.track', rows).forEach((r) => {
      const playing = r.dataset.uri === curUri();
      if (playing === r.classList.contains('playing') && !playing) return;
      r.classList.toggle('playing', playing);
      const n = r.querySelector('.n');
      const i = +r.dataset.i;
      n.innerHTML = playing ? `<span class="eq${player.state.playing ? '' : ' paused'}"><span></span><span></span><span></span></span>` : String(numbers ? numbers[i] : i + 1);
    });
  };
  const off1 = bus.on('track', sync);
  const off2 = bus.on('state', () => $$('.track.playing .eq', rows).forEach((q) => q.classList.toggle('paused', !player.state.playing)));
  cleanups.push(() => {
    off1();
    off2();
    io.disconnect();
  });
  return {
    append(newTracks) {
      tracks = newTracks;
      recompute();
      if (shown < Math.min(120, view.length)) more();
      else if (query && !view.length) rows.innerHTML = `<div class="empty">No songs match “${esc(query)}”</div>`;
    },
    filter(q) {
      query = q.trim().toLowerCase();
      recompute();
      rows.innerHTML = '';
      shown = 0;
      if (!view.length) rows.innerHTML = `<div class="empty">No songs match “${esc(query)}”</div>`;
      else more();
      main.scrollTop = Math.min(main.scrollTop, el.offsetTop - 80);
    },
  };
}

function filterBox(getList, placeholder) {
  const box = document.createElement('label');
  box.className = 'track-filter';
  box.innerHTML = `<i>${icons.search}</i><input placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">`;
  const input = box.querySelector('input');
  let t = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => getList()?.filter(input.value), 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      getList()?.filter('');
    }
  });
  return box;
}

function hero({ image, round, liked: isLiked, type, title, desc, meta }) {
  return `<div class="hero">${isLiked ? `<div class="hero-cover liked">${icons.heartFill}</div>` : `<img class="hero-cover${round ? ' round' : ''}" src="${esc(image || '')}" alt="">`}
    <div class="hero-info"><div class="hero-type">${esc(type)}</div><div class="hero-title">${esc(title)}</div>${desc ? `<div class="hero-desc">${desc}</div>` : ''}<div class="hero-meta">${meta || ''}</div></div></div>`;
}

function actions({ onPlay, onShuffle }) {
  const div = document.createElement('div');
  div.className = 'actions';
  div.innerHTML = `<button class="big-play" title="Play">${playIcon}</button>${onShuffle ? `<button class="pill-btn"><i data-icon="shuffle"></i>Shuffle</button>` : ''}`;
  hydrateIcons(div);
  div.querySelector('.big-play').onclick = onPlay;
  if (onShuffle) div.querySelector('.pill-btn').onclick = onShuffle;
  return div;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

async function home({ el, alive }) {
  const me = await getMe().catch(() => null);
  el.innerHTML = `<h1 class="page-title">${greeting()}${me?.display_name ? ', ' + esc(me.display_name.split(' ')[0]) : ''}</h1>
    <div id="h-recent"></div><div id="h-lists"></div><div id="h-top"></div>`;
  const [recent, top] = await Promise.all([
    api('/me/player/recently-played', { query: { limit: 40 } }).catch(() => null),
    api('/me/top/tracks', { query: { limit: 10, time_range: 'short_term' } }).catch(() => null),
  ]);
  if (!alive()) return;
  const seen = new Set();
  const albums = [];
  for (const it of recent?.items || []) {
    const a = it.track?.album;
    if (a && !seen.has(a.id)) {
      seen.add(a.id);
      albums.push(a);
    }
  }
  if (albums.length) {
    const sec = $('#h-recent', el);
    sec.innerHTML = `<h2 class="section-title">Jump back in</h2><div class="grid">${albums.slice(0, 12).map(albumCard).join('')}</div>`;
    bindCards(sec);
  }
  if (library.playlists.length) {
    const sec = $('#h-lists', el);
    sec.innerHTML = `<h2 class="section-title">Your playlists</h2><div class="grid">${library.playlists.slice(0, 12).map(playlistCard).join('')}</div>`;
    bindCards(sec);
  }
  const topTracks = (top?.items || []).map(normTrack).filter(Boolean);
  if (topTracks.length) {
    const sec = $('#h-top', el);
    sec.innerHTML = `<h2 class="section-title">On repeat lately</h2><div></div>`;
    trackList(sec.lastElementChild, topTracks, { onPlay: (i) => player.playTracks(topTracks, i) });
  }
  if (!albums.length && !library.playlists.length && !topTracks.length) el.insertAdjacentHTML('beforeend', '<div class="empty">Play something and it will show up here.</div>');
}

async function search({ el, alive }) {
  el.innerHTML = `<h1 class="page-title">Search</h1><div class="search-box"><i data-icon="search"></i><input id="q" placeholder="Songs, artists, albums, playlists" autocomplete="off" spellcheck="false"></div><div id="results"></div>`;
  hydrateIcons(el);
  const input = $('#q', el);
  const out = $('#results', el);
  input.value = store.get('lastSearch', '');
  let timer = 0;
  let seq = 0;
  const run = async () => {
    const q = input.value.trim();
    store.set('lastSearch', q);
    if (!q) {
      out.innerHTML = '<div class="empty">Find your next favourite song.</div>';
      return;
    }
    const my = ++seq;
    out.innerHTML = spinner;
    const data = await api('/search', { query: { q, type: 'track,artist,album,playlist', limit: 10 } }).catch((e) => ({ error: e }));
    if (my !== seq || !alive()) return;
    if (data.error) {
      out.innerHTML = `<div class="empty">${esc(data.error.message)}</div>`;
      return;
    }
    const tracks = (data.tracks?.items || []).map(normTrack).filter(Boolean);
    const artists = (data.artists?.items || []).filter(Boolean);
    const albums = (data.albums?.items || []).filter(Boolean);
    const lists = (data.playlists?.items || []).filter(Boolean);
    if (!tracks.length && !artists.length && !albums.length && !lists.length) {
      out.innerHTML = '<div class="empty">No results.</div>';
      return;
    }
    const top = artists[0] && artists[0].name.toLowerCase() === q.toLowerCase() ? { kind: 'artist', a: artists[0] } : tracks[0] ? { kind: 'track', t: tracks[0] } : null;
    out.innerHTML = `<div class="split"><div><h2 class="section-title">Top result</h2><div id="top"></div></div><div><h2 class="section-title">Songs</h2><div id="songs"></div></div></div>
      ${artists.length ? `<h2 class="section-title">Artists</h2><div class="grid" data-cards>${artists.map(artistCard).join('')}</div>` : ''}
      ${albums.length ? `<h2 class="section-title">Albums</h2><div class="grid" data-cards>${albums.map(albumCard).join('')}</div>` : ''}
      ${lists.length ? `<h2 class="section-title">Playlists</h2><div class="grid" data-cards>${lists.map(playlistCard).join('')}</div>` : ''}`;
    $$('[data-cards]', out).forEach(bindCards);
    const topEl = $('#top', out);
    if (top?.kind === 'artist') {
      topEl.innerHTML = `<div class="top-result"><img src="${esc(img(top.a.images, 300))}" style="border-radius:50%" alt=""><div><div class="tr-name">${esc(top.a.name)}</div><div class="hero-type" style="margin-top:6px">Artist</div></div></div>`;
      topEl.firstElementChild.onclick = () => navigate('artist', top.a.id);
    } else if (top) {
      topEl.innerHTML = `<div class="top-result"><img src="${esc(img(top.t.album?.images, 300))}" alt=""><div><div class="tr-name">${esc(top.t.name)}</div><div class="hero-meta" style="margin-top:6px">Song · ${artistsHTML(top.t.artists)}</div></div></div>`;
      topEl.firstElementChild.onclick = (e) => (e.target.closest('[data-artist]') ? navigate('artist', e.target.closest('[data-artist]').dataset.artist) : player.playTracks(tracks, 0));
    }
    trackList($('#songs', out), tracks.slice(0, 5), { onPlay: (i) => player.playTracks(tracks, i), showAlbum: false });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 380);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (clearTimeout(timer), run()));
  setTimeout(() => input.focus(), 50);
  run();
}

async function liked({ el, alive }) {
  const me = await getMe().catch(() => null);
  el.innerHTML = hero({ liked: true, type: 'Playlist', title: 'Liked Songs', meta: `<b>${esc(me?.display_name || '')}</b> · <span id="lk-count">…</span>` }) + '<div id="lk-actions"></div><div id="lk-list">' + spinner + '</div>';
  setTitle('Liked Songs');
  let tracks = [];
  let list = null;
  const play = (i) => player.playTracks(tracks, i);
  const lkAct = actions({ onPlay: () => play(0), onShuffle: async () => { await player.setShuffle(true); play(Math.floor(Math.random() * tracks.length)); } });
  lkAct.appendChild(filterBox(() => list, 'Search in Liked Songs'));
  $('#lk-actions', el).appendChild(lkAct);
  await pages('/me/tracks', {
    query: { limit: 50 },
    max: 5000,
    onPage: (items, block) => {
      if (!alive()) return;
      tracks = items.map((x) => normTrack(x.track || x.item)).filter(Boolean);
      $('#lk-count', el).textContent = `${block?.total ?? tracks.length} songs`;
      if (!list) {
        log('liked shown', tracks.length);
        $('#lk-list', el).innerHTML = '';
        list = trackList($('#lk-list', el), tracks, { onPlay: play });
      } else list.append(tracks);
    },
  });
  if (alive() && !tracks.length) $('#lk-list', el).innerHTML = '<div class="empty">Songs you like will appear here.</div>';
}

async function playlist({ el, alive }, id) {
  log('open playlist', id);
  el.innerHTML = spinner;
  const [p, me] = await Promise.all([api(`/playlists/${id}`).catch((e) => (console.warn('playlist', id, e), null)), getMe().catch(() => null)]);
  if (!alive()) return;
  if (!p) {
    el.innerHTML = `<div class="empty">Spotify couldn't open this playlist right now.<br><button class="pill-btn" style="margin-top:16px" id="pl-retry">Try again</button></div>`;
    $('#pl-retry', el).onclick = () => refresh();
    return;
  }
  library.meId = library.meId || me?.id;
  const mine = owns(p);
  const block = p.items || p.tracks;
  const total = block?.total;
  const owner = p.owner?.display_name || '';
  const desc = p.description ? esc(new DOMParser().parseFromString(p.description, 'text/html').body.textContent) : '';
  el.innerHTML = hero({ image: img(p.images, 640), type: p.public === false ? 'Private playlist' : 'Playlist', title: p.name, desc, meta: `<b>${esc(owner)}</b>${total != null ? ` · ${total} songs` : ''}` }) + '<div id="pl-actions"></div><div id="pl-list"></div>';
  setTitle(p.name);
  if (mine) {
    const t = el.querySelector('.hero-title');
    t.classList.add('link');
    t.title = 'Edit details';
    t.onclick = () => editPlaylistFlow(p);
  }
  const act = actions({ onPlay: () => player.playContext(p.uri), onShuffle: async () => { await player.setShuffle(true); player.playContext(p.uri); } });
  if (!mine) {
    const [saved] = await inLibrary([p.uri]);
    const heart = document.createElement('button');
    heart.className = 'icon-pill' + (saved ? ' on' : '');
    heart.title = saved ? 'Remove from Your Library' : 'Save to Your Library';
    heart.innerHTML = `<i>${saved ? icons.heartFill : icons.heart}</i>`;
    heart.onclick = () => libraryToggle(p.uri).then(() => refresh());
    act.appendChild(heart);
  }
  const more = document.createElement('button');
  more.className = 'icon-pill';
  more.title = 'More';
  more.innerHTML = `<i>${icons.more}</i>`;
  more.onclick = (e) => menu(e, [
    ...(mine ? [{ label: 'Edit details', onClick: () => editPlaylistFlow(p) }] : []),
    { label: mine ? 'Delete' : 'Remove from Your Library', onClick: () => deletePlaylistFlow(p) },
    { label: 'Add to queue', onClick: async () => { for (const t of tracks.slice(0, 50)) await player.queue(t.uri).catch(() => {}); } },
    '-',
    ...playlistMenuItems.map((m) => ({ label: m.label, onClick: () => m.onClick(tracks, p) })),
    '-',
    { label: 'Copy link', onClick: () => navigator.clipboard.writeText(`https://open.spotify.com/playlist/${p.id}`).then(() => toast('Link copied')) },
  ]);
  act.appendChild(more);
  let listRef = null;
  act.appendChild(filterBox(() => listRef, 'Search in playlist'));
  $('#pl-actions', el).appendChild(act);
  let tracks = [];
  const listEl = $('#pl-list', el);
  const onPlay = (i) => player.playContext(p.uri, null, tracks[i].uri);
  let snapshot = p.snapshot_id;
  const onRemove = mine
    ? async (i, t) => {
        try {
          const res = await removeFromPlaylist(p.id, [t.uri], snapshot);
          snapshot = res?.snapshot_id || snapshot;
          toast(`Removed from ${p.name}`);
          refresh();
        } catch (e) {
          toast('Could not remove: ' + e.message);
        }
      }
    : null;
  if (!Array.isArray(block?.items)) {
    listEl.innerHTML = spinner;
    try {
      log('playlist_full', id);
      let full = await invoke('playlist_full', { id });
      log('playlist_full got', full.length);
      if (!full.length && total) {
        // the private loader sometimes comes back empty on the first try
        await new Promise((r) => setTimeout(r, 800));
        full = await invoke('playlist_full', { id }).catch(() => []);
        log('playlist_full retry got', full.length);
      }
      if (!alive()) return;
      tracks = full.map(normTrack).filter(Boolean);
      listEl.innerHTML = '';
      if (!tracks.length && total) listEl.innerHTML = `<div class="notice">Spotify didn't send the song list for this playlist (${total} songs). Press play to listen anyway.<div style="margin-top:14px"><button class="pill-btn" id="pl-retry2">Try again</button></div></div>`;
      else if (!tracks.length) listEl.innerHTML = '<div class="empty">This playlist is empty.</div>';
      else listRef = trackList(listEl, tracks, { onPlay, onRemove });
      $('#pl-retry2', el)?.addEventListener('click', () => refresh());
      if (total == null && tracks.length) el.querySelector('.hero-meta').insertAdjacentHTML('beforeend', ` · ${tracks.length} songs`);
    } catch (e) {
      console.warn('playlist_full failed', String(e));
      if (!alive()) return;
      if (String(e).includes('LR_LOGIN')) {
        listEl.innerHTML = `<div class="notice">Spotify hides songs of playlists you don't own from personal apps. Afterglow can still show them with one extra Spotify login.<div style="margin-top:14px"><button class="pill-btn accent" id="pl-unlock">Show songs</button></div></div>`;
        $('#pl-unlock', el).onclick = async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = 'Finish in your browser…';
          try {
            await invoke('login_extra');
            refresh();
          } catch (err) {
            ev.target.disabled = false;
            ev.target.textContent = 'Show songs';
            toast(String(err));
          }
        };
      } else {
        listEl.innerHTML = `<div class="notice">Couldn't load the songs (${esc(String(e))}). Press play to listen anyway.</div>`;
      }
    }
    return;
  }
  const take = (items) => items.map((x) => normTrack(x.item || x.track)).filter(Boolean);
  tracks = take(block.items);
  if (!tracks.length && !block.next) {
    listEl.innerHTML = `<div class="empty">This playlist is empty.<br>Right-click any song and choose <b>Add to playlist</b>.</div>`;
    return;
  }
  const list = trackList(listEl, tracks, { onPlay, onRemove });
  listRef = list;
  log('playlist shown', id, tracks.length);
  let next = block.next;
  let all = block.items;
  while (next && alive() && all.length < 10000) {
    const page = await api(next);
    all = all.concat(page.items || []);
    tracks = take(all);
    list.append(tracks);
    next = page.next;
  }
}

async function album({ el, alive }, id) {
  el.innerHTML = spinner;
  const a = await api(`/albums/${id}`);
  if (!alive()) return;
  const info = { name: a.name, uri: a.uri, id: a.id, images: a.images };
  const tracks = (a.tracks?.items || []).map((t) => normTrack({ ...t, album: info })).filter(Boolean);
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  el.innerHTML = hero({ image: img(a.images, 640), type: a.album_type === 'single' ? 'Single' : 'Album', title: a.name, meta: `${artistsHTML(a.artists)} · ${(a.release_date || '').slice(0, 4)} · ${tracks.length} songs, ${Math.round(total / 60000)} min` }) + '<div id="al-actions"></div><div id="al-list"></div>';
  el.querySelector('.hero-meta').addEventListener('click', (e) => e.target.closest('[data-artist]') && navigate('artist', e.target.closest('[data-artist]').dataset.artist));
  setTitle(a.name);
  const act = actions({ onPlay: () => player.playContext(a.uri) });
  const [saved] = await inLibrary([a.uri]);
  const heart = document.createElement('button');
  heart.className = 'icon-pill' + (saved ? ' on' : '');
  heart.title = saved ? 'Remove from Your Library' : 'Save to Your Library';
  heart.innerHTML = `<i>${saved ? icons.heartFill : icons.heart}</i>`;
  heart.onclick = () => libraryToggle(a.uri).then(() => refresh());
  act.appendChild(heart);
  $('#al-actions', el).appendChild(act);
  trackList($('#al-list', el), tracks, { onPlay: (i) => player.playContext(a.uri, i), showAlbum: false, numbers: (a.tracks?.items || []).map((t) => t.track_number) });
}

async function artist({ el, alive }, id) {
  el.innerHTML = spinner;
  const a = await api(`/artists/${id}`);
  if (!alive()) return;
  el.innerHTML = hero({ image: img(a.images, 640), round: true, type: 'Artist', title: a.name, meta: '' }) + '<div id="ar-actions"></div><div id="ar-popular"></div><div id="ar-albums"></div><div id="ar-singles"></div>';
  setTitle(a.name);
  const act = actions({ onPlay: () => player.playContext(a.uri) });
  const [following] = await inLibrary([a.uri]);
  const fb = document.createElement('button');
  fb.className = 'pill-btn';
  fb.textContent = following ? 'Following' : 'Follow';
  fb.onclick = () => libraryToggle(a.uri).then(() => refresh());
  act.appendChild(fb);
  $('#ar-actions', el).appendChild(act);
  const popular = (async () => {
    const res = await Promise.all([0, 10].map((offset) => api('/search', { query: { q: `artist:"${a.name}"`, type: 'track', limit: 10, offset } }).catch(() => null)));
    const seen = new Set();
    return res
      .flatMap((r) => r?.tracks?.items || [])
      .filter((t) => t?.artists?.some((x) => x.id === id) && !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()))
      .map(normTrack)
      .filter(Boolean)
      .slice(0, 10);
  })();
  const albumsOf = (group) => pages(`/artists/${id}/albums`, { query: { include_groups: group, limit: 10 }, max: 60 }).catch(() => []);
  popular.then((tracks) => {
    if (!alive() || !tracks.length) return;
    const sec = $('#ar-popular', el);
    sec.innerHTML = `<h2 class="section-title">Popular</h2><div></div>`;
    trackList(sec.lastElementChild, tracks, { onPlay: (i) => player.playTracks(tracks, i) });
  });
  const [full, singles] = await Promise.all([albumsOf('album'), albumsOf('single')]);
  if (!alive()) return;
  if (full.length) {
    const s2 = $('#ar-albums', el);
    s2.innerHTML = `<h2 class="section-title">Albums</h2><div class="grid">${full.map(albumCard).join('')}</div>`;
    bindCards(s2);
  }
  if (singles.length) {
    const s3 = $('#ar-singles', el);
    s3.innerHTML = `<h2 class="section-title">Singles &amp; EPs</h2><div class="grid">${singles.map(albumCard).join('')}</div>`;
    bindCards(s3);
  }
  if (!full.length && !singles.length && !(await popular).length) el.insertAdjacentHTML('beforeend', '<div class="empty">Spotify didn\'t send anything for this artist.</div>');
}

function sw(on) {
  return `<button class="switch${on ? ' on' : ''}"></button>`;
}

async function settings({ el }) {
  setTitle('Settings');
  const cfg = await invoke('get_config');
  const os = await invoke('platform');
  const me = await getMe().catch(() => null);
  const plugins = await invoke('list_plugins');
  const disabled = new Set(cfg.disabled_plugins || []);
  const engineNames = { web: 'Spotify Web Player', soloist: 'Spotify Soloist', remote: 'Remote control', none: 'Starting…' };
  el.innerHTML = `<h1 class="page-title">Settings</h1><div class="settings">
    <div class="set-group"><h3>Account</h3>
      <div class="set-row"><div><div class="set-label">${esc(me?.display_name || 'Spotify')}</div><div class="set-desc">Client ID ${esc(cfg.client_id || '')}</div></div><button class="pill-btn" id="s-logout">Log out</button></div>
    </div>
    <div class="set-group"><h3>Playback</h3>
      <div class="set-row"><div><div class="set-label">Engine</div><div class="set-desc">Auto picks the Spotify web player when this system supports it${os === 'linux' ? ', then Soloist' : ''}, else it remote-controls your other Spotify devices.</div></div>
        <span class="badge ok">${engineNames[player.kind] || player.kind}</span></div>
      <div class="set-row"><div class="set-label">Preferred engine</div>
        <select class="field" id="s-engine" style="width:220px;height:40px;margin:0">
          ${['auto', 'web', ...(os === 'linux' ? ['soloist'] : []), 'remote'].map((m) => `<option value="${m}" ${(cfg.engine || 'auto') === m ? 'selected' : ''}>${{ auto: 'Automatic', web: 'Web player', soloist: 'Soloist', remote: 'Remote control' }[m]}</option>`).join('')}
        </select></div>
      <div class="set-row" id="s-autoplay-row"><div><div class="set-label">Autoplay</div><div class="set-desc">When your music ends, keep playing similar songs.</div></div>${sw(store.get('autoplay', true))}</div>
      ${os === 'linux' ? `<div class="set-row"><div><div class="set-label">Soloist API key</div><div class="set-desc">${cfg.has_soloist_key ? 'Saved.' : 'Needed on Linux. Get it from the Spotify developer dashboard → Soloist API Key.'}</div></div><input class="field" id="s-soloist" type="password" placeholder="${cfg.has_soloist_key ? '••••••••' : 'spak_…'}"></div>` : ''}
    </div>
    <div class="set-group"><h3>Window</h3>
      <div class="set-row" id="s-tray-row"><div><div class="set-label">Keep playing when closed</div><div class="set-desc">Closing the window hides Afterglow to the system tray. Music, media keys and the tray menu keep working.</div></div>${sw(cfg.close_to_tray !== false)}</div>
      <div class="set-row"><div><div class="set-label">Quit Afterglow</div><div class="set-desc">Stop the music and close Afterglow completely.</div></div><button class="pill-btn" id="s-quit">Quit</button></div>
    </div>
    <div class="set-group"><h3>Appearance</h3>
      <div class="set-row"><div><div class="set-label">Colors from album art</div><div class="set-desc">Tint the app with the current cover's color.</div></div>${sw(store.get('accentFromArt', true))}</div>
      <div class="set-row" data-k="animatedBg"><div><div class="set-label">Moving background</div><div class="set-desc">Animated album-art glow behind the lyrics. Turn off to save battery.</div></div>${sw(store.get('animatedBg', true))}</div>
      <div class="set-row" data-k="lyricBlur"><div><div class="set-label">Blur distant lyrics</div><div class="set-desc">Apple Music style focus on the current line.</div></div>${sw(store.get('lyricBlur', true))}</div>
      <div class="set-row"><div><div class="set-label">Lyrics style</div><div class="set-desc">Automatic fills word by word when the song has word timings, otherwise lights up whole lines (like Apple Music). Word by word guesses timings for every song.</div></div>
        <select class="field" id="s-lstyle" style="width:220px;height:40px;margin:0">
          ${[['auto', 'Automatic'], ['word', 'Word by word'], ['line', 'Line by line'], ['static', 'Static']].map(([k, v]) => `<option value="${k}" ${store.get('lyricStyle', 'auto') === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      <div class="set-row"><div><div class="set-label">Lyrics background</div><div class="set-desc">Blurred album art, Apple Music style flowing colors from the cover, or one calm color.</div></div>
        <select class="field" id="s-lbg" style="width:220px;height:40px;margin:0">
          ${[['cover', 'Album art'], ['colors', 'Moving colors'], ['solid', 'Solid']].map(([k, v]) => `<option value="${k}" ${store.get('lyricsBg', 'cover') === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      <div class="set-row" id="s-anim-row"><div><div class="set-label">Animations</div><div class="set-desc">Smooth entrances, hover effects and transitions everywhere.</div></div>${sw(store.get('animations', true))}</div>
      <div class="set-row" id="s-pct-row"><div><div class="set-label">Show slider values</div><div class="set-desc">Show the percentage next to the volume and size sliders.</div></div>${sw(store.get('sliderValues', false))}</div>
      <div class="set-row"><div class="set-label">Lyrics size</div><div style="display:flex;align-items:center;gap:10px"><div class="slider volume" id="s-lsize" style="width:200px"><div class="slider-fill"></div><div class="slider-knob"></div></div><span class="slider-pct" id="s-lsize-pct"></span></div></div>
      <div class="set-row"><div><div class="set-label">Sound ring sensitivity</div><div class="set-desc">How strongly the ring around the cover reacts to the music. Turn it up for quiet songs or low volume.</div></div><div style="display:flex;align-items:center;gap:10px"><div class="slider volume" id="s-vsens" style="width:200px"><div class="slider-fill"></div><div class="slider-knob"></div></div><span class="slider-pct" id="s-vsens-pct"></span></div></div>
    </div>
    <div class="set-group" id="s-themes"><h3>Themes</h3><div class="theme-grid" id="theme-grid"></div></div>
    <div class="set-group"><h3>Plugins</h3>
      ${[...plugins.scripts, ...plugins.styles.filter((x) => !x.name.startsWith('theme-'))].map((p) => `<div class="set-row" data-plugin="${esc(p.name)}"><div><div class="set-label">${esc(p.name)}</div><div class="set-desc">${p.name.endsWith('.css') ? 'Theme' : 'Script'}${window.__afterglowErrors?.[p.name] ? ' · <span style="color:#ff6b81">' + esc(window.__afterglowErrors[p.name]) + '</span>' : ''}</div></div>${sw(!disabled.has(p.name))}</div>`).join('') || '<div class="set-row"><div class="set-desc">No plugins yet. Drop .js or .css files into the plugins folder.</div></div>'}
      <div class="set-row"><div class="set-desc">${esc(plugins.dir)}</div><div style="display:flex;gap:8px"><button class="pill-btn" id="s-folder"><i data-icon="folder"></i>Open folder</button><button class="pill-btn" id="s-reload"><i data-icon="refresh"></i>Reload</button></div></div>
    </div>
    <div class="set-group"><h3>About</h3><div class="set-row"><div><div class="set-label">Afterglow 0.2</div><div class="set-desc">Lyrics from Spotify (Musixmatch) and LRCLIB. Music and data from Spotify.</div></div></div></div>
  </div>`;
  hydrateIcons(el);
  const rows = $$('.set-group', el);
  $('#s-logout', el).onclick = async () => {
    await invoke('logout');
    location.reload();
  };
  $('#s-engine', el).onchange = async (e) => {
    await invoke('set_config', { key: 'engine', value: e.target.value });
    toast('Restarting player…');
    setTimeout(() => location.reload(), 600);
  };
  const sk = $('#s-soloist', el);
  if (sk) sk.onchange = async () => {
    if (!sk.value.trim()) return;
    await invoke('set_config', { key: 'soloist_key', value: sk.value.trim() });
    toast('Key saved, restarting player…');
    setTimeout(() => location.reload(), 600);
  };
  const apBtn = $('#s-autoplay-row .switch', el);
  apBtn.onclick = () => {
    const on = !apBtn.classList.contains('on');
    apBtn.classList.toggle('on', on);
    store.set('autoplay', on);
  };
  const trayBtn = $('#s-tray-row .switch', el);
  trayBtn.onclick = async () => {
    const on = !trayBtn.classList.contains('on');
    trayBtn.classList.toggle('on', on);
    await invoke('set_config', { key: 'close_to_tray', value: on });
  };
  $('#s-quit', el).onclick = () => invoke('quit_app');
  const appearance = rows[3];
  const toggles = $$('.set-row', appearance);
  const bindToggle = (row, key, apply) => {
    const b = row.querySelector('.switch');
    b.onclick = () => {
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      store.set(key, on);
      apply?.(on);
    };
  };
  bindToggle(toggles[0], 'accentFromArt', () => bus.emit('track', player.state.track));
  bindToggle(toggles[1], 'animatedBg', (on) => document.body.classList.toggle('still', !on));
  bindToggle(toggles[2], 'lyricBlur', (on) => import('./np.js').then((m) => m.setLyricBlur(on)));
  $('#s-lstyle', el).onchange = (e) => import('./np.js').then((m) => m.setLyricStyle(e.target.value));
  $('#s-lbg', el).onchange = (e) => import('./np.js').then((m) => m.setLyricsBg(e.target.value));
  const animBtn = $('#s-anim-row .switch', el);
  animBtn.onclick = () => {
    const on = !animBtn.classList.contains('on');
    animBtn.classList.toggle('on', on);
    store.set('animations', on);
    document.body.classList.toggle('no-anim', !on);
  };
  const pctBtn = $('#s-pct-row .switch', el);
  pctBtn.onclick = () => {
    const on = !pctBtn.classList.contains('on');
    pctBtn.classList.toggle('on', on);
    store.set('sliderValues', on);
    document.body.classList.toggle('slider-values', on);
  };
  const { themes, themeInfo, applyTheme } = await import('./plugins.js');
  const grid = $('#theme-grid', el);
  const renderThemes = () => {
    const infos = [
      { file: null, name: 'Default', bg: '#0b0b10', elev: '#15151c', accent: '#fa2d48', sidebar: 'rgba(18,18,24,.72)' },
      { file: '@album', name: 'Album', album: true, bg: 'linear-gradient(135deg,#3b1d5e,#7a2848 50%,#1d4a6b)', elev: 'rgba(255,255,255,.18)', accent: '#ffb14f', sidebar: 'rgba(0,0,0,.35)' },
      ...themes.list.map(themeInfo),
    ];
    grid.innerHTML = infos
      .map((t) => `<button class="theme-card${(themes.active || null) === t.file ? ' on' : ''}" data-file="${esc(t.file || '')}">
        <div class="tc-preview" style="background:${esc(t.bg)}"><div class="tc-side" style="background:${esc(t.sidebar)}"></div><div class="tc-main"><div class="tc-line" style="background:${esc(t.elev)}"></div><div class="tc-line short" style="background:${esc(t.elev)}"></div><div class="tc-dot" style="background:${esc(t.accent)}"></div></div></div>
        <div class="tc-name">${esc(t.name)}${t.album ? ' <span class="tc-tag">changes with the song</span>' : ''}</div></button>`)
      .join('');
  };
  renderThemes();
  grid.onclick = (e) => {
    const c = e.target.closest('.theme-card');
    if (!c) return;
    applyTheme(c.dataset.file || null);
    renderThemes();
  };
  const sizeEl = $('#s-lsize', el);
  const sz = slider(sizeEl, {
    onInput: (v) => {
      const px = Math.round(26 + v * 30);
      document.documentElement.style.setProperty('--lyric-size', px + 'px');
      store.set('lyricSize', px);
      $('#s-lsize-pct', el).textContent = Math.round((px / 38) * 100) + '%';
    },
  });
  sz.set((store.get('lyricSize', 38) - 26) / 30);
  $('#s-lsize-pct', el).textContent = Math.round((store.get('lyricSize', 38) / 38) * 100) + '%';
  // 0..1 slider -> x0.25..x4 gain on the ring (0.5 = x1)
  const sensPct = (v) => Math.round(2 ** ((v - 0.5) * 4) * 100) + '%';
  const vs = slider($('#s-vsens', el), {
    onInput: (v) => {
      store.set('vizSensitivity', v);
      $('#s-vsens-pct', el).textContent = sensPct(v);
    },
  });
  vs.set(store.get('vizSensitivity', 0.5));
  $('#s-vsens-pct', el).textContent = sensPct(store.get('vizSensitivity', 0.5));
  $$('[data-plugin]', el).forEach((row) => {
    const b = row.querySelector('.switch');
    b.onclick = async () => {
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      on ? disabled.delete(row.dataset.plugin) : disabled.add(row.dataset.plugin);
      await invoke('set_config', { key: 'disabled_plugins', value: [...disabled] });
      toast('Reload to apply');
    };
  });
  $('#s-folder', el).onclick = () => invoke('open_plugins_dir');
  $('#s-reload', el).onclick = () => location.reload();
}

async function plugin({ el }, id) {
  const page = pluginPages.get(id);
  if (!page) {
    el.innerHTML = '<div class="empty">Plugin page not found.</div>';
    return;
  }
  setTitle(page.title || '');
  await page.render(el);
}

function navItemHTML({ id, kind, image, name, sub, round }) {
  return `<button class="pl-nav-item${round ? ' round' : ''}" data-kind="${kind}" data-id="${esc(id)}" title="${esc(name)}">${image ? `<img loading="lazy" src="${esc(image)}" alt="">` : '<div class="ph"></div>'}<div class="pl-nav-text"><span>${esc(name)}</span><span class="pl-nav-sub">${esc(sub)}</span></div></button>`;
}

function renderLibrary() {
  const nav = $('#playlist-nav');
  $$('#lib-chips .chip').forEach((c) => c.classList.toggle('on', c.dataset.f === library.filter));
  const f = library.filter;
  if (f === 'playlists') {
    nav.innerHTML = library.playlists.map((p) => navItemHTML({ id: p.id, kind: 'playlist', image: img(p.images, 64), name: p.name, sub: `Playlist · ${p.owner?.display_name || ''}` })).join('') || '<div class="empty" style="padding:20px 8px">No playlists yet</div>';
  } else if (f === 'albums') {
    if (!library.albums) return reloadLibrarySection('albums');
    nav.innerHTML = library.albums.map((a) => navItemHTML({ id: a.id, kind: 'album', image: img(a.images, 64), name: a.name, sub: `Album · ${a.artists?.[0]?.name || ''}` })).join('') || '<div class="empty" style="padding:20px 8px">No saved albums</div>';
  } else {
    if (!library.artists) return reloadLibrarySection('artists');
    nav.innerHTML = library.artists.map((a) => navItemHTML({ id: a.id, kind: 'artist', image: img(a.images, 64), name: a.name, sub: 'Artist', round: true })).join('') || '<div class="empty" style="padding:20px 8px">Not following anyone</div>';
  }
  $$('.pl-nav-item', nav).forEach((b) => b.classList.toggle('active', current?.route === b.dataset.kind && current?.param === b.dataset.id));
}

export async function reloadLibrarySection(kind) {
  if (kind === 'albums') {
    const items = await pages('/me/albums', { query: { limit: 50 }, max: 500 }).catch((e) => (console.warn('albums', e), null));
    library.albums = items ? items.map((x) => x.album).filter(Boolean) : [];
    if (!items) setTimeout(() => (library.albums = null), 15000);
  } else if (kind === 'artists') {
    const out = [];
    let url = '/me/following?type=artist&limit=50';
    let failed = false;
    while (url && out.length < 1000) {
      const d = await api(url).catch((e) => (console.warn('following', e), (failed = true), null));
      out.push(...(d?.artists?.items || []));
      url = d?.artists?.next || null;
    }
    library.artists = out;
    if (failed) setTimeout(() => (library.artists = null), 15000);
  }
  if (library.filter === kind) renderLibrary();
}

// Phone: the sidebar is a tab bar, so "Library" borrows the sidebar's library list for a page.
function libraryPage({ el }) {
  const section = $('#playlist-nav').closest('.nav-section');
  const parent = section.parentElement;
  const next = section.nextSibling;
  el.innerHTML = '<h1 class="page-title">Your Library</h1>';
  section.classList.add('lib-page');
  el.appendChild(section);
  cleanups.push(() => {
    section.classList.remove('lib-page');
    parent.insertBefore(section, next);
  });
}

function setupLibrary() {
  const section = $('#playlist-nav').closest('.nav-section');
  if (section.dataset.ready) return;
  section.dataset.ready = '1';
  section.querySelector('.nav-title').outerHTML = `<div class="nav-title-row"><div class="nav-title">Your Library</div><button class="mini-btn" id="lib-new" title="Create playlist"><i>${icons.plus}</i></button></div>
    <div class="chips" id="lib-chips"><button class="chip" data-f="playlists">Playlists</button><button class="chip" data-f="albums">Albums</button><button class="chip" data-f="artists">Artists</button></div>`;
  $('#lib-new').onclick = async () => {
    const p = await newPlaylistFlow();
    if (p) navigate('playlist', p.id);
  };
  $('#lib-chips').onclick = (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    library.filter = c.dataset.f;
    store.set('libFilter', library.filter);
    renderLibrary();
  };
  const nav = $('#playlist-nav');
  nav.onclick = (e) => {
    const b = e.target.closest('.pl-nav-item');
    if (b) navigate(b.dataset.kind, b.dataset.id);
  };
  nav.oncontextmenu = async (e) => {
    const b = e.target.closest('.pl-nav-item');
    if (!b) return;
    e.preventDefault();
    const kind = b.dataset.kind;
    const uri = `spotify:${kind}:${b.dataset.id}`;
    if (kind === 'playlist') {
      const p = library.playlists.find((x) => x.id === b.dataset.id);
      return menu(e, [
        { label: 'Play', onClick: () => player.playContext(p.uri) },
        { label: 'Open', onClick: () => navigate('playlist', p.id) },
        '-',
        ...(owns(p) ? [{ label: 'Edit details', onClick: () => editPlaylistFlow(p) }] : []),
        { label: owns(p) ? 'Delete' : 'Remove from Your Library', onClick: () => deletePlaylistFlow(p) },
        { label: 'Copy link', onClick: () => navigator.clipboard.writeText(`https://open.spotify.com/playlist/${p.id}`).then(() => toast('Link copied')) },
      ]);
    }
    menu(e, [
      { label: 'Play', onClick: () => player.playContext(uri) },
      { label: 'Open', onClick: () => navigate(kind, b.dataset.id) },
      '-',
      { label: kind === 'artist' ? 'Unfollow' : 'Remove from Your Library', onClick: () => libraryToggle(uri) },
    ]);
  };
  bus.on('page', () => $$('.pl-nav-item', nav).forEach((b) => b.classList.toggle('active', current?.route === b.dataset.kind && current?.param === b.dataset.id)));
}

export async function loadPlaylists() {
  setupLibrary();
  const [items, me] = await Promise.all([pages('/me/playlists', { query: { limit: 50 }, max: 500 }).catch(() => []), getMe().catch(() => null)]);
  library.meId = me?.id || library.meId;
  library.playlists = items.filter(Boolean);
  renderLibrary();
}
