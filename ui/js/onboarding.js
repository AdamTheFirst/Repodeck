// First-run setup and cloning: find repositories already on disk, add folders, clone from GitHub.
import { h, mount, icon, btn, act, modal, form, banner, showError, plural, debounce, ago } from './dom.js';
import { rpc } from './api.js';
import { store, emit } from './store.js';
import { navigate } from './router.js';
import { pickFolder } from './views/settings.js';

const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();

// ---------------- GitHub repository picker (shared by setup and the clone dialog) ----------------
function githubPicker() {
  let all = null;
  let error = null;
  let filter = '';
  let showArchived = false;
  const chosen = new Map(); // nameWithOwner -> repo
  const local = new Set(store.repos.filter((r) => r.slug).map((r) => `${r.slug.owner}/${r.slug.repo}`.toLowerCase()));
  const listEl = h('div', { class: 'panel', style: { maxHeight: '300px', overflow: 'auto' } });
  const search = h('input', { type: 'search', placeholder: 'Search your GitHub repositories', style: { flex: '1' } });
  const counter = h('span', { class: 'muted nowrap' });
  const onChange = new Set();
  search.addEventListener('input', debounce(() => { filter = search.value.trim().toLowerCase(); draw(); }, 150));
  function draw() {
    counter.textContent = chosen.size ? `${chosen.size} selected` : '';
    if (error) { mount(listEl, h('div', { class: 'warn-box', style: { margin: '8px' } }, error)); return; }
    if (!all) { mount(listEl, h('div', { class: 'skeleton' }, 'Loading repositories from GitHub…')); return; }
    const rows = all.filter((r) => (showArchived || !r.isArchived) && (!filter || r.nameWithOwner.toLowerCase().includes(filter) || (r.description || '').toLowerCase().includes(filter)));
    if (!rows.length) { mount(listEl, h('div', { class: 'empty' }, all.length ? 'No repositories match.' : 'No repositories found for your account.')); return; }
    mount(listEl, rows.slice(0, 400).map((r) => {
      const have = local.has(r.nameWithOwner.toLowerCase());
      return h('label', { class: 'list-row', style: { cursor: have ? 'default' : 'pointer', opacity: have ? 0.6 : 1 } },
        h('input', { type: 'checkbox', disabled: have, checked: chosen.has(r.nameWithOwner), onchange: (e) => { if (e.target.checked) chosen.set(r.nameWithOwner, r); else chosen.delete(r.nameWithOwner); draw(); onChange.forEach((f) => f()); } }),
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'ellipsis', style: { fontWeight: 600 } }, r.nameWithOwner),
            r.isPrivate ? h('span', { class: 'badge' }, 'private') : null, r.isArchived ? h('span', { class: 'badge' }, 'archived') : null, have ? h('span', { class: 'badge ok' }, 'already here') : null),
          r.description ? h('div', { class: 'sub ellipsis' }, r.description) : null),
        h('span', { class: 'faint nowrap', style: { fontSize: '11px' } }, r.updatedAt ? ago(r.updatedAt) : ''));
    }));
  }
  const el = h('div', { class: 'col' },
    h('div', { class: 'row' }, search, h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { showArchived = e.target.checked; draw(); } }), 'Archived'), counter),
    listEl);
  function load() {
    all = null; error = null; draw();
    rpc('gh.repoListAll').then((l) => { all = l; if (!l.length) error = null; draw(); })
      .catch((e) => { error = /not installed/.test(e.message) ? 'GitHub CLI is not installed. Run the installer again to add it.' : /auth|login|401/i.test(e.message) ? 'Not signed in to GitHub yet. Use "Sign in to GitHub" above.' : e.message.split('\n')[0]; draw(); });
  }
  load();
  return { el, chosen: () => [...chosen.values()], clear: () => { chosen.clear(); draw(); }, onChange: (f) => onChange.add(f), reload: load };
}

