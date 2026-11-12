// DOM helpers. Untrusted text is only ever set through textContent / attributes, never innerHTML.
import { rpc } from './api.js';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate') el[k] = !!v;
      else if (k === 'href') { el.setAttribute('href', safeHref(v)); }
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function safeHref(v) { return /^(https?:|mailto:|#)/i.test(String(v)) ? String(v) : '#'; }
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

// ---------- icons (original line icons, drawn as inline SVG) ----------
const ICONS = {
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  fetch: 'M12 4v12m0 0-4-4m4 4 4-4M5 20h14',
  pull: 'M12 4v12m0 0-4-4m4 4 4-4M5 20h14',
  push: 'M12 20V8m0 0-4 4m4-4 4 4M5 4h14',
  sync: 'M4 12a8 8 0 0 1 13.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.7L4 16m0 4v-4h4',
  branch: 'M6 4v12M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 4a2 2 0 1 0 0 .01M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 8c0 5-12 3-12 8',
  commit: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 12h6m6 0h6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2m5 0h3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6 6 18',
  chevronRight: 'M9 6l6 6-6 6',
  back: 'M19 12H5m0 0 6-6m-6 6 6 6',
  chevronDown: 'M6 9l6 6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  star: 'M12 4l2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2 8 13.7 4 9.8 9.5 9z',
  pr: 'M6 4v16M6 4a2 2 0 1 0 0 .01M18 20a2 2 0 1 0 0-.01M18 18V9a3 3 0 0 0-3-3h-4m0 0 2-2m-2 2 2 2',
  issue: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11.5v.01',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  stash: 'M4 8h16v11H4zM2 5h20v3H2zM10 12h4',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
  graph: 'M6 3v18M6 8c6 0 12 1 12 6v7M18 3v3',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  tree: 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  bolt: 'M13 3 5 13h6l-1 8 8-10h-6z',
  log: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  broom: 'M14 4l6 6M12 6l6 6-7 7H5v-6zM8 14l2 2',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  warn: 'M12 4 2 20h20zM12 10v4m0 3v.01',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  merge: 'M6 4v16M6 4a2 2 0 1 0 0 .01M6 9c0 4 6 5 12 5m0 0a2 2 0 1 0 0 .01',
  rocket: 'M12 15l-3-3c1-5 5-8 10-8 0 5-3 9-8 10zM9 12l-4 1-2 3 4 1M12 15l-1 4 3 2 1-4M15 9h.01',
  diff: 'M8 4v8M4 8h8M12 18h8M6 14l12 6M18 4v8',
};
export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `svg ${cls}`);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.more);
  svg.append(p);
  return svg;
}

export function btn(label, onClick, { cls = '', title, iconName, disabled, type } = {}) {
  return h('button', { class: `btn ${cls}`, title: title || (typeof label === 'string' && !label ? undefined : title), onclick: onClick, disabled, type: type || 'button' },
    iconName ? icon(iconName) : null, label || null);
}
export function iconBtn(name, title, onClick, cls = '') {
  return h('button', { class: `btn icon ghost ${cls}`, title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); onClick(e); } }, icon(name));
}

// ---------- formatting ----------
export function ago(t) {
  if (!t) return '';
  const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}
