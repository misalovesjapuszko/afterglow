import { api, getToken, normTrack } from './api.js';
import { bus, invoke, sleep, toast } from './util.js';

// ---- Local (offline) playback via HTML5 <audio> ----
let localAudio = null;
let localTrack = null;
let localTimer = null;

export const DEVICE = 'Afterglow';

// which way the last skip went, so song transitions can slide the right way
let skip = { dir: 1, at: 0 };
export const skipDirection = () => (Date.now() - skip.at < 8000 ? skip.dir : 1);

export const player = {
  kind: 'none',
  backend: null,
  state: { track: null, playing: false, position: 0, ts: 0, duration: 0, volume: 0.6, shuffle: false, repeat: 'off', context: null },
  pos() {
    const s = this.state;
    if (!s.playing) return s.position;
    const now = performance.now();
    // small sync corrections are blended in over SLEW ms instead of jumping
    const k = clock.corr ? Math.min(1, (now - clock.at) / SLEW) : 0;
    return Math.max(0, Math.min(s.duration || Infinity, s.position + (now - s.ts) + clock.corr * k));
  },
  async play(body) {
    if (!this.backend) return toast('Player is still starting…');
    try {
      await this.backend.start(body);
    } catch (e) {
      toast('Could not play: ' + e.message);
    }
  },
  playTracks(tracks, index = 0) {
    const list = tracks.filter(Boolean);
    const start = Math.max(0, index - 100);
    const uris = list.slice(start, start + 500).map((t) => t.uri);
    return this.play({ uris, offset: { position: index - start } });
  },
  playContext(contextUri, index, trackUri) {
    const body = { context_uri: contextUri };
    if (trackUri) body.offset = { uri: trackUri };
    else if (index != null) body.offset = { position: index };
    return this.play(body);
  },
  toggle() { return this.state.playing ? this.pause() : this.resume(); },
  pause() { return this.backend?.pause(); },
  resume() { return this.backend?.resume(); },
  next() { skip = { dir: 1, at: Date.now() }; return this.backend?.next(); },
  prev() { skip = { dir: -1, at: Date.now() }; return this.backend?.prev(); },
  seek(ms) {
    update({ position: ms, ts: performance.now() });
    return this.backend?.seek(Math.round(ms));
  },
  setVolume(v) {
    v = Math.min(1, Math.max(0, v));
    update({ volume: v });
    return this.backend?.setVolume(v);
  },
  setShuffle(on) {
    update({ shuffle: on });
    return this.backend?.setShuffle(on);
  },
  cycleRepeat() {
    const next = { off: 'context', context: 'track', track: 'off' }[this.state.repeat] || 'off';
    update({ repeat: next });
    return this.backend?.setRepeat(next);
  },
  queue(uri, { silent = false } = {}) {
    const dev = this.backend?.deviceId?.();
    return api('/me/player/queue', { method: 'POST', query: { uri, device_id: dev } }).then(() => !silent && toast('Added to queue'));
  },
};

const SLEW = 700;
const clock = { corr: 0, at: 0 };

// Backends call this with a fresh position report. Small differences are slewed
// so lyrics don't snap back and forth; real jumps (seek, skip, pause) apply at once.
function syncClock(position, patch = {}) {
  const s = player.state;
  const now = performance.now();
  const sameTrack = !patch.track || patch.track?.uri === s.track?.uri;
  const playing = patch.playing ?? s.playing;
  const predicted = player.pos();
  const err = position - predicted;
  if (sameTrack && playing && s.playing && Math.abs(err) < 450) {
    return update({ ...patch, position: predicted, ts: now }, err);
  }
  update({ ...patch, position, ts: now });
}

function update(patch, corr = 0) {
  if ('position' in patch) {
    clock.corr = corr;
    clock.at = performance.now();
  }
  const prevUri = player.state.track?.uri;
  Object.assign(player.state, patch);
  bus.emit('state', player.state);
  if ((player.state.track?.uri || null) !== (prevUri || null)) bus.emit('track', player.state.track);
}

async function webApiStart(deviceId, body) {
  await api('/me/player/play', { method: 'PUT', query: { device_id: deviceId }, body });
}

let emeResult = null;
async function eme() {
  if (emeResult !== null) return emeResult;
  emeResult = await emeCheck();
  return emeResult;
}

async function emeCheck() {
  if (!navigator.requestMediaKeySystemAccess) return false;
  try {
    await Promise.race([
      navigator.requestMediaKeySystemAccess('com.widevine.alpha', [
        { initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] },
      ]),
      sleep(4000).then(() => { throw new Error('timeout'); }),
    ]);
    return true;
  } catch {
    return false;
  }
}

