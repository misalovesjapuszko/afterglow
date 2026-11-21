# Afterglow plugins

Plugins are plain `.js` files, themes are `.css` files. Put them in the plugins folder:

- Linux: `~/.config/afterglow/plugins/`
- Windows: `%APPDATA%\Afterglow\plugins\`

Settings → Plugins has **Open folder**, **Reload**, and an on/off switch per plugin. A file ending in anything else (like `theme.css.off`) is ignored.

Every plugin gets a `Afterglow` object.

## Player

```js
Afterglow.player.state            // { track, playing, position, duration, volume, shuffle, repeat, context }
Afterglow.player.engine           // 'web' | 'soloist' | 'remote'
Afterglow.player.play(uri)        // track, album, playlist or artist URI
Afterglow.player.play([uri, uri], startIndex)
Afterglow.player.pause() / resume() / toggle() / next() / prev()
Afterglow.player.seek(ms)
Afterglow.player.setVolume(0..1)
Afterglow.player.setShuffle(true)
Afterglow.player.cycleRepeat()
Afterglow.player.queue(trackUri)
```

A track looks like `{ uri, id, name, artists: [{ name, uri, id }], album: { name, uri, id, images }, duration }`.

## Events

```js
Afterglow.on('track', (track) => {})     // song changed
Afterglow.on('state', (state) => {})     // play/pause/seek/volume...
Afterglow.on('lyrics', ({ track, mode, lines }) => {})
Afterglow.on('page', ({ route, param }) => {})
Afterglow.on('liked-changed', ({ uri, on }) => {})
```

`Afterglow.on` returns a function that unsubscribes.

## Spotify Web API

```js
const me = await Afterglow.api('/me');
await Afterglow.api('/me/player/queue', { method: 'POST', query: { uri } });
const text = await Afterglow.fetchText('https://example.com/data.json');  // no CORS limits
```

## Lyrics

Add your own lyrics source. Higher priority runs first; the built-in LRCLIB source has priority -100.

```js
Afterglow.lyrics.addProvider(async (track) => {
  const lrc = await Afterglow.fetchText(`https://my-lyrics.example/${track.id}.lrc`).catch(() => null);
  return lrc ? { synced: Afterglow.lyrics.parseLRC(lrc), source: 'My lyrics' } : null;
}, { priority: 10 });
```

Return `{ synced: [{ time, text }] }`, `{ plain: ['line', ...] }`, `{ instrumental: true }` or `null`.

## UI

```js
Afterglow.ui.toast('Hello');
Afterglow.ui.menu(event, [{ label: 'One', onClick() {} }, '-', { label: 'Two', disabled: true }]);
Afterglow.ui.addPlayerButton({ id, title, icon: '<svg…>', onClick(e) {} });
Afterglow.ui.addSidebarItem({ label: 'Stats', icon, page: 'stats' });
Afterglow.ui.registerPage('stats', { title: 'Stats', render(el) { el.innerHTML = '<h1 class="page-title">Stats</h1>'; } });
Afterglow.ui.addTrackMenuItem({ label: 'Search on YouTube', onClick(track) {} });
Afterglow.ui.addStyle('.lyric.active { color: gold }');
Afterglow.ui.navigate('artist', id);   // 'home' | 'search' | 'liked' | 'playlist' | 'album' | 'artist' | 'settings' | 'plugin'
Afterglow.ui.openNowPlaying();
Afterglow.icons.heart                  // built-in SVG icons
```

## Storage

```js
Afterglow.storage.set('count', 3);
Afterglow.storage.get('count', 0);
```

## Themes

Themes override CSS variables (and anything else):

```css
:root {
  --bg: #0b0b10;
  --bg-elev: #15151c;
  --sidebar: rgba(18, 18, 24, 0.72);
  --text: #f5f5f7;
  --muted: #9a9aa3;
  --accent: #fa2d48;      /* set this to stop the album-art tint */
  --lyric-size: 38px;
}
```

See the examples that are created in the folder on first run: `sleep-timer.js`, `now-playing-title.js`, `theme-sunset.css.off`.
