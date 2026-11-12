// Stashes: list, view, apply, pop, drop, clear, branch.
import { h, mount, btn, act, confirmDanger, form, prompt, ago, banner, showError } from '../dom.js';
import { rpc } from '../api.js';
import { createDiffView } from '../diffview.js';

export function render(view, r) {
  const listEl = h('div', { class: 'pane-scroll' });
  const filesEl = h('div', { class: 'pane-scroll', style: { maxHeight: '35%', borderBottom: '1px solid var(--border)' } });
  const diff = createDiffView({});
  const left = h('div', { class: 'left' },
    h('div', { class: 'commitbox' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Stashes'),
        btn('Stash changes…', () => stashNow(), { cls: 'primary small', iconName: 'stash' })),
      h('div', { class: 'faint', style: { fontSize: '12px' } }, 'A stash saves uncommitted changes and cleans the working tree, so you can switch tasks.')),
    listEl);
  const right = h('div', { class: 'right' }, filesEl, diff.el);
  mount(view, h('div', { class: 'split' }, left, right));
  let stashes = [];
  let selected = null;

  async function load() {
    try { stashes = await rpc('stash.list', { id: r.id }); } catch (e) { mount(listEl, h('div', { class: 'errbox' }, e.message)); return; }
    if (selected && !stashes.some((s) => s.ref === selected.ref && s.hash === selected.hash)) selected = null;
    mount(listEl,
      stashes.length ? stashes.map((s) => h('div', { class: `list-row ${selected && selected.hash === s.hash ? 'selected' : ''}`, onclick: () => { selected = s; load(); show(s); } },
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, s.message), h('div', { class: 'sub' }, `${s.ref} · ${ago(s.time)}${s.hasUntracked ? ' · includes untracked files' : ''}`))))
        : h('div', { class: 'empty' }, 'No stashes.'),
      stashes.length > 1 ? h('div', { style: { padding: '10px' } }, btn('Clear all stashes…', async () => {
        if (await confirmDanger({ title: 'Delete every stash?', message: `All ${stashes.length} stashes will be deleted:`, items: stashes.map((s) => `${s.ref}: ${s.message}`), recover: 'Not recoverable from git-helper.', confirmLabel: 'Clear all' })) act(() => rpc('stash.clear', { id: r.id }), { ok: 'Stashes cleared' }).then(load);
      }, { cls: 'small danger' })) : null);
    if (!selected) { mount(filesEl, h('div', { class: 'empty' }, stashes.length ? 'Select a stash to see its changes.' : '')); diff.set({ files: [] }); }
  }

  async function show(s) {
    const actions = h('div', { class: 'diff-toolbar' },
      h('strong', { class: 'grow ellipsis' }, `${s.ref}: ${s.message}`),
      btn('Apply', () => apply(s, false), { cls: 'small' }),
      btn('Pop', () => apply(s, true), { cls: 'small primary', title: 'Apply, then delete the stash if it applied cleanly' }),
      btn('Branch…', async () => { const n = await prompt('Create branch from stash', 'Branch name'); if (n) act(() => rpc('stash.branch', { id: r.id, ref: s.ref, name: n }), { ok: `Created ${n} with the stashed changes` }).then(load); }, { cls: 'small' }),
      btn('Drop…', async () => {
        if (await confirmDanger({ title: 'Drop stash?', message: `Delete ${s.ref} "${s.message}".`, recover: 'Not recoverable from git-helper.', confirmLabel: 'Drop' })) act(() => rpc('stash.drop', { id: r.id, ref: s.ref }), { ok: 'Stash dropped' }).then(() => { selected = null; load(); });
      }, { cls: 'small danger' }));
    mount(filesEl, actions, h('div', { class: 'skeleton' }, 'Loading…'));
    try {
      const files = await rpc('stash.files', { id: r.id, ref: s.ref });
      const rows = files.map((f) => {
        const row = h('div', { class: 'file-row', onclick: async () => {
          rows.forEach((x) => x.classList.remove('selected')); row.classList.add('selected');
          try {
            diff.set(f.status === '?' ? await rpc('repo.diff', { id: r.id, kind: 'range', from: require4b(), to: `${s.ref}^3`, file: f.path }) : await rpc('repo.diff', { id: r.id, kind: 'range', from: `${s.ref}^1`, to: s.ref, file: f.path }));
          } catch (e) { banner({ level: 'error', title: e.message }); }
        } }, h('span', { class: `st st-${f.status}` }, f.status), h('span', { class: 'name' }, f.path));
        return row;
      });
      mount(filesEl, actions, rows.length ? rows : h('div', { class: 'empty' }, 'Empty stash.'));
      if (rows[0]) rows[0].click();
    } catch (e) { mount(filesEl, actions, h('div', { class: 'errbox' }, e.message)); }
  }
  const require4b = () => '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree

  async function apply(s, pop) {
    try {
      const res = await rpc('stash.apply', { id: r.id, ref: s.ref, pop });
      banner({ level: 'success', title: pop ? 'Stash popped' : 'Stash applied', body: (res.output || '').split('\n').slice(0, 2).join('\n'), timeout: 3500 });
    } catch (e) {
      if (/CONFLICT/i.test(`${e.message}${e.stderr}`)) banner({ level: 'warn', title: 'Applied with conflicts', body: pop ? 'Because of the conflicts the stash was kept. Resolve them in Changes, then drop the stash.' : 'Resolve them in the Changes tab.', timeout: 0 });
      else showError(e, 'Could not apply the stash');
    }
    load();
  }

  async function stashNow() {
    const v = await form({ title: 'Stash changes', fields: [
      { name: 'message', label: 'Message', placeholder: 'What were you working on?' },
      { name: 'untracked', label: 'Include untracked files', type: 'checkbox', value: true },
      { name: 'keepIndex', label: 'Keep staged changes in the working tree too', type: 'checkbox', value: false },
    ], submit: 'Stash' });
    if (v) act(() => rpc('stash.push', { id: r.id, message: v.message.trim() || undefined, includeUntracked: v.untracked, keepIndex: v.keepIndex }), { ok: 'Changes stashed' }).then(load);
  }

  load();
  return { dispose() {}, onSummary: load };
}
