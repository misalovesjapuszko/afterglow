import { api, normTrack, areLiked, setLiked } from './api.js';
import { hydrateIcons, setIcon, icons } from './icons.js';
import { nowPlaying, bindNowPlaying, nudgeOffset } from './np.js';
import { player, init as initPlayer, skipDirection } from './player.js';
import { loadPlugins } from './plugins.js';
import './autoplay.js';
import { navigate, back, loadPlaylists } from './views.js';
import { $, $$, bus, esc, fmt, hideMenu, img, invoke, slider, store, toast } from './util.js';

hydrateIcons();
// liquid glass: the specular highlight follows the pointer
let sheenRaf = 0;
document.addEventListener('pointermove', (e) => {
  if (sheenRaf) return;
  sheenRaf = requestAnimationFrame(() => {
    sheenRaf = 0;
    const el = e.target.closest?.('#sidebar, #player, #queue-panel, .np-tools, .dialog, .wc-card, .glass');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
}, { passive: true });
document.body.classList.toggle('still', !store.get('animatedBg', true));
document.body.classList.toggle('lyric-blur', store.get('lyricBlur', true));
document.documentElement.style.setProperty('--lyric-size', store.get('lyricSize', 38) + 'px');
document.body.classList.toggle('slider-values', store.get('sliderValues', false));
document.body.classList.toggle('no-anim', !store.get('animations', true));
const replay = (el, cls) => {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
};
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, .wc-card')) e.preventDefault();
});

// ---- First-run setup: a short guided tour that walks people through making their own
// (free) Spotify developer app, pasting its Client ID and logging in.
const REDIRECT = 'http://127.0.0.1:8899/login';
const DASHBOARD = 'https://developer.spotify.com/dashboard';
const validId = (v) => /^[0-9a-f]{32}$/i.test(v.trim());
const SPOTIFY_LOGO = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 14.4a.6.6 0 0 1-.9.2c-2.4-1.4-5.3-1.8-8.8-1a.6.6 0 1 1-.3-1.2c3.8-.9 7-.5 9.7 1.1.3.2.4.6.3.9Zm1.2-2.7a.8.8 0 0 1-1.1.3c-2.7-1.7-6.9-2.2-10.1-1.2a.8.8 0 0 1-.5-1.5c3.7-1.1 8.3-.6 11.4 1.3.4.3.5.8.3 1.1Zm.1-2.8C14.7 9 9.4 8.8 6.3 9.7a.9.9 0 1 1-.5-1.8c3.5-1.1 9.4-.9 13.1 1.3a.9.9 0 0 1-1 1.7Z"/></svg>';

const LOGIN_ERRORS = [
  [/CANCELLED/, 'The sign-in window was closed. Press the button to try again.'],
  [/timed out/i, 'The login took too long. Press Connect and finish in the Spotify page within 5 minutes.'],
  [/access_denied/i, 'Spotify said no (you pressed Cancel, or this Spotify account is not allowed in your developer app yet).'],
  [/busy/i, 'Another app is using port 8899. Close other Afterglow windows and try again.'],
  [/state mismatch/i, 'That login link was old. Press Connect again.'],
];
const explain = (e) => LOGIN_ERRORS.find(([re]) => re.test(String(e)))?.[1] || String(e);