export function fmtDate(t) {
  const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function duration(a, b) {
  const s = Math.max(0, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }
export const short = (h) => (h || '').slice(0, 8);

// ---------- overlays ----------
const root = () => document.getElementById('overlay-root');
let modalStack = [];

export function modal({ title, body, actions = [], wide = false, onClose, initialFocus }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (v) => {
      back.remove();
      modalStack = modalStack.filter((m) => m !== back);
      document.removeEventListener('keydown', key, true);
      if (onClose) onClose(v);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    const foot = h('div', { class: 'mfoot' }, actions.map((a) => {
      const b = h('button', { class: `btn ${a.cls || ''}`, type: 'button', onclick: async () => {
        if (a.validate) { const err = await a.validate(); if (err) return; }
        close(typeof a.value === 'function' ? a.value() : a.value);
      } }, a.label);
      if (a.default) b.dataset.default = '1';
      return b;
    }));
    const dlg = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'mhead' }, h('h2', null, title), iconBtn('x', 'Close', () => close(undefined))),
      h('div', { class: 'mbody' }, body), actions.length ? foot : null);
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(undefined); } }, dlg);
    const key = (e) => {
      if (modalStack[modalStack.length - 1] !== back) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(undefined); }
      if (e.key === 'Enter' && (e.ctrlKey || (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON'))) {
        const d = foot.querySelector('[data-default]');
        if (d && !d.disabled) { e.preventDefault(); d.click(); }
      }
    };
    document.addEventListener('keydown', key, true);
    root().append(back);
    modalStack.push(back);
    setTimeout(() => {
      const f = initialFocus ? dlg.querySelector(initialFocus) : dlg.querySelector('input, textarea, select') || foot.querySelector('.btn:not(.danger)');
      if (f) f.focus();
    }, 20);
    dlg.closeModal = close;
  });
}

/** Confirmation for anything destructive. Lists exactly what will be lost. */
export function confirmDanger({ title, message, items = [], recover, confirmLabel = 'Confirm', danger = true }) {
  const body = h('div', { class: 'col' },
    h('div', null, message),
    items.length ? h('ul', { class: 'loss-list' }, items.slice(0, 500).map((i) => h('li', null, i)), items.length > 500 ? h('li', null, `… and ${items.length - 500} more`) : null) : null,
    recover ? h('div', { class: recover.startsWith('Cannot') || recover.startsWith('Not recoverable') ? 'danger-box' : 'info-box' }, recover) : null);
  return modal({
    title, body,
    actions: [{ label: 'Cancel', value: false, default: !danger }, { label: confirmLabel, cls: danger ? 'danger solid' : 'primary', value: true, default: false }],
    initialFocus: '.mfoot .btn:first-child',
  }).then((v) => !!v);
}

/** Generic form dialog. fields: [{ name, label, type, value, options, placeholder, required, hint }] */
export function form({ title, fields, submit = 'OK', wide = false, intro, danger }) {
  const inputs = {};
  const errBox = h('div', { class: 'errbox hidden' });
  const body = h('div', { class: 'col' }, intro || null, fields.map((f) => {
    let el;
    if (f.type === 'textarea') el = h('textarea', { rows: f.rows || 6, placeholder: f.placeholder || '' }, f.value || '');
    else if (f.type === 'select') el = h('select', null, f.options.map((o) => (typeof o === 'string' ? h('option', { value: o, selected: o === f.value }, o) : h('option', { value: o.value, selected: o.value === f.value }, o.label))));
    else if (f.type === 'checkbox') el = h('input', { type: 'checkbox', checked: !!f.value });
    else el = h('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', spellcheck: 'false' });
    if (f.type !== 'textarea' && f.type !== 'checkbox' && f.type !== 'select') el.style.width = '100%';
    if (f.type === 'textarea') el.style.width = '100%';
    inputs[f.name] = el;
    if (f.type === 'checkbox') return h('label', { class: 'check' }, el, f.label, f.hint ? h('span', { class: 'muted' }, ` ${f.hint}`) : null);
    return h('label', { class: 'field' }, h('span', null, f.label), el, f.hint ? h('span', { class: 'faint' }, f.hint) : null);
  }), errBox);
  const read = () => Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value]));
  return modal({
    title, body, wide,
    actions: [
      { label: 'Cancel', value: null },
      { label: submit, cls: danger ? 'danger solid' : 'primary', default: true, value: read, validate: () => {
        const v = read();
        for (const f of fields) {
          if (f.required && !String(v[f.name]).trim()) { errBox.textContent = `${f.label} is required.`; errBox.classList.remove('hidden'); return true; }
          if (f.validate) { const m = f.validate(v[f.name], v); if (m) { errBox.textContent = m; errBox.classList.remove('hidden'); return true; } }
        }
        return false;
      } },
    ],
  });
}

export function prompt(title, label, value = '', opts = {}) {
  return form({ title, fields: [{ name: 'v', label, value, required: true, ...opts }], submit: opts.submit || 'OK' }).then((r) => (r ? r.v.trim() : null));
}

