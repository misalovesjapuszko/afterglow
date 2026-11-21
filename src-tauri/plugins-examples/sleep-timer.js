const moon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
let timer = null;
let until = 0;

function set(minutes) {
  clearTimeout(timer);
  timer = null;
  until = 0;
  if (minutes) {
    until = Date.now() + minutes * 60000;
    timer = setTimeout(() => {
      Afterglow.player.pause();
      Afterglow.ui.toast('Sleep timer: paused');
      until = 0;
      btn.classList.remove('active');
    }, minutes * 60000);
    Afterglow.ui.toast(`Pausing in ${minutes} min`);
  } else {
    Afterglow.ui.toast('Sleep timer off');
  }
  btn.classList.toggle('active', !!minutes);
}

const btn = Afterglow.ui.addPlayerButton({
  id: 'sleep-timer',
  title: 'Sleep timer',
  icon: moon,
  onClick(e) {
    const left = until ? Math.ceil((until - Date.now()) / 60000) : 0;
    Afterglow.ui.menu(e, [
      ...(left ? [{ label: `${left} min left`, disabled: true }] : []),
      { label: '15 minutes', onClick: () => set(15) },
      { label: '30 minutes', onClick: () => set(30) },
      { label: '1 hour', onClick: () => set(60) },
      { label: 'Turn off', onClick: () => set(0) },
    ]);
  },
});
