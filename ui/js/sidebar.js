// Repository tree with dirty highlighting, filters and favourites.
import { h, mount, icon, iconBtn, menuAt, act, copyText, banner, runDot } from './dom.js';
import { rpc } from './api.js';
import { store, subscribe, prefs, boardFor, boardState, emit } from './store.js';
import { navigate } from './router.js';

let el;
let treeEl;
let filter = prefs.get('filter', '');
let dirtyOnly = prefs.get('dirtyOnly', false);
let sortDirty = prefs.get('sortDirty', true);
let collapsed = new Set(prefs.get('collapsed', []));

export function initSidebar(root) {
  el = root;
  const input = h('input', { type: 'search', placeholder: 'Filter (Ctrl+P to jump)', value: filter, style: { flex: '1' }, oninput: (e) => { filter = e.target.value; prefs.set('filter', filter); renderTree(); } });
  const dirtyBtn = h('button', { class: `toggle ${dirtyOnly ? 'on' : ''}`, title: 'Show only repositories with changes, unpushed or unpulled commits, or an operation in progress',
    onclick: () => { dirtyOnly = !dirtyOnly; prefs.set('dirtyOnly', dirtyOnly); dirtyBtn.classList.toggle('on', dirtyOnly); renderTree(); } }, 'Needs attention');
  const sortBtn = h('button', { class: `toggle ${sortDirty ? 'on' : ''}`, title: 'Put repositories that need attention first within each folder',
    onclick: () => { sortDirty = !sortDirty; prefs.set('sortDirty', sortDirty); sortBtn.classList.toggle('on', sortDirty); renderTree(); } }, 'Dirty first');
  const tools = h('div', { class: 'side-tools' },
    h('div', { class: 'row', style: { gap: '2px' } }, input,
      iconBtn('fetch', 'Fetch all repositories', () => fetchAll()),
      iconBtn('refresh', 'Refresh status of all repositories (rescan folders)', () => act(() => rpc('repos.scan'))),
      iconBtn('plus', 'Clone or add repositories', () => import('./onboarding.js').then((m) => m.cloneDialog()))),
    h('div', { class: 'row', style: { gap: '6px' } }, dirtyBtn, sortBtn));
  treeEl = h('div', { class: 'tree', role: 'tree' });
  mount(el, tools, treeEl);
  subscribe('repos', renderTree);
  subscribe('summary', () => scheduleRender());
  subscribe('board', () => scheduleRender());
  subscribe('selected', () => renderTree());
  subscribe('myprs', () => scheduleRender());
  renderTree();
}

let pend = null;
function scheduleRender() { if (pend) return; pend = requestAnimationFrame(() => { pend = null; renderTree(); }); }

export function needsAttention(r) {
  const s = r.summary;
  if (!s) return false;
  return s.dirty > 0 || s.ahead > 0 || s.unpushed > 0 || (s.inProgress && s.inProgress.length) || s.locked || s.behind > 0;
}

function matches(r) {
  if (filter) {
    const f = filter.toLowerCase();
    if (!r.label.toLowerCase().includes(f) && !(r.summary && r.summary.branch && r.summary.branch.toLowerCase().includes(f))) return false;
  }
  if (dirtyOnly && !needsAttention(r)) return false;
  return true;
}

function myPrCount(r) {
  if (!store.myprs || !r.slug) return 0;
  const key = `${r.slug.owner}/${r.slug.repo}`.toLowerCase();
  return store.myprs.mine.filter((p) => p.repo.toLowerCase() === key).length;
}

