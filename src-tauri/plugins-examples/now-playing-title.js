Afterglow.on('track', (t) => {
  document.title = t ? `${t.name} · ${t.artists.map((a) => a.name).join(', ')}` : 'Afterglow';
});
