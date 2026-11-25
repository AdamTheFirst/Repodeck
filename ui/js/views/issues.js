// Issues: list, view, comment, create, close/reopen, labels/assignees, branch from issue.
import { h, mount, icon, btn, iconBtn, act, form, modal, confirmDanger, banner, ago, markdown, debounce, plural } from '../dom.js';
import { rpc } from '../api.js';
import { prefs } from '../store.js';
import { navigate } from '../router.js';
import { unavailable } from './prs.js';

export function render(view, r, sub) {
  if (!r.slug || !r.slug.github) return unavailable(view, r, 'Issues');
  if (sub && /^\d+$/.test(sub)) return detail(view, r, +sub);
  return list(view, r);
}

function list(view, r) {
  let filter = prefs.get('issueFilter', 'all');
  let state = 'open';
  const bar = h('div', { class: 'diff-toolbar' });
  const body = h('div', { class: 'pane-scroll' });
  const searchIn = h('input', { type: 'search', placeholder: 'Search issues', style: { width: '220px' } });
  searchIn.addEventListener('input', debounce(load, 400));
  mount(view, h('div', { class: 'pane', style: { flex: 1 } }, bar, body));
  function renderBar() {
    mount(bar,
      h('div', { class: 'pill-tabs' }, [['all', 'All'], ['assigned', 'Assigned to me'], ['mine', 'Created by me']].map(([k, l]) => h('button', { class: filter === k ? 'active' : '', onclick: () => { filter = k; prefs.set('issueFilter', k); renderBar(); load(); } }, l))),
      h('div', { class: 'pill-tabs' }, [['open', 'Open'], ['closed', 'Closed']].map(([k, l]) => h('button', { class: state === k ? 'active' : '', onclick: () => { state = k; renderBar(); load(); } }, l))),
      searchIn, h('span', { class: 'spacer' }), iconBtn('refresh', 'Refresh', () => load(), 'small'),
      btn('New issue', () => createIssue(r).then((ok) => ok && load()), { cls: 'primary small', iconName: 'plus' }));
  }
  async function load() {
    mount(body, h('div', { class: 'progress' }), h('div', { class: 'skeleton' }, 'Loading…'));
    try {
      const list = await rpc('issue.list', { id: r.id, filter, state, search: searchIn.value.trim() });
      mount(body, list.length ? list.map((i) => h('div', { class: 'list-row', onclick: () => navigate(`#/repo/${r.id}/issues/${i.number}`) },
        icon('issue'), h('div', { class: 'grow' }, h('div', { class: 'row' }, h('span', { class: 't ellipsis' }, i.title), (i.labels || []).slice(0, 4).map((l) => h('span', { class: 'badge', style: { borderColor: `#${l.color}` } }, l.name))),
          h('div', { class: 'sub' }, `#${i.number} · ${i.author ? i.author.login : ''} · updated ${ago(i.updatedAt)}${(i.assignees || []).length ? ` · assigned to ${i.assignees.map((a) => a.login).join(', ')}` : ''}`)),
        (Array.isArray(i.comments) ? i.comments.length : i.comments) ? h('span', { class: 'badge' }, plural(Array.isArray(i.comments) ? i.comments.length : i.comments, 'comment')) : null))
        : h('div', { class: 'empty' }, h('h3', null, searchIn.value.trim() ? 'No issues match' : `No ${state} issues`), h('div', null, searchIn.value.trim() ? 'Nothing fits the search.' : state === 'open' ? 'Nothing is waiting here.' : 'None have been closed yet.')));
    } catch (e) { mount(body, h('div', { class: 'errbox', style: { margin: '12px' } }, e.message)); }
  }
  renderBar(); load();
  return null;
}

async function createIssue(r) {
  const labels = await rpc('gh.labels', { id: r.id }).catch(() => []);
  const v = await form({ title: 'New issue', wide: true, fields: [
    { name: 'title', label: 'Title', required: true },
    { name: 'body', label: 'Description (Markdown)', type: 'textarea', rows: 10 },
    { name: 'labels', label: `Labels, comma separated${labels.length ? ` (${labels.slice(0, 8).map((l) => l.name).join(', ')}…)` : ''}` },
    { name: 'me', label: 'Assign to me', type: 'checkbox' },
  ], submit: 'Create issue' });
  if (!v) return false;
  const res = await act(() => rpc('issue.create', { id: r.id, title: v.title.trim(), body: v.body, labels: v.labels.split(',').map((x) => x.trim()).filter(Boolean), assignees: v.me ? ['@me'] : [] }), { ok: 'Issue created' });
  return !!res;
}