async function welcome(cfg, error = '') {
  const os = await invoke('platform').catch(() => '');
  const w = $('#welcome');
  w.hidden = false;
  w.innerHTML = `<div class="wc-card">
    <div class="wc-top"><button class="wc-back" id="wc-back" title="Back">${icons.chevronLeft || '‹'}</button><div class="wc-dots">${'<i></i>'.repeat(4)}</div><span class="wc-count" id="wc-count"></span></div>
    <div class="wc-stage" id="wc-stage"></div>
  </div>`;
  const state = { id: (cfg.client_id || '').trim(), step: 0 };
  const copy = (text, label) => `<button class="wc-copy" data-copy="${esc(text)}"><span class="wc-copy-label">${esc(label)}</span><code>${esc(text)}</code><b>Copy</b></button>`;
  const playback = {
    windows: 'Music plays right inside Afterglow.',
    linux: 'Afterglow can play on this PC (add a free Soloist key later in Settings) or control any other Spotify device.',
    ios: 'On iPhone and iPad, Afterglow is the remote and the Spotify app does the playing. Keep Spotify installed and open it once.',
    macos: 'Afterglow controls your Spotify devices (the Spotify desktop app, phone, speakers).',
  }[os] || 'Afterglow plays music or controls your other Spotify devices.';
  const loginWhere = os === 'ios' ? 'The Spotify login page opens right here.' : 'Your browser opens the Spotify login page.';

  const steps = [
    () => `
      <div class="wc-logo"></div>
      <h1>Welcome to Afterglow</h1>
      <p>A beautiful Spotify player with live, word-by-word lyrics.</p>
      <div class="wc-feats">
        <div><span>${icons.lyrics}</span>Synced lyrics that glow along with the song</div>
        <div><span>${icons.sliders}</span>Album-art colors and liquid glass everywhere</div>
        <div><span>${icons.plugin}</span>Plugins and themes you can write yourself</div>
      </div>
      <div class="wc-chips"><span>Needs Spotify Premium</span><span>Sign in once, that’s it</span></div>
      <button class="wc-btn wc-spotify" id="wc-web">${SPOTIFY_LOGO}<span>Sign in with Spotify</span></button>
      <div class="wc-err" id="wc-err">${esc(error)}</div>
      <div class="wc-alt">Sign-in not working? <button class="wc-link" data-next>Use your own Spotify developer app</button> instead. It’s the official way and takes about 3 minutes.</div>`,
    () => `
      <div class="wc-kicker">Step 1 of 3</div>
      <h2>Make your own Spotify key</h2>
      <p>Spotify asks every app to have a free “developer app”. It takes a minute and it’s only for you.</p>
      <ol class="wc-steps">
        <li><div><b>Open the Spotify dashboard</b> and log in with your Spotify account.</div>
          <button class="wc-mini" data-open="${DASHBOARD}">Open dashboard ↗</button></li>
        <li><div><b>Press “Create app”</b> and fill it in like this:</div>
          <div class="wc-form">
            ${copy('Afterglow', 'App name')}
            ${copy('My Afterglow player', 'App description')}
            ${copy(REDIRECT, 'Redirect URI')}
            <div class="wc-note">Paste the Redirect URI and press <b>Add</b> next to it, otherwise it isn’t saved.</div>
          </div></li>
        <li><div>Under <b>Which API/SDKs</b>, tick <b>Web API</b> and <b>Web Playback SDK</b>. Accept the terms and press <b>Save</b>.</div></li>
      </ol>
      <button class="wc-btn" data-next>I made the app</button>`,
    () => `
      <div class="wc-kicker">Step 2 of 3</div>
      <h2>Paste your Client ID</h2>
      <p>In your new app, open <b>Settings</b>. The <b>Client ID</b> is the 32-character code at the top. (You don’t need the Client secret.)</p>
      <div class="wc-idbox">
        <input class="field" id="wc-id" placeholder="e.g. 3f9a…  (32 letters and numbers)" value="${esc(state.id)}" spellcheck="false" autocomplete="off">
        <button class="wc-paste" id="wc-paste">Paste</button>
      </div>
      <div class="wc-check" id="wc-check"></div>
      <button class="wc-btn" id="wc-idnext" data-next>Continue</button>
      <div class="wc-small">Got a Client ID from a friend? That works too, as long as they added your Spotify email under <b>User Management</b>.</div>`,
    () => `
      <div class="wc-kicker">Step 3 of 3</div>
      <h2>Connect Spotify</h2>
      <p>${loginWhere} Log in and press <b>Agree</b>.</p>
      <div class="wc-tip"><b>Spotify may ask twice.</b> The second time switches on Spotify’s own synced lyrics and full playlists.</div>
      <div class="wc-tip">${esc(playback)}</div>
      <button class="wc-btn" id="wc-go">Connect Spotify</button>
      <div class="wc-err" id="wc-err">${esc(error)}</div>`,
  ];

  const stage = $('#wc-stage');
  const render = (dir = 1) => {
    stage.innerHTML = `<div class="wc-step">${steps[state.step]()}</div>`;
    $$('.wc-dots i', w).forEach((d, i) => d.classList.toggle('on', i <= state.step));
    $('#wc-back').style.visibility = state.step ? 'visible' : 'hidden';
    $('#wc-count').textContent = '';
    const el = stage.firstElementChild;
    if (!document.body.classList.contains('no-anim'))
      el.animate([{ opacity: 0, transform: `translateX(${dir * 40}px)`, filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    bind();
  };
  const go = (n) => {
    const dir = n > state.step ? 1 : -1;
    state.step = Math.max(0, Math.min(steps.length - 1, n));
    render(dir);
  };
  $('#wc-back').onclick = () => go(state.step - 1);

  function bind() {
    for (const b of $$('[data-next]', stage)) b.onclick = () => go(state.step + 1);
    for (const b of $$('[data-goto]', stage)) b.onclick = () => go(+b.dataset.goto);
    for (const b of $$('[data-open]', stage)) b.onclick = () => invoke('open_url', { url: b.dataset.open });
    for (const b of $$('[data-copy]', stage))
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
        } catch {
          const r = document.createRange();
          r.selectNodeContents(b.querySelector('code'));
          getSelection().removeAllRanges();
          getSelection().addRange(r);
          document.execCommand('copy');
        }
        b.classList.add('done');
        b.querySelector('b').textContent = 'Copied';
        setTimeout(() => {
          b.classList.remove('done');
          b.querySelector('b').textContent = 'Copy';
        }, 1600);
      };
    const input = $('#wc-id');
    if (input) {
      const check = () => {
        const v = input.value.trim();
        state.id = v;
        const ok = validId(v);
        $('#wc-idnext').disabled = !ok;
        const c = $('#wc-check');
        c.className = 'wc-check ' + (ok ? 'ok' : v ? 'bad' : '');
        c.textContent = ok ? '✓ Looks right' : v ? `That’s ${v.length} characters. A Client ID has 32 (0-9, a-f).` : '';
      };
      input.oninput = check;
      check();
      setTimeout(() => input.focus(), 50);
      $('#wc-paste').onclick = async () => {
        try {
          input.value = (await navigator.clipboard.readText()).trim();
          check();
        } catch {
          input.focus();
          toast('Press Ctrl+V (or long-press → Paste)');
        }
      };
      input.onkeydown = (e) => e.key === 'Enter' && validId(input.value) && go(3);
    }
    const web = $('#wc-web');
    if (web)
      web.onclick = async () => {
        web.disabled = true;
        web.querySelector('span').textContent = 'Finish signing in in the Spotify window…';
        $('#wc-err').textContent = '';
        try {
          await invoke('web_login');
          location.reload();
        } catch (e) {
          web.disabled = false;
          web.querySelector('span').textContent = 'Sign in with Spotify';
          $('#wc-err').textContent = explain(e);
        }
      };
    const btn = $('#wc-go');
    if (btn)
      btn.onclick = async () => {
        if (!validId(state.id)) return go(2);
        btn.disabled = true;
        btn.textContent = os === 'ios' ? 'Opening Spotify login…' : 'Finish logging in in your browser…';
        $('#wc-err').textContent = '';
        try {
          await invoke('login', { clientId: state.id.trim() });
          location.reload();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Try again';
          $('#wc-err').textContent = explain(e);
        }
      };
  }

  // returning user whose login expired: straight to the Connect step
  state.step = error && validId(state.id) && cfg.auth !== 'web' ? 3 : 0;
  render();
}

// ---- iPhone: native Liquid Glass tab bar + mini player (UIKit, see src-tauri/plugins/glassbar).
// The web versions stay in the page (hidden) so everything else keeps working the same.
const GLASS_TABS = [
  { id: 'search', title: 'Search', icon: 'magnifyingglass' },
  { id: 'home', title: 'Home', icon: 'house.fill' },
  { id: 'liked', title: 'Liked', icon: 'heart.fill' },
  { id: 'library', title: 'Library', icon: 'square.stack.fill' },
  { id: 'settings', title: 'Settings', icon: 'gearshape.fill' },
];
async function nativeBars() {
  if ((await invoke('platform').catch(() => '')) !== 'ios') return;
  const gb = (cmd, args) => invoke(`plugin:glassbar|${cmd}`, args).catch((e) => console.warn('glassbar', cmd, e));
  const phone = matchMedia('(max-width: 700px)');
  window.__glassbar = (name, value) => {
    if (name === 'tab') navigate(value);
    else if (value === 'toggle') player.toggle();
    else if (value === 'next') player.next();
    else if (player.state.track) nowPlaying.show();
  };
  const res = await gb('configure', { tabs: GLASS_TABS, selected: 'home' });
  if (!res?.ok) return;
  document.body.classList.add('native-bars');
  const sync = () => gb('show', { visible: phone.matches && !nowPlaying.open && $('#welcome').hidden });
  let last = '';
  const sendTrack = () => {
    const t = player.state.track;
    const msg = { title: t?.name || '', artist: (t?.artists || []).map((a) => a.name).join(', '), art: img(t?.album?.images, 128) || '', playing: !!player.state.playing };
    const key = JSON.stringify(msg);
    if (key !== last) (last = key), gb('track', msg);
  };
  bus.on('page', ({ route }) => gb('tab', { id: route }));
  bus.on('track', sendTrack);
  bus.on('state', sendTrack);
  new MutationObserver(sync).observe($('#np'), { attributes: true, attributeFilter: ['class'] });
  phone.addEventListener('change', sync);
  sync();
  sendTrack();
}

const seekBar = slider($('#pl-seek'), { onChange: (v) => player.seek(v * (player.state.duration || 0)) });
const npSeek = slider($('#np-seek'), { onChange: (v) => player.seek(v * (player.state.duration || 0)) });
bindNowPlaying(npSeek);
let lastVol = 0;
const volBar = slider($('#pl-volume'), {
  onInput: (v) => {
    $('#pl-vol-pct').textContent = Math.round(v * 100) + '%';
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

function bindControls(prefix) {
  $(`#${prefix}-play`).onclick = () => player.toggle();
  $(`#${prefix}-next`).onclick = () => player.next();
  $(`#${prefix}-prev`).onclick = () => player.prev();
  $(`#${prefix}-shuffle`).onclick = () => player.setShuffle(!player.state.shuffle);
  $(`#${prefix}-repeat`).onclick = () => player.cycleRepeat();
}
bindControls('pl');
bindControls('np');

$('#pl-art').onclick = () => player.state.track && nowPlaying.toggle();
$('#pl-lyrics').onclick = () => nowPlaying.toggle();
$('#pl-mute').onclick = () => {
  if (player.state.volume > 0.01) {
    store.set('volumeBeforeMute', player.state.volume);
    player.setVolume(0);
  } else player.setVolume(store.get('volumeBeforeMute', 0.6));
};
$('#pl-artist').onclick = (e) => {
  const a = e.target.closest('[data-artist]');
  if (a) {
    nowPlaying.hide();
    navigate('artist', a.dataset.artist);
  }
};
$('#pl-like').onclick = async () => {
  const t = player.state.track;
  if (!t) return;
  const on = !$('#pl-like').classList.contains('liked');
  setLikeBtn(on);
  if (on) replay($('#pl-like'), 'pop');
  setLiked(t.uri, on).catch((e) => {
    setLikeBtn(!on);
    toast(e.message);
  });
};
function setLikeBtn(on) {
  const b = $('#pl-like');
  b.classList.toggle('liked', on);
  setIcon(b, on ? 'heartFill' : 'heart');
}

let wasPlaying = null;
bus.on('state', (s) => {
  if (wasPlaying !== null && wasPlaying !== s.playing) {
    replay($('#pl-play'), 'bump');
    replay($('#np-play'), 'bump');
  }
  wasPlaying = s.playing;
  for (const p of ['pl', 'np']) {
    setIcon($(`#${p}-play`), s.playing ? 'pause' : 'play');
    $(`#${p}-shuffle`).classList.toggle('active', !!s.shuffle);
    const r = $(`#${p}-repeat`);
    r.classList.toggle('active', s.repeat !== 'off');
    setIcon(r, s.repeat === 'track' ? 'repeatOne' : 'repeat');
  }
  volBar.set(s.volume);
  $('#pl-vol-pct').textContent = Math.round(s.volume * 100) + '%';
  setIcon($('#pl-mute'), s.volume < 0.01 ? 'mute' : s.volume < 0.5 ? 'volumeLow' : 'volume');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s.playing ? 'playing' : 'paused';
});

bus.on('track', async (t) => {
  $('.pl-left').style.setProperty('--dir', skipDirection());
  replay($('.pl-left'), 'swap');
  $('#pl-title').textContent = t?.name || 'Not playing';
  $('#pl-artist').innerHTML = (t?.artists || []).map((a) => (a.id ? `<span class="link" data-artist="${esc(a.id)}">${esc(a.name)}</span>` : esc(a.name))).join(', ');
  const im = $('#pl-art img');
  const src = img(t?.album?.images, 128);
  if (src) im.src = src;
  else im.removeAttribute('src');
  if (!queuePanel.hidden) loadQueue();
  if ('mediaSession' in navigator && t) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
      album: t.album?.name || '',
      artwork: (t.album?.images || []).map((i) => ({ src: i.url, sizes: `${i.width || 300}x${i.height || 300}` })),
    });
  }
  if (t?.uri) {
    const [on] = await areLiked([t.uri]);
    if (player.state.track?.uri === t.uri) setLikeBtn(on);
  } else setLikeBtn(false);
});

bus.on('autoplay', () => {
  if (!queuePanel.hidden) loadQueue();
});

bus.on('liked-changed', ({ uri, on }) => {
  if (player.state.track?.uri === uri) setLikeBtn(on);
});

setInterval(() => {
  if (document.hidden) return;
  const pos = player.pos();
  const dur = player.state.duration || 0;
  $('#pl-pos').textContent = fmt(pos);
  $('#pl-dur').textContent = fmt(dur);
  seekBar.set(dur ? pos / dur : 0);
}, 250);

let lastMedia = 0;
let mediaTimer = 0;
function pushMedia(seeked = false) {
  const send = () => {
    lastMedia = performance.now();
    const s = player.state;
    const t = s.track;
    invoke('media_update', {
      state: {
        uri: t?.uri || '',
        title: t?.name || '',
        artist: (t?.artists || []).map((a) => a.name).join(', '),
        artists: (t?.artists || []).map((a) => a.name),
        album: t?.album?.name || '',
        art: img(t?.album?.images, 300),
        duration: Math.round(s.duration || 0),
        position: Math.round(player.pos()),
        playing: !!s.playing,
        volume: s.volume,
        shuffle: !!s.shuffle,
        repeat: s.repeat,
        seeked,
      },
    }).catch(() => {});
  };
  clearTimeout(mediaTimer);
  if (seeked || performance.now() - lastMedia > 400) send();
  else mediaTimer = setTimeout(send, 400);
}
let lastPos = 0;
bus.on('state', (s) => {
  const p = player.pos();
  const jumped = Math.abs(p - lastPos) > 3000;
  lastPos = p;
  pushMedia(jumped);
});
bus.on('track', () => pushMedia(true));
setInterval(() => (lastPos = player.pos()), 1000);

const ev = window.__TAURI__?.event;
if (ev) {
  ev.listen('media', ({ payload }) => {
    if (payload === 'playpause') player.toggle();
    else if (payload === 'play') player.resume();
    else if (payload === 'pause') player.pause();
    else if (payload === 'next') player.next();
    else if (payload === 'previous') player.prev();
  });
  ev.listen('media-seek', ({ payload }) => player.seek(Math.max(0, player.pos() + payload)));
  ev.listen('media-position', ({ payload }) => player.seek(Math.max(0, payload)));
  ev.listen('media-volume', ({ payload }) => player.setVolume(payload));
  ev.listen('media-shuffle', ({ payload }) => player.setShuffle(!!payload));
}

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const h = (a, f) => {
    try {
      ms.setActionHandler(a, f);
    } catch {}
  };
  h('play', () => player.resume());
  h('pause', () => player.pause());
  h('nexttrack', () => player.next());
  h('previoustrack', () => player.prev());
  h('seekto', (d) => d.seekTime != null && player.seek(d.seekTime * 1000));
}