function renderTree() {
  if (!treeEl) return;
  const scroll = treeEl.scrollTop;
  const roots = new Map();
  for (const r of store.repos) {
    if (!roots.has(r.root)) roots.set(r.root, { name: r.rootName, path: r.root, repos: [] });
    roots.get(r.root).repos.push(r);
  }
  const out = [];
  const favs = store.config ? store.config.favourites || [] : [];
  const favRepos = store.repos.filter((r) => favs.includes(r.path) && matches(r));
  if (favRepos.length) {
    out.push(wsHead('fav', 'Favourites', favRepos));
    if (!collapsed.has('fav')) for (const r of sortList(favRepos)) out.push(repoRow(r, 0, false));
  }
  for (const [key, ws] of roots) {
    const visible = ws.repos.filter(matches);
    if (!visible.length && (filter || dirtyOnly)) continue;
    out.push(wsHead(key, ws.name, ws.repos));
    if (collapsed.has(key)) continue;
    const flat = !!(filter || dirtyOnly);
    if (flat) { for (const r of sortList(visible)) out.push(repoRow(r, 0, false)); continue; }
    // nested tree by parent repo
    const kids = new Map();
    for (const r of ws.repos) { const p = r.parent && ws.repos.some((x) => x.id === r.parent) ? r.parent : null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r); }
    const walk = (parent, depth) => {
      for (const r of sortList(kids.get(parent) || [])) {
        const has = (kids.get(r.id) || []).length > 0;
        out.push(repoRow(r, depth, has));
        if (has && !collapsed.has(r.id)) walk(r.id, depth + 1);
      }
    };
    walk(null, 0);
  }
  if (!store.repos.length) {
    out.push(h('div', { class: 'empty' }, h('h3', null, 'No repositories yet'),
      h('div', { class: 'col', style: { alignItems: 'center' } }, h('a', { onclick: () => navigate('#/settings/setup') }, 'Find repositories on this computer'),
        h('a', { onclick: () => import('./onboarding.js').then((m) => m.cloneDialog()) }, 'Clone from GitHub'))));
  }
  mount(treeEl, out);
  treeEl.scrollTop = scroll;
}