function detail(view, r, number) {
  const page = h('div', { class: 'page' });
  mount(view, page);
  const back = () => iconBtn('back', 'Back to the list', () => navigate(`#/repo/${r.id}/issues`));
  mount(page, h('div', { class: 'row', style: { marginBottom: '10px' } }, back(), h('h2', null, `Issue #${number}`)), h('div', { class: 'skeleton' }, 'Loading…'));
  async function load() {
    let i;
    try { i = await rpc('issue.view', { id: r.id, number }); } catch (e) { mount(page, h('div', { class: 'row', style: { marginBottom: '10px' } }, back(), h('h2', null, `Issue #${number}`)), h('div', { class: 'errbox' }, e.message)); return; }
    const box = h('textarea', { rows: 4, placeholder: 'Comment (Markdown)', style: { width: '100%' } });
    // The same shape as a pull request: the conversation on the left, what the issue is tagged with on the right.
    const none = () => h('span', { class: 'faint' }, 'none');
    const block = (title, content, onEdit) => h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', { class: 'grow' }, title), onEdit ? iconBtn('edit', 'Edit labels and assignees', onEdit) : null),
      h('div', { class: 'panel-body col', style: { gap: '4px' } }, content));
    const side = h('div', { class: 'col', style: { width: '280px', flex: 'none' } },
      block('Labels', (i.labels || []).length ? h('div', { class: 'row wrap' }, i.labels.map((l) => h('span', { class: 'badge', style: { borderColor: `#${l.color}` } }, l.name))) : none(), () => editMeta(i)),
      block('Assignees', (i.assignees || []).length ? i.assignees.map((a) => h('div', null, a.login)) : none(), () => editMeta(i)),
      block('Milestone', i.milestone ? i.milestone.title : none()));
    mount(page,
      h('div', { class: 'row', style: { marginBottom: '14px' } }, back(),
        h('h2', { class: 'grow' }, `${i.title} `, h('span', { class: 'muted' }, `#${i.number}`)),
        h('span', { class: `badge ${i.state === 'OPEN' ? 'ok' : ''}` }, i.state.toLowerCase()),
        btn('Create branch', () => branchFromIssue(i), { cls: 'small', iconName: 'branch' }),
        i.state === 'OPEN' ? btn('Close…', () => closeIssue(i), { cls: 'small' }) : btn('Reopen', () => act(() => rpc('issue.reopen', { id: r.id, number }), { ok: 'Reopened' }).then(load), { cls: 'small' }),
        btn('Open on GitHub', () => rpc('open.url', { url: i.url }), { cls: 'small', iconName: 'external' })),
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '18px' } },
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'comment' }, h('div', { class: 'chead' }, h('strong', null, i.author ? i.author.login : ''), h('span', { class: 'muted' }, `opened ${ago(i.createdAt)}`)), h('div', { class: 'cbody' }, markdown(i.body))),
          (i.comments || []).map((c) => h('div', { class: 'comment' }, h('div', { class: 'chead' }, h('strong', null, c.author ? c.author.login : ''), h('span', { class: 'muted' }, ago(c.createdAt))), h('div', { class: 'cbody' }, markdown(c.body)))),
          box, h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'spacer' }),
            btn('Comment', async () => { if (!box.value.trim()) return; if (await act(() => rpc('issue.comment', { id: r.id, number, body: box.value }), { ok: 'Comment posted' }) !== undefined) await load(); }, { cls: 'primary' }))),
        side));
  }
  async function closeIssue(i) {
    const v = await form({ title: `Close #${i.number}?`, fields: [{ name: 'reason', label: 'Reason', type: 'select', value: 'completed', options: [{ value: 'completed', label: 'Completed' }, { value: 'not planned', label: 'Not planned' }] }], submit: 'Close issue' });
    if (v) act(() => rpc('issue.close', { id: r.id, number, reason: v.reason }), { ok: 'Closed' }).then(load);
  }
  async function editMeta(i) {
    const labels = await rpc('gh.labels', { id: r.id }).catch(() => []);
    const cur = (i.labels || []).map((l) => l.name);
    const curA = (i.assignees || []).map((a) => a.login);
    const boxes = labels.map((l) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: l.name, checked: cur.includes(l.name) }), l.name));
    const assignees = h('input', { type: 'text', value: curA.join(', '), style: { width: '100%' } });
    const v = await modal({ title: 'Labels and assignees', body: h('div', { class: 'col' }, h('strong', null, 'Labels'), h('div', { class: 'col', style: { maxHeight: '260px', overflow: 'auto' } }, boxes), h('label', { class: 'field' }, h('span', null, 'Assignees (logins, comma separated; @me for yourself)'), assignees)),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', default: true, value: () => ({ labels: boxes.filter((b) => b.firstChild.checked).map((b) => b.firstChild.value), assignees: assignees.value.split(',').map((x) => x.trim()).filter(Boolean) }) }] });
    if (!v) return;
    await act(() => rpc('issue.edit', { id: r.id, number, addLabels: v.labels.filter((x) => !cur.includes(x)), removeLabels: cur.filter((x) => !v.labels.includes(x)), addAssignees: v.assignees.filter((x) => !curA.includes(x)), removeAssignees: curA.filter((x) => !v.assignees.includes(x)) }), { ok: 'Updated' });
    load();
  }
  async function branchFromIssue(i) {
    const slug = i.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const v = await form({ title: `Branch for #${i.number}`, intro: h('div', { class: 'muted' }, `Tip: put "Closes #${i.number}" in the pull request description to link it and close the issue on merge.`), fields: [
      { name: 'name', label: 'Branch name', value: `${i.number}-${slug}`, required: true },
      { name: 'fromDefault', label: 'Start from the latest default branch (otherwise from the current HEAD)', type: 'checkbox', value: true },
    ], submit: 'Create and switch' });
    if (!v) return;
    if (r.summary && r.summary.dirty && v.fromDefault && !(await confirmDanger({ title: 'Uncommitted changes', message: 'Your uncommitted changes will be carried to the new branch (git refuses if they conflict).', confirmLabel: 'Continue', danger: false }))) return;
    act(() => rpc('issue.branch', { id: r.id, number: i.number, name: v.name.trim(), fromDefault: v.fromDefault }), { ok: (x) => `Switched to ${x.branch}` });
  }
  load();
  void banner;
  return null;
}
