// Branches, tags, remotes, worktrees and submodules.
import { h, mount, icon, btn, act, menuAt, confirmDanger, form, prompt, ago, copyText, banner, showError } from '../dom.js';
import { rpc } from '../api.js';
import { navigate } from '../router.js';
import { createBranchDialog, switchTo } from '../repoview.js';

export function render(view, r) {
  const page = h('div', { class: 'page' });
  mount(view, page);
  let disposed = false;
  let filter = '';

  async function load() {
    let refs;
    try { refs = await rpc('repo.refs', { id: r.id }); } catch (e) { mount(page, h('div', { class: 'errbox' }, e.message)); return; }
    if (disposed) return;
    const [remotes, worktrees, subs] = await Promise.all([
      rpc('repo.remotes', { id: r.id }).catch(() => []), rpc('repo.worktrees', { id: r.id }).catch(() => []), rpc('repo.submodules', { id: r.id }).catch(() => []),
    ]);
    const f = (b) => !filter || b.name.toLowerCase().includes(filter.toLowerCase());
    const search = h('input', { type: 'search', placeholder: 'Filter branches and tags', value: filter, style: { width: '260px' }, oninput: (e) => { filter = e.target.value; load(); } });
    mount(page,
      h('div', { class: 'row', style: { marginBottom: '12px' } }, search, h('span', { class: 'spacer' }),
        btn('New branch', () => createBranchDialog(r).then(load), { cls: 'primary', iconName: 'plus' }),
        btn('Compare branches…', () => compareDialog(refs), { iconName: 'diff' }),
        btn('Fetch and prune', () => act(() => rpc('repo.fetch', { id: r.id, prune: true }), { ok: 'Fetched' }).then(load), { iconName: 'fetch' })),
      h('div', { class: 'section-title' }, h('h2', null, 'Local branches'), h('span', { class: 'faint' }, refs.defaultRemoteRef ? `merged = contained in ${refs.defaultRemoteRef}` : '')),
      h('table', { class: 'grid panel' },
        h('tr', null, h('th', null, 'Branch'), h('th', null, 'Upstream'), h('th', null, 'Ahead / behind'), h('th', null, 'Last commit'), h('th', null, '')),
        refs.local.filter(f).sort((a, b) => (b.current - a.current) || (b.time - a.time)).map((b) => h('tr', { class: 'clickable', oncontextmenu: (e) => menuAt(e, localMenu(b, refs)), ondblclick: () => !b.current && switchTo(r, { name: b.name }).then(load) },
          h('td', null, h('div', { class: 'row' }, icon('branch', 'sm'), h('strong', { style: { fontWeight: b.current ? 700 : 500 } }, b.name),
            b.current ? h('span', { class: 'badge accent' }, 'current') : null, b.name === refs.defaultBranch ? h('span', { class: 'badge' }, 'default') : null,
            b.merged && b.name !== refs.defaultBranch ? h('span', { class: 'badge ok' }, 'merged') : null)),
          h('td', null, b.upstream ? h('span', { class: b.gone ? 'muted' : '' }, b.upstream, b.gone ? h('span', { class: 'badge bad', style: { marginLeft: '6px' } }, 'gone') : null) : h('span', { class: 'faint' }, 'not published')),
          h('td', null, b.upstream && !b.gone ? `${b.ahead} ↑  ${b.behind} ↓` : ''),
          h('td', { class: 'muted' }, h('div', { class: 'ellipsis', style: { maxWidth: '380px' } }, b.subject), h('div', { class: 'faint', style: { fontSize: '11px' } }, `${b.author} · ${ago(b.time)}`)),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            !b.current ? btn('Switch', () => switchTo(r, { name: b.name }).then(load), { cls: 'small' }) : null, ' ',
            btn('', (e) => menuAt(e, localMenu(b, refs)), { cls: 'small icon', iconName: 'more', title: 'More' }))))),
      h('div', { class: 'section-title' }, h('h2', null, 'Remote branches')),
      h('table', { class: 'grid panel' },
        h('tr', null, h('th', null, 'Branch'), h('th', null, 'Last commit'), h('th', null, '')),
        refs.remote.filter(f).sort((a, b) => b.time - a.time).slice(0, 300).map((b) => h('tr', { oncontextmenu: (e) => menuAt(e, remoteMenu(b)) },
          h('td', null, h('div', { class: 'row' }, icon('branch', 'sm'), b.name)),
          h('td', { class: 'muted' }, h('div', { class: 'ellipsis', style: { maxWidth: '420px' } }, b.subject), h('div', { class: 'faint', style: { fontSize: '11px' } }, `${b.author} · ${ago(b.time)}`)),
          h('td', { style: { textAlign: 'right' } }, btn('Check out', () => checkoutRemote(b), { cls: 'small' }), ' ', btn('', (e) => menuAt(e, remoteMenu(b)), { cls: 'small icon', iconName: 'more' }))))),
      h('div', { class: 'section-title' }, h('h2', null, 'Tags'), h('span', { class: 'spacer' }),
        btn('New tag', () => newTag(), { cls: 'small', iconName: 'plus' }), btn('Push all tags', () => act(() => rpc('repo.pushTags', { id: r.id }), { ok: 'Tags pushed' }), { cls: 'small', iconName: 'push' })),
      refs.tags.length ? h('table', { class: 'grid panel' },
        h('tr', null, h('th', null, 'Tag'), h('th', null, 'Commit'), h('th', null, 'Type'), h('th', null, '')),
        refs.tags.filter(f).sort((a, b) => b.time - a.time).slice(0, 300).map((t) => h('tr', null,
          h('td', null, h('div', { class: 'row' }, icon('tag', 'sm'), t.name)),
          h('td', null, h('a', { class: 'mono', onclick: () => navigate(`#/repo/${r.id}/graph/${t.target}`) }, t.target.slice(0, 8)), ' ', h('span', { class: 'muted' }, t.subject)),
          h('td', { class: 'muted' }, t.annotated ? 'annotated' : 'lightweight'),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            btn('Push', () => act(() => rpc('tag.push', { id: r.id, name: t.name }), { ok: 'Tag pushed' }), { cls: 'small' }), ' ',
            btn('Delete…', () => deleteTag(t), { cls: 'small danger' })))))
        : h('div', { class: 'muted' }, 'No tags.'),
      h('div', { class: 'section-title' }, h('h2', null, 'Remotes'), h('span', { class: 'spacer' }), btn('Add remote', () => addRemote(), { cls: 'small', iconName: 'plus' })),
      remotes.length ? h('table', { class: 'grid panel' }, h('tr', null, h('th', null, 'Name'), h('th', null, 'URL'), h('th', null, '')),
        remotes.map((rm) => h('tr', null, h('td', null, rm.name), h('td', { class: 'mono' }, rm.url, rm.pushUrl ? h('div', { class: 'faint' }, `push: ${rm.pushUrl}`) : null),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            btn('Copy', () => copyText(rm.url), { cls: 'small' }), ' ',
            btn('Change URL…', () => changeUrl(rm), { cls: 'small' }), ' ',
            btn('Remove…', () => removeRemote(rm), { cls: 'small danger' })))))
        : h('div', { class: 'muted' }, 'No remotes. Add one to push and to use GitHub features.'),
      h('div', { class: 'section-title' }, h('h2', null, 'Worktrees'), h('span', { class: 'spacer' }), btn('Add worktree', () => addWorktree(refs), { cls: 'small', iconName: 'plus' })),
      h('table', { class: 'grid panel' }, h('tr', null, h('th', null, 'Folder'), h('th', null, 'Branch'), h('th', null, '')),
        worktrees.map((w, i) => h('tr', null, h('td', { class: 'mono' }, w.path, i === 0 ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'main') : null, w.prunable ? h('span', { class: 'badge warn', style: { marginLeft: '6px' } }, 'missing') : null),
          h('td', null, w.detached ? `detached @ ${(w.head || '').slice(0, 8)}` : w.branch || ''),
          h('td', { style: { textAlign: 'right' } }, i > 0 ? btn('Remove…', () => removeWorktree(w), { cls: 'small danger' }) : null)))),
      subs.length ? [
        h('div', { class: 'section-title' }, h('h2', null, 'Submodules'), h('span', { class: 'spacer' }), btn('Init and update all', () => act(() => rpc('repo.updateSubmodules', { id: r.id }), { ok: 'Submodules updated' }).then(load), { cls: 'small' })),
        h('table', { class: 'grid panel' }, h('tr', null, h('th', null, 'Path'), h('th', null, 'Commit'), h('th', null, 'State')),
          subs.map((s) => h('tr', null, h('td', { class: 'mono' }, s.path), h('td', { class: 'mono' }, s.hash.slice(0, 10), ' ', h('span', { class: 'muted' }, s.describe)),
            h('td', null, h('span', { class: `badge ${s.code === ' ' ? 'ok' : s.code === 'U' ? 'bad' : 'warn'}` }, s.state))))),
      ] : null);
  }

  function localMenu(b, refs) {
    return [
      { header: true, label: b.name },
      { label: 'Switch to this branch', icon: 'branch', disabled: b.current, action: () => switchTo(r, { name: b.name }).then(load) },
      { label: 'Show in graph', icon: 'graph', action: () => navigate(`#/repo/${r.id}/graph/${b.hash}`) },
      { label: 'Rename…', icon: 'edit', action: async () => { const to = await prompt('Rename branch', 'New name', b.name); if (to && to !== b.name) act(() => rpc('branch.rename', { id: r.id, from: b.name, to }), { ok: 'Renamed' }).then(load); } },
      { label: 'Set upstream…', icon: 'push', action: async () => {
        const v = await form({ title: `Set upstream of ${b.name}`, fields: [{ name: 'u', label: 'Upstream', type: 'select', options: refs.remote.map((x) => x.name), value: `origin/${b.name}` }], submit: 'Set' });
        if (v) act(() => rpc('branch.setUpstream', { id: r.id, branch: b.name, upstream: v.u }), { ok: 'Upstream set' }).then(load);
      } },
      '-',
      { label: 'Merge into current branch…', icon: 'merge', disabled: b.current, action: async () => { if (await confirmDanger({ title: `Merge ${b.name}?`, message: `Merge ${b.name} into ${refs.current}.`, confirmLabel: 'Merge', danger: false })) mergeOrRebase('branch.merge', { rev: b.name }); } },
      { label: 'Rebase current branch onto this…', icon: 'branch', disabled: b.current, action: async () => { if (await confirmDanger({ title: `Rebase onto ${b.name}?`, message: `Replay the commits of ${refs.current} on top of ${b.name}. If ${refs.current} is already pushed you will need to force push.`, confirmLabel: 'Rebase', danger: false })) mergeOrRebase('branch.rebase', { onto: b.name }); } },
      { label: 'Compare with current branch', icon: 'diff', disabled: b.current, action: () => showCompare(refs.current, b.name) },
      '-',
      { label: 'Delete…', icon: 'trash', danger: true, disabled: b.current, action: () => deleteLocal(b, refs) },
      b.upstream && !b.gone ? { label: `Delete ${b.upstream} on the remote…`, icon: 'trash', danger: true, action: () => deleteRemote({ name: b.upstream }) } : null,
      { label: 'Copy name', icon: 'copy', action: () => copyText(b.name) },
    ];
  }
  function remoteMenu(b) {
    return [
      { header: true, label: b.name },
      { label: 'Check out as local branch', icon: 'branch', action: () => checkoutRemote(b) },
      { label: 'Show in graph', icon: 'graph', action: () => navigate(`#/repo/${r.id}/graph/${b.hash}`) },
      { label: 'Merge into current branch…', icon: 'merge', action: async () => { if (await confirmDanger({ title: `Merge ${b.name}?`, message: `Merge ${b.name} into the current branch.`, confirmLabel: 'Merge', danger: false })) mergeOrRebase('branch.merge', { rev: b.name }); } },
      { label: 'Delete on remote…', icon: 'trash', danger: true, action: () => deleteRemote(b) },
      { label: 'Copy name', icon: 'copy', action: () => copyText(b.name) },
    ];
  }
  async function mergeOrRebase(method, params) {
    try { await rpc(method, { id: r.id, ...params }); banner({ level: 'success', title: method === 'branch.merge' ? 'Merged' : 'Rebased', timeout: 3000 }); } catch (e) {
      if (/CONFLICT|could not apply|Automatic merge failed/i.test(`${e.message}${e.stderr}`)) banner({ level: 'warn', title: 'Stopped on conflicts', body: 'Resolve them in the Changes tab, then Continue or Abort.', timeout: 0, actions: [{ label: 'Go to Changes', action: () => navigate(`#/repo/${r.id}/changes`) }] });
      else showError(e);
    }
    load();
  }
  async function checkoutRemote(b) {
    const local = b.name.slice(b.name.indexOf('/') + 1);
    await switchTo(r, { remoteRef: b.name, name: local });
    load();
  }
  async function deleteLocal(b, refs) {
    const merged = b.merged || (await rpc('branch.isMerged', { id: r.id, name: b.name }).catch(() => ({ merged: false }))).merged;
    const ok = await confirmDanger({
      title: `Delete branch ${b.name}?`,
      message: merged ? `"${b.name}" is merged into ${refs.defaultRemoteRef || 'the current branch'}; nothing is lost.` : `"${b.name}" has commits that are not merged into ${refs.defaultRemoteRef || 'the current branch'}${b.ahead ? ` (${b.ahead} not pushed)` : ''}. Those commits will no longer be on any branch.`,
      recover: merged ? null : 'Recoverable through git reflog for about 90 days.',
      confirmLabel: merged ? 'Delete' : 'Delete unmerged branch',
    });
    if (ok) act(() => rpc('branch.delete', { id: r.id, name: b.name, force: !merged }), { ok: `Deleted ${b.name}` }).then(load);
  }
  async function deleteRemote(b) {
    const slash = b.name.indexOf('/');
    const remote = b.name.slice(0, slash); const name = b.name.slice(slash + 1);
    if (await confirmDanger({ title: 'Delete remote branch?', message: `Delete "${name}" on ${remote}. Open pull requests from it will be closed by GitHub.`, recover: 'Can be restored only by pushing it again from a clone that still has it.', confirmLabel: 'Delete on remote' })) {
      act(() => rpc('branch.deleteRemote', { id: r.id, remote, name }), { ok: 'Remote branch deleted' }).then(load);
    }
  }
  async function newTag() {
    const v = await form({ title: 'New tag on HEAD', fields: [{ name: 'name', label: 'Tag name', required: true, placeholder: 'v1.2.3' }, { name: 'message', label: 'Message (optional: makes an annotated tag)', type: 'textarea', rows: 3 }, { name: 'push', label: 'Push to origin', type: 'checkbox' }], submit: 'Create' });
    if (!v) return;
    const ok = await act(() => rpc('tag.create', { id: r.id, name: v.name.trim(), message: v.message.trim() || undefined }), { ok: 'Tag created' });
    if (ok !== undefined && v.push) await act(() => rpc('tag.push', { id: r.id, name: v.name.trim() }), { ok: 'Tag pushed' });
    load();
  }
  async function deleteTag(t) {
    const v = await form({ title: `Delete tag ${t.name}?`, intro: h('div', null, 'Deleting a tag used by releases or deployments can break them.'), fields: [{ name: 'remote', label: 'Also delete it on origin', type: 'checkbox' }], submit: 'Delete', danger: true });
    if (!v) return;
    await act(() => rpc('tag.delete', { id: r.id, name: t.name }), { ok: 'Tag deleted' });
    if (v.remote) await act(() => rpc('tag.deleteRemote', { id: r.id, name: t.name }), { ok: 'Remote tag deleted' });
    load();
  }
  async function addRemote() {
    const v = await form({ title: 'Add remote', fields: [{ name: 'name', label: 'Name', value: 'origin', required: true }, { name: 'url', label: 'URL', required: true, placeholder: 'git@github.com:owner/repo.git' }], submit: 'Add' });
    if (v) act(() => rpc('repo.addRemote', { id: r.id, name: v.name.trim(), url: v.url.trim() }), { ok: 'Remote added' }).then(load);
  }
  async function changeUrl(rm) {
    const url = await prompt(`Change URL of ${rm.name}`, 'URL', rm.url);
    if (url && url !== rm.url) act(() => rpc('repo.setRemoteUrl', { id: r.id, name: rm.name, url }), { ok: 'Remote updated' }).then(load);
  }
  async function removeRemote(rm) {
    if (await confirmDanger({ title: `Remove remote ${rm.name}?`, message: `Removes the remote and its remote-tracking branches from this clone. Nothing on the server changes.`, confirmLabel: 'Remove' })) act(() => rpc('repo.removeRemote', { id: r.id, name: rm.name }), { ok: 'Remote removed' }).then(load);
  }
  async function addWorktree(refs) {
    const v = await form({ title: 'Add worktree', fields: [
      { name: 'dir', label: 'Folder for the worktree', required: true, value: `${r.path}-wt` },
      { name: 'mode', label: 'Branch', type: 'select', options: [{ value: 'new', label: 'Create a new branch' }, ...refs.local.filter((b) => !b.current).map((b) => ({ value: `existing:${b.name}`, label: `Existing: ${b.name}` }))], value: 'new' },
      { name: 'newBranch', label: 'New branch name (when creating)', placeholder: 'feature/x' },
    ], submit: 'Add' });
    if (!v) return;
    const params = v.mode === 'new' ? { dir: v.dir, newBranch: v.newBranch.trim() } : { dir: v.dir, branch: v.mode.slice(9) };
    act(() => rpc('repo.addWorktree', { id: r.id, ...params }), { ok: 'Worktree added' }).then(load);
  }
  async function removeWorktree(w) {
    if (await confirmDanger({ title: 'Remove worktree?', message: `Removes the folder ${w.path}. git refuses if it has uncommitted changes, so nothing unsaved is lost.`, confirmLabel: 'Remove' })) act(() => rpc('repo.removeWorktree', { id: r.id, dir: w.path }), { ok: 'Worktree removed' }).then(load);
  }
  async function compareDialog(refs) {
    const names = [...refs.local.map((b) => b.name), ...refs.remote.map((b) => b.name)];
    const v = await form({ title: 'Compare branches', fields: [
      { name: 'a', label: 'Branch', type: 'select', options: names, value: refs.current || names[0] },
      { name: 'b', label: 'Compared with', type: 'select', options: names, value: refs.defaultRemoteRef || names[0] },
    ], submit: 'Compare' });
    if (v) showCompare(v.a, v.b);
  }
  async function showCompare(a, b) {
    const { modal } = await import('../dom.js');
    const { createDiffView } = await import('../diffview.js');
    const res = await rpc('branch.compare', { id: r.id, a, b }).catch((e) => { showError(e); return null; });
    if (!res) return;
    const diff = createDiffView({});
    const files = h('div', { class: 'pane-scroll', style: { maxHeight: '180px', borderBottom: '1px solid var(--border)' } },
      res.files.map((f) => h('div', { class: 'file-row', onclick: async () => diff.set(await rpc('repo.diff', { id: r.id, kind: 'range', from: `${b}...${a}`, file: f.path })) },
        h('span', { class: `st st-${f.status}` }, f.status), h('span', { class: 'name' }, f.path))));
    const commitList = (list) => (list.length ? list.slice(0, 50).map((c) => h('div', { class: 'row', style: { fontSize: '12px' } }, h('span', { class: 'mono muted' }, c.hash.slice(0, 8)), h('span', { class: 'ellipsis' }, c.subject))) : h('div', { class: 'faint' }, 'none'));
    modal({
      title: `${a} compared with ${b}`, wide: true,
      body: h('div', { class: 'col' },
        h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '24px' } },
          h('div', { class: 'grow' }, h('h3', null, `Only in ${a} (${res.ahead})`), commitList(res.onlyA)),
          h('div', { class: 'grow' }, h('h3', null, `Only in ${b} (${res.behind})`), commitList(res.onlyB))),
        h('h3', null, `Files changed in ${a} since it diverged (${res.files.length})`), files, h('div', { style: { height: '40vh', display: 'flex' } }, diff.el)),
      actions: [{ label: 'Close', cls: 'primary', default: true, value: null }],
    });
  }

  load();
  return { dispose() { disposed = true; }, onSummary: () => {} };
}
