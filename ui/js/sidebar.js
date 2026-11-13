// Repository sidebar: local repositories per folder (nested), then repositories that exist
// on GitHub for the open account but are not cloned yet.
import { h, mount, icon, iconBtn, menuAt, menuBelow, act, copyText, banner, plural } from './dom.js';
import { rpc } from './api.js';
import { store, subscribe, prefs, boardFor, boardState, emit } from './store.js';
import { navigate } from './router.js';
import { fetchRepo } from './fetch.js';

let el;
let treeEl;
let segEl;
let filter = prefs.get('filter', '');
let savedEl;
let inputEl;
let attentionOnly = prefs.get('dirtyOnly', false);
let collapsed = new Set(prefs.get('collapsed', ['remote']));
let hiddenOpen = prefs.get('hiddenOpen', false);
let remote = null;        // repositories on GitHub (all), or null while unknown
let remoteFor = null;     // account the list belongs to
let remoteError = null;

export function initSidebar(root) {
  el = root;
  const input = h('input', { type: 'search', placeholder: 'Filter repositories', 'aria-label': 'Filter repositories', value: filter, style: { flex: '1' }, oninput: (e) => { filter = e.target.value; prefs.set('filter', filter); renderTree(); } });
  inputEl = input;
  savedEl = h('div', { class: 'saved-filters' });
  segEl = h('div', { class: 'pill-tabs', style: { alignSelf: 'flex-start' } });
  const tools = h('div', { class: 'side-tools' },
    h('div', { class: 'row', style: { gap: '4px' } }, input,
      iconBtn('star', 'Save the current filter', () => saveFilter()),
      iconBtn('fetch', 'Fetch all repositories', () => fetchAll()),
      iconBtn('refresh', 'Rescan folders and refresh status', () => act(() => rpc('repos.scan'))),
      iconBtn('plus', 'Clone or add repositories', () => import('./onboarding.js').then((m) => m.cloneDialog()))),
    segEl, savedEl);
  treeEl = h('div', { class: 'tree', role: 'tree' });
  mount(el, tools, treeEl);
  subscribe('repos', () => { renderTree(); });
  subscribe('summary', schedule);
  subscribe('board', schedule);
  subscribe('selected', renderTree);
  subscribe('myprs', schedule);
  subscribe('accounts', () => loadRemote(false));
  subscribe('config', () => loadRemote(false));
  renderTree();
  loadRemote(false);
}

let pend = null;
function schedule() { if (pend) return; pend = requestAnimationFrame(() => { pend = null; renderTree(); }); }

/** Remote list for the open account; refetched when the account changes or on demand. */
export async function loadRemote(force) {
  const who = store.config ? store.config.currentAccount : '';
  if (!who) { remote = null; remoteFor = ''; remoteError = null; schedule(); return; }
  if (!force && remoteFor === who && remote) return;
  if (remoteFor !== who) { remote = null; schedule(); }
  remoteFor = who;
  try { const list = await rpc('gh.repoListAll'); if (remoteFor === who) { remote = list; remoteError = null; } } catch (e) { if (remoteFor === who) { remote = []; remoteError = e.message.split('\n')[0]; } }
  schedule();
}

export function needsAttention(r) {
  const s = r.summary;
  if (!s) return false;
  return s.dirty > 0 || s.ahead > 0 || s.unpushed > 0 || (s.inProgress && s.inProgress.length) || s.locked || s.behind > 0;
}

// Hidden repositories stay on disk and keep working; they only move out of the way, into their own section.
const hiddenPaths = () => new Set((store.config && store.config.hidden) || []);
const isHidden = (r, set = hiddenPaths()) => set.has(r.path);
export const shownRepos = () => { const set = hiddenPaths(); return set.size ? store.repos.filter((r) => !set.has(r.path)) : store.repos; };

function matches(r) {
  if (filter) {
    const f = filter.toLowerCase();
    if (!r.label.toLowerCase().includes(f) && !(r.summary && r.summary.branch && r.summary.branch.toLowerCase().includes(f))) return false;
  }
  return !attentionOnly || needsAttention(r);
}

function myPrCount(r) {
  if (!store.myprs || !r.slug) return 0;
  const key = `${r.slug.owner}/${r.slug.repo}`.toLowerCase();
  return store.myprs.mine.filter((p) => p.repo.toLowerCase() === key).length;
}

