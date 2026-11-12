// Changes tab: VS Code Source Control equivalent.
import { h, mount, icon, btn, iconBtn, act, menuAt, menuBelow, confirmDanger, banner, plural, showError, debounce, ago, form, markdown, modal } from '../dom.js';
import { rpc } from '../api.js';
import { prefs, subscribe, store } from '../store.js';
import { navigate } from '../router.js';
import { createDiffView } from '../diffview.js';
import { push } from '../repoview.js';
import { fileHistory, blame, gitignoreMenu } from '../fileviews.js';

const GROUPS = [
  ['conflicted', 'Merge conflicts'], ['staged', 'Staged changes'], ['unstaged', 'Changes'], ['untracked', 'Untracked'],
];

export function render(view, r) {
  let data = null;
  let selected = prefs.get(`sel.${r.id}`, null); // { group, path, orig }
  let listMode = prefs.get('listMode', 'list');
  const collapsedGroups = new Set(prefs.get('collapsedGroups', []));
  let disposed = false;
  let loading = false;

  // ---------- commit box ----------
  const msgKey = `msg.${r.id}`;
  const msg = h('textarea', { rows: 3, placeholder: 'Commit message  (Ctrl+Enter to commit)', spellcheck: 'true' }, prefs.get(msgKey, ''));
  const hint = h('div', { class: 'subject-hint faint' });
  const amend = h('input', { type: 'checkbox' });
  const signoff = h('input', { type: 'checkbox', checked: prefs.get('signoff', false) });
  const noVerify = h('input', { type: 'checkbox' });
  const commitBtn = h('button', { class: 'btn primary grow', onclick: () => doCommit() }, icon('check'), 'Commit');
  const commitMore = h('button', { class: 'btn primary icon', title: 'More commit options', onclick: (e) => menuBelow(e.currentTarget, [
    { label: 'Commit and push', icon: 'push', action: () => doCommit({ then: 'push' }) },
    { label: 'Commit and sync (pull, then push)', icon: 'sync', action: () => doCommit({ then: 'sync' }) },
    { label: 'Stage everything and commit', icon: 'plus', action: () => doCommit({ stageAll: true }) },
    '-',
    { label: 'Undo last commit', icon: 'undo', action: () => import('../repoview.js').then((m) => m.undoCommit(r)) },
  ]) }, icon('chevronDown'));
  msg.addEventListener('input', () => { prefs.set(msgKey, msg.value); updateHint(); });
  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); doCommit(); } });
  amend.addEventListener('change', async () => {
    if (amend.checked && !msg.value.trim()) { try { msg.value = await rpc('repo.lastMessage', { id: r.id }); updateHint(); } catch {} }
    commitBtn.lastChild.textContent = amend.checked ? 'Amend commit' : 'Commit';
  });
  signoff.addEventListener('change', () => prefs.set('signoff', signoff.checked));
  function updateHint() {
    const subj = msg.value.split('\n')[0];
    hint.textContent = subj.length > 72 ? `Subject is ${subj.length} characters; 50–72 reads best in logs.` : subj.length ? `${subj.length} characters` : '';
    hint.style.color = subj.length > 72 ? 'var(--warn)' : '';
  }
  updateHint();
  const commitBox = h('div', { class: 'commitbox' }, msg, hint,
    h('div', { class: 'row wrap', style: { gap: '12px', fontSize: '12px' } },
      h('label', { class: 'check', title: 'Replace the last commit with a new one (only if not pushed)' }, amend, 'Amend'),
      h('label', { class: 'check', title: 'Add a Signed-off-by line' }, signoff, 'Sign-off'),
      h('label', { class: 'check', title: 'Skip pre-commit and commit-msg hooks (git commit --no-verify)' }, noVerify, 'Skip hooks')),
    h('div', { class: 'btngroup', style: { display: 'flex' } }, commitBtn, commitMore));

  const listEl = h('div', { class: 'pane-scroll', tabindex: '0', title: 'Keys: ↑/↓ select, S stage/unstage, Delete discard, E open in editor' });
  listEl.addEventListener('keydown', (e) => {
    if (!data || e.target !== listEl) return;
    const flat = GROUPS.filter(([g]) => !collapsedGroups.has(g)).flatMap(([g]) => data[g].map((f) => ({ g, f })));
    if (!flat.length) return;
    const i = selected ? flat.findIndex((x) => x.g === selected.group && x.f.path === selected.path) : -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      select(n.g, n.f);
      const row = listEl.querySelector('.file-row.selected'); if (row) row.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (i < 0) return;
    const { g, f } = flat[i];
    if (e.key.toLowerCase() === 's' && !e.ctrlKey) {
      e.preventDefault();
      if (g === 'staged') act(() => rpc('repo.unstage', { id: r.id, files: [f.path] }));
      else if (g === 'conflicted') markResolved(f);
      else act(() => rpc('repo.stage', { id: r.id, files: [f.path] }));
    } else if (e.key === 'Delete' && g !== 'staged' && g !== 'conflicted') { e.preventDefault(); discardFiles(g, [f]); }
    else if (e.key.toLowerCase() === 'e') { e.preventDefault(); act(() => rpc('open.editor', { id: r.id, file: f.path })); }
  });
  const listHead = h('div', { class: 'row', style: { padding: '6px 10px', borderBottom: '1px solid var(--border)' } });
  const left = h('div', { class: 'left' }, commitBox, listHead, listEl);
  const right = h('div', { class: 'right' });
  mount(view, h('div', { class: 'split' }, left, right));

  // ---------- data ----------
  async function load() {
    if (loading) return; loading = true;
    try {
      data = await rpc('repo.changes', { id: r.id });
      if (disposed) return;
      if (selected && !findFile(selected)) {
        // the file moved between groups (e.g. it was just staged): keep following it
        const alt = GROUPS.map(([g]) => g).find((g) => data[g].some((f) => f.path === selected.path));
        selected = alt ? { ...selected, group: alt } : null;
      }
      renderList();
      renderRight();
    } catch (e) {
      mount(listEl, h('div', { class: 'errbox', style: { margin: '10px' } }, e.message));
    } finally { loading = false; }
  }
  const reload = debounce(load, 250);

  function findFile(s) {
    if (!data || !s) return null;
    return (data[s.group] || []).find((f) => f.path === s.path) || null;
  }

  // ---------- file list ----------
  function renderList() {
    const total = GROUPS.reduce((a, [g]) => a + data[g].length, 0);
    mount(listHead,
      h('strong', null, total ? plural(total, 'change') : 'No changes'), h('span', { class: 'spacer' }),
      h('div', { class: 'pill-tabs' },
        h('button', { class: listMode === 'list' ? 'active' : '', title: 'Flat list', onclick: () => { listMode = 'list'; prefs.set('listMode', 'list'); renderList(); } }, icon('list', 'sm')),
        h('button', { class: listMode === 'tree' ? 'active' : '', title: 'Folder tree', onclick: () => { listMode = 'tree'; prefs.set('listMode', 'tree'); renderList(); } }, icon('tree', 'sm'))),
      iconBtn('refresh', 'Refresh', () => load()));
    const out = [];
    for (const [g, label] of GROUPS) {
      const files = data[g];
      if (!files.length) continue;
      const open = !collapsedGroups.has(g);
      out.push(h('div', { class: 'group-head', onclick: () => { if (open) collapsedGroups.add(g); else collapsedGroups.delete(g); prefs.set('collapsedGroups', [...collapsedGroups]); renderList(); } },
        icon(open ? 'chevronDown' : 'chevronRight', 'sm'), label, h('span', { class: 'badge' }, files.length),
        h('span', { class: 'actions' }, groupActions(g, files))));
      if (!open) continue;
      if (listMode === 'tree') out.push(...treeRows(g, files));
      else for (const f of files) out.push(fileRow(g, f, 0, true));
    }
    if (!total) {
      out.push(h('div', { class: 'empty' }, h('h3', null, 'Working tree clean'), h('div', null, 'Nothing to commit.')));
    }
    mount(listEl, out);
  }

  function groupActions(g, files) {
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    if (g === 'staged') return [btn('', stop(() => act(() => rpc('repo.unstageAll', { id: r.id }))), { cls: 'small ghost icon', iconName: 'minus', title: 'Unstage all' })];
    if (g === 'conflicted') return [];
    return [
      btn('', stop(() => discardFiles(g, files)), { cls: 'small ghost icon', iconName: 'undo', title: g === 'untracked' ? 'Delete all untracked files' : 'Discard all changes' }),
      btn('', stop(() => act(() => rpc('repo.stage', { id: r.id, files: files.map((f) => f.path) }))), { cls: 'small ghost icon', iconName: 'plus', title: 'Stage all' }),
    ];
  }

  function treeRows(g, files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = root;
      for (const p of parts.slice(0, -1)) { if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] }); node = node.dirs.get(p); }
      node.files.push(f);
    }
    const out = [];
    const walk = (node, depth, prefix) => {
      for (const [name, sub] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        // compress single-child chains
        let label = name; let n = sub; let full = prefix + name;
        while (n.dirs.size === 1 && !n.files.length) { const [[k, v]] = [...n.dirs]; label += `/${k}`; full += `/${k}`; n = v; }
        const key = `${g}:${full}`;
        const closed = collapsedGroups.has(key);
        out.push(h('div', { class: 'tree-dir', style: { paddingLeft: `${10 + depth * 14}px` }, onclick: () => { if (closed) collapsedGroups.delete(key); else collapsedGroups.add(key); renderList(); } },
          icon(closed ? 'chevronRight' : 'chevronDown', 'sm'), icon('folder', 'sm'), label));
        if (!closed) walk(n, depth + 1, full + '/');
      }
      for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) out.push(fileRow(g, f, depth, false));
    };
    walk(root, 0, '');
    return out;
  }

  function fileRow(g, f, depth, showDir) {
    const name = f.path.split('/').pop();
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const st = g === 'conflicted' ? 'U' : g === 'untracked' ? '?' : f.status;
    const isSel = selected && selected.group === g && selected.path === f.path;
    const acts = [];
    acts.push(iconBtn('edit', 'Open file in editor', () => act(() => rpc('open.editor', { id: r.id, file: f.path })), 'small'));
    if (g === 'staged') acts.push(iconBtn('minus', 'Unstage', () => act(() => rpc('repo.unstage', { id: r.id, files: [f.path] })), 'small'));
    else if (g !== 'conflicted') {
      acts.push(iconBtn('undo', g === 'untracked' ? 'Delete file' : 'Discard changes', () => discardFiles(g, [f]), 'small'));
      acts.push(iconBtn('plus', 'Stage', () => act(() => rpc('repo.stage', { id: r.id, files: [f.path] })), 'small'));
    } else acts.push(iconBtn('check', 'Mark as resolved (stage)', () => markResolved(f), 'small'));
    return h('div', {
      class: `file-row ${isSel ? 'selected' : ''}`, style: { paddingLeft: `${10 + depth * 14 + (listMode === 'tree' ? 14 : 0)}px` },
      title: `${f.path}${f.orig ? `\nrenamed from ${f.orig}` : ''}\n${f.label || f.conflict || ''}`,
      onclick: () => select(g, f), ondblclick: () => act(() => rpc('open.editor', { id: r.id, file: f.path })),
      oncontextmenu: (e) => menuAt(e, fileMenu(g, f)),
    },
    h('span', { class: `st st-${st}` }, st), h('span', { class: 'name' }, name, showDir && dir ? h('span', { class: 'dir' }, dir) : null, f.submodule ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'submodule') : null),
    h('span', { class: 'acts' }, acts));
  }

  function fileMenu(g, f) {
    return [
      { label: 'Open in editor', icon: 'edit', action: () => act(() => rpc('open.editor', { id: r.id, file: f.path })) },
      { label: 'Reveal in Explorer', icon: 'folder', action: () => act(() => rpc('open.explorer', { id: r.id, file: f.path })) },
      { label: 'Copy path', icon: 'copy', action: () => navigator.clipboard.writeText(f.path) },
      '-',
      g === 'staged' ? { label: 'Unstage', icon: 'minus', action: () => act(() => rpc('repo.unstage', { id: r.id, files: [f.path] })) }
        : { label: g === 'conflicted' ? 'Mark resolved' : 'Stage', icon: 'plus', action: () => (g === 'conflicted' ? markResolved(f) : act(() => rpc('repo.stage', { id: r.id, files: [f.path] }))) },
      g !== 'staged' && g !== 'conflicted' ? { label: g === 'untracked' ? 'Delete file…' : 'Discard changes…', icon: 'undo', danger: true, action: () => discardFiles(g, [f]) } : null,
      g === 'staged' ? { label: 'Discard staged and unstaged changes…', icon: 'undo', danger: true, action: () => discardFileCompletely(f) } : null,
      '-',
      g !== 'untracked' ? { label: 'File history', icon: 'log', action: () => fileHistory(r, f.path) } : null,
      g !== 'untracked' ? { label: 'Blame', icon: 'eye', action: () => blame(r, f.path) } : null,
      ...gitignoreMenu(r, f.path, g === 'untracked'),
    ];
  }

  function select(g, f) {
    selected = { group: g, path: f.path, orig: f.orig || null };
    prefs.set(`sel.${r.id}`, selected);
    renderList();
    renderRight();
    if (document.activeElement === document.body || document.activeElement.closest('.file-row')) listEl.focus({ preventScroll: true });
  }

  // ---------- actions ----------
  async function discardFiles(g, files) {
    const untracked = g === 'untracked';
    const ok = await confirmDanger({
      title: untracked ? `Delete ${plural(files.length, 'untracked file')}?` : `Discard changes in ${plural(files.length, 'file')}?`,
      message: untracked ? 'These files are not tracked by git and will be deleted from disk:' : 'Unstaged changes in these files will be reverted to the staged/committed version:',
      items: files.map((f) => f.path),
      recover: 'A safety copy is kept for 30 days. Restore it from "Recently discarded" on this tab.' + (untracked ? ' Untracked files over 200 MB in total are not copied and cannot be recovered.' : ''),
      confirmLabel: untracked ? 'Delete' : 'Discard',
    });
    if (!ok) return;
    const res = await act(() => rpc('repo.discard', { id: r.id, files: untracked ? [] : files.map((f) => f.path), untracked: untracked ? files.map((f) => f.path) : [] }));
    if (res) {
      banner({ level: 'success', title: untracked ? 'Files deleted' : 'Changes discarded', body: res.notBackedUp.length ? `Not backed up (too large): ${res.notBackedUp.join(', ')}` : 'A safety copy was kept.', actions: [{ label: 'Undo', action: () => restore(res.backup) }], timeout: 8000 });
    }
  }
  async function discardFileCompletely(f) {
    const ok = await confirmDanger({ title: 'Discard all changes to this file?', message: 'Both staged and unstaged changes will be reverted to the last commit:', items: [f.path], recover: 'A safety copy is kept for 30 days.', confirmLabel: 'Discard' });
    if (!ok) return;
    await act(async () => { await rpc('repo.unstage', { id: r.id, files: [f.path] }); return rpc('repo.discard', { id: r.id, files: [f.path] }); }, { ok: 'Changes discarded' });
  }
  async function restore(id) { await act(() => rpc('repo.restoreBackup', { id: r.id, backupId: id }), { ok: (x) => (x.messages.length ? `Restored. ${x.messages.join(' ')}` : 'Restored') }); }
  async function markResolved(f) {
    let text = '';
    try { const c = await rpc('conflict.get', { id: r.id, file: f.path }); text = c.segs.filter((s) => s.type === 'conflict').length; } catch {}
    if (text) {
      const ok = await confirmDanger({ title: 'Conflict markers remain', message: `${f.path} still contains ${plural(text, 'conflict')}. Mark it resolved anyway? The markers would be committed as file content.`, confirmLabel: 'Mark resolved', danger: true });
      if (!ok) return;
    }
    await act(() => rpc('conflict.markResolved', { id: r.id, files: [f.path] }), { ok: `${f.path} marked resolved` });
  }

  async function doCommit({ then, stageAll } = {}) {
    const message = msg.value;
    if (!message.trim() && !amend.checked) { msg.focus(); banner({ level: 'warn', title: 'Write a commit message first', timeout: 3000 }); return; }
    if (data && data.conflicted.length) { banner({ level: 'error', title: 'Resolve merge conflicts before committing', timeout: 4000 }); return; }
    let staged = data ? data.staged.length : 0;
    const other = data ? data.unstaged.length + data.untracked.length : 0;
    if (stageAll || (!staged && !amend.checked)) {
      if (!other && !staged) { banner({ level: 'info', title: 'Nothing to commit', timeout: 3000 }); return; }
      if (!stageAll) {
        const ok = await confirmDanger({ title: 'Nothing is staged', message: `Stage all ${plural(other, 'change')} (including untracked files) and commit them?`, confirmLabel: 'Stage all and commit', danger: false });
        if (!ok) return;
      }
      if (!(await act(() => rpc('repo.stageAll', { id: r.id })))) return;
      staged = other;
    }
    if (amend.checked) {
      const pushed = await rpc('repo.unpushedCount', { id: r.id }).catch(() => 1);
      if (pushed === 0 && !(await confirmDanger({ title: 'Amend a pushed commit?', message: 'The last commit is already on a remote. Amending rewrites it, so you would need to force push and anyone who pulled it gets a conflict.', confirmLabel: 'Amend anyway' }))) return;
    }
    commitBtn.disabled = true;
    try {
      const res = await rpc('repo.commit', { id: r.id, message, amend: amend.checked, signoff: signoff.checked, noVerify: noVerify.checked, then });
      msg.value = ''; prefs.set(msgKey, ''); updateHint();
      amend.checked = false; noVerify.checked = false; commitBtn.lastChild.textContent = 'Commit';
      banner({ level: 'success', title: then ? `Committed and ${then === 'push' ? 'pushed' : 'synced'}` : 'Committed', body: (res.output || '').split('\n')[0], timeout: 4000 });
    } catch (e) {
      showError(e, /hook/i.test(`${e.message}${e.stderr}`) ? 'Commit rejected by a git hook' : 'Commit failed');
    } finally { commitBtn.disabled = false; load(); }
  }

  // ---------- right pane ----------
  const diff = createDiffView({
    selectable: true,
    hunkActions: (fi, hk) => {
      if (!selected) return [];
      if (selected.group === 'unstaged') return [
        h('a', { onclick: () => applySel('stage', { [hk]: 'all' }) }, 'Stage hunk'),
        h('a', { onclick: () => applySel('discard', { [hk]: 'all' }), style: { color: 'var(--bad)' } }, 'Discard hunk'),
      ];
      if (selected.group === 'staged') return [h('a', { onclick: () => applySel('unstage', { [hk]: 'all' }) }, 'Unstage hunk')];
      return [];
    },
    get selectionActions() {
      if (!selected) return [];
      if (selected.group === 'unstaged') return [
        { label: 'Stage selected lines', cls: 'primary', run: (p) => applySel('stage', p.hunks) },
        { label: 'Discard selected lines', cls: 'danger', run: (p) => applySel('discard', p.hunks) },
      ];
      if (selected.group === 'staged') return [{ label: 'Unstage selected lines', cls: 'primary', run: (p) => applySel('unstage', p.hunks) }];
      return [];
    },
    toolbarExtra: () => {
      if (!selected) return null;
      const f = findFile(selected);
      return [
        h('span', { class: 'mono ellipsis', style: { fontWeight: 600 }, title: selected.path }, selected.path),
        h('span', { class: 'badge' }, selected.group === 'staged' ? 'staged' : selected.group === 'untracked' ? 'untracked' : 'working tree'),
        f && selected.group === 'unstaged' ? btn('Stage file', () => act(() => rpc('repo.stage', { id: r.id, files: [f.path] })), { cls: 'small' }) : null,
        f && selected.group === 'untracked' ? btn('Stage file', () => act(() => rpc('repo.stage', { id: r.id, files: [f.path] })), { cls: 'small' }) : null,
        f && selected.group === 'staged' ? btn('Unstage file', () => act(() => rpc('repo.unstage', { id: r.id, files: [f.path] })), { cls: 'small' }) : null,
        btn('Open', () => act(() => rpc('open.editor', { id: r.id, file: selected.path })), { cls: 'small ghost', iconName: 'edit' }),
      ];
    },
    onOptions: () => renderRight(),
    onFull: () => renderRight(true),
    binaryNode: (f) => imageCompare(f),
  });

  async function applySel(action, hunks) {
    if (action === 'discard') {
      const ok = await confirmDanger({ title: 'Discard selected changes?', message: `The selected lines in ${selected.path} will be reverted.`, recover: 'A safety copy is kept for 30 days under "Recently discarded".', confirmLabel: 'Discard' });
      if (!ok) return;
    }
    try {
      await rpc('repo.applySelection', { id: r.id, action, file: selected.path, selection: { hunks }, expect: diff.data && diff.data.fingerprint });
    } catch (e) { showError(e, 'Could not apply the selection'); }
    await load();
  }

  function imageCompare(f) {
    const path = selected.path;
    if (!/\.(png|jpe?g|gif|bmp|webp|ico|svg)$/i.test(path)) return 'Binary file: contents not shown.';
    const wrap = h('div', { class: 'images' });
    const sides = selected.group === 'staged' ? [['HEAD', 'Before (last commit)'], ['INDEX', 'After (staged)']]
      : selected.group === 'untracked' ? [['WORKTREE', 'New file']] : [['INDEX', 'Before (staged/committed)'], ['WORKTREE', 'After (working tree)']];
    for (const [rev, label] of sides) {
      const fig = h('figure', null, h('div', { class: 'faint' }, 'Loading…'), h('figcaption', { class: 'muted' }, label));
      wrap.append(fig);
      rpc('repo.image', { id: r.id, rev, file: path }).then((d) => {
        fig.firstChild.replaceWith(d.data ? h('img', { src: d.data, alt: label }) : h('div', { class: 'faint' }, d.svgText ? 'SVG (shown as text for safety)' : d.tooLarge ? 'Too large to preview' : 'Not present'));
      });
    }
    return wrap;
  }

  async function renderRight(full = false) {
    if (!selected || !findFile(selected)) { renderOverview(); return; }
    if (selected.group === 'conflicted') { renderConflict(findFile(selected)); return; }
    if (right.firstChild !== diff.el) mount(right, diff.el);
    try {
      const kind = selected.group === 'staged' ? 'staged' : selected.group === 'untracked' ? 'untracked' : 'unstaged';
      const d = await rpc('repo.diff', { id: r.id, kind, file: selected.path, orig: selected.orig, ignoreWs: diff.ignoreWs, full });
      if (disposed) return;
      diff.set(d);
    } catch (e) {
      mount(right, h('div', { class: 'errbox', style: { margin: '12px' } }, e.message));
    }
  }

  async function renderOverview() {
    const s = r.summary || {};
    const box = h('div', { class: 'page' });
    mount(right, box);
    const parts = [];
    parts.push(h('div', { class: 'section-title' }, h('h2', null, s.branch ? `On ${s.branch}` : 'Detached HEAD')));
    const facts = [];
    if (s.upstream) facts.push(`Tracking ${s.upstream}${s.ahead || s.behind ? `: ${s.ahead} to push, ${s.behind} to pull` : ', up to date'}`);
    else if (s.branch) facts.push('Not published yet. Use Publish to push it to origin.');
    if (s.defaultBranch && s.branch !== s.defaultBranch && s.defaultRemoteRef) facts.push(`${s.aheadDefault || 0} ahead of / ${s.behindDefault || 0} behind ${s.defaultRemoteRef}`);
    parts.push(h('div', { class: 'muted' }, facts.map((f) => h('div', null, f))));
    const prBox = h('div');
    const unpushedBox = h('div');
    const backupsBox = h('div');
    parts.push(prBox, unpushedBox, backupsBox);
    mount(box, parts);
    // PR for the current branch (shortcut)
    if (r.slug && r.slug.github && s.branch && s.branch !== s.defaultBranch) {
      rpc('pr.forBranch', { id: r.id, branch: s.branch }).then((prs) => {
        if (disposed) return;
        const p = prs[0];
        mount(prBox, h('div', { class: 'section-title' }, h('h3', null, 'Pull request for this branch')),
          p ? h('div', { class: 'panel list-row', onclick: () => navigate(`#/repo/${r.id}/prs/${p.number}`) },
            icon('pr'), h('div', { class: 'grow' }, h('div', { class: 't' }, `#${p.number} ${p.title}`), h('div', { class: 'sub' }, `${p.state.toLowerCase()}${p.isDraft ? ' · draft' : ''} · ${p.baseRefName} ← ${p.headRefName}`)),
            p.checks ? h('span', { class: `badge ${p.checks === 'success' ? 'ok' : p.checks === 'failure' ? 'bad' : 'run'}` }, `checks ${p.checks}`) : null)
            : h('div', { class: 'row' }, h('span', { class: 'muted' }, 'No pull request yet.'), btn('Create pull request', () => navigate(`#/repo/${r.id}/prs/new`), { cls: 'primary small', iconName: 'pr' })));
      }).catch(() => {});
    }
    rpc('repo.unpushedLog', { id: r.id }).then((log) => {
      if (disposed || !log.length) return;
      mount(unpushedBox, h('div', { class: 'section-title' }, h('h3', null, `Unpushed commits (${log.length})`), h('span', { class: 'spacer' }), btn(s.upstream ? 'Push' : 'Publish', () => push(r), { cls: 'small', iconName: 'push' })),
        h('div', { class: 'panel' }, log.map((c) => h('div', { class: 'list-row', onclick: () => navigate(`#/repo/${r.id}/graph/${c.hash}`) }, h('span', { class: 'mono muted' }, c.hash.slice(0, 8)), h('span', { class: 'grow ellipsis' }, c.subject), h('span', { class: 'faint' }, ago(c.commitTime))))));
    }).catch(() => {});
    rpc('repo.backups', { id: r.id }).then((list) => {
      const live = list.filter(Boolean);
      if (disposed || !live.length) return;
      mount(backupsBox, h('div', { class: 'section-title' }, h('h3', null, 'Recently discarded'), h('span', { class: 'faint' }, 'safety copies, kept 30 days')),
        h('div', { class: 'panel' }, live.slice(0, 20).map((b) => h('div', { class: 'list-row' },
          icon('undo'), h('div', { class: 'grow' }, h('div', null, b.note), h('div', { class: 'sub ellipsis', title: b.files.join('\n') }, b.files.slice(0, 4).join(', ') + (b.files.length > 4 ? ` +${b.files.length - 4} more` : ''))),
          h('span', { class: 'faint' }, ago(b.time)), btn('Restore', () => restore(b.id), { cls: 'small' })))));
    }).catch(() => {});
  }

  // ---------- conflict editor ----------
  async function renderConflict(f) {
    let parsed;
    try { parsed = await rpc('conflict.get', { id: r.id, file: f.path }); } catch (e) { parsed = null; }
    const ops = (r.summary && r.summary.inProgress) || [];
    const rebasing = ops.includes('rebase');
    const head = h('div', { class: 'diff-toolbar' },
      h('span', { class: 'mono', style: { fontWeight: 600 } }, f.path), h('span', { class: 'badge bad' }, f.conflict),
      h('span', { class: 'spacer' }),
      btn(rebasing ? 'Take upstream (ours)' : 'Take current (ours)', () => takeSide('ours'), { cls: 'small', title: 'Replace the whole file with the current branch version' }),
      btn(rebasing ? 'Take your commit (theirs)' : 'Take incoming (theirs)', () => takeSide('theirs'), { cls: 'small', title: 'Replace the whole file with the incoming version' }),
      /deleted/.test(f.conflict) ? btn('Accept deletion', () => act(() => rpc('conflict.acceptDeletion', { id: r.id, file: f.path }), { ok: 'File removed' }), { cls: 'small danger' }) : null,
      btn('Open in editor', () => act(() => rpc('open.editor', { id: r.id, file: f.path })), { cls: 'small', iconName: 'edit' }));
    async function takeSide(side) {
      const ok = await confirmDanger({ title: `Use the ${side === 'ours' ? 'current' : 'incoming'} version?`, message: `${f.path} will be replaced entirely by the ${side} version and marked resolved. Changes from the other side in this file are dropped.`, confirmLabel: 'Use this version' });
      if (ok) act(() => rpc('conflict.take', { id: r.id, file: f.path, side }), { ok: 'Resolved' });
    }
    if (!parsed) { mount(right, head, h('div', { class: 'empty' }, 'This file cannot be shown as text (binary or deleted on one side). Use the buttons above.')); return; }
    const conflicts = parsed.segs.filter((s) => s.type === 'conflict');
    const choices = conflicts.map(() => null);
    const body = h('div', { class: 'pane-scroll' });
    const footer = h('div', { class: 'diff-toolbar' });
    function draw() {
      const out = [];
      let ci = 0;
      for (const s of parsed.segs) {
        if (s.type === 'text') {
          const lines = s.lines;
          const shown = lines.length > 8 ? [...lines.slice(0, 3), `… ${lines.length - 6} unchanged lines …`, ...lines.slice(-3)] : lines;
          out.push(h('div', { class: 'ctext' }, shown.join('\n')));
          continue;
        }
        const idx = ci++;
        const ch = choices[idx];
        const pick = (v) => { choices[idx] = choices[idx] === v ? null : v; draw(); };
        out.push(h('div', { class: 'conflict' },
          h('div', { class: 'chead' }, h('strong', null, `Conflict ${idx + 1} of ${conflicts.length}`), ch ? h('span', { class: 'badge ok' }, `→ ${ch.replace('both-theirs-first', 'both (incoming first)')}`) : h('span', { class: 'badge bad' }, 'unresolved'), h('span', { class: 'spacer' }),
            h('a', { onclick: () => pick('ours') }, 'Accept current'), ' · ', h('a', { onclick: () => pick('theirs') }, 'Accept incoming'), ' · ',
            h('a', { onclick: () => pick('both') }, 'Accept both'), ' · ', h('a', { onclick: () => pick('both-theirs-first') }, 'Both, incoming first')),
          h('div', { class: 'chead' }, `Current: ${s.oursLabel || 'HEAD'}`),
          h('div', { class: 'side ours', style: { opacity: ch && !['ours', 'both', 'both-theirs-first'].includes(ch) ? '.45' : '1' } }, s.ours.join('\n') || ' '),
          s.base ? h('div', { class: 'chead' }, 'Common ancestor') : null, s.base ? h('div', { class: 'side base' }, s.base.join('\n') || ' ') : null,
          h('div', { class: 'chead' }, `Incoming: ${s.theirsLabel || ''}`),
          h('div', { class: 'side theirs', style: { opacity: ch && !['theirs', 'both', 'both-theirs-first'].includes(ch) ? '.45' : '1' } }, s.theirs.join('\n') || ' ')));
      }
      if (!conflicts.length) out.unshift(h('div', { class: 'info-box', style: { margin: '10px' } }, 'No conflict markers left in this file. Mark it resolved to stage it.'));
      mount(body, out);
      const done = choices.filter(Boolean).length;
      mount(footer, h('span', null, `${done} of ${conflicts.length} conflicts decided`), h('span', { class: 'spacer' }),
        btn('Save choices', () => save(false), { cls: 'small', disabled: !done }),
        btn(conflicts.length ? 'Save and mark resolved' : 'Mark resolved', () => (conflicts.length ? save(true) : markResolved(f)), { cls: 'small primary', disabled: conflicts.length > 0 && done < conflicts.length }));
    }
    async function save(mark) {
      await act(() => rpc('conflict.resolve', { id: r.id, file: f.path, choices, markResolved: mark }), { ok: mark ? 'Resolved and staged' : 'Saved' });
      load();
    }
    mount(right, head, body, footer);
    draw();
  }

  const unsub = subscribe('refresh', () => load());
  load();
  // Reload only when the working tree state actually changed (the summary carries a hash of git status output).
  const stateKey = () => { const s = r.summary || {}; return `${s.statusHash}|${(s.inProgress || []).join(',')}|${s.locked}`; };
  let lastKey = stateKey();
  return {
    dispose() { disposed = true; unsub(); },
    onSummary: () => { const k = stateKey(); if (k !== lastKey) { lastKey = k; reload(); } },
  };
}

export { form, markdown, modal };
