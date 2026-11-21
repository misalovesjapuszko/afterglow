import { api } from './api.js';
import { addProvider, parseLRC } from './lyrics.js';
import { nowPlaying } from './np.js';
import { player } from './player.js';
import { icons, hydrateIcons } from './icons.js';
import { navigate, pluginPages, trackMenuItems, library } from './views.js';
import { $, bus, esc, invoke, menu, store, toast } from './util.js';

function scopedStore(ns) {
  return {
    get: (k, d) => store.get(`plugin:${ns}:${k}`, d),
    set: (k, v) => store.set(`plugin:${ns}:${k}`, v),
  };
}

function makeApi(name) {
  return Object.freeze({
    version: '0.1.0',
    plugin: name,
    player: {
      get state() { return { ...player.state, position: player.pos() }; },
      get engine() { return player.kind; },
      play: (target, index) => {
        if (Array.isArray(target)) return player.playTracks(target.map((t) => (typeof t === 'string' ? { uri: t } : t)), index || 0);
        if (typeof target === 'string' && target.includes(':track:')) return player.play({ uris: [target] });
        if (typeof target === 'string') return player.playContext(target, index);
        return player.resume();
      },
      pause: () => player.pause(),
      resume: () => player.resume(),
      toggle: () => player.toggle(),
      next: () => player.next(),
      prev: () => player.prev(),
      seek: (ms) => player.seek(ms),
      setVolume: (v) => player.setVolume(v),
      setShuffle: (on) => player.setShuffle(on),
      cycleRepeat: () => player.cycleRepeat(),
      queue: (uri) => player.queue(uri),
    },
    on: (ev, fn) => bus.on(ev, fn),
    off: (ev, fn) => bus.off(ev, fn),
    emit: (ev, data) => bus.emit(`plugin:${ev}`, data),
    api: (path, opts) => api(path, opts),
    fetchText: (url) => invoke('http_get', { url }),
    lyrics: {
      addProvider: (fn, opts) => addProvider(fn, opts),
      parseLRC,
      get current() { return nowPlaying.lyrics; },
    },
    library: { get playlists() { return library.playlists.slice(); } },
    storage: scopedStore(name),
    icons: { ...icons },
    ui: {
      toast: (msg, ms) => toast(String(msg), ms),
      menu: (event, items) => menu(event, items),
      navigate: (route, param) => navigate(route, param),
      openNowPlaying: () => nowPlaying.show(),
      closeNowPlaying: () => nowPlaying.hide(),
      addPlayerButton({ id, title = '', icon = icons.plugin, onClick }) {
        const b = document.createElement('button');
        b.className = 'icon-btn';
        b.title = title;
        b.dataset.plugin = name;
        if (id) b.id = `plugin-${id}`;
        b.innerHTML = `<i>${icon}</i>`;
        b.onclick = (e) => onClick?.(e);
        $('#plugin-player-buttons').appendChild(b);
        return b;
      },
      addSidebarItem({ id, label, icon = icons.plugin, onClick, page }) {
        $('#plugin-nav-section').hidden = false;
        const b = document.createElement('button');
        b.className = 'nav-item';
        b.dataset.page = page || id || '';
        b.innerHTML = `<i>${icon}</i><span>${esc(label)}</span>`;
        b.onclick = () => (page ? navigate('plugin', page) : onClick?.());
        $('#plugin-nav').appendChild(b);
        return b;
      },
      registerPage(id, { title, render }) {
        pluginPages.set(id, { title, render });
      },
      addTrackMenuItem({ label, onClick }) {
        trackMenuItems.push({ label, onClick });
      },
      setTheme: (file) => applyTheme(file),
      get themes() { return themes.list.map(themeInfo); },
      addStyle(css) {
        const st = document.createElement('style');
        st.dataset.plugin = name;
        st.textContent = css;
        document.head.appendChild(st);
        return st;
      },
      hydrateIcons,
    },
  });
}

export const themes = { list: [], active: null };

export function themeInfo(t) {
  const v = (k) => t.css.match(new RegExp(`--${k}\\s*:\\s*([^;]+);`))?.[1]?.trim();
  const name = t.css.match(/name:\s*([^*\n]+)/)?.[1]?.trim() || t.css.match(/\/\*\s*([^—*\n-]+)/)?.[1]?.trim() || t.name.replace(/^theme-|\.css$/g, '');
  return { file: t.name, name, bg: v('bg') || '#0b0b10', elev: v('bg-elev') || '#15151c', accent: v('accent') || '#fa2d48', sidebar: v('sidebar') || 'rgba(18,18,24,.72)' };
}