// ---------- context menu ----------
let openMenu = null;
export function menu(x, y, items) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => {
    if (it === '-') return h('div', { class: 'msep' });
    if (it.label && it.header) return h('div', { class: 'mlabel' }, it.label);
    return h('button', { class: it.danger ? 'danger' : '', disabled: it.disabled, title: it.title || '', role: 'menuitem', onclick: () => { closeMenu(); it.action(); } },
      it.icon ? icon(it.icon, 'sm') : h('span', { style: { width: '14px' } }), it.label);
  }));
  root().append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 6))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 6))}px`;
  openMenu = el;
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc, true);
  });
  const first = el.querySelector('button:not(:disabled)');
  if (first) first.focus();
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function esc(e) {
  if (!openMenu) return;
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const bs = [...openMenu.querySelectorAll('button:not(:disabled)')];
    const i = bs.indexOf(document.activeElement);
    bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus();
  }
}
export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', esc, true);
}
export function menuAt(ev, items) { ev.preventDefault(); ev.stopPropagation(); menu(ev.clientX, ev.clientY, items); }
export function menuBelow(el, items) { const r = el.getBoundingClientRect(); menu(r.left, r.bottom + 2, items); }

// ---------- banners & errors ----------
export function banner({ level = 'info', title, body, url, timeout = 6000, actions = [] }) {
  const host = document.getElementById('banners');
  const el = h('div', { class: `banner ${level}`, role: level === 'error' ? 'alert' : 'status' },
    h('div', { class: 'grow' },
      h('div', { class: 'bt' }, title),
      body ? h('div', { class: 'bb' }, body) : null,
      (url || actions.length) ? h('div', { class: 'row', style: { marginTop: '6px' } },
        url ? h('a', { onclick: () => rpc('open.url', { url }) }, 'Open') : null,
        actions.map((a) => h('a', { onclick: () => { a.action(); el.remove(); } }, a.label))) : null),
    iconBtn('x', 'Dismiss', () => el.remove()));
  host.append(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
  while (host.children.length > 5) host.firstChild.remove();
  return el;
}

/** Show a failure with the real git/gh output and the exact command. */
export function showError(e, title = 'Operation failed') {
  const details = h('div', { class: 'col' },
    h('div', { class: 'errbox' }, e.stderr && e.stderr.trim() && !e.message.includes(e.stderr.trim().slice(0, 40)) ? `${e.message}\n\n${e.stderr.trim()}` : e.message),
    e.command ? h('div', null, h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' } }, `Command${e.code != null ? ` (exit code ${e.code})` : ''}`), h('div', { class: 'cmdline' }, e.command)) : null);
  return modal({ title, body: details, actions: [{ label: 'Copy details', value: 'copy' }, { label: 'Close', cls: 'primary', value: null, default: true }] })
    .then((v) => { if (v === 'copy') copyText(`${e.message}\n${e.command || ''}\n${e.stderr || ''}`); });
}

/** Run an async action with error reporting. Returns the result or undefined on failure. */
export async function act(fn, { ok, title } = {}) {
  try {
    const r = await fn();
    if (ok) banner({ level: 'success', title: typeof ok === 'function' ? ok(r) : ok, timeout: 3500 });
    return r;
  } catch (e) {
    showError(e, title);
    return undefined;
  }
}

export function copyText(t) {
  navigator.clipboard.writeText(t).then(() => banner({ level: 'info', title: 'Copied to clipboard', timeout: 1500 }), () => banner({ level: 'error', title: 'Could not copy to clipboard' }));
}

// ---------- safe markdown (DOM-built, no raw HTML) ----------
export function markdown(src) {
  const el = h('div', { class: 'md' });
  if (!src || !src.trim()) { el.append(h('p', { class: 'muted' }, 'No description.')); return el; }
  src = src.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(l);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      const pre = h('pre', null, h('code', null, buf.join('\n')));
      if (fence[2] === 'suggestion') el.append(h('div', { class: 'suggestion' }, h('div', null, 'Suggested change'), pre));
      else el.append(pre);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const hd = /^(#{1,6})\s+(.*)$/.exec(l);
    if (hd) { el.append(h(`h${Math.min(4, hd[1].length)}`, null, inline(hd[2]))); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { el.append(h('hr')); i++; continue; }
    if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const bq = h('blockquote'); bq.append(markdown(buf.join('\n'))); el.append(bq); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const t = h('table', null, h('tr', null, cells(rows[0]).map((c) => h('th', null, inline(c)))), rows.slice(2).map((r) => h('tr', null, cells(r).map((c) => h('td', null, inline(c))))));
      el.append(t); continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const list = h(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) { if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) { list.lastChild.append(' ', inline(lines[i].trim())); i++; continue; } break; }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
        const item = h('li', { style: m[1].length >= 2 ? { marginLeft: `${Math.min(m[1].length, 8) * 6}px` } : null });
        if (task) item.append(h('input', { type: 'checkbox', checked: task[1] !== ' ', disabled: true }), ' ', inline(task[2]));
        else item.append(inline(m[3]));
        list.append(item); i++;
      }
      el.append(list); continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    const p = h('p');
    buf.forEach((b, k) => { if (k) p.append(h('br')); p.append(inline(b)); });
    el.append(p);
  }
  return el;
}

function inline(text) {
  const frag = document.createDocumentFragment();
  // strip raw HTML tags but keep their text; render <br> as space
  text = text.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-zA-Z][^>]*>/g, '');
  const rx = /(`[^`]+`)|(!\[([^\]]*)\]\(([^)\s]+)[^)]*\))|(\[([^\]]+)\]\(([^)\s]+)[^)]*\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0; let m;
  while ((m = rx.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1]) frag.append(h('code', null, m[1].slice(1, -1)));
    else if (m[2]) { if (/^https:\/\//.test(m[4])) frag.append(h('img', { src: m[4], alt: m[3], loading: 'lazy', referrerpolicy: 'no-referrer' })); else frag.append(m[3]); }
    else if (m[5]) frag.append(link(m[7], m[6]));
    else if (m[8]) frag.append(h('strong', null, inline(m[8].slice(2, -2))));
    else if (m[9]) frag.append(h('em', null, inline(m[9].slice(1, -1))));
    else if (m[10]) frag.append(h('s', null, inline(m[10].slice(2, -2))));
    else if (m[11]) frag.append(link(m[11], m[11]));
    last = rx.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
function link(url, label) {
  if (!/^https?:\/\//i.test(url)) return document.createTextNode(label);
  return h('a', { href: url, title: url }, label);
}

// All external links open in the system browser, never inside the app window.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (/^https?:\/\//i.test(href)) { e.preventDefault(); rpc('open.url', { url: href }).catch(() => {}); }
  else if (href === '#') e.preventDefault();
});

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export function statusBadge(status, conclusion) {
  const s = (status || '').toLowerCase(); const c = (conclusion || '').toLowerCase();
  if (s && s !== 'completed') return h('span', { class: 'badge run' }, h('span', { class: 'dot run' }), s.replace(/_/g, ' '));
  if (c === 'success') return h('span', { class: 'badge ok' }, icon('check', 'sm'), 'passed');
  if (['failure', 'timed_out', 'startup_failure', 'action_required', 'error'].includes(c)) return h('span', { class: 'badge bad' }, icon('x', 'sm'), c.replace(/_/g, ' '));
  if (c === 'cancelled') return h('span', { class: 'badge' }, 'cancelled');
  if (c === 'skipped' || c === 'neutral') return h('span', { class: 'badge' }, c);
  return h('span', { class: 'badge' }, c || s || 'unknown');
}
export function runDot(status, conclusion) {
  const s = (status || '').toLowerCase(); const c = (conclusion || '').toLowerCase();
  if (s && s !== 'completed') return h('span', { class: 'dot run', title: s });
  if (c === 'success') return h('span', { class: 'dot ok', title: 'passed' });
  if (['failure', 'timed_out', 'startup_failure', 'action_required', 'error'].includes(c)) return h('span', { class: 'dot bad', title: c });
  return h('span', { class: 'dot', title: c || s });
}
