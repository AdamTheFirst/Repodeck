// All repositories: overview, bulk operations, branch cleanup, commit search.
import { h, mount, icon, btn, act, modal, form, confirmDanger, banner, ago, plural, debounce } from '../dom.js';
import { rpc } from '../api.js';
import { store, subscribe } from '../store.js';
import { navigate } from '../router.js';
import { needsAttention } from '../sidebar.js';

const SUBS = [['overview', 'Overview'], ['bulk', 'Bulk operations'], ['cleanup', 'Branch cleanup'], ['search', 'Search commits']];

export function render(main, parts) {
  const sub = SUBS.some(([k]) => k === parts[0]) ? parts[0] : 'overview';
  const page = h('div', { class: 'page' });
  mount(main, h('div', { class: 'tabs' }, SUBS.map(([k, l]) => h('button', { class: `tab ${sub === k ? 'active' : ''}`, onclick: () => navigate(`#/multi/${k}`) }, l))), page);
  if (sub === 'bulk') return bulk(page);
  if (sub === 'cleanup') return cleanup(page);
  if (sub === 'search') return search(page);
  return overview(page);
}

// ---------- shared: preview + run with a result table ----------
export async function runBulk(op, ids, args = {}, label) {
  if (!ids.length) { banner({ level: 'info', title: 'Select at least one repository', timeout: 3000 }); return null; }
  let preview;
  try { preview = await rpc('bulk.preview', { op, ids, args }); } catch (e) { banner({ level: 'error', title: e.message }); return null; }
  const runnable = preview.filter((p) => !p.skip);
  const ok = await modal({
    title: `${label}: ${plural(runnable.length, 'repository')}`, wide: true,
    body: h('div', { class: 'col' },
      h('div', { class: 'muted' }, runnable.length ? 'Each repository is checked again right before it runs; anything that became unsafe is skipped.' : 'Nothing to do: every selected repository would be skipped.'),
      h('table', { class: 'grid' }, h('tr', null, h('th', null, 'Repository'), h('th', null, 'Branch'), h('th', null, 'Will do')),
        preview.map((p) => h('tr', null, h('td', null, p.label), h('td', { class: 'muted' }, p.branch || ''), h('td', null, p.skip ? h('span', { class: 'muted' }, `skip: ${p.skip}`) : h('span', { style: { color: 'var(--ok)' } }, label)))))),
    actions: [{ label: 'Cancel', value: false }, { label: `Run on ${runnable.length}`, cls: 'primary', default: true, value: true }],
  });
  if (!ok || !runnable.length) return null;
  banner({ level: 'info', title: `${label} running on ${plural(runnable.length, 'repository')}…`, timeout: 2500 });
  let res;
  try { res = await rpc('bulk.run', { op, ids: runnable.map((p) => p.id), args }); } catch (e) { banner({ level: 'error', title: e.message }); return null; }
  const failed = res.filter((x) => x.status === 'failed');
  modal({
    title: `${label}: ${res.filter((x) => x.status === 'ok').length} done, ${failed.length} failed, ${res.filter((x) => x.status === 'skipped').length} skipped`, wide: true,
    body: h('table', { class: 'grid' }, h('tr', null, h('th', null, 'Repository'), h('th', null, 'Result'), h('th', null, 'Details')),
      res.map((x) => h('tr', null, h('td', null, x.label), h('td', null, h('span', { class: `badge ${x.status === 'ok' ? 'ok' : x.status === 'failed' ? 'bad' : ''}` }, x.status)),
        h('td', { class: 'mono', style: { whiteSpace: 'pre-wrap', fontSize: '11px', maxWidth: '520px' } }, (x.message || '').slice(0, 600))))),
    actions: [{ label: 'Close', cls: 'primary', default: true, value: null }],
  });
  return res;
}