const queuePanel = $('#queue-panel');
async function loadQueue() {
  const list = $('#queue-list');
  try {
    const q = await api('/me/player/queue');
    const cur = normTrack(q?.currently_playing);
    const next = (q?.queue || []).map(normTrack).filter(Boolean);
    const item = (t, now) => `<div class="q-item${now ? ' now' : ''}" data-uri="${esc(t.uri)}"><img src="${esc(img(t.album?.images, 64))}" alt=""><div class="q-text"><div class="q-name">${esc(t.name)}</div><div class="q-artist">${esc(t.artists.map((a) => a.name).join(', '))}</div></div></div>`;
    list.innerHTML = (cur ? `<div class="q-label">Now playing</div>${item(cur, true)}` : '') + (next.length ? `<div class="q-label">Next up</div>${next.map((t) => item(t)).join('')}` : '<div class="empty">Nothing queued.</div>');
  } catch (e) {
    list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
$('#pl-queue').onclick = () => {
  queuePanel.hidden = !queuePanel.hidden;
  $('#pl-queue').classList.toggle('active', !queuePanel.hidden);
  if (!queuePanel.hidden) loadQueue();
};
$('#qp-close').onclick = () => $('#pl-queue').click();

$$('#sidebar [data-route]').forEach((b) => (b.onclick = () => navigate(b.dataset.route)));
$('#back-btn').onclick = () => back();
$('#main').addEventListener('scroll', (e) => $('#topbar').classList.toggle('scrolled', e.target.scrollTop > 40), { passive: true });
document.addEventListener('click', (e) => !e.target.closest('#menu') && hideMenu());
window.addEventListener('blur', hideMenu);

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, select');
  if (e.key === 'Escape') {
    hideMenu();
    if (nowPlaying.open) nowPlaying.hide();
    else if (!queuePanel.hidden) $('#pl-queue').click();
    return;
  }
  if (e.key === 'MediaPlayPause') return player.toggle();
  if (e.key === 'MediaTrackNext') return player.next();
  if (e.key === 'MediaTrackPrevious') return player.prev();
  if (e.key === 'MediaStop' || e.key === 'MediaPause') return player.pause();
  if (e.key === 'MediaPlay') return player.resume();
  if (typing) return;
  if (e.code === 'Space') {
    e.preventDefault();
    player.toggle();
  } else if (e.key === 'ArrowRight' && e.ctrlKey) player.next();
  else if (e.key === 'ArrowLeft' && e.ctrlKey) player.prev();
  else if (e.key === 'ArrowRight') player.seek(Math.min(player.pos() + 5000, (player.state.duration || 1) - 500));
  else if (e.key === 'ArrowLeft') player.seek(Math.max(0, player.pos() - 5000));
  else if (e.key === 'ArrowUp' && e.ctrlKey) player.setVolume(player.state.volume + 0.05);
  else if (e.key === 'ArrowDown' && e.ctrlKey) player.setVolume(player.state.volume - 0.05);
  else if (e.key.toLowerCase() === 'l' && !e.ctrlKey) nowPlaying.toggle();
  else if (e.key === '[' || e.key === ']') {
    const off = nudgeOffset(e.key === ']' ? 100 : -100, { global: e.shiftKey });
    if (off != null) toast(`Lyrics ${off === 0 ? 'in sync' : off > 0 ? `${(off / 1000).toFixed(1)}s earlier` : `${(-off / 1000).toFixed(1)}s later`}`);
  }
  else if ((e.key === 'k' || e.key === 'f') && e.ctrlKey) {
    e.preventDefault();
    const box = document.querySelector('.track-filter input');
    if (e.key === 'f' && box) box.focus();
    else navigate('search');
  }
});

bus.on('pairing', (need) => {
  const el = $('#pairing');
  el.hidden = !need;
  el.innerHTML = need ? 'One-time setup: open Spotify on your phone or PC, tap the <b>devices</b> icon and pick <b>Afterglow</b>. After that Afterglow works on its own.' : '';
});
bus.on('engine-hint', (h) => {
  if (h === 'soloist-key') toast('Add your Soloist API key in Settings to play music on Linux', 6000);
});
let welcomed = false;
bus.on('logged-out', async (why) => {
  if (welcomed) return;
  welcomed = true;
  welcome(await invoke('get_config'), why === 'SCOPES' ? 'Afterglow got new features and needs a few more Spotify permissions. Press Connect once.' : 'Your Spotify login expired. Sign in again.');
});

async function start() {
  const cfg = await invoke('get_config');
  if (!cfg.logged_in) return welcome(cfg);
  player.state.volume = store.get('volume', 0.6);
  volBar.set(player.state.volume);
  await loadPlugins();
  // optional local-only additions (ui/js/local/ is gitignored and absent in public builds)
  await import('./local/index.js').then((m) => m.install?.()).catch(() => {});
  navigate('home', null, { push: false });
  loadPlaylists();
  nativeBars();
  await initPlayer();
}

start();