export async function cloneSelected(items, parent, protocol) {
  if (!items.length) return null;
  banner({ level: 'info', title: `Cloning ${plural(items.length, 'repository')} into ${parent}…`, timeout: 4000 });
  const res = await act(() => rpc('repo.cloneMany', { parent, items: items.map((r) => ({ url: protocol === 'ssh' ? r.sshUrl : `${r.url}.git`, name: r.nameWithOwner.split('/')[1] })) }));
  if (!res) return null;
  const failed = res.filter((x) => x.status === 'failed');
  banner({ level: failed.length ? 'error' : 'success', title: `Cloned ${res.length - failed.length} of ${res.length}`, body: failed.map((f) => `${f.name}: ${f.message}`).join('\n') || null, timeout: failed.length ? 0 : 5000 });
  return res;
}

export async function ensureRoot(p) {
  const roots = store.config.roots || [];
  if (roots.some((r) => norm(r.path) === norm(p))) return;
  store.config = await rpc('config.update', { patch: { roots: [...roots, { path: p, name: p.split(/[\\/]/).filter(Boolean).pop() }] } });
  emit('config');
}

// ---------------- first-run setup ----------------
export function setup(main) {
  const page = h('div', { class: 'page' }, h('div', { class: 'onboard' }));
  const wrap = page.firstChild;
  mount(main, page);
  const picked = new Map((store.config.roots || []).map((r) => [norm(r.path), { path: r.path, count: null }]));
  let found = null;

  const foundEl = h('div', { class: 'col' });
  const accountsEl = h('div', { class: 'muted' }, 'Checking GitHub sign-in…');
  const summaryEl = h('span', { class: 'muted' });
  const picker = githubPicker();
  const destSel = h('select', { style: { maxWidth: '360px' } });
  const protoSel = h('select', null, h('option', { value: 'https' }, 'HTTPS'), h('option', { value: 'ssh' }, 'SSH'));

  function drawFound() {
    const rows = [];
    if (!found) rows.push(h('div', { class: 'row muted' }, icon('refresh', 'sm spin'), 'Looking for repositories on this computer…'));
    const extra = [...picked.values()].filter((p) => !found || !found.folders.some((f) => norm(f.path) === norm(p.path)));
    const items = [...(found ? found.folders : []), ...extra.map((p) => ({ path: p.path, count: p.count, repos: [], manual: true }))];
    for (const f of items) {
      const on = picked.has(norm(f.path));
      rows.push(h('label', { class: `pick-row ${on ? 'on' : ''}` },
        h('input', { type: 'checkbox', checked: on, onchange: (e) => { if (e.target.checked) picked.set(norm(f.path), f); else picked.delete(norm(f.path)); drawFound(); } }),
        icon('folder'),
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'mono ellipsis', style: { fontWeight: 600 } }, f.path),
            f.count != null ? h('span', { class: 'badge accent nowrap' }, plural(f.count, 'repository')) : h('span', { class: 'badge nowrap' }, 'added by you')),
          f.repos.length ? h('div', { class: 'sub ellipsis' }, f.repos.join(', ')) : null)));
    }
    if (found && !items.length) rows.push(h('div', { class: 'muted' }, 'No repositories found automatically. Add a folder or clone from GitHub below.'));
    if (found && found.timedOut) rows.push(h('div', { class: 'faint' }, 'The search stopped after 10 seconds; add other folders by hand if something is missing.'));
    mount(foundEl, rows);
    // destination options for cloning
    const dests = [...picked.values()].map((p) => p.path);
    const cur = destSel.value;
    mount(destSel, dests.map((d) => h('option', { value: d, selected: d === cur }, d)), h('option', { value: '__browse' }, 'Choose another folder…'));
    const total = [...picked.values()].reduce((a, p) => a + (p.count || 0), 0);
    summaryEl.textContent = picked.size ? `${plural(picked.size, 'folder')} selected${total ? `, about ${plural(total, 'repository')}` : ''}` : 'Select at least one folder';
    finishBtn.disabled = !picked.size;
  }
  destSel.addEventListener('change', async () => {
    if (destSel.value !== '__browse') return;
    const p = await pickFolder('Clone into which folder?');
    if (p) { picked.set(norm(p), { path: p, count: null }); drawFound(); destSel.value = p; } else destSel.selectedIndex = 0;
  });

  const cloneBtn = btn('Clone selected', async () => {
    const items = picker.chosen();
    if (!items.length) { banner({ level: 'info', title: 'Tick the repositories to clone first', timeout: 3000 }); return; }
    let dest = destSel.value;
    if (!dest || dest === '__browse') { dest = await pickFolder('Clone into which folder?'); if (!dest) return; picked.set(norm(dest), { path: dest, count: null }); drawFound(); }
    await ensureRoot(dest);
    cloneBtn.disabled = true;
    const res = await cloneSelected(items, dest, protoSel.value);
    cloneBtn.disabled = false;
    if (res) { picker.clear(); const p = picked.get(norm(dest)); if (p) p.count = (p.count || 0) + res.filter((x) => x.status === 'ok').length; drawFound(); }
  }, { cls: 'primary', iconName: 'fetch' });

  const finishBtn = btn('Done: show my repositories', async () => {
    try {
      const roots = [...picked.values()].map((p) => ({ path: p.path, name: p.path.split(/[\\/]/).filter(Boolean).pop() }));
      store.config = await rpc('config.update', { patch: { roots, firstRunDone: true } });
      emit('config');
      await rpc('repos.scan');
      navigate('#/repo');
    } catch (e) { showError(e); }
  }, { cls: 'primary' });

  mount(wrap,
    h('div', { class: 'onboard-head' }, h('img', { src: '/icon.svg', alt: '', width: 40, height: 40 }),
      h('div', null, h('h1', null, 'Set up git-helper'), h('div', { class: 'muted' }, 'Pick where your repositories live. Nested repositories inside them are found too. Nothing in your repositories is changed by this.'))),
    h('section', { class: 'panel onboard-card' },
      h('div', { class: 'panel-head' }, h('span', { class: 'step-no' }, '1'), h('h3', { class: 'grow' }, 'Repositories already on this computer'),
        btn('Add folder…', async () => { const p = await pickFolder('Add a folder that contains repositories'); if (p) { picked.set(norm(p), { path: p, count: null }); drawFound(); } }, { cls: 'small', iconName: 'plus' })),
      h('div', { class: 'panel-body' }, foundEl)),
    h('section', { class: 'panel onboard-card' },
      h('div', { class: 'panel-head' }, h('span', { class: 'step-no' }, '2'), h('h3', { class: 'grow' }, 'Clone from GitHub'), h('span', { class: 'faint' }, 'optional')),
      h('div', { class: 'panel-body col' }, accountsEl, picker.el,
        h('div', { class: 'row wrap' }, h('span', { class: 'nowrap' }, 'Into'), destSel, h('span', { class: 'nowrap' }, 'using'), protoSel, h('span', { class: 'spacer' }), cloneBtn))),
    h('div', { class: 'row onboard-foot' }, summaryEl, h('span', { class: 'spacer' }), finishBtn));

  drawFound();
  const drawAccounts = () => rpc('account.list').then((r) => {
    if (!r.installed) { mount(accountsEl, h('span', { class: 'warn-box', style: { display: 'block' } }, 'GitHub CLI not found. Local repositories work; run the installer again to add it for pull requests and Actions.')); return; }
    mount(accountsEl, r.accounts.length
      ? h('div', { class: 'row wrap' }, h('span', null, 'Showing repositories of ', h('strong', null, r.current || '?'), ' and its organisations. These folders will belong to this account.'),
        h('span', { class: 'spacer' }), btn('Add another account', () => import('./account.js').then((m) => m.signIn()).then(() => setTimeout(() => { drawAccounts(); picker.reload(); }, 500)), { cls: 'small' }))
      : h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Sign in to see and clone your GitHub repositories. Local folders work without it.'),
        btn('Sign in to GitHub', () => import('./account.js').then((m) => m.signIn()).then(() => setTimeout(() => { drawAccounts(); picker.reload(); }, 500)), { cls: 'small primary' })));
  }).catch(() => {});
  drawAccounts();
  rpc('setup.discover').then((r) => {
    found = r;
    // Nothing is selected for the user: they tick the folders they want.
    for (const f of r.folders) { const p = picked.get(norm(f.path)); if (p) p.count = f.count; }
    drawFound();
  }).catch((e) => { found = { folders: [] }; drawFound(); banner({ level: 'error', title: 'Automatic search failed', body: e.message }); });
}

