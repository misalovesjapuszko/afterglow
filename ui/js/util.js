export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmt = (ms) => {
  ms = Math.max(0, ms || 0);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

const listeners = new Map();
export const bus = {
  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
    return () => listeners.get(ev)?.delete(fn);
  },
  off(ev, fn) {
    listeners.get(ev)?.delete(fn);
  },
  emit(ev, data) {
    listeners.get(ev)?.forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error(`[${ev}]`, e);
      }
    });
  },
};

export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('afterglow:' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('afterglow:' + k, JSON.stringify(v));
    } catch {}
  },
};

export function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function img(images, size = 300) {
  if (!images?.length) return '';
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 640) >= size) || sorted[sorted.length - 1]).url;
}

export function menu(e, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-' || it.separator) {
      m.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
      continue;
    }
    const b = document.createElement('button');
    b.className = 'menu-item';
    b.textContent = it.label;
    b.disabled = !!it.disabled;
    b.onclick = () => {
      hideMenu();
      it.onClick?.();
    };
    m.appendChild(b);
  }
  m.hidden = false;
  const r = e.currentTarget?.getBoundingClientRect?.();
  let x = e.clientX ?? r?.left ?? 100;
  let y = e.clientY ?? r?.bottom ?? 100;
  const { width, height } = m.getBoundingClientRect();
  if (x + width > innerWidth - 8) x = innerWidth - width - 8;
  if (y + height > innerHeight - 8) y = y - height - (r ? r.height : 0);
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = Math.max(8, y) + 'px';
  e.preventDefault?.();
  e.stopPropagation?.();
}

export function hideMenu() {
  $('#menu').hidden = true;
}

export function slider(el, { onInput, onChange }) {
  const fill = el.querySelector('.slider-fill');
  const knob = el.querySelector('.slider-knob');
  let dragging = false;
  const set = (v) => {
    v = Math.min(1, Math.max(0, v));
    fill.style.width = v * 100 + '%';
    if (knob) knob.style.left = v * 100 + '%';
  };
  const at = (e) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    set(at(e));
    onInput?.(at(e));
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    set(at(e));
    onInput?.(at(e));
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    onChange?.(at(e));
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return { set: (v) => !dragging && set(v), get dragging() { return dragging; } };
}

export function dialog({ title, text = '', fields = [], confirm = 'Save', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'dialog-wrap';
    wrap.innerHTML = `<div class="dialog"><h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
      ${fields.map((f) => `<label class="dlg-label">${esc(f.label || '')}${f.multiline ? `<textarea class="field" data-k="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}" rows="3">${esc(f.value || '')}</textarea>` : `<input class="field" data-k="${esc(f.key)}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}" spellcheck="false">`}</label>`).join('')}
      <div class="dlg-actions"><button class="pill-btn" data-act="cancel">Cancel</button><button class="pill-btn ${danger ? 'danger' : 'accent'}" data-act="ok">${esc(confirm)}</button></div></div>`;
    document.body.appendChild(wrap);
    const done = (ok) => {
      const values = {};
      wrap.querySelectorAll('[data-k]').forEach((el) => (values[el.dataset.k] = el.value.trim()));
      wrap.remove();
      resolve(ok ? values : null);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) done(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) done(act === 'ok');
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') done(true);
    });
    setTimeout(() => (wrap.querySelector('[data-k]') || wrap.querySelector('[data-act="ok"]'))?.focus(), 30);
  });
}

const send = (level, args) => {
  try {
    const msg = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    window.__TAURI__?.core.invoke('js_log', { level, msg }).catch(() => {});
  } catch {}
};
for (const level of ['warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    send(level, args);
  };
}
window.addEventListener('error', (e) => send('error', [e.error || e.message]));
window.addEventListener('unhandledrejection', (e) => send('error', ['unhandled:', e.reason]));
export const log = (...args) => send('info', args);