function renderSeg() {
  const shown = shownRepos();
  const need = shown.filter(needsAttention).length;
  mount(segEl,
    h('button', { class: attentionOnly ? '' : 'active', onclick: () => setAttention(false) }, `All ${shown.length}`),
    h('button', { class: attentionOnly ? 'active' : '', title: 'Changes, unpushed or unpulled commits, or an operation in progress', onclick: () => setAttention(true) }, `Needs attention ${need}`));
}
function setAttention(v) { attentionOnly = v; prefs.set('dirtyOnly', v); renderTree(); }

// ----- saved filters (per account): a name for a filter text plus the "needs attention" switch
const filterKey = () => (store.config && store.config.currentAccount) || '_local';
const savedList = () => ((store.config && store.config.savedFilters) || {})[filterKey()] || [];
async function writeSaved(list) {
  store.config = await rpc('config.update', { patch: { savedFilters: { ...(store.config.savedFilters || {}), [filterKey()]: list } } });
  renderTree();
}
async function saveFilter() {
  if (!filter.trim() && !attentionOnly) { banner({ level: 'info', title: 'Type a filter first, then save it', timeout: 3000 }); return; }
  const { prompt } = await import('./dom.js');
  const name = await prompt('Save filter', 'Name', filter.trim() || 'Needs attention', { submit: 'Save' });
  if (!name) return;
  await writeSaved([...savedList().filter((x) => x.name !== name), { name, text: filter.trim(), attention: attentionOnly }]);
}
function applySaved(sf) {
  const active = filter.trim() === sf.text && attentionOnly === !!sf.attention;
  filter = active ? '' : sf.text;
  attentionOnly = active ? false : !!sf.attention;
  inputEl.value = filter; prefs.set('filter', filter); prefs.set('dirtyOnly', attentionOnly);
  renderTree();
}
function renderSaved() {
  const list = savedList();
  savedEl.classList.toggle('hidden', !list.length);
  mount(savedEl, list.map((sf) => h('button', {
    class: filter.trim() === sf.text && attentionOnly === !!sf.attention ? 'on' : '',
    title: `${sf.text ? `Filter: ${sf.text}` : 'All repositories'}${sf.attention ? ' · needs attention only' : ''}\nRight-click to remove`,
    onclick: () => applySaved(sf),
    oncontextmenu: (e) => menuAt(e, [{ label: `Remove “${sf.name}”`, icon: 'trash', danger: true, action: () => writeSaved(savedList().filter((x) => x.name !== sf.name)) }]),
  }, sf.name)));
}

function renderTree() {
  if (!treeEl) return;
  renderSeg();
  renderSaved();
  const scroll = treeEl.scrollTop;
  const roots = new Map();
  const shown = shownRepos();
  for (const r of shown) {
    if (!roots.has(r.root)) roots.set(r.root, { name: r.rootName, repos: [] });
    roots.get(r.root).repos.push(r);
  }
  const out = [];
  const favs = store.config ? store.config.favourites || [] : [];
  const favRepos = shown.filter((r) => favs.includes(r.path) && matches(r));
  if (favRepos.length) {
    out.push(groupHead('fav', 'Favourites', favRepos.length, favRepos.filter(needsAttention).length));
    if (!collapsed.has('fav')) for (const r of sortList(favRepos)) out.push(repoRow(r, 0, false));
  }
  for (const [key, ws] of roots) {
    const visible = ws.repos.filter(matches);
    if (!visible.length && (filter || attentionOnly)) continue;
    out.push(groupHead(key, `Local · ${ws.name}`, ws.repos.length, ws.repos.filter(needsAttention).length, key));
    if (collapsed.has(key)) continue;
    if (filter || attentionOnly) { for (const r of sortList(visible)) out.push(repoRow(r, 0, false)); continue; }
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
    out.push(h('div', { class: 'empty' }, h('h3', null, 'No local repositories'),
      h('div', { class: 'col', style: { alignItems: 'center' } }, h('a', { onclick: () => navigate('#/settings/setup') }, 'Choose folders'),
        h('a', { onclick: () => navigate('#/github') }, 'Clone from GitHub'))));
  }
  out.push(...hiddenSection());
  out.push(...remoteSection());
  sync(treeEl, out.flat(Infinity).filter(Boolean));
  if (treeEl.scrollTop !== scroll) treeEl.scrollTop = scroll;
}