// ---------------- clone dialog (sidebar "+") ----------------
export async function cloneDialog() {
  const roots = store.config.roots || [];
  if (!roots.length) { navigate('#/settings/setup'); return; }
  const picker = githubPicker();
  const urlIn = h('input', { type: 'text', placeholder: 'Or paste any clone URL', style: { width: '100%' }, spellcheck: 'false' });
  const rootSel = h('select', { style: { maxWidth: '100%' } }, roots.map((r) => h('option', { value: r.path }, r.path)), h('option', { value: '__browse' }, 'Choose another folder…'));
  const sub = h('input', { type: 'text', placeholder: 'optional subfolder, e.g. services', style: { width: '100%' } });
  const protoSel = h('select', null, h('option', { value: 'https' }, 'HTTPS'), h('option', { value: 'ssh' }, 'SSH'));
  rootSel.addEventListener('change', async () => {
    if (rootSel.value !== '__browse') return;
    const p = await pickFolder('Clone into which folder?');
    if (!p) { rootSel.selectedIndex = 0; return; }
    rootSel.insertBefore(h('option', { value: p, selected: true }, p), rootSel.lastChild);
  });
  const v = await modal({
    title: 'Add repositories', wide: true,
    body: h('div', { class: 'col' }, picker.el, urlIn,
      h('div', { class: 'row', style: { alignItems: 'flex-end' } },
        h('label', { class: 'field grow' }, h('span', null, 'Into folder'), rootSel), h('label', { class: 'field', style: { width: '200px' } }, h('span', null, 'Subfolder'), sub),
        h('label', { class: 'field' }, h('span', null, 'Protocol'), protoSel)),
      h('div', { class: 'faint' }, 'Already have the repository somewhere else on disk? ', h('a', { onclick: () => { document.querySelector('.modal-back').remove(); navigate('#/settings'); } }, 'Add its folder in Settings'), '. Want an empty new repository? ', h('a', { onclick: () => { document.querySelector('.modal-back').remove(); initDialog(); } }, 'Create one'), '.')),
    actions: [{ label: 'Cancel', value: null }, { label: 'Clone', cls: 'primary', default: true, value: () => ({ items: picker.chosen(), url: urlIn.value.trim(), root: rootSel.value, sub: sub.value.trim(), proto: protoSel.value }) }],
  });
  if (!v) return;
  if (v.root === '__browse') return;
  const parent = v.sub ? `${v.root.replace(/[\\/]+$/, '')}\\${v.sub}` : v.root;
  await ensureRoot(v.root);
  if (!v.items.length && !v.url) { banner({ level: 'info', title: 'Nothing selected to clone', timeout: 3000 }); return; }
  if (v.url) {
    // a pasted URL is used exactly as given
    const m = /([^/:]+?)(\.git)?\/?$/.exec(v.url);
    const res = await act(() => rpc('repo.cloneMany', { parent, items: [{ url: v.url, name: m ? m[1] : 'repository' }] }));
    if (res && res[0].status === 'failed') banner({ level: 'error', title: `Clone failed: ${res[0].name}`, body: res[0].message, timeout: 0 });
    else if (res) banner({ level: 'success', title: `Cloned ${res[0].name}`, timeout: 4000 });
  }
  if (v.items.length) await cloneSelected(v.items, parent, v.proto);
}

async function initDialog() {
  const roots = store.config.roots;
  const v = await form({ title: 'Create a new repository', fields: [
    { name: 'root', label: 'Inside', type: 'select', options: roots.map((r) => ({ value: r.path, label: r.path })), value: roots[0].path },
    { name: 'name', label: 'Folder name', required: true, validate: (x) => (/[<>:"|?*\\/]/.test(x) ? 'Invalid folder name' : null) },
  ], submit: 'Create' });
  if (v) act(() => rpc('repo.init', { dir: `${v.root.replace(/[\\/]+$/, '')}\\${v.name.trim()}` }), { ok: 'Repository created' });
}
