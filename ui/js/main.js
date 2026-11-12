import { rpc, connect, on, onPending, onConnection } from './api.js';
import { h, mount, icon, banner, act, menuBelow } from './dom.js';
import { store, setRepos, updateSummary, emit, subscribe, prefs, boardState, current } from './store.js';
import { initSidebar } from './sidebar.js';
import { onRoute, navigate, start as startRouter } from './router.js';
import { renderRepo } from './repoview.js';
import { openPalette } from './palette.js';

const main = document.getElementById('main');
let disposeView = null;

function applyTheme() {
  const t = store.config ? store.config.theme : 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- top bar ----------
const NAV = [
  ['repo', 'Repositories', 'folder', () => { const id = store.selected || prefs.get('lastRepo') || (store.repos[0] && store.repos[0].id); navigate(id ? `#/repo/${id}/${store.tab}` : '#/repo'); }],
  ['board', 'Actions board', 'bolt', () => navigate('#/board')],
  ['feature', 'Feature branches', 'branch', () => navigate('#/feature')],
  ['multi', 'All repositories', 'layers', () => navigate('#/multi')],
  ['activity', 'Activity', 'log', () => navigate('#/activity')],
  ['settings', 'Settings', 'gear', () => navigate('#/settings')],
];
function renderTopbar() {
  const tb = document.getElementById('topbar');
  const counts = { failure: 0, running: 0 };
  for (const b of Object.values(store.board)) { const s = boardState(b); if (s === 'failure') counts.failure++; if (s === 'running') counts.running++; }
  const activeTrackers = store.trackers.filter((t) => t.state === 'waiting' || t.state === 'running').length;
  const reviews = store.myprs ? store.myprs.review.length : 0;
  mount(tb,
    h('div', { class: 'brand' }, h('img', { src: '/icon.svg', alt: '' }), 'git-helper'),
    NAV.map(([k, label, ic, go]) => h('button', { class: `navbtn ${store.view === k ? 'active' : ''}`, onclick: go, title: label }, icon(ic), label)),
    h('span', { class: 'spacer' }),
    reviews ? h('span', { class: 'indicator', title: 'Pull requests waiting for your review', onclick: (e) => reviewMenu(e.currentTarget) }, icon('eye', 'sm'), `${reviews} review${reviews === 1 ? '' : 's'}`) : null,
    h('span', { class: 'indicator', title: 'Default-branch workflow runs across all repositories. Click for the Actions board.', onclick: () => navigate('#/board') },
      counts.failure ? h('span', { class: 'row', style: { gap: '4px', color: 'var(--bad)' } }, h('span', { class: 'dot bad' }), `${counts.failure} failing`) : null,
      counts.running || activeTrackers ? h('span', { class: 'row', style: { gap: '4px', color: 'var(--run)' } }, h('span', { class: 'dot run' }), `${counts.running + activeTrackers} running`) : null,
      !counts.failure && !counts.running && !activeTrackers ? h('span', { class: 'row', style: { gap: '4px' } }, h('span', { class: `dot ${Object.keys(store.board).length ? 'ok' : ''}` }), Object.keys(store.board).length ? 'All green' : 'Actions') : null));
}
function reviewMenu(el) {
  menuBelow(el, store.myprs.review.map((p) => ({ label: `${p.repo}#${p.number}  ${p.title}`, icon: 'pr', action: () => openPr(p) })));
}
function openPr(p) {
  const r = store.repos.find((x) => x.slug && `${x.slug.owner}/${x.slug.repo}`.toLowerCase() === p.repo.toLowerCase());
  if (r) navigate(`#/repo/${r.id}/prs/${p.number}`); else rpc('open.url', { url: p.url });
}

// ---------- status bar ----------
let pendingCount = 0;
let lastErr = null;
function renderStatus() {
  const sb = document.getElementById('statusbar');
  const busy = store.repos.filter((r) => r.busy);
  mount(sb,
    h('span', { class: 'item', title: store.connected ? 'Connected to the local server' : 'Lost connection to the local server' },
      h('span', { class: `dot ${store.connected ? 'ok' : 'bad'}` }), store.connected ? 'Connected' : 'Disconnected — retrying'),
    busy.length ? h('span', { class: 'item', title: busy.map((r) => `${r.label}: ${r.busy.label}`).join('\n') }, icon('refresh', 'sm spin'), busy.length === 1 ? `${busy[0].label}: ${busy[0].busy.label}` : `${busy.length} operations running`) : null,
    pendingCount && !busy.length ? h('span', { class: 'item' }, icon('refresh', 'sm spin'), 'Working…') : null,
    lastErr ? h('span', { class: 'item', style: { color: 'var(--bad)' }, onclick: () => navigate('#/activity'), title: lastErr.error }, icon('warn', 'sm'), `Last failure: ${lastErr.command.split(' ').slice(0, 4).join(' ')}…`) : null,
    h('span', { class: 'spacer' }),
    h('span', { class: 'item', onclick: () => openPalette() }, h('span', { class: 'kbd' }, 'Ctrl+P'), 'Go to repository'),
    h('span', { class: 'item', onclick: () => navigate('#/activity') }, icon('log', 'sm'), 'Activity log'));
}

// ---------- routing ----------
onRoute((parts) => {
  if (disposeView) { try { disposeView(); } catch {} disposeView = null; }
  const [view = 'repo', a, b, c] = parts;
  store.view = view;
  rpc('app.boardVisible', { visible: view === 'board' }).catch(() => {});
  if (view === 'repo') {
    const id = a && store.byId.has(a) ? a : (store.selected && store.byId.has(store.selected) ? store.selected : null);
    store.selected = id;
    if (id) prefs.set('lastRepo', id);
    if (b) store.tab = b;
    emit('selected');
    disposeView = renderRepo(main, id, store.tab, c);
  } else {
    const loaders = {
      board: () => import('./views/board.js'), feature: () => import('./views/feature.js'), multi: () => import('./views/multi.js'),
      activity: () => import('./views/activity.js'), settings: () => import('./views/settings.js'),
    };
    const load = loaders[view];
    if (!load) { navigate('#/repo'); return; }
    mount(main, h('div', { class: 'skeleton' }, 'Loading…'));
    load().then((m) => { if (store.view === view) disposeView = m.render(main, parts.slice(1)); }).catch((e) => mount(main, h('div', { class: 'errbox' }, e.message)));
  }
  renderTopbar();
});

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette(); }
  else if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) { e.preventDefault(); const r = current(); act(() => rpc('repos.refresh', r ? { id: r.id } : {})); emit('refresh'); }
  else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); navigate('#/board'); }
  else if (e.altKey && /^[1-7]$/.test(e.key) && store.view === 'repo' && store.selected) {
    e.preventDefault();
    const tabs = ['changes', 'graph', 'branches', 'stashes', 'prs', 'issues', 'actions'];
    navigate(`#/repo/${store.selected}/${tabs[+e.key - 1]}`);
  }
});