// The list is redrawn on every status update. Rows that come out the same keep their element, so the
// row under the pointer does not lose and regain its hover state (which showed as flicker).
const drawn = new WeakMap(); // element -> its HTML when it was put in
function sync(parent, nodes) {
  const old = [...parent.children];
  nodes.forEach((n, i) => {
    const html = n.outerHTML;
    const cur = parent.children[i];
    if (cur && drawn.get(cur) === html) return;
    drawn.set(n, html);
    if (cur) parent.replaceChild(n, cur); else parent.appendChild(n);
  });
  for (const o of old.slice(nodes.length)) o.remove();
}

function hiddenSection() {
  const set = hiddenPaths();
  const all = store.repos.filter((r) => set.has(r.path));
  if (!all.length) return [];
  const list = all.filter(matches);
  if (!list.length && (filter || attentionOnly)) return [];
  const open = hiddenOpen || !!filter;
  const out = [h('div', { class: 'side-sep' })];
  out.push(h('div', { class: 'ws-head', title: 'Repositories you have hidden. Right-click one to show it again.', onclick: () => { hiddenOpen = !hiddenOpen; prefs.set('hiddenOpen', hiddenOpen); renderTree(); } },
    icon(open ? 'chevronDown' : 'chevronRight', 'sm'), h('span', { class: 'grow ellipsis' }, 'Hidden'), h('span', { class: 'faint' }, all.length)));
  if (open) for (const r of sortList(list)) out.push(repoRow(r, 0, false, true));
  return out;
}

function remoteSection() {
  const who = store.config ? store.config.currentAccount : '';
  if (!who || attentionOnly) return [];
  const local = new Set(store.repos.filter((r) => r.slug).map((r) => `${r.slug.owner}/${r.slug.repo}`.toLowerCase()));
  const f = filter.toLowerCase();
  const list = (remote || []).filter((r) => !r.isArchived && !local.has(r.nameWithOwner.toLowerCase()) && (!f || r.nameWithOwner.toLowerCase().includes(f)));
  const out = [h('div', { class: 'side-sep' })];
  const open = !collapsed.has('remote') || !!filter;
  out.push(h('div', { class: 'ws-head', onclick: () => toggle('remote'), title: `On GitHub for ${who}, not cloned to this computer` },
    icon(open ? 'chevronDown' : 'chevronRight', 'sm'), h('span', { class: 'grow ellipsis' }, 'Remote · not cloned'), h('span', { class: 'badge' }, remote ? list.length : '…')));
  if (!open) return out;
  if (!remote) { out.push(h('div', { class: 'skeleton' }, 'Loading')); return out; }
  if (remoteError) { out.push(h('div', { class: 'faint', style: { padding: '4px 14px' } }, remoteError)); return out; }
  for (const r of list.slice(0, filter ? 60 : 12)) {
    out.push(h('div', { class: 'repo-row remote', title: `${r.nameWithOwner}${r.description ? `\n${r.description}` : ''}`, onclick: (e) => cloneMenu(e.currentTarget, r), oncontextmenu: (e) => menuAt(e, [
      { label: 'Clone…', icon: 'fetch', action: () => cloneMenu(e.currentTarget, r) },
      { label: 'Open on GitHub', icon: 'external', action: () => rpc('open.url', { url: r.url }) },
    ]) },
    icon('external', 'sm'), h('span', { class: 'repo-name' }, r.nameWithOwner), h('span', { class: 'btn small ghost clone', style: { height: '22px', color: 'var(--accent)' } }, 'Clone')));
  }
  out.push(h('div', { class: 'repo-row', style: { color: 'var(--accent)' }, onclick: () => navigate('#/github') }, list.length > 12 && !filter ? `Show all ${list.length} on GitHub` : 'Open the GitHub page'));
  return out;
}

function cloneMenu(anchor, r) {
  const roots = store.config.roots || [];
  const go = async (dest) => {
    const { cloneSelected, ensureRoot, cloneDefaults } = await import('./onboarding.js');
    await ensureRoot(dest);
    await cloneSelected([r], dest, cloneDefaults().proto);
  };
  menuBelow(anchor, [
    { header: true, label: `Clone ${r.nameWithOwner} into` },
    ...roots.map((rt) => ({ label: rt.path, icon: 'folder', action: () => go(rt.path) })),
    { label: 'Another folder…', icon: 'plus', action: async () => { const { pickFolder } = await import('./views/settings.js'); const p = await pickFolder('Clone into which folder?'); if (p) go(p); } },
    '-',
    { label: 'Open on GitHub', icon: 'external', action: () => rpc('open.url', { url: r.url }) },
  ]);
}