// ---------- overview ----------
function overview(page) {
  function draw() {
    const rows = store.repos.filter((r) => r.summary).map((r) => ({ r, s: r.summary }));
    const cats = [
      ['Uncommitted changes', rows.filter((x) => x.s.dirty), (x) => `${x.s.dirty} change(s)`],
      ['Unpushed commits', rows.filter((x) => x.s.ahead || (!x.s.upstream && x.s.unpushed)), (x) => (x.s.upstream ? `${x.s.ahead} to push to ${x.s.upstream}` : `${x.s.unpushed} on unpublished branch ${x.s.branch}`)],
      ['Behind upstream', rows.filter((x) => x.s.behind), (x) => `${x.s.behind} to pull`],
      ['Not on default branch', rows.filter((x) => x.s.branch && x.s.defaultBranch && x.s.branch !== x.s.defaultBranch), (x) => `on ${x.s.branch}${x.s.behindDefault ? `, ${x.s.behindDefault} behind ${x.s.defaultBranch}` : ''}`],
      ['Stashes', rows.filter((x) => x.s.stash), (x) => `${x.s.stash} stash(es)`],
      ['Operation in progress or locked', rows.filter((x) => (x.s.inProgress || []).length || x.s.locked || x.s.detached), (x) => [...(x.s.inProgress || []), x.s.locked ? 'index locked' : null, x.s.detached ? 'detached HEAD' : null].filter(Boolean).join(', ')],
    ];
    mount(page,
      h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h2', null, 'Nothing forgotten'), h('span', { class: 'muted' }, `${store.repos.length} repositories, ${store.repos.filter(needsAttention).length} need attention`), h('span', { class: 'spacer' }),
        btn('Fetch all', () => runBulk('fetch', store.repos.map((r) => r.id), {}, 'Fetch'), { cls: 'small', iconName: 'fetch' })),
      cats.map(([title, list, desc]) => h('div', { style: { marginBottom: '16px' } },
        h('div', { class: 'section-title' }, h('h3', null, title), h('span', { class: `badge ${list.length ? 'dirty' : ''}` }, list.length)),
        list.length ? h('div', { class: 'panel' }, list.map((x) => h('div', { class: 'list-row', onclick: () => navigate(`#/repo/${x.r.id}/changes`) }, h('strong', { style: { minWidth: '240px' } }, x.r.label), h('span', { class: 'muted grow' }, desc(x)))))
          : h('div', { class: 'faint' }, 'None.'))));
  }
  const un = subscribe('summary', debounce(draw, 300));
  draw();
  return () => un();
}