function sortList(list) {
  return [...list].sort((a, b) => {
    if (sortDirty) {
      const d = (needsAttention(b) ? 1 : 0) - (needsAttention(a) ? 1 : 0);
      if (d) return d;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
}

function wsHead(key, name, repos) {
  const dirty = repos.filter(needsAttention).length;
  return h('div', { class: 'ws-head', onclick: () => toggle(key), title: key },
    icon(collapsed.has(key) ? 'chevronRight' : 'chevronDown', 'sm'), h('span', { class: 'grow ellipsis' }, name),
    dirty ? h('span', { class: 'badge dirty', title: `${dirty} need attention` }, dirty) : null, h('span', { class: 'faint' }, repos.length));
}
function toggle(key) {
  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
  prefs.set('collapsed', [...collapsed]);
  renderTree();
}

function repoRow(r, depth, hasKids) {
  const s = r.summary || {};
  const attention = needsAttention(r);
  const b = boardFor(r);
  const bs = boardState(b);
  const favs = store.config ? store.config.favourites || [] : [];
  const meta = [];
  if (r.busy) meta.push(h('span', { class: 'badge run', title: r.busy.label }, icon('refresh', 'sm spin')));
  if (s.error) meta.push(h('span', { class: 'badge bad', title: s.error }, '!'));
  if (s.inProgress && s.inProgress.length) meta.push(h('span', { class: 'badge bad', title: `${s.inProgress.join(', ')} in progress` }, s.inProgress[0].toUpperCase()));
  if (s.locked) meta.push(h('span', { class: 'badge bad', title: 'index.lock exists: another git process is running or crashed' }, 'LOCK'));
  if (s.dirty) meta.push(h('span', { class: 'badge dirty', title: `${s.counts.staged} staged, ${s.counts.unstaged} changed, ${s.counts.untracked} untracked${s.counts.conflicted ? `, ${s.counts.conflicted} conflicted` : ''}` }, s.dirty));
  if (s.ahead) meta.push(h('span', { class: 'badge accent', title: `${s.ahead} commit(s) to push` }, `↑${s.ahead}`));
  if (!s.upstream && s.unpushed) meta.push(h('span', { class: 'badge accent', title: `${s.unpushed} commit(s) not on any remote (branch not published)` }, `↑${s.unpushed}`));
  if (s.behind) meta.push(h('span', { class: 'badge warn', title: `${s.behind} commit(s) to pull` }, `↓${s.behind}`));
  if (s.behindDefault && s.branch !== s.defaultBranch) meta.push(h('span', { class: 'badge warn', title: `${s.behindDefault} commit(s) behind ${s.defaultRemoteRef}` }, `⇣${s.behindDefault}`));
  const prs = myPrCount(r);
  if (prs) meta.push(h('span', { class: 'badge', title: `${prs} open pull request(s) by you` }, icon('pr', 'sm'), prs));
  if (bs) meta.push(h('span', { title: `Latest run on ${b.branch}: ${bs}`, style: { display: 'inline-flex' } }, runDot(bs === 'running' ? 'in_progress' : 'completed', bs === 'failure' ? 'failure' : bs === 'success' ? 'success' : bs)));
  const offDefault = s.branch && s.defaultBranch && s.branch !== s.defaultBranch;
  const row = h('div', {
    class: `repo-row ${store.selected === r.id ? 'selected' : ''} ${attention ? 'dirty' : ''}`,
    style: { paddingLeft: `${4 + depth * 14}px` }, role: 'treeitem', 'aria-selected': store.selected === r.id ? 'true' : 'false',
    title: `${r.path}${s.error ? `\n${s.error}` : ''}`,
    onclick: () => navigate(`#/repo/${r.id}/${store.tab || 'changes'}`),
    oncontextmenu: (e) => menuAt(e, repoMenu(r)),
  },
  h('span', { class: 'twisty', onclick: (e) => { if (hasKids) { e.stopPropagation(); toggle(r.id); } } }, hasKids ? icon(collapsed.has(r.id) ? 'chevronRight' : 'chevronDown', 'sm') : null),
  favs.includes(r.path) ? h('span', { class: 'star' }, '★') : null,
  h('span', { class: 'repo-name' }, r.rel === '.' ? r.name : r.name),
  h('span', { class: `branch ${offDefault ? 'off-default' : ''}`, title: s.detached ? 'Detached HEAD' : s.branch }, s.detached ? `@${(s.oid || '').slice(0, 7)}` : s.branch || ''),
  h('span', { class: 'meta' }, meta));
  return row;
}

export function repoMenu(r) {
  const favs = store.config.favourites || [];
  const isFav = favs.includes(r.path);
  return [
    { label: 'Open in Explorer', icon: 'folder', action: () => act(() => rpc('open.explorer', { id: r.id })) },
    { label: 'Open terminal here', icon: 'terminal', action: () => act(() => rpc('open.terminal', { id: r.id })) },
    { label: 'Open in editor', icon: 'edit', action: () => act(() => rpc('open.editor', { id: r.id })) },
    { label: 'Open on GitHub', icon: 'external', disabled: !r.slug || !r.slug.github, action: () => rpc('open.url', { url: `https://github.com/${r.slug.owner}/${r.slug.repo}` }) },
    '-',
    { label: 'Fetch', icon: 'fetch', action: () => act(() => rpc('repo.fetch', { id: r.id }), { ok: `Fetched ${r.label}` }) },
    { label: 'Pull', icon: 'pull', action: () => act(() => rpc('repo.pull', { id: r.id }), { ok: `Pulled ${r.label}` }) },
    { label: 'Push', icon: 'push', action: () => act(() => rpc('repo.push', { id: r.id }), { ok: `Pushed ${r.label}` }) },
    '-',
    { label: 'Copy path', icon: 'copy', action: () => copyText(r.path) },
    { label: 'Copy remote URL', icon: 'copy', disabled: !r.slug, action: async () => { const rs = await rpc('repo.remotes', { id: r.id }); const o = rs.find((x) => x.name === (r.slug.remote || 'origin')) || rs[0]; if (o) copyText(o.url); } },
    { label: isFav ? 'Remove from favourites' : 'Add to favourites', icon: 'star', action: () => toggleFav(r) },
  ];
}

async function toggleFav(r) {
  const favs = new Set(store.config.favourites || []);
  if (favs.has(r.path)) favs.delete(r.path); else favs.add(r.path);
  store.config = await rpc('config.update', { patch: { favourites: [...favs] } });
  emit('config');
  renderTree();
}

async function fetchAll() {
  const ids = store.repos.map((r) => r.id);
  banner({ level: 'info', title: `Fetching ${ids.length} repositories…`, timeout: 2500 });
  const res = await act(() => rpc('bulk.run', { op: 'fetch', ids }));
  if (!res) return;
  const failed = res.filter((x) => x.status === 'failed');
  if (failed.length) banner({ level: 'error', title: `Fetch failed in ${failed.length} repositories`, body: failed.map((f) => `${f.label}: ${f.message.split('\n')[0]}`).join('\n'), timeout: 0 });
  else banner({ level: 'success', title: `Fetched ${res.length} repositories`, timeout: 3000 });
}
