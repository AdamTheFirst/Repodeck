// Repository page: header with branch + sync actions, in-progress banner, tabs.
import { h, mount, icon, btn, iconBtn, act, menuBelow, menuAt, confirmDanger, form, prompt, banner, plural, showError } from './dom.js';
import { rpc } from './api.js';
import { store, subscribe, boardFor, boardState } from './store.js';
import { navigate } from './router.js';
import { repoMenu } from './sidebar.js';

const TABS = [
  ['changes', 'Changes', 'diff'], ['graph', 'Graph', 'graph'], ['branches', 'Branches & tags', 'branch'], ['stashes', 'Stashes', 'stash'],
  ['prs', 'Pull requests', 'pr'], ['issues', 'Issues', 'issue'], ['actions', 'Actions', 'bolt'],
];
const LOADERS = {
  changes: () => import('./views/changes.js'), graph: () => import('./views/graph.js'), branches: () => import('./views/branches.js'),
  stashes: () => import('./views/stashes.js'), prs: () => import('./views/prs.js'), issues: () => import('./views/issues.js'), actions: () => import('./views/actions.js'),
};

export function renderRepo(main, id, tab, sub) {
  if (!id) {
    mount(main, h('div', { class: 'empty' }, h('h3', null, 'Select a repository'), h('div', null, 'Pick one on the left, or press ', h('span', { class: 'kbd' }, 'Ctrl+P'), '.')));
    return null;
  }
  const r = store.byId.get(id);
  if (!LOADERS[tab]) tab = 'changes';
  const head = h('div', { class: 'repo-head' });
  const statebar = h('div');
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const view = h('div', { class: 'view' });
  mount(main, head, statebar, tabs, view);
  let disposeTab = null;
  let disposed = false;

  function renderHead() {
    const s = r.summary || {};
    const pullLabel = s.behind ? `Pull ${s.behind}` : 'Pull';
    const pushLabel = !s.upstream && s.branch ? 'Publish' : s.ahead ? `Push ${s.ahead}` : 'Push';
    const b = boardFor(r);
    const bs = boardState(b);
    mount(head,
      h('div', { class: 'col', style: { gap: '0' } },
        h('div', { class: 'row' }, h('span', { class: 'title' }, r.label), r.slug && r.slug.github ? h('a', { class: 'faint', style: { fontSize: '12px' }, onclick: () => rpc('open.url', { url: `https://github.com/${r.slug.owner}/${r.slug.repo}` }) }, `${r.slug.owner}/${r.slug.repo}`) : null),
        h('span', { class: 'faint', style: { fontSize: '11px' } }, r.path)),
      h('span', { class: 'sep' }),
      h('button', { class: 'btn', title: 'Switch branch', onclick: (e) => branchMenu(e.currentTarget) },
        icon('branch'), s.detached ? `detached @ ${(s.oid || '').slice(0, 8)}` : s.branch || '(no commits)', icon('chevronDown', 'sm')),
      s.upstream ? h('span', { class: 'faint', style: { fontSize: '12px' }, title: 'Upstream' }, `→ ${s.upstream}`) : null,
      s.defaultBranch && s.branch && s.branch !== s.defaultBranch && s.behindDefault
        ? h('button', { class: 'btn small', title: `${s.behindDefault} commit(s) on ${s.defaultRemoteRef} are not in this branch`, onclick: () => updateFromDefault(r) }, icon('warn', 'sm'), `${s.behindDefault} behind ${s.defaultBranch}`) : null,
      h('span', { class: 'spacer' }),
      bs ? h('button', { class: 'btn small ghost', title: `Latest workflow runs on ${b.branch}`, onclick: () => navigate(`#/repo/${r.id}/actions`) },
        h('span', { class: `dot ${bs === 'failure' ? 'bad' : bs === 'running' ? 'run' : bs === 'success' ? 'ok' : ''}` }), `${b.branch}: ${bs === 'failure' ? 'failing' : bs === 'running' ? 'running' : bs === 'success' ? 'passing' : bs}`) : null,
      h('div', { class: 'btngroup' },
        btn('Fetch', () => act(() => rpc('repo.fetch', { id: r.id }), { ok: 'Fetched' }), { iconName: 'fetch', title: 'Fetch from all remotes' }),
        btn(pullLabel, () => pull(r), { iconName: 'pull', title: `Pull (${store.config.pullStrategy})`, disabled: !s.upstream }),
        btn(pushLabel, () => push(r), { iconName: 'push', title: s.upstream ? 'Push commits' : 'Publish this branch to origin', disabled: !s.branch }),
        btn('Sync', () => act(() => rpc('repo.sync', { id: r.id }), { ok: 'Synced' }), { iconName: 'sync', title: 'Pull, then push', disabled: !s.upstream })),
      iconBtn('more', 'More actions', (e) => menuBelow(e.currentTarget, moreMenu(r))),
      r.busy ? h('span', { class: 'badge run' }, icon('refresh', 'sm spin'), r.busy.label) : null);
    renderState();
  }

  function renderState() {
    const s = r.summary || {};
    const items = [];
    for (const op of s.inProgress || []) {
      const conflicted = s.counts && s.counts.conflicted;
      const text = {
        merge: 'A merge is in progress.', rebase: 'A rebase is in progress.', 'cherry-pick': 'A cherry-pick is in progress.',
        revert: 'A revert is in progress.', bisect: 'A bisect session is active.', am: 'Applying patches (git am) is in progress.',
      }[op] || `${op} in progress.`;
      items.push(h('div', { class: `statebar ${conflicted ? 'bad' : ''}` },
        icon('warn'), h('strong', null, text),
        conflicted ? h('span', null, `${plural(conflicted, 'file')} with conflicts. Resolve them in Changes, then continue.`) : op !== 'bisect' ? h('span', null, 'No conflicts left.') : null,
        h('span', { class: 'spacer' }),
        op !== 'bisect' ? btn('Continue', () => act(() => rpc('op.continue', { id: r.id, op }), { ok: `${op} continued` }), { cls: 'primary small', disabled: !!conflicted }) : null,
        ['rebase', 'cherry-pick', 'revert'].includes(op) ? btn('Skip this commit', async () => { if (await confirmDanger({ title: 'Skip commit?', message: `The current commit will be left out of the ${op}. Its changes will not be applied.`, confirmLabel: 'Skip' })) act(() => rpc('op.skip', { id: r.id, op })); }, { cls: 'small' }) : null,
        btn(op === 'bisect' ? 'End bisect' : 'Abort', async () => {
          if (await confirmDanger({ title: `Abort ${op}?`, message: op === 'bisect' ? 'Ends the bisect session and returns to the original branch.' : `Stops the ${op} and returns the branch to where it was before. Any conflict resolutions made so far are lost.`, confirmLabel: 'Abort' })) act(() => rpc('op.abort', { id: r.id, op }), { ok: `${op} aborted` });
        }, { cls: 'danger small' })));
    }
    if (s.locked) items.push(h('div', { class: 'statebar bad' }, icon('warn'), h('strong', null, 'The index is locked.'),
      h('span', null, 'Another git process is running in this repository, or one crashed and left .git/index.lock behind. If no git program is running, delete that file and refresh.')));
    if (s.detached && !(s.inProgress || []).length) items.push(h('div', { class: 'statebar' }, icon('warn'), h('strong', null, 'Detached HEAD.'),
      h('span', null, 'Commits made here belong to no branch.'), h('span', { class: 'spacer' }),
      btn('Create branch here', () => createBranchDialog(r, { from: 'HEAD' }), { cls: 'small' })));
    if (s.error) items.push(h('div', { class: 'statebar bad' }, icon('warn'), h('strong', null, 'Could not read repository status:'), h('span', null, s.error)));
    mount(statebar, items);
  }

  function renderTabs() {
    mount(tabs, TABS.map(([k, label, ic]) => {
      let extra = null;
      const s = r.summary || {};
      if (k === 'changes' && s.dirty) extra = h('span', { class: 'badge dirty' }, s.dirty);
      if (k === 'stashes' && s.stash) extra = h('span', { class: 'badge' }, s.stash);
      if (k === 'actions') { const bs = boardState(boardFor(r)); if (bs === 'failure') extra = h('span', { class: 'dot bad' }); else if (bs === 'running') extra = h('span', { class: 'dot run' }); }
      return h('button', { class: `tab ${tab === k ? 'active' : ''}`, role: 'tab', onclick: () => navigate(`#/repo/${r.id}/${k}`), title: `Alt+${TABS.findIndex((t) => t[0] === k) + 1}` }, icon(ic, 'sm'), label, extra);
    }));
  }

  function branchMenu(el) {
    rpc('repo.refs', { id: r.id }).then((refs) => {
      const s = r.summary || {};
      const locals = refs.local.sort((a, b) => b.time - a.time).slice(0, 25);
      menuBelow(el, [
        { label: 'Create new branch…', icon: 'plus', action: () => createBranchDialog(r, {}) },
        { label: 'All branches…', icon: 'list', action: () => navigate(`#/repo/${r.id}/branches`) },
        '-', { header: true, label: 'Recent local branches' },
        ...locals.map((b) => ({ label: `${b.name}${b.current ? '  (current)' : ''}${b.gone ? '  [upstream gone]' : ''}`, icon: 'branch', disabled: b.current, action: () => switchTo(r, { name: b.name }, s) })),
      ]);
    }).catch((e) => showError(e));
  }

  const unsubs = [
    subscribe('summary', (sid) => { if (sid === id && !disposed) { renderHead(); renderTabs(); if (disposeTab && disposeTab.onSummary) disposeTab.onSummary(); } }),
    subscribe('board', () => { if (!disposed) { renderHead(); renderTabs(); } }),
  ];
  renderHead(); renderTabs();
  rpc('repo.summary', { id }).catch(() => {});

  mount(view, h('div', { class: 'skeleton' }, 'Loading…'));
  LOADERS[tab]().then((m) => {
    if (disposed) return;
    disposeTab = m.render(view, r, sub) || null;
  }).catch((e) => mount(view, h('div', { class: 'errbox' }, e.stack || e.message)));

  return () => {
    disposed = true;
    unsubs.forEach((u) => u());
    if (disposeTab) { if (typeof disposeTab === 'function') disposeTab(); else if (disposeTab.dispose) disposeTab.dispose(); }
  };
}

