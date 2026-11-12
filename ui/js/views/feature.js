// Feature branches across repositories: find every repo with a branch, see its state, PRs and
// checks, and act on all of them at once (switch, pull, push, update, create PRs, merge PRs in order).
import { h, mount, icon, btn, act, modal, form, confirmDanger, banner, plural, iconBtn } from '../dom.js';
import { rpc } from '../api.js';
import { store, prefs } from '../store.js';
import { navigate } from '../router.js';
import { runBulk } from './multi.js';

export function render(main, parts) {
  let branch = parts[0] ? decodeURIComponent(parts[0]) : prefs.get('featureBranch', '');
  let rows = [];
  const sel = new Set();
  const page = h('div', { class: 'page' });
  mount(main, page);
  const input = h('input', { type: 'text', placeholder: 'Branch name, e.g. feature/new-routing', value: branch, style: { width: '360px' }, list: 'feature-branches', spellcheck: 'false' });
  const datalist = h('datalist', { id: 'feature-branches' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') find(); });
  const table = h('div');

  let suggestions = [];
  rpc('feature.branches').then((list) => {
    suggestions = list;
    mount(datalist, list.map((b) => h('option', { value: b.name }, `${b.count} repositories`)));
    if (!branch) landing();
  }).catch(() => {});
  function landing() {
    const multi = suggestions.filter((b) => b.count > 1);
    const rest = suggestions.filter((b) => b.count === 1).slice(0, 30);
    const chip = (b) => h('button', { class: 'chip-btn', onclick: () => { input.value = b.name; find(); } }, icon('branch', 'sm'), h('span', { class: 'mono' }, b.name), h('span', { class: 'badge' }, b.count));
    mount(table,
      multi.length ? [h('div', { class: 'section-title' }, h('h3', null, 'Branches in several repositories')), h('div', { class: 'chips' }, multi.map(chip))] : null,
      rest.length ? [h('div', { class: 'section-title' }, h('h3', null, 'Other local branches')), h('div', { class: 'chips' }, rest.map(chip))] : null,
      !suggestions.length ? h('div', { class: 'empty' }, h('h3', null, 'No feature branches'), h('div', null, 'Every repository only has its default branch.')) : null);
  }

  async function find() {
    branch = input.value.trim();
    if (!branch) return;
    prefs.set('featureBranch', branch);
    mount(table, h('div', { class: 'skeleton' }, `Looking for "${branch}" in ${store.repos.length} repositories…`));
    try { rows = await rpc('feature.find', { branch, withPrs: true }); } catch (e) { mount(table, h('div', { class: 'errbox' }, e.message)); return; }
    sel.clear();
    rows.forEach((x) => sel.add(x.id));
    draw();
  }

  function draw() {
    const chosen = rows.filter((x) => sel.has(x.id));
    const prs = chosen.filter((x) => x.pr && x.pr.state === 'OPEN');
    mount(table,
      rows.length ? [
        h('div', { class: 'row wrap', style: { margin: '6px 0 10px' } },
          h('strong', null, `${rows.length} repositories have ${branch}`), h('span', { class: 'muted' }, `${chosen.length} selected`), h('span', { class: 'spacer' }),
          btn('Switch to branch', () => bulk('switch', 'Switch to branch'), { cls: 'small', iconName: 'branch' }),
          btn('Pull', () => bulk('pull', 'Pull'), { cls: 'small', iconName: 'pull' }),
          btn('Push', () => bulk('push', 'Push'), { cls: 'small', iconName: 'push' }),
          btn('Update from default', () => bulk('updateFromDefault', `Update from default (${store.config.updateFromDefault})`), { cls: 'small', iconName: 'merge' }),
          btn('Back to default branch', () => bulk('returnDefault', 'Return to default branch', { pull: true }), { cls: 'small' }),
          btn('Create PRs…', () => createPrs(), { cls: 'small primary', iconName: 'pr' }),
          btn(`Merge ${prs.length} PRs…`, () => mergePrs(prs), { cls: 'small primary', iconName: 'merge', disabled: !prs.length }),
          btn('Delete branch…', () => bulk('deleteBranch', 'Delete local branch'), { cls: 'small danger' }),
          iconBtn('refresh', 'Refresh', () => find())),
        h('table', { class: 'grid panel' },
          h('tr', null, h('th', { style: { width: '32px' } }, h('input', { type: 'checkbox', checked: sel.size === rows.length, onchange: (e) => { rows.forEach((x) => (e.target.checked ? sel.add(x.id) : sel.delete(x.id))); draw(); } })),
            h('th', null, 'Repository'), h('th', null, 'Where'), h('th', null, 'Local vs remote'), h('th', null, 'vs default'), h('th', null, 'Working tree'), h('th', null, 'Pull request'), h('th', null, 'Checks')),
          rows.map((x) => h('tr', null,
            h('td', null, h('input', { type: 'checkbox', checked: sel.has(x.id), onchange: (e) => { if (e.target.checked) sel.add(x.id); else sel.delete(x.id); draw(); } })),
            h('td', null, h('a', { onclick: () => navigate(`#/repo/${x.id}/changes`) }, x.label), x.current ? h('span', { class: 'badge accent', style: { marginLeft: '6px' } }, 'checked out') : null),
            h('td', { class: 'muted' }, [x.local ? 'local' : null, x.remote ? 'remote' : null].filter(Boolean).join(' + ')),
            h('td', null, x.local && x.remote ? (x.ahead || x.behind ? `${x.ahead} to push, ${x.behind} to pull` : h('span', { class: 'muted' }, 'in sync')) : x.local ? h('span', { class: 'badge warn' }, 'not pushed') : h('span', { class: 'muted' }, 'remote only')),
            h('td', null, x.merged ? h('span', { class: 'badge ok' }, `merged into ${x.defaultBranch}`) : x.aheadDefault != null ? h('span', null, `${x.aheadDefault} ahead`, x.behindDefault ? h('span', { class: 'badge warn', style: { marginLeft: '6px' } }, `${x.behindDefault} behind`) : null) : ''),
            h('td', null, x.dirty ? h('span', { class: 'badge dirty' }, `${x.dirty} changed`) : h('span', { class: 'muted' }, 'clean'), (x.inProgress || []).length ? h('span', { class: 'badge bad', style: { marginLeft: '6px' } }, x.inProgress[0]) : null),
            h('td', null, x.pr ? h('a', { onclick: () => navigate(`#/repo/${x.id}/prs/${x.pr.number}`) }, `#${x.pr.number} `, h('span', { class: `badge ${x.pr.state === 'MERGED' ? 'accent' : x.pr.state === 'OPEN' ? (x.pr.isDraft ? '' : 'ok') : ''}` }, x.pr.isDraft && x.pr.state === 'OPEN' ? 'draft' : x.pr.state.toLowerCase()),
              x.pr.reviewDecision ? h('span', { class: `badge ${x.pr.reviewDecision === 'APPROVED' ? 'ok' : x.pr.reviewDecision === 'CHANGES_REQUESTED' ? 'bad' : ''}`, style: { marginLeft: '4px' } }, x.pr.reviewDecision.toLowerCase().replace(/_/g, ' ')) : null)
              : x.prError ? h('span', { class: 'faint', title: x.prError }, 'unavailable') : h('span', { class: 'faint' }, 'none')),
            h('td', null, x.pr && x.pr.checks ? h('a', { onclick: () => navigate(`#/repo/${x.id}/prs/${x.pr.number}`) }, h('span', { class: `badge ${x.pr.checks === 'success' ? 'ok' : x.pr.checks === 'failure' ? 'bad' : 'run'}` }, x.pr.checks)) : '')))),
      ] : branch ? h('div', { class: 'empty' }, `No repository has a branch named "${branch}" (local or as of the last fetch).`) : null);
  }

  async function bulk(op, label, extra = {}) {
    const res = await runBulk(op, [...sel], { branch, ...extra }, label);
    if (res) find();
  }

  async function createPrs() {
    const without = rows.filter((x) => sel.has(x.id) && (!x.pr || x.pr.state !== 'OPEN'));
    if (!without.length) { banner({ level: 'info', title: 'Every selected repository already has an open pull request for this branch', timeout: 4000 }); return; }
    const v = await form({
      title: `Create pull requests for ${branch}`, wide: true,
      intro: h('div', { class: 'col' }, h('div', { class: 'muted' }, `One pull request per repository, each into that repository's default branch. Branches that are not pushed yet are pushed first.`),
        h('div', { class: 'mono', style: { fontSize: '12px' } }, without.map((x) => x.label).join(', '))),
      fields: [
        { name: 'title', label: 'Title (same for all)', required: true, value: branch.replace(/^[^/]+\//, '').replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) },
        { name: 'body', label: 'Description (same for all, Markdown)', type: 'textarea', rows: 8 },
        { name: 'draft', label: 'Create as drafts', type: 'checkbox' },
        { name: 'crossLink', label: 'Add links between the pull requests to each description', type: 'checkbox', value: true },
      ],
      submit: `Create ${without.length} pull request(s)`,
    });
    if (!v) return;
    banner({ level: 'info', title: `Creating ${without.length} pull requests…`, timeout: 3000 });
    const res = await act(() => rpc('feature.createPrs', { ids: without.map((x) => x.id), branch, title: v.title, body: v.body, draft: v.draft, crossLink: v.crossLink }));
    if (!res) return;
    modal({ title: 'Pull requests', wide: true, body: h('table', { class: 'grid' }, h('tr', null, h('th', null, 'Repository'), h('th', null, 'Result')),
      res.map((x) => h('tr', null, h('td', null, x.label), h('td', null, x.status === 'ok' ? h('a', { onclick: () => rpc('open.url', { url: x.url }) }, `#${x.number}`) : h('span', { style: { color: 'var(--bad)' } }, x.message), x.status === 'ok' && x.message ? h('div', { class: 'faint' }, x.message) : null)))),
    actions: [{ label: 'Close', cls: 'primary', default: true, value: null }] });
    find();
  }

  async function mergePrs(prs) {
    const order = [...prs];
    const methodSel = h('select', null, [['squash', 'Squash and merge'], ['merge', 'Create a merge commit'], ['rebase', 'Rebase and merge']].map(([v, l]) => h('option', { value: v }, l)));
    const del = h('input', { type: 'checkbox', checked: true });
    const listEl = h('div', { class: 'panel' });
    const drawOrder = () => mount(listEl, order.map((x, i) => h('div', { class: 'list-row' },
      h('strong', null, `${i + 1}.`), h('span', { class: 'grow' }, `${x.label} #${x.pr.number}`),
      x.pr.checks ? h('span', { class: `badge ${x.pr.checks === 'success' ? 'ok' : x.pr.checks === 'failure' ? 'bad' : 'run'}` }, `checks ${x.pr.checks}`) : null,
      x.pr.reviewDecision ? h('span', { class: 'badge' }, x.pr.reviewDecision.toLowerCase().replace(/_/g, ' ')) : null,
      iconBtn('chevronDown', 'Move down', () => { if (i < order.length - 1) { [order[i], order[i + 1]] = [order[i + 1], order[i]]; drawOrder(); } }),
      i > 0 ? h('button', { class: 'btn icon ghost small', title: 'Move up', onclick: () => { [order[i], order[i - 1]] = [order[i - 1], order[i]]; drawOrder(); } }, '↑') : null)));
    drawOrder();
    const notGreen = order.filter((x) => x.pr.checks && x.pr.checks !== 'success');
    const ok = await modal({
      title: `Merge ${plural(order.length, 'pull request')} in order`, wide: true,
      body: h('div', { class: 'col' },
        h('div', { class: 'muted' }, 'They are merged one after another in this order (put shared libraries or APIs first). Merging stops at the first failure. Every merge is tracked on the Actions board.'),
        notGreen.length ? h('div', { class: 'warn-box' }, `${notGreen.length} of them do not have passing checks.`) : null,
        listEl, h('label', { class: 'field' }, h('span', null, 'Merge method'), methodSel), h('label', { class: 'check' }, del, `Delete ${branch} on GitHub after each merge`)),
      actions: [{ label: 'Cancel', value: false }, { label: 'Merge all', cls: 'primary', default: true, value: true }],
    });
    if (!ok) return;
    const res = await act(() => rpc('feature.mergePrs', { items: order.map((x) => ({ id: x.id, number: x.pr.number })), method: methodSel.value, deleteBranch: del.checked, branch }));
    if (!res) return;
    const failed = res.find((x) => x.status === 'failed');
    modal({ title: failed ? 'Merging stopped' : 'All merged', wide: true, body: h('div', { class: 'col' },
      h('table', { class: 'grid' }, h('tr', null, h('th', null, 'Repository'), h('th', null, 'Result'), h('th', null, 'Details')),
        res.map((x) => h('tr', null, h('td', null, `${x.label} #${x.number}`), h('td', null, h('span', { class: `badge ${x.status === 'ok' ? 'ok' : x.status === 'failed' ? 'bad' : ''}` }, x.status)), h('td', { class: 'wrapcell', style: { whiteSpace: 'pre-wrap' } }, x.message || '')))),
      h('div', { class: 'info-box' }, 'Workflow runs on each default branch are tracked on the Actions board; you will be notified when they finish.')),
    actions: [{ label: 'Open Actions board', value: 'board' }, { label: 'Close', cls: 'primary', default: true, value: null }] }).then((v) => { if (v === 'board') navigate('#/board'); });
    find();
  }

  mount(page,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Feature branches'), h('div', { class: 'muted' }, 'One branch across many repositories: see where it exists and act on all of them at once.'))),
    h('div', { class: 'row', style: { marginBottom: '8px' } }, input, datalist, btn('Find', () => find(), { cls: 'primary', iconName: 'search' }),
      h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Suggestions show branch names that exist in several repositories.')),
    table);
  if (branch) find();
  void confirmDanger; void icon;
  return null;
}
