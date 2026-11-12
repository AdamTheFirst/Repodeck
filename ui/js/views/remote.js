// Repositories on GitHub for the open account: what exists remotely, what is already cloned, clone the rest.
import { h, mount, icon, btn, banner, ago, plural, debounce } from '../dom.js';
import { rpc } from '../api.js';
import { store, subscribe, prefs } from '../store.js';
import { navigate } from '../router.js';
import { cloneSelected, ensureRoot, cloneDefaults } from '../onboarding.js';
import { pickFolder } from './settings.js';

export function render(main) {
  let all = null;
  let error = null;
  let text = '';
  let owner = '';
  let show = prefs.get('remoteShow', 'all'); // all | missing | cloned
  let archived = false;
  const chosen = new Set();
  const page = h('div', { class: 'page' });
  mount(main, page);
  const who = store.config.currentAccount;

  const localFor = () => {
    const m = new Map();
    for (const r of store.repos) if (r.slug) m.set(`${r.slug.owner}/${r.slug.repo}`.toLowerCase(), r);
    return m;
  };
  const search = h('input', { type: 'search', placeholder: 'Search repositories', style: { width: '240px' } });
  search.addEventListener('input', debounce(() => { text = search.value.trim().toLowerCase(); draw(); }, 150));
  const destSel = h('select', { style: { maxWidth: '300px' } });
  const protoSel = h('select', { title: 'Clone protocol' }, h('option', { value: 'https' }, 'HTTPS'), h('option', { value: 'ssh', selected: cloneDefaults().proto === 'ssh' }, cloneDefaults().host ? `SSH (${cloneDefaults().host})` : 'SSH'));
  const listEl = h('div');
  const barEl = h('div', { class: 'row wrap', style: { marginBottom: '10px' } });
  const cloneBar = h('div', { class: 'selection-bar hidden', style: { borderRadius: '8px', marginBottom: '10px' } });

  function drawDest() {
    const cur = destSel.value;
    mount(destSel, store.config.roots.map((r) => h('option', { value: r.path, selected: r.path === cur }, r.path)), h('option', { value: '__browse' }, 'Choose another folder…'));
  }
  destSel.addEventListener('change', async () => {
    if (destSel.value !== '__browse') return;
    const p = await pickFolder('Clone into which folder?');
    if (p) { await ensureRoot(p); drawDest(); destSel.value = p; } else destSel.selectedIndex = 0;
  });

  async function clone(items) {
    let dest = destSel.value;
    if (!dest || dest === '__browse') { dest = await pickFolder('Clone into which folder?'); if (!dest) return; }
    await ensureRoot(dest);
    drawDest(); destSel.value = dest;
    const res = await cloneSelected(items, dest, protoSel.value);
    if (res) { chosen.clear(); draw(); }
  }

  function draw() {
    const local = localFor();
    if (!who) { mount(listEl, h('div', { class: 'empty' }, h('h3', null, 'Sign in to see your GitHub repositories'), btn('Sign in to GitHub', () => import('../account.js').then((m) => m.signIn()), { cls: 'primary' }))); return; }
    if (error) { mount(listEl, h('div', { class: 'errbox' }, error)); return; }
    if (!all) { mount(listEl, h('div', { class: 'progress' }), h('div', { class: 'skeleton' }, `Loading repositories of ${who} and its organisations…`)); return; }
    const owners = [...new Set(all.map((r) => r.owner))];
    const rows = all.filter((r) => (archived || !r.isArchived) && (!owner || r.owner === owner) && (!text || r.nameWithOwner.toLowerCase().includes(text) || (r.description || '').toLowerCase().includes(text))
      && (show === 'all' || (show === 'cloned') === local.has(r.nameWithOwner.toLowerCase())));
    const clonedCount = all.filter((r) => local.has(r.nameWithOwner.toLowerCase())).length;
    mount(barEl,
      h('div', { class: 'pill-tabs' }, [['all', `All (${all.length})`], ['missing', `Not cloned (${all.length - clonedCount})`], ['cloned', `Cloned (${clonedCount})`]].map(([k, l]) => h('button', { class: show === k ? 'active' : '', onclick: () => { show = k; prefs.set('remoteShow', k); draw(); } }, l))),
      search,
      h('select', { onchange: (e) => { owner = e.target.value; draw(); } }, h('option', { value: '' }, 'All owners'), owners.map((o) => h('option', { value: o, selected: o === owner }, o))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: archived, onchange: (e) => { archived = e.target.checked; draw(); } }), 'Archived'),
      h('span', { class: 'spacer' }));
    cloneBar.classList.toggle('hidden', !chosen.size);
    mount(cloneBar, h('strong', null, `${plural(chosen.size, 'repository')} selected`), btn('Clone selected', () => clone(all.filter((r) => chosen.has(r.nameWithOwner))), { cls: 'small primary', iconName: 'fetch' }),
      h('span', { class: 'spacer' }), btn('Clear', () => { chosen.clear(); draw(); }, { cls: 'small ghost' }));
    const missing = rows.filter((r) => !local.has(r.nameWithOwner.toLowerCase()));
    mount(listEl, rows.length ? h('table', { class: 'grid panel fixed' },
      h('tr', null, h('th', { style: { width: '36px' } }, h('input', { type: 'checkbox', title: 'Select all not yet cloned', checked: missing.length > 0 && missing.every((r) => chosen.has(r.nameWithOwner)), onchange: (e) => { missing.forEach((r) => (e.target.checked ? chosen.add(r.nameWithOwner) : chosen.delete(r.nameWithOwner))); draw(); } })),
        h('th', null, 'Repository'), h('th', { style: { width: '110px' } }, 'Language'), h('th', { style: { width: '100px' } }, 'Updated'), h('th', { style: { width: '26%' } }, 'On this computer'), h('th', { style: { width: '120px' } }, '')),
      rows.slice(0, 600).map((r) => {
        const loc = local.get(r.nameWithOwner.toLowerCase());
        return h('tr', null,
          h('td', null, loc ? null : h('input', { type: 'checkbox', checked: chosen.has(r.nameWithOwner), onchange: (e) => { if (e.target.checked) chosen.add(r.nameWithOwner); else chosen.delete(r.nameWithOwner); draw(); } })),
          h('td', null, h('div', { class: 'row', style: { gap: '6px' } }, h('strong', { class: 'ellipsis' }, r.nameWithOwner), r.isPrivate ? h('span', { class: 'badge' }, 'private') : h('span', { class: 'badge' }, 'public'), r.isFork ? h('span', { class: 'badge' }, 'fork') : null, r.isArchived ? h('span', { class: 'badge warn' }, 'archived') : null),
            r.description ? h('div', { class: 'faint ellipsis', style: { fontSize: '12px' } }, r.description) : null),
          h('td', { class: 'muted nowrap' }, r.language || ''),
          h('td', { class: 'muted nowrap' }, r.updatedAt ? ago(r.updatedAt) : ''),
          h('td', null, loc ? h('a', { class: 'row', style: { gap: '6px' }, title: loc.path, onclick: () => navigate(`#/repo/${loc.id}/changes`) }, h('span', { class: 'badge ok' }, 'cloned'), h('span', { class: 'ellipsis' }, loc.label)) : h('span', { class: 'faint' }, 'not cloned')),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            loc ? btn('Open', () => navigate(`#/repo/${loc.id}/changes`), { cls: 'small' }) : btn('Clone', () => clone([r]), { cls: 'small primary' }), ' ',
            btn('', () => rpc('open.url', { url: r.url }), { cls: 'small icon ghost', iconName: 'external', title: 'Open on GitHub' })));
      })) : h('div', { class: 'empty' }, all.length ? 'No repositories match.' : `${who} has no repositories.`));
  }

  function load() {
    all = null; error = null; draw();
    if (!who) return;
    rpc('gh.repoListAll').then((l) => { all = l; draw(); }).catch((e) => { error = e.message; draw(); });
  }
  mount(page,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Repositories on GitHub'), h('div', { class: 'muted' }, who ? `Everything ${who} can see, including its organisations. Cloned repositories land in this account's folders.` : 'Not signed in.')),
      h('span', { class: 'spacer' }), h('span', { class: 'nowrap muted' }, 'Clone into'), destSel, protoSel, btn('Refresh', () => load(), { iconName: 'refresh' })),
    barEl, cloneBar, listEl);
  drawDest();
  load();
  const un = subscribe('repos', () => { if (all) draw(); });
  void icon; void banner;
  return () => un();
}