export const ALBUM_THEME = '@album';
let lastPalette = null;
const ALBUM_VARS = ['--bg', '--bg-elev', '--sidebar', '--line', '--bg-hover', '--bg-active', '--accent', '--muted', '--player-bg'];

function albumColors(pal) {
  if (!pal?.length) return;
  const base = pal[0];
  const score = (c) => {
    const mx = Math.max(...c), mn = Math.min(...c);
    return (mx ? (mx - mn) / mx : 0) * (mx / 255);
  };
  let acc = [...pal].sort((a, b) => score(b) - score(a))[0];
  const mx = Math.max(...acc);
  if (mx < 200) acc = acc.map((v) => Math.min(255, Math.round((v * 200) / Math.max(1, mx))));
  const mix = (c, k) => c.map((v) => Math.round(v * k)).join(',');
  const r = document.documentElement.style;
  r.setProperty('--bg', `rgb(${mix(base, 0.13)})`);
  r.setProperty('--bg-elev', `rgb(${mix(base, 0.22)})`);
  r.setProperty('--sidebar', `rgba(${mix(base, 0.17)},0.8)`);
  r.setProperty('--player-bg', `rgba(${mix(base, 0.15)},0.9)`);
  r.setProperty('--line', `rgba(${base.map((v) => Math.min(255, v + 70)).join(',')},0.12)`);
  r.setProperty('--bg-hover', `rgba(${acc.join(',')},0.08)`);
  r.setProperty('--bg-active', `rgba(${acc.join(',')},0.15)`);
  r.setProperty('--accent', `rgb(${acc.join(',')})`);
  r.setProperty('--muted', `rgb(${base.map((v) => Math.round(165 + (v - 165) * 0.3)).join(',')})`);
}

bus.on('palette', (pal) => {
  lastPalette = pal;
  if (themes.active === ALBUM_THEME) albumColors(pal);
});

export function applyTheme(file, save = true) {
  document.querySelectorAll('style[data-theme]').forEach((e) => e.remove());
  ALBUM_VARS.forEach((v) => document.documentElement.style.removeProperty(v));
  document.body.classList.toggle('album-theme', file === ALBUM_THEME);
  if (file === ALBUM_THEME) {
    themes.active = ALBUM_THEME;
    albumColors(lastPalette);
    if (save) invoke('set_config', { key: 'theme', value: ALBUM_THEME });
    bus.emit('theme', ALBUM_THEME);
    return;
  }
  const t = themes.list.find((x) => x.name === file);
  themes.active = t ? file : null;
  if (t) {
    const st = document.createElement('style');
    st.dataset.theme = file;
    st.textContent = t.css;
    document.head.appendChild(st);
  }
  if (save) invoke('set_config', { key: 'theme', value: themes.active });
  bus.emit('theme', themes.active);
}

export async function loadPlugins() {
  const errors = (window.__afterglowErrors = {});
  let list;
  try {
    list = await invoke('list_plugins');
  } catch {
    return;
  }
  const cfg = await invoke('get_config');
  const disabled = new Set(cfg.disabled_plugins || []);
  themes.list = list.styles.filter((s) => s.name.startsWith('theme-'));
  for (const s of list.styles) {
    if (s.name.startsWith('theme-') || disabled.has(s.name)) continue;
    const st = document.createElement('style');
    st.dataset.plugin = s.name;
    st.textContent = s.css;
    document.head.appendChild(st);
  }
  applyTheme(cfg.theme || null, false);
  for (const p of list.scripts) {
    if (disabled.has(p.name)) continue;
    const api = makeApi(p.name);
    try {
      const run = new Function('Afterglow', `"use strict";\n${p.code}\n//# sourceURL=plugin/${p.name}`);
      await run(api);
    } catch (e) {
      console.error(`plugin ${p.name} failed`, e);
      errors[p.name] = e.message;
      toast(`Plugin ${p.name} failed: ${e.message}`, 4000);
    }
  }
  window.Afterglow = makeApi('console');
}
