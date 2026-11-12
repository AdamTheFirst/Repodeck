// File history, blame and "view at revision" dialogs, plus .gitignore helpers.
import { h, mount, modal, act, ago, fmtDate, btn, banner } from './dom.js';
import { rpc } from './api.js';
import { createDiffView } from './diffview.js';
import { navigate } from './router.js';

export async function fileHistory(r, file) {
  const list = h('div', { class: 'pane-scroll', style: { width: '42%', borderRight: '1px solid var(--border)' } }, h('div', { class: 'skeleton' }, 'Loading history…'));
  const diff = createDiffView({ selectable: false });
  const body = h('div', { class: 'row', style: { alignItems: 'stretch', height: '62vh', gap: '0' } }, list, h('div', { class: 'pane grow' }, diff.el));
  modal({ title: `History of ${file}`, body, wide: true, actions: [{ label: 'Close', value: null, cls: 'primary', default: true }] });
  try {
    const commits = await rpc('repo.fileHistory', { id: r.id, file });
    if (!commits.length) { mount(list, h('div', { class: 'empty' }, 'No commits touch this file.')); return; }
    const rows = commits.map((c) => {
      const row = h('div', { class: 'list-row', onclick: async () => {
        rows.forEach((x) => x.classList.remove('selected')); row.classList.add('selected');
        try { diff.set(await rpc('repo.diff', { id: r.id, kind: 'commit', commit: c.hash, file })); } catch (e) { diff.set({ files: [] }); banner({ level: 'error', title: e.message }); }
      } },
      h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, c.subject), h('div', { class: 'sub' }, `${c.author} · ${ago(c.commitTime)} · `, h('span', { class: 'mono' }, c.hash.slice(0, 8)))),
      h('a', { title: 'Show in graph', onclick: (e) => { e.stopPropagation(); document.querySelector('.modal-back').remove(); navigate(`#/repo/${r.id}/graph/${c.hash}`); } }, 'graph'),
      h('a', { title: 'View the file as it was in this commit', onclick: (e) => { e.stopPropagation(); viewAt(r, c.hash, file); } }, 'view'));
      return row;
    });
    mount(list, rows);
    rows[0].click();
  } catch (e) { mount(list, h('div', { class: 'errbox' }, e.message)); }
}

export async function viewAt(r, rev, file) {
  const pre = h('pre', { class: 'log', style: { height: '62vh', margin: 0 } }, 'Loading…');
  modal({ title: `${file} @ ${rev.slice(0, 8)}`, body: pre, wide: true, actions: [{ label: 'Close', value: null, cls: 'primary', default: true }] });
  try {
    const d = await rpc('repo.fileAt', { id: r.id, rev, file });
    pre.textContent = d.binary ? `Binary file (${d.size} bytes).` : d.text;
  } catch (e) { pre.textContent = e.message; }
}

export async function blame(r, file) {
  const box = h('div', { class: 'diff', style: { height: '64vh' } }, h('div', { class: 'skeleton' }, 'Running blame…'));
  modal({ title: `Blame: ${file}`, body: box, wide: true, actions: [{ label: 'Close', value: null, cls: 'primary', default: true }] });
  try {
    const b = await rpc('repo.blame', { id: r.id, file });
    const tb = h('tbody');
    let prev = null;
    const shades = new Map();
    b.lines.forEach((l, i) => {
      const c = b.commits[l.hash] || {};
      const first = l.hash !== prev;
      prev = l.hash;
      if (!shades.has(l.hash)) shades.set(l.hash, shades.size % 2);
      const uncommitted = /^0+$/.test(l.hash);
      tb.append(h('tr', { style: { background: shades.get(l.hash) ? 'var(--panel-2)' : '' } },
        h('td', { style: { width: '260px', fontFamily: 'var(--font)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', borderTop: first ? '1px solid var(--border)' : '' }, title: `${c.summary || ''}\n${c.author || ''} ${c.time ? fmtDate(c.time) : ''}` },
          first ? (uncommitted ? h('span', { class: 'faint' }, 'Not committed yet') : h('span', null, h('a', { class: 'mono', onclick: () => { document.querySelector('.modal-back').remove(); navigate(`#/repo/${r.id}/graph/${l.hash}`); } }, l.hash.slice(0, 7)), ' ', h('span', { class: 'muted' }, `${c.author || ''}, ${ago(c.time)}`))) : ''),
        h('td', { class: 'ln' }, i + 1),
        h('td', { class: 'code' }, l.text)));
    });
    mount(box, h('table', null, tb));
  } catch (e) { mount(box, h('div', { class: 'errbox' }, e.message)); }
}

export function gitignoreMenu(r, file, untracked) {
  const ext = /\.[^./]+$/.exec(file);
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : null;
  const add = (pattern) => act(() => rpc('repo.gitignore', { id: r.id, pattern }), { ok: (x) => (x.already ? `"${pattern}" is already in .gitignore` : `Added "${pattern}" to .gitignore`) });
  const items = [
    '-', { header: true, label: 'Add to .gitignore' },
    { label: `This file (/${file})`, action: () => add(`/${file}`) },
    ext ? { label: `All *${ext[0]} files`, action: () => add(`*${ext[0]}`) } : null,
    dir ? { label: `The folder /${dir}`, action: () => add(`/${dir}`) } : null,
  ];
  if (!untracked) items.push({ label: 'Note: tracked files stay tracked until removed with "git rm --cached"', disabled: true, action: () => {} });
  return items;
}
export { btn };