// sidebar resize
(function resizer() {
  const r = document.getElementById('resizer');
  const side = document.getElementById('sidebar');
  side.style.width = `${prefs.get('sideWidth', 300)}px`;
  r.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => { side.style.width = `${Math.max(200, Math.min(600, ev.clientX))}px`; };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); prefs.set('sideWidth', parseInt(side.style.width, 10)); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
})();

// ---------- boot ----------
async function boot() {
  try {
    store.config = await rpc('config.get');
  } catch (e) {
    mount(main, h('div', { class: 'empty' }, h('h3', null, 'Cannot reach git-helper'), h('div', null, e.message)));
    return;
  }
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  const { repos, roots } = await rpc('repos.list');
  store.roots = roots;
  setRepos(repos);
  const b = await rpc('board.get'); store.board = b.board || {}; store.boardAt = b.at;
  store.trackers = await rpc('trackers.list');
  store.myprs = await rpc('myprs.get');
  initSidebar(document.getElementById('sidebar'));
  renderTopbar(); renderStatus();

  on('repos', (list) => { setRepos(list); renderTopbar(); });
  on('summary', ({ id, summary, busy }) => { updateSummary(id, summary, busy); renderStatus(); });
  on('board', ({ board, at }) => { store.board = board; store.boardAt = at; emit('board'); renderTopbar(); });
  on('trackers', (t) => { store.trackers = t; emit('trackers'); renderTopbar(); });
  on('myprs', (d) => { store.myprs = d; emit('myprs'); renderTopbar(); });
  on('notify', (n) => banner({ level: n.level, title: n.title, body: n.body, url: n.url, timeout: n.level === 'error' ? 0 : 10000 }));
  on('activity', (a) => { if (!a.ok) { lastErr = a; renderStatus(); } emit('activity', a); });
  onPending((n) => { pendingCount = n; renderStatus(); });
  onConnection((ok) => { store.connected = ok; renderStatus(); if (ok) rpc('repos.list').then(({ repos: l }) => setRepos(l)).catch(() => {}); });
  subscribe('config', () => { applyTheme(); renderTopbar(); });
  connect();

  // refresh on focus (cheap: one status call per repo, done server-side in parallel)
  let lastFocus = 0;
  window.addEventListener('focus', () => {
    if (Date.now() - lastFocus < 3000) return;
    lastFocus = Date.now();
    rpc('repos.refresh', {}).catch(() => {});
    emit('refresh');
  });

  if (!store.config.firstRunDone || !store.config.roots.length) history.replaceState(null, '', '#/settings/setup');
  else if (!location.hash) {
    const last = prefs.get('lastRepo');
    history.replaceState(null, '', last && store.byId.has(last) ? `#/repo/${last}/changes` : '#/repo');
  }
  startRouter();
}
boot();
