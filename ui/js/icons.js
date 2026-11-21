const s = (d, fill = true) =>
  fill
    ? `<svg viewBox="0 0 24 24" fill="currentColor">${d}</svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const icons = {
  expand: s('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>', false),
  timer: s('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9.5 2.5h5"/>', false),
  sliders: s('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.4" fill="currentColor"/><circle cx="15" cy="17" r="2.4" fill="currentColor"/>', false),
  home: s('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>', false),
  search: s('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', false),
  heart: s('<path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.6 4.5 7.2 4.5c2 0 3.5 1.1 4.8 2.8 1.3-1.7 2.8-2.8 4.8-2.8 3.6 0 5.8 3.5 4.5 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/>', false),
  heartFill: s('<path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.6 4.5 7.2 4.5c2 0 3.5 1.1 4.8 2.8 1.3-1.7 2.8-2.8 4.8-2.8 3.6 0 5.8 3.5 4.5 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/>'),
  settings: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', false),
  play: s('<path d="M7 4.6v14.8a1 1 0 0 0 1.5.9l12-7.4a1 1 0 0 0 0-1.8l-12-7.4A1 1 0 0 0 7 4.6z"/>'),
  pause: s('<rect x="5.5" y="4" width="4.5" height="16" rx="1.4"/><rect x="14" y="4" width="4.5" height="16" rx="1.4"/>'),
  next: s('<path d="M4 5.3v13.4a1 1 0 0 0 1.5.8l9.6-6.7a1 1 0 0 0 0-1.6L5.5 4.5A1 1 0 0 0 4 5.3z"/><rect x="17" y="4.5" width="3" height="15" rx="1.2"/>'),
  prev: s('<path d="M20 5.3v13.4a1 1 0 0 1-1.5.8l-9.6-6.7a1 1 0 0 1 0-1.6l9.6-6.7a1 1 0 0 1 1.5.8z"/><rect x="4" y="4.5" width="3" height="15" rx="1.2"/>'),
  shuffle: s('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>', false),
  repeat: s('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>', false),
  repeatOne: s('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>', false),
  lyrics: s('<path d="M4 6h12M4 11h16M4 16h9"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M21 17.5V10"/>', false),
  queue: s('<path d="M3 6h13M3 11h13M3 16h8"/><path d="M17 14v7l5-3.5z" fill="currentColor"/>', false),
  volume: s('<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>', false),
  volumeLow: s('<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>', false),
  mute: s('<path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/><path d="m16 9 6 6M22 9l-6 6"/>', false),
  chevronLeft: s('<path d="m15 18-6-6 6-6"/>', false),
  chevronDown: s('<path d="m6 9 6 6 6-6"/>', false),
  close: s('<path d="M18 6 6 18M6 6l12 12"/>', false),
  plugin: s('<path d="M9 3h6v4a2 2 0 1 0 4 0h2v6h-2a2 2 0 1 0 0 4h2v4h-6v-2a2 2 0 1 0-4 0v2H3v-6h2a2 2 0 1 0 0-4H3V3h6z"/>', false),
  music: s('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', false),
  folder: s('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', false),
  plus: s('<path d="M12 5v14M5 12h14"/>', false),
  more: s('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>'),
  check: s('<path d="M5 12.5 10 17 19 7"/>', false),
  userPlus: s('<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>', false),
  refresh: s('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>', false),
  download: s('<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>', false),
  downloaded: s('<path d="M5 12.5 10 17 19 7"/><rect x="2" y="2" width="20" height="20" rx="4"/>', false),
  exportFile: s('<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 15h6"/><path d="M12 12v6"/>', false),
};

export function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((el) => {
    const name = el.dataset.icon;
    if (el.dataset.done === name) return;
    el.innerHTML = icons[name] || '';
    el.dataset.done = name;
  });
}

export function setIcon(el, name) {
  const i = el.matches('i') ? el : el.querySelector('i[data-icon]');
  if (!i || i.dataset.icon === name) return;
  i.dataset.icon = name;
  i.innerHTML = icons[name] || '';
  i.dataset.done = name;
}