// ---------- shared actions (also used by other views) ----------

export async function pull(r) {
  await act(() => rpc('repo.pull', { id: r.id }), { ok: (x) => (x && x.output && /Already up to date/i.test(x.output) ? 'Already up to date' : 'Pulled') });
}

export async function push(r, opts = {}) {
  try {
    const res = await rpc('repo.push', { id: r.id, ...opts });
    banner({ level: 'success', title: `Pushed ${res.branch}`, body: r.slug && r.slug.github ? 'Watching the workflow runs this push starts. You will be notified when they finish.' : null, timeout: 5000 });
  } catch (e) {
    if (/\[rejected\]|non-fast-forward|fetch first|stale info/i.test(`${e.message} ${e.stderr}`)) {
      const choice = await import('./dom.js').then((d) => d.modal({
        title: 'Push rejected',
        body: h('div', { class: 'col' }, h('div', null, 'The remote has commits that are not in your branch. Pull them first, then push again.'), h('div', { class: 'errbox' }, e.message)),
        actions: [{ label: 'Close', value: null }, { label: 'Pull now', cls: 'primary', default: true, value: 'pull' }],
      }));
      if (choice === 'pull') await pull(r);
      return;
    }
    showError(e, 'Push failed');
  }
}

export async function switchTo(r, target, s) {
  s = s || r.summary || {};
  let mode = 'carry';
  if (s.dirty) {
    const choice = await import('./dom.js').then((d) => d.modal({
      title: `Switch to ${target.name || target.remoteRef}?`,
      body: h('div', { class: 'col' }, h('div', null, `You have ${plural(s.dirty, 'uncommitted change')}. What should happen to them?`),
        h('ul', null, h('li', null, h('strong', null, 'Stash and switch: '), 'save them in a stash (you can apply it later).'),
          h('li', null, h('strong', null, 'Bring changes: '), 'keep them in the working tree. Git refuses if they conflict with the other branch; nothing is lost.'))),
      actions: [{ label: 'Cancel', value: null }, { label: 'Bring changes', value: 'carry' }, { label: 'Stash and switch', cls: 'primary', default: true, value: 'stash' }],
    }));
    if (!choice) return;
    mode = choice;
  }
  await act(() => rpc('branch.switch', { id: r.id, ...target, mode }), { ok: `Switched to ${target.name || target.remoteRef}${mode === 'stash' ? ' (changes stashed)' : ''}` });
}