function sdkTrack(t) {
  if (!t) return null;
  return {
    uri: t.uri,
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => ({ name: a.name, uri: a.uri, id: a.uri?.split(':').pop() })),
    album: t.album ? { name: t.album.name, uri: t.album.uri, id: t.album.uri?.split(':').pop(), images: t.album.images || [] } : null,
    duration: t.duration_ms || 0,
  };
}

function sdkBackend() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (!settled) {
        settled = true;
        reject(e instanceof Error ? e : new Error(e?.message || String(e)));
      }
    };
    window.onSpotifyWebPlaybackSDKReady = () => {
      const p = new window.Spotify.Player({
        name: DEVICE,
        getOAuthToken: (cb) => getToken().then(cb).catch(() => {}),
        volume: player.state.volume,
      });
      let deviceId = null;
      p.addListener('ready', ({ device_id }) => {
        deviceId = device_id;
        if (settled) return;
        settled = true;
        resolve({
          deviceId: () => deviceId,
          start: (body) => webApiStart(deviceId, body),
          pause: () => p.pause(),
          resume: () => p.resume(),
          next: () => p.nextTrack(),
          prev: () => p.previousTrack(),
          seek: (ms) => p.seek(ms),
          setVolume: (v) => p.setVolume(v),
          setShuffle: (on) => api('/me/player/shuffle', { method: 'PUT', query: { state: on, device_id: deviceId } }),
          setRepeat: (m) => api('/me/player/repeat', { method: 'PUT', query: { state: m, device_id: deviceId } }),
        });
      });
      p.addListener('not_ready', () => toast('Player went offline, reconnecting…'));
      p.addListener('initialization_error', fail);
      p.addListener('authentication_error', fail);
      p.addListener('account_error', () => fail(new Error('Spotify Premium is required')));
      p.addListener('playback_error', (e) => toast('Playback error: ' + (e?.message || '')));
      p.addListener('player_state_changed', (s) => {
        if (!s) return;
        syncClock(s.position, {
          track: sdkTrack(s.track_window?.current_track),
          playing: !s.paused,
          duration: s.duration,
          shuffle: s.shuffle,
          repeat: ['off', 'context', 'track'][s.repeat_mode] || 'off',
          context: s.context?.uri || null,
        });
      });
      const sync = () => p.getCurrentState().then((s) => s && syncClock(s.position, { playing: !s.paused })).catch(() => {});
      setInterval(() => !document.hidden && player.state.playing && sync(), 3000);
      bus.on('resync', sync);
      p.connect().then((ok) => !ok && fail(new Error('connect failed')));
      setTimeout(() => fail(new Error('Web player timed out')), 15000);
    };
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.onerror = () => fail(new Error('Could not load the Spotify web player'));
    document.head.appendChild(script);
  });
}

function soloistTrack(e) {
  if (!e?.uri) return null;
  const d = e.decorations || {};
  const parent = d.parent?.entity;
  const covers = d.visual_identity?.cover || parent?.decorations?.visual_identity?.cover || [];
  const images = covers.filter((c) => c.url).map((c) => ({ url: c.url, width: typeof c.size === 'number' ? c.size : c.width || ({ small: 64, large: 640 }[String(c.size).toLowerCase()] || 300) }));
  return {
    uri: e.uri,
    id: e.uri.split(':').pop(),
    name: d.identity?.name || '',
    artists: (d.creators || []).map((c) => ({ name: c.entity?.decorations?.identity?.name || '', uri: c.entity?.uri, id: c.entity?.uri?.split(':').pop() })),
    album: parent ? { name: parent.decorations?.identity?.name || '', uri: parent.uri, id: parent.uri?.split(':').pop(), images } : { name: '', images },
    duration: d.playback?.duration_ms || 0,
  };
}

async function findDevice(name) {
  const res = await api('/me/player/devices');
  return res?.devices?.find((d) => d.name === name)?.id || null;
}