// ---------- bulk ----------
function bulk(page) {
  const sel = new Set();
  let op = 'fetch';
  const args = { branch: '', fromDefault: true, checkout: true, force: false, pull: true, message: '' };
  async function draw() {
    const ops = await rpc('bulk.ops').catch(() => ({}));
    const repos = [...store.repos].sort((a, b) => a.label.localeCompare(b.label));
    const needsBranch = ['switch', 'createBranch', 'deleteBranch'].includes(op);
    const argEls = [];
    if (needsBranch) argEls.push(h('label', { class: 'field' }, h('span', null, 'Branch name'), h('input', { type: 'text', value: args.branch, placeholder: 'feature/x', oninput: (e) => { args.branch = e.target.value.trim(); } })));
    if (op === 'createBranch') argEls.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: args.fromDefault, onchange: (e) => { args.fromDefault = e.target.checked; } }), 'Start from the latest default branch'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: args.checkout, onchange: (e) => { args.checkout = e.target.checked; } }), 'Switch to it'));
    if (op === 'deleteBranch') argEls.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: args.force, onchange: (e) => { args.force = e.target.checked; } }), 'Also delete branches that are not merged (their commits leave all branches)'));
    if (op === 'returnDefault') argEls.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: args.pull, onchange: (e) => { args.pull = e.target.checked; } }), 'Fast-forward pull after switching'));
    if (op === 'stash') argEls.push(h('label', { class: 'field' }, h('span', null, 'Stash message'), h('input', { type: 'text', value: args.message, oninput: (e) => { args.message = e.target.value; } })));
    mount(page,
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '20px' } },
        h('div', { class: 'panel', style: { width: '340px', flex: 'none' } }, h('div', { class: 'panel-head' }, h('h3', null, 'Operation')),
          h('div', { class: 'panel-body col' },
            h('select', { onchange: (e) => { op = e.target.value; draw(); } }, Object.entries(ops).map(([k, l]) => h('option', { value: k, selected: k === op }, l))),
            argEls,
            h('div', { class: 'faint', style: { fontSize: '12px' } }, 'You will see exactly what runs where, and what is skipped and why, before anything happens.'),
            btn(`Preview on ${sel.size} selected`, () => { if (needsBranch && !args.branch) { banner({ level: 'warn', title: 'Enter a branch name', timeout: 3000 }); return; } runBulk(op, [...sel], args, ops[op]).then(() => draw()); }, { cls: 'primary', disabled: !sel.size }))),
        h('div', { class: 'grow' },
          h('div', { class: 'row', style: { marginBottom: '8px' } }, h('strong', null, 'Repositories'), h('span', { class: 'spacer' }),
            h('a', { onclick: () => { repos.forEach((r) => sel.add(r.id)); draw(); } }, 'all'), h('a', { onclick: () => { sel.clear(); draw(); } }, 'none'),
            h('a', { onclick: () => { sel.clear(); repos.filter(needsAttention).forEach((r) => sel.add(r.id)); draw(); } }, 'needing attention')),
          h('table', { class: 'grid panel' }, h('tr', null, h('th', null, ''), h('th', null, 'Repository'), h('th', null, 'Branch'), h('th', null, 'State')),
            repos.map((r) => { const s = r.summary || {}; return h('tr', { class: 'clickable', onclick: () => { if (sel.has(r.id)) sel.delete(r.id); else sel.add(r.id); draw(); } },
              h('td', null, h('input', { type: 'checkbox', checked: sel.has(r.id) })), h('td', null, r.label), h('td', { class: 'muted' }, s.branch || ''),
              h('td', null, s.dirty ? h('span', { class: 'badge dirty' }, `${s.dirty} changed`) : null, ' ', s.ahead ? h('span', { class: 'badge accent' }, `↑${s.ahead}`) : null, ' ', s.behind ? h('span', { class: 'badge warn' }, `↓${s.behind}`) : null)); })))));
  }
  draw();
  return null;
}