export async function createBranchDialog(r, { from } = {}) {
  const s = r.summary || {};
  const opts = [{ value: '', label: `Current HEAD${s.branch ? ` (${s.branch})` : ''}` }];
  if (s.defaultRemoteRef) opts.push({ value: s.defaultRemoteRef, label: `${s.defaultRemoteRef} (latest default branch)` });
  if (from && from !== 'HEAD') opts.unshift({ value: from, label: from });
  const v = await form({
    title: 'Create branch',
    fields: [
      { name: 'name', label: 'Branch name', required: true, placeholder: 'feature/my-change', validate: (x) => (/\s|\.\.|[~^:?*[\\]/.test(x) || x.startsWith('-') ? 'Branch names cannot contain spaces, "..", or ~ ^ : ? * [ \\' : null) },
      { name: 'from', label: 'Start from', type: 'select', options: opts, value: from && from !== 'HEAD' ? from : '' },
      { name: 'checkout', label: 'Switch to the new branch', type: 'checkbox', value: true },
    ],
    submit: 'Create',
  });
  if (!v) return;
  await act(() => rpc('branch.create', { id: r.id, name: v.name.trim(), from: v.from || undefined, checkout: v.checkout }), { ok: `Created ${v.name}` });
}

async function updateFromDefault(r) {
  const s = r.summary;
  const how = store.config.updateFromDefault;
  if (s.dirty) { banner({ level: 'warn', title: 'Commit or stash your changes first', timeout: 4000 }); return; }
  const ok = await confirmDanger({ title: `Update from ${s.defaultBranch}?`, message: `${how === 'rebase' ? 'Rebase' : 'Merge'} ${s.behindDefault} new commit(s) from ${s.defaultRemoteRef} into ${s.branch}.${how === 'rebase' && s.upstream ? ' Rebasing a pushed branch means you will need to force push.' : ''}`, confirmLabel: how === 'rebase' ? 'Rebase' : 'Merge', danger: false });
  if (!ok) return;
  await act(() => rpc(how === 'rebase' ? 'branch.rebase' : 'branch.merge', how === 'rebase' ? { id: r.id, onto: s.defaultRemoteRef } : { id: r.id, rev: s.defaultRemoteRef }), { ok: `Updated from ${s.defaultBranch}` });
}

function moreMenu(r) {
  const s = r.summary || {};
  return [
    { header: true, label: 'Sync' },
    { label: 'Fetch and prune deleted remote branches', icon: 'fetch', action: () => act(() => rpc('repo.fetch', { id: r.id, prune: true }), { ok: 'Fetched and pruned' }) },
    { label: 'Pull (rebase)', icon: 'pull', disabled: !s.upstream, action: () => act(() => rpc('repo.pull', { id: r.id, strategy: 'rebase' }), { ok: 'Pulled with rebase' }) },
    { label: 'Pull (fast-forward only)', icon: 'pull', disabled: !s.upstream, action: () => act(() => rpc('repo.pull', { id: r.id, strategy: 'ff-only' }), { ok: 'Pulled' }) },
    { label: 'Pull (merge)', icon: 'pull', disabled: !s.upstream, action: () => act(() => rpc('repo.pull', { id: r.id, strategy: 'merge' }), { ok: 'Pulled' }) },
    { label: 'Push all tags', icon: 'tag', action: () => act(() => rpc('repo.pushTags', { id: r.id }), { ok: 'Tags pushed' }) },
    { label: 'Force push (with lease)…', icon: 'push', danger: true, disabled: !s.upstream, action: async () => {
      if (await confirmDanger({ title: 'Force push?', message: `Overwrites ${s.upstream} with your local ${s.branch}. Commits on the remote that are not in your branch will be removed from it. "With lease" refuses if someone pushed since your last fetch.`, recover: 'Removed remote commits can only be recovered from another clone or the reflog of whoever pushed them.', confirmLabel: 'Force push' })) push(r, { forceWithLease: true });
    } },
    '-', { header: true, label: 'Commits' },
    { label: 'Undo last commit', icon: 'undo', action: () => undoCommit(r) },
    { label: 'Reword last commit…', icon: 'edit', action: () => reword(r) },
    { label: 'Squash recent commits…', icon: 'merge', action: () => squash(r) },
    '-', ...repoMenu(r),
  ];
}

export async function undoCommit(r) {
  if (!(await confirmDanger({ title: 'Undo last commit?', message: 'The last commit is removed from the branch and its changes go back to the staging area. Nothing in your files is lost.', confirmLabel: 'Undo commit', danger: false }))) return;
  try { await rpc('repo.undoCommit', { id: r.id }); banner({ level: 'success', title: 'Last commit undone; its changes are staged', timeout: 3500 }); } catch (e) {
    if (e.hint === 'revert') {
      if (await confirmDanger({ title: 'Commit already pushed', message: `${e.message}\n\nCreate a revert commit now?`, confirmLabel: 'Revert', danger: false })) act(() => rpc('commit.revert', { id: r.id, rev: 'HEAD' }), { ok: 'Revert commit created' });
    } else showError(e);
  }
}
async function reword(r) {
  const msg = await rpc('repo.lastMessage', { id: r.id }).catch(() => '');
  const v = await form({ title: 'Reword last commit', fields: [{ name: 'm', label: 'Message', type: 'textarea', value: msg, required: true }], submit: 'Save message' });
  if (v) act(() => rpc('repo.reword', { id: r.id, message: v.m }), { ok: 'Commit message updated' });
}
async function squash(r) {
  const log = await rpc('repo.unpushedLog', { id: r.id }).catch((e) => { showError(e); return null; });
  if (!log) return;
  if (log.length < 2) { banner({ level: 'info', title: 'Need at least two unpushed commits to squash', timeout: 4000 }); return; }
  const v = await form({
    title: 'Squash unpushed commits',
    intro: h('div', { class: 'muted' }, `Only commits that are not on any remote can be squashed. ${log.length} available.`),
    fields: [
      { name: 'n', label: 'Number of commits (newest first)', type: 'select', options: log.slice(1).map((c, i) => ({ value: String(i + 2), label: `${i + 2}: down to "${c.subject}"` })), value: '2' },
      { name: 'm', label: 'Message for the combined commit', type: 'textarea', value: log.slice(0, 2).map((c) => c.subject).join('\n'), required: true },
    ],
    submit: 'Squash',
  });
  if (v) act(() => rpc('repo.squash', { id: r.id, count: +v.n, message: v.m }), { ok: 'Commits squashed' });
}
export { prompt, menuAt };