async function soloistBackend() {
  const port = await invoke('soloist_start');
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('Could not connect to Soloist'));
  });
  const send = (command, extra = {}) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'command', command, ...extra }));
  const syncPos = (p) => {
    if (!p || p.position_ms == null) return;
    const lag = Math.max(0, Date.now() - (p.timestamp_ms || Date.now())) * (p.speed ?? 1);
    syncClock(p.position_ms + lag);
  };
  const setStatus = (st) => update({ playing: st === 'playing', position: player.pos(), ts: performance.now() });
  ws.onmessage = (ev) => {
    let v;
    try {
      v = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (v.type) {
      case 'auth_state':
        bus.emit('pairing', !v.logged_in);
        break;
      case 'playback_state': {
        const t = soloistTrack(v.item);
        update({
          track: t,
          duration: t?.duration || 0,
          playing: v.status === 'playing',
          volume: v.volume != null ? v.volume / 100 : player.state.volume,
          shuffle: !!v.options?.shuffle,
          repeat: v.options?.repeat || 'off',
          context: v.context?.uri || null,
        });
        syncPos(v.position);
        break;
      }
      case 'track_changed': {
        const t = soloistTrack(v.item);
        update({ track: t, duration: t?.duration || 0, position: 0, ts: performance.now() });
        setTimeout(() => send('get_state'), 700);
        setTimeout(() => send('get_state'), 2500);
        break;
      }
      case 'playback_changed':
        setStatus(v.status);
        break;
      case 'position_sync':
        syncPos(v.position);
        break;
      case 'volume_changed':
        update({ volume: (v.volume ?? 60) / 100 });
        break;
      case 'options_changed':
        update({ shuffle: !!v.options?.shuffle, repeat: v.options?.repeat || player.state.repeat });
        break;
      case 'context_changed':
        update({ context: v.context?.uri || null });
        break;
      case 'error':
        toast(v.message || 'Soloist error');
        break;
    }
  };
  ws.onclose = (ev) => {
    clearInterval(resync);
    console.warn('soloist socket closed', ev.code, ev.reason);
    if (player.backend !== backend) return;
    toast('Soloist disconnected, reconnecting…');
    setTimeout(() => init(true), 2500);
  };
  send('get_state');
  const resync = setInterval(() => !document.hidden && player.state.playing && send('get_state'), 10000);
  bus.on('resync', () => send('get_state'));
  let deviceId = null;
  const backend = {
    deviceId: () => deviceId,
    stop: () => {
      clearInterval(resync);
      ws.onclose = null;
      ws.close();
    },
    async start(body) {
      deviceId = deviceId || (await findDevice(DEVICE));
      if (!deviceId) {
        send('activate');
        for (let i = 0; i < 10 && !deviceId; i++) {
          await sleep(500);
          deviceId = await findDevice(DEVICE);
        }
      }
      if (deviceId) {
        try {
          return await webApiStart(deviceId, body);
        } catch (e) {
          if (e.status === 404) deviceId = null;
        }
      }
      const uri = body.context_uri || body.uris?.[body.offset?.position || 0];
      send('play', { uri });
    },
    pause: () => send('pause'),
    resume: () => send('play'),
    next: () => send('skip_next'),
    prev: () => send('skip_prev'),
    seek: (ms) => send('seek', { position_ms: ms }),
    setVolume: (v) => send('set_volume', { volume: Math.round(v * 100) }),
    setShuffle: (on) => send('set_shuffle', { enabled: on }),
    setRepeat(m) {
      send('set_repeat_track', { enabled: m === 'track' });
      send('set_repeat_context', { enabled: m === 'context' });
    },
  };
  return backend;
}

function remoteBackend() {
  let timer = null;
  const poll = async () => {
    try {
      const sent = performance.now();
      const s = await api('/me/player', { background: true });
      const half = (performance.now() - sent) / 2;
      if (!s) return update({ playing: false });
      syncClock((s.progress_ms || 0) + (s.is_playing ? half : 0), {
        track: normTrack(s.item),
        playing: s.is_playing,
        duration: s.item?.duration_ms || 0,
        volume: (s.device?.volume_percent ?? 60) / 100,
        shuffle: s.shuffle_state,
        repeat: s.repeat_state,
        context: s.context?.uri || null,
      });
    } catch {}
  };
  const after = (p) => Promise.resolve(p).finally(() => setTimeout(poll, 400));
  timer = setInterval(() => !document.hidden && poll(), 3000);
  const fast = setInterval(() => !document.hidden && document.querySelector('#np.open') && poll(), 2000);
  bus.on('resync', poll);
  poll();
  return {
    deviceId: () => null,
    start: (body) => after(api('/me/player/play', { method: 'PUT', body })),
    pause: () => after(api('/me/player/pause', { method: 'PUT' })),
    resume: () => after(api('/me/player/play', { method: 'PUT' })),
    next: () => after(api('/me/player/next', { method: 'POST' })),
    prev: () => after(api('/me/player/previous', { method: 'POST' })),
    seek: (ms) => after(api('/me/player/seek', { method: 'PUT', query: { position_ms: ms } })),
    setVolume: (v) => api('/me/player/volume', { method: 'PUT', query: { volume_percent: Math.round(v * 100) } }),
    setShuffle: (on) => after(api('/me/player/shuffle', { method: 'PUT', query: { state: on } })),
    setRepeat: (m) => after(api('/me/player/repeat', { method: 'PUT', query: { state: m } })),
    stop: () => {
      clearInterval(timer);
      clearInterval(fast);
    },
  };
}