function sortList(list) {
  return [...list].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

function groupHead(key, name, count, attention, title) {
  return h('div', { class: 'ws-head', onclick: () => toggle(key), title: title || '' },
    icon(collapsed.has(key) ? 'chevronRight' : 'chevronDown', 'sm'), h('span', { class: 'grow ellipsis' }, name),
    attention ? h('span', { class: 'badge warn', title: `${attention} need attention` }, attention) : h('span', { class: 'faint' }, count));
}
function toggle(key) {
  if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
  prefs.set('collapsed', [...collapsed]);
  renderTree();
}

function repoRow(r, depth, hasKids, dim) {
  const s = r.summary || {};
  const attention = needsAttention(r);
  const b = boardFor(r);
  const bs = boardState(b);
  const favs = store.config ? store.config.favourites || [] : [];
  const meta = [];
  if (r.busy) meta.push(h('span', { class: 'badge run', title: r.busy.label }, icon('refresh', 'sm spin')));
  if (s.error) meta.push(h('span', { class: 'badge bad', title: s.error }, '!'));
  if (s.inProgress && s.inProgress.length) meta.push(h('span', { class: 'badge bad', title: `${s.inProgress.join(', ')} in progress` }, s.inProgress[0]));
  if (s.locked) meta.push(h('span', { class: 'badge bad', title: 'index.lock exists: another git process is running or crashed' }, 'locked'));
  if (s.dirty) meta.push(h('span', { class: 'badge warn', title: `${s.counts.staged} staged, ${s.counts.unstaged} changed, ${s.counts.untracked} untracked${s.counts.conflicted ? `, ${s.counts.conflicted} conflicted` : ''}` }, s.dirty));
  if (s.ahead) meta.push(h('span', { class: 'badge info', title: `${s.ahead} commit(s) to push` }, `↑${s.ahead}`));
  if (!s.upstream && s.unpushed) meta.push(h('span', { class: 'badge info', title: `${s.unpushed} commit(s) on a branch that is not published` }, `↑${s.unpushed}`));
  if (s.behind) meta.push(h('span', { class: 'badge warn', title: `${s.behind} commit(s) to pull` }, `↓${s.behind}`));
  const mine = myPrCount(r);
  const open = b && !b.error && b.openPrs != null ? b.openPrs : mine;
  if (open) meta.push(h('span', { class: `badge ${mine ? 'accent' : ''}`, title: `${open} open pull request${open === 1 ? '' : 's'}${mine ? `, ${mine} by you` : ''}` }, icon('pr', 'sm'), open));
  const ci = bs === 'failure' ? 'bad' : bs === 'running' ? 'run' : bs === 'success' ? 'ok' : '';
  const offDefault = s.branch && s.defaultBranch && s.branch !== s.defaultBranch;
  return h('div', {
    class: `repo-row ${store.selected === r.id ? 'selected' : ''} ${attention ? 'dirty' : ''} ${dim ? 'is-hidden' : ''}`,
    style: { paddingLeft: `${8 + depth * 16}px` }, role: 'treeitem', 'aria-selected': store.selected === r.id ? 'true' : 'false',
    title: `${r.path}${b && !b.error && bs ? `\n${b.branch}: ${bs}` : ''}${s.error ? `\n${s.error}` : ''}`,
    onclick: () => navigate(`#/repo/${r.id}/${store.tab || 'changes'}`),
    oncontextmenu: (e) => menuAt(e, repoMenu(r)),
  },
  hasKids ? h('span', { class: 'twisty', onclick: (e) => { e.stopPropagation(); toggle(r.id); } }, icon(collapsed.has(r.id) ? 'chevronRight' : 'chevronDown', 'sm'))
    : h('span', { class: `dot ${ci}`, title: bs ? `Latest run on ${b.branch}: ${bs}` : 'No workflow status' }),
  favs.includes(r.path) ? h('span', { class: 'star' }, '★') : null,
  h('span', { class: 'repo-name' }, dim ? r.label : r.name),
  h('span', { class: `branch ${offDefault ? 'off-default' : ''}`, title: s.detached ? 'Detached HEAD' : s.branch }, s.detached ? `@${(s.oid || '').slice(0, 7)}` : s.branch || ''),
  h('span', { class: 'meta' }, meta));
}

export function repoMenu(r) {
  const favs = store.config.favourites || [];
  const isFav = favs.includes(r.path);
  const hidden = isHidden(r);
  return [
    { label: 'Open in Explorer', icon: 'folder', action: () => act(() => rpc('open.explorer', { id: r.id })) },
    { label: 'Open terminal here', icon: 'terminal', action: () => act(() => rpc('open.terminal', { id: r.id })) },
    { label: 'Open in editor', icon: 'edit', action: () => act(() => rpc('open.editor', { id: r.id })) },
    { label: 'Open on GitHub', icon: 'external', disabled: !r.slug || !r.slug.github, action: () => rpc('open.url', { url: `https://github.com/${r.slug.owner}/${r.slug.repo}` }) },
    '-',
    { label: 'Fetch', icon: 'fetch', action: () => fetchRepo(r) },
    { label: 'Pull', icon: 'pull', action: () => act(() => rpc('repo.pull', { id: r.id }), { ok: `Pulled ${r.label}` }) },
    { label: 'Push', icon: 'push', action: () => act(() => rpc('repo.push', { id: r.id }), { ok: `Pushed ${r.label}` }) },
    '-',
    { label: 'Copy path', icon: 'copy', action: () => copyText(r.path) },
    { label: 'Copy remote URL', icon: 'copy', disabled: !r.slug, action: async () => { const rs = await rpc('repo.remotes', { id: r.id }); const o = rs.find((x) => x.name === (r.slug.remote || 'origin')) || rs[0]; if (o) copyText(o.url); } },
    { label: isFav ? 'Remove from favourites' : 'Add to favourites', icon: 'star', action: () => toggleFav(r) },
    { label: hidden ? 'Show in sidebar' : 'Hide from sidebar', icon: hidden ? 'eye' : 'eyeOff', action: () => toggleHidden(r) },
  ];
}

async function toggleFav(r) {
  const favs = new Set(store.config.favourites || []);
  if (favs.has(r.path)) favs.delete(r.path); else favs.add(r.path);
  store.config = await rpc('config.update', { patch: { favourites: [...favs] } });
  emit('config');
  renderTree();
}

async function toggleHidden(r) {
  const set = hiddenPaths();
  const hide = !set.has(r.path);
  if (hide) set.add(r.path); else set.delete(r.path);
  store.config = await rpc('config.update', { patch: { hidden: [...set] } });
  emit('config');
  renderTree();
  if (hide) banner({ level: 'info', title: `${r.label} is hidden`, body: 'It is in the Hidden section at the bottom of the sidebar.', timeout: 6000, actions: [{ label: 'Undo', action: () => toggleHidden(r) }] });
}

/** What "Fetch all" covers: hidden repositories only when the setting says so. */
export const fetchTargets = () => (store.config && store.config.skipHiddenOnFetch === false ? store.repos : shownRepos());

async function fetchAll() {
  const ids = fetchTargets().map((r) => r.id);
  if (!ids.length) return;
  banner({ level: 'info', title: `Fetching ${plural(ids.length, 'repository')}…`, timeout: 2500 });
  const res = await act(() => rpc('bulk.run', { op: 'fetch', ids }));
  if (!res) return;
  const failed = res.filter((x) => x.status === 'failed');
  const skipped = res.filter((x) => x.status === 'skipped');
  const done = res.length - failed.length - skipped.length;
  const note = skipped.length ? `Left alone: ${plural(skipped.length, 'repository')} with no remote, or with a remote that was not found or refused access last time. Fetch one on its own to try it again.` : '';
  if (failed.length) banner({ level: 'error', title: `Fetch failed in ${plural(failed.length, 'repository')}`, body: failed.map((f) => `${f.label}: ${f.message.split('\n')[0]}`).join('\n') + (note ? `\n\n${note}` : ''), timeout: 0 });
  else banner({ level: 'success', title: `Fetched ${plural(done, 'repository')}`, body: note || undefined });
}