// ---------- cleanup ----------
function cleanup(page) {
  async function load() {
    mount(page, h('div', { class: 'skeleton' }, 'Looking for merged and orphaned branches in every repository…'));
    let list;
    try { list = await rpc('cleanup.list'); } catch (e) { mount(page, h('div', { class: 'errbox' }, e.message)); return; }
    const sel = new Set(list.filter((x) => x.merged).map((x) => `${x.id}|${x.branch}`));
    function draw() {
      mount(page,
        h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h2', null, 'Branch cleanup'), h('span', { class: 'muted' }, 'Local branches already merged into the default branch, or whose remote branch was deleted. Fetch with prune first for accurate "gone" results.'),
          h('span', { class: 'spacer' }), btn('Fetch and prune all', () => act(() => rpc('bulk.run', { op: 'fetch', ids: store.repos.map((r) => r.id) })).then(load), { cls: 'small' })),
        list.length ? h('table', { class: 'grid panel' }, h('tr', null, h('th', null, ''), h('th', null, 'Repository'), h('th', null, 'Branch'), h('th', null, 'Why'), h('th', null, 'Last commit')),
          list.map((x) => { const k = `${x.id}|${x.branch}`; return h('tr', { class: 'clickable', onclick: () => { if (sel.has(k)) sel.delete(k); else sel.add(k); draw(); } },
            h('td', null, h('input', { type: 'checkbox', checked: sel.has(k) })), h('td', null, x.label), h('td', { class: 'mono' }, x.branch),
            h('td', null, x.merged ? h('span', { class: 'badge ok' }, 'merged') : null, ' ', x.gone ? h('span', { class: x.merged ? 'badge' : 'badge warn', title: x.merged ? '' : 'The remote branch is gone but these commits are not in the default branch (for example after a squash merge). Deleting removes them from all branches.' }, x.merged ? 'remote gone' : 'remote gone, NOT merged') : null),
            h('td', { class: 'muted' }, `${x.subject} · ${ago(x.time)}`)); }))
          : h('div', { class: 'empty' }, 'Nothing to clean up.'),
        list.length ? h('div', { class: 'row', style: { marginTop: '12px' } }, h('span', { class: 'spacer' }), btn(`Delete ${sel.size} branch(es)…`, async () => {
          const items = list.filter((x) => sel.has(`${x.id}|${x.branch}`));
          const unmerged = items.filter((x) => !x.merged);
          if (!(await confirmDanger({ title: `Delete ${plural(items.length, 'local branch', )}?`, message: unmerged.length ? `${unmerged.length} of them are NOT merged; their commits will no longer be on any branch.` : 'All of them are merged; no commits are lost.', items: items.map((x) => `${x.label}: ${x.branch}${x.merged ? '' : '  (not merged)'}`), recover: 'Deleted branches stay recoverable through git reflog for about 90 days.', confirmLabel: 'Delete' }))) return;
          const res = await act(() => rpc('cleanup.delete', { items: items.map((x) => ({ id: x.id, branch: x.branch, force: !x.merged })) }));
          if (res) { const f = res.filter((x) => x.status === 'failed'); banner({ level: f.length ? 'error' : 'success', title: `Deleted ${res.length - f.length} branch(es)${f.length ? `, ${f.length} failed` : ''}`, body: f.map((x) => `${x.label} ${x.branch}: ${x.message}`).join('\n'), timeout: f.length ? 0 : 4000 }); load(); }
        }, { cls: 'danger', disabled: !sel.size })) : null);
    }
    draw();
  }
  load();
  return null;
}

// ---------- search ----------
function search(page) {
  const q = h('input', { type: 'search', placeholder: 'Words in commit messages', style: { width: '280px' } });
  const author = h('input', { type: 'search', placeholder: 'Author', style: { width: '160px' } });
  const since = h('select', null, [['', 'Any time'], ['1 week ago', 'Last week'], ['1 month ago', 'Last month'], ['3 months ago', 'Last 3 months'], ['1 year ago', 'Last year']].map(([v, l]) => h('option', { value: v }, l)));
  const results = h('div');
  async function go() {
    if (!q.value.trim() && !author.value.trim()) { mount(results); return; }
    mount(results, h('div', { class: 'progress' }));
    try {
      const list = await rpc('search.commits', { grep: q.value.trim(), author: author.value.trim(), since: since.value || undefined });
      mount(results, list.length ? h('div', { class: 'panel' }, list.map((c) => h('div', { class: 'list-row', onclick: () => navigate(`#/repo/${c.repoId}/graph/${c.hash}`) },
        h('span', { class: 'badge', style: { minWidth: '140px' } }, c.repo), h('span', { class: 'mono muted' }, c.hash.slice(0, 8)), h('span', { class: 'grow ellipsis' }, c.subject), h('span', { class: 'muted' }, c.author), h('span', { class: 'faint', style: { width: '90px', textAlign: 'right' } }, ago(c.commitTime)))))
        : h('div', { class: 'empty' }, 'No commits found.'));
    } catch (e) { mount(results, h('div', { class: 'errbox' }, e.message)); }
  }
  const d = debounce(go, 500);
  q.addEventListener('input', d); author.addEventListener('input', d); since.addEventListener('change', go);
  mount(page, h('div', { class: 'row', style: { marginBottom: '12px' } }, h('h2', null, 'Search commits in every repository'), q, author, since), results);
  q.focus();
  return null;
}

export { icon, form };