function stopLocal() {
  if (localAudio) {
    localAudio.pause();
    localAudio.src = '';
    localAudio.remove();
    localAudio = null;
  }
  localTrack = null;
  if (localTimer) {
    clearInterval(localTimer);
    localTimer = null;
  }
}

function playLocal(track, filePath) {
  // Stop any current Spotify playback
  player.backend?.pause?.();
  stopLocal();

  localTrack = track;
  localAudio = new Audio();

  // Tauri 2 asset protocol: convert local path to asset URL
  const assetUrl = window.__TAURI__?.core?.convertFileSrc?.(filePath) || `asset://localhost/${filePath}`;
  localAudio.src = assetUrl;
  localAudio.volume = player.state.volume;

  const t = {
    uri: track.uri || `local:track:${track.id}`,
    id: track.id,
    name: track.name,
    artists: Array.isArray(track.artists) ? track.artists.map((a) => typeof a === 'string' ? { name: a } : a) : [],
    album: track.album || { name: '', images: track.images || [] },
    duration: track.duration || 0,
  };

  localAudio.onloadedmetadata = () => {
    const dur = (localAudio.duration || 0) * 1000;
    update({ track: t, playing: true, position: 0, ts: performance.now(), duration: dur || t.duration });
  };

  localAudio.onended = () => {
    update({ playing: false, position: player.state.duration, ts: performance.now() });
    stopLocal();
  };

  localAudio.onerror = () => {
    toast('Could not play local file');
    stopLocal();
  };

  localAudio.play().catch(() => toast('Could not play local file'));

  // Position sync
  localTimer = setInterval(() => {
    if (!localAudio || localAudio.paused) return;
    const pos = (localAudio.currentTime || 0) * 1000;
    syncClock(pos, { playing: true });
  }, 500);

  // Override player controls for local playback
  player.kind = 'local';
}

// Wire local playback controls
const origToggle = player.toggle.bind(player);
const origPause = player.pause.bind(player);
const origResume = player.resume.bind(player);
const origSeek = player.seek.bind(player);
const origSetVolume = player.setVolume.bind(player);

player.toggle = function () {
  if (localAudio) {
    if (localAudio.paused) {
      localAudio.play();
      update({ playing: true, position: (localAudio.currentTime || 0) * 1000, ts: performance.now() });
    } else {
      localAudio.pause();
      update({ playing: false, position: (localAudio.currentTime || 0) * 1000, ts: performance.now() });
    }
    return;
  }
  return origToggle();
};

player.pause = function () {
  if (localAudio) {
    localAudio.pause();
    update({ playing: false, position: (localAudio.currentTime || 0) * 1000, ts: performance.now() });
    return;
  }
  return origPause();
};

player.resume = function () {
  if (localAudio) {
    localAudio.play();
    update({ playing: true, position: (localAudio.currentTime || 0) * 1000, ts: performance.now() });
    return;
  }
  return origResume();
};

player.seek = function (ms) {
  if (localAudio) {
    localAudio.currentTime = ms / 1000;
    update({ position: ms, ts: performance.now() });
    return;
  }
  return origSeek(ms);
};

const origSetVolumePlayer = player.setVolume;
player.setVolume = function (v) {
  v = Math.min(1, Math.max(0, v));
  if (localAudio) localAudio.volume = v;
  update({ volume: v });
  if (!localAudio) return this.backend?.setVolume(v);
};

// When the user starts a Spotify track, stop local playback
const origPlay = player.play.bind(player);
player.play = async function (body) {
  stopLocal();
  player.kind = player.backend ? (player.kind === 'local' ? 'web' : player.kind) : 'none';
  return origPlay(body);
};

// Listen for play-local events from the downloads view
bus.on('play-local', ({ track, path }) => playLocal(track, path));

export async function init(retry = false) {
  const os = await invoke('platform');
  const cfg = await invoke('get_config');
  const mode = cfg.engine || 'auto';
  const attempts = [];
  if (mode === 'auto' || mode === 'web') attempts.push(['web', async () => ((await eme()) ? sdkBackend() : Promise.reject(new Error('no DRM')))]);
  if ((mode === 'auto' || mode === 'soloist') && os === 'linux') attempts.push(['soloist', soloistBackend]);
  attempts.push(['remote', async () => remoteBackend()]);
  player.backend?.stop?.();
  for (const [kind, make] of attempts) {
    try {
      player.backend = await make();
      player.kind = kind;
      bus.emit('engine', { kind });
      if (kind === 'remote' && !retry) toast('Remote mode: controlling your other Spotify devices');
      return;
    } catch (e) {
      console.warn(`engine ${kind} failed:`, e);
      if (kind === 'soloist' && String(e).includes('NO_KEY')) bus.emit('engine-hint', 'soloist-key');
    }
  }
}
