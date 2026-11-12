// First-run setup and cloning: find repositories already on disk, add folders, clone from GitHub.
import { h, mount, icon, btn, act, modal, form, banner, showError, plural, debounce, ago } from './dom.js';
import { rpc } from './api.js';
import { store, emit, subscribe, prefs } from './store.js';
import { navigate } from './router.js';
import { pickFolder } from './views/settings.js';

const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();

/** How the open account clones: protocol and, for SSH, the host alias from the user's ssh config. */
export function cloneDefaults() {
  const a = (store.config.accountSsh || {})[store.config.currentAccount] || {};
  return { proto: a.protocol || 'https', host: a.host || '' };
}
export function cloneUrl(r, proto) {
  if (proto !== 'ssh') return `${r.url}.git`;
  return `git@${cloneDefaults().host || 'github.com'}:${r.nameWithOwner}.git`;
}

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
  return { el, chosen: () => [...chosen.values()], clear: () => { chosen.clear(); draw(); }, onChange: (f) => onChange.add(f), reload: load,
    /** Repositories known to exist on disk although they are not loaded in the app yet. */
    addLocal: (slugList) => { for (const x of slugList) { local.add(x.toLowerCase()); chosen.forEach((v, k) => { if (k.toLowerCase() === x.toLowerCase()) chosen.delete(k); }); } draw(); } };
}

export async function cloneSelected(items, parent, protocol) {
  if (!items.length) return null;
  banner({ level: 'info', title: `Cloning ${plural(items.length, 'repository')} into ${parent}…`, timeout: 4000 });
  const res = await act(() => rpc('repo.cloneMany', { parent, items: items.map((r) => ({ url: cloneUrl(r, protocol), name: r.nameWithOwner.split('/')[1] })) }));
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

// ---------------- first-run setup: a four-step wizard. Nothing is selected or saved until the user says so. ----------------
const STEPS = ['Account', 'Local folders', 'Clone from GitHub', 'Review'];

export function setup(main) {
  const state = {
    step: store.config.currentAccount ? 1 : 0,
    picked: new Map((store.config.roots || []).map((r) => [norm(r.path), { path: r.path, count: null, kept: true }])),
    found: null,
    accounts: null,
    picker: null,
    dest: '',
    proto: cloneDefaults().proto,
    sshHost: cloneDefaults().host,
    slugsFor: '',
    busy: false,
  };
  const page = h('div', { class: 'page' }, h('div', { class: 'wizard' }));
  const wrap = page.firstChild;
  mount(main, page);

  const otherOwner = (p) => {
    const ar = store.config.accountRoots || {};
    for (const [login, list] of Object.entries(ar)) if (login !== store.config.currentAccount && login !== '*' && (list || []).some((r) => norm(r.path) === norm(p))) return login;
    return null;
  };

  function go(n) { state.step = Math.max(0, Math.min(3, n)); draw(); }

  function header() {
    return [
      h('div', { class: 'row', style: { justifyContent: 'center', gap: '10px', fontSize: '17px', fontWeight: 650 } }, h('img', { src: '/icon.svg', width: 30, height: 30, alt: '' }), 'Repodeck setup'),
      h('div', { class: 'steps' }, STEPS.flatMap((label, i) => [
        i ? h('span', { class: 'faint' }, '—') : null,
        h('button', { class: `step ${i === state.step ? 'on' : i < state.step ? 'done' : ''}`, disabled: i >= state.step, onclick: () => go(i) }, h('b', null, i < state.step ? '✓' : String(i + 1)), label),
      ])),
    ];
  }

  function foot({ next, nextLabel = 'Continue', skip, info }) {
    return h('div', { class: 'wizard-foot' },
      state.step > 0 ? btn('Back', () => go(state.step - 1), { iconName: 'back' }) : null,
      h('span', { class: 'grow muted', style: { textAlign: 'center' } }, info || ''),
      skip ? btn('Skip this step', skip, { cls: 'ghost' }) : null,
      btn(nextLabel, next, { cls: 'primary', disabled: state.busy }));
  }

  // ---- step 1: account
  function stepAccount() {
    const a = state.accounts;
    const body = h('div', { class: 'col', style: { gap: '10px' } });
    if (!a) mount(body, h('div', { class: 'skeleton' }, 'Loading'));
    else if (!a.installed) mount(body, h('div', { class: 'warn-box' }, 'The GitHub CLI is not installed, so pull requests, Actions and cloning from GitHub are unavailable. Run Setup again and choose Repair to add it. You can still continue with local repositories.'));
    else if (!a.accounts.length) mount(body, h('div', { class: 'pick-row' }, h('div', { class: 'grow' }, h('strong', null, 'No account signed in'), h('div', { class: 'sub' }, 'Sign-in opens GitHub in your browser. Your password never passes through this app.')),
      btn('Sign in to GitHub', () => signInThen(), { cls: 'primary' })));
    else mount(body, a.accounts.map((acc) => h('div', { class: `pick-row ${acc.current ? 'on' : ''}`, style: { cursor: 'default' } },
      h('img', { class: 'avatar', src: acc.avatar, width: 34, height: 34, alt: '', referrerpolicy: 'no-referrer' }),
      h('div', { class: 'grow' }, h('div', { class: 'row', style: { gap: '8px' } }, h('strong', null, acc.login), acc.current ? h('span', { class: 'badge accent' }, 'setting up this account') : null, acc.elsewhere ? h('span', { class: 'badge' }, 'open in another window') : null),
        h('div', { class: 'sub' }, acc.folders ? plural(acc.folders, 'folder') + ' assigned' : 'No folders yet')),
      !acc.current && !acc.elsewhere ? btn('Use this account', async () => { const m = await import('./account.js'); await m.useAccount(acc.login); }, { cls: 'small' }) : null)),
      h('div', null, btn('Add another account', () => signInThen(), { cls: 'small', iconName: 'plus' })));
    return [h('section', { class: 'panel wizard-card' },
      h('div', { class: 'col', style: { gap: '4px' } }, h('h1', null, 'Which GitHub account is this for?'), h('span', { class: 'muted' }, 'Every account is its own workspace with its own folders and repositories. You can add more accounts later.')),
      body),
    foot({ next: () => go(1), nextLabel: store.config.currentAccount ? 'Continue' : 'Continue without GitHub', info: store.config.currentAccount ? `Setting up ${store.config.currentAccount}` : '' })];
  }
  async function signInThen() { const m = await import('./account.js'); await m.signIn(); }
  async function loadAccounts() { state.accounts = await rpc('account.list').catch(() => ({ installed: false, accounts: [] })); if (state.step === 0) draw(); }

  // ---- step 2: local folders
  function stepFolders() {
    const rows = [];
    if (!state.found) rows.push(h('div', { class: 'row muted' }, icon('refresh', 'sm spin'), 'Looking for repositories on this computer…'));
    const extra = [...state.picked.values()].filter((p) => !state.found || !state.found.folders.some((f) => norm(f.path) === norm(p.path)));
    const items = [...(state.found ? state.found.folders : []), ...extra.map((p) => ({ path: p.path, count: p.count, repos: [], manual: true }))];
    for (const f of items) {
      const on = state.picked.has(norm(f.path));
      const owner = otherOwner(f.path);
      rows.push(h('label', { class: `pick-row ${on ? 'on' : ''}` },
        h('input', { type: 'checkbox', checked: on, onchange: (e) => { if (e.target.checked) state.picked.set(norm(f.path), f); else state.picked.delete(norm(f.path)); draw(); } }),
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'row', style: { gap: '8px' } }, h('span', { class: 'mono ellipsis', style: { fontWeight: 600 } }, f.path),
            f.count != null ? h('span', { class: 'badge accent nowrap' }, plural(f.count, 'repository')) : h('span', { class: 'badge nowrap' }, 'added by you'),
            owner ? h('span', { class: 'badge nowrap', title: 'You can still add it here too' }, `assigned to ${owner}`) : null),
          f.repos && f.repos.length ? h('div', { class: 'sub ellipsis' }, f.repos.join(', ')) : null)));
    }
    if (state.found && !items.length) rows.push(h('div', { class: 'muted' }, 'No repositories were found automatically. Add a folder, or clone from GitHub in the next step.'));
    const total = [...state.picked.values()].reduce((n, p) => n + (p.count || 0), 0);
    const who = store.config.currentAccount;
    return [h('section', { class: 'panel wizard-card' },
      h('div', { class: 'col', style: { gap: '4px' } }, h('h1', null, who ? `Which folders belong to ${who}?` : 'Which folders hold your repositories?'),
        h('span', { class: 'muted' }, `${[...state.picked.values()].some((p) => p.kept) ? 'Folders this account already has are ticked; nothing else is selected for you.' : 'Nothing is selected for you: tick the folders this workspace should show.'} Repositories nested inside them are included. Looking changes nothing on disk.`)),
      h('div', { class: 'col', style: { gap: '10px' } }, rows),
      h('div', { class: 'row' }, btn('Add another folder…', async () => { const p = await pickFolder('Add a folder that contains repositories'); if (p) { state.picked.set(norm(p), { path: p, count: null }); draw(); } }, { iconName: 'plus' }),
        state.found ? h('span', { class: 'faint', style: { fontSize: '12px' } }, `${plural(state.found.folders.length, 'folder')} found${state.found.timedOut ? ' (search stopped after 10 seconds)' : ''}`) : null)),
    foot({ next: () => go(2), skip: state.picked.size ? null : () => go(2), info: state.picked.size ? `${plural(state.picked.size, 'folder')} selected${total ? `, about ${plural(total, 'repository')}` : ''}` : 'No folders selected' })];
  }
  function discover() {
    rpc('setup.discover').then((r) => {
      state.found = r;
      for (const f of r.folders) { const p = state.picked.get(norm(f.path)); if (p) p.count = f.count; }
      if (state.step === 1) draw();
    }).catch((e) => { state.found = { folders: [] }; banner({ level: 'error', title: 'Automatic search failed', body: e.message }); if (state.step === 1) draw(); });
  }

  // ---- step 3: clone
  function stepClone() {
    const who = store.config.currentAccount;
    if (!who) {
      return [h('section', { class: 'panel wizard-card' }, h('h1', null, 'Clone from GitHub'), h('div', { class: 'muted' }, 'Sign in to a GitHub account in step 1 to list and clone its repositories. You can also do this later from the GitHub page.')),
        foot({ next: () => go(3), nextLabel: 'Continue' })];
    }
    if (!state.picker) state.picker = githubPicker();
    // Repositories inside the folders ticked in step 2 are already here, even though nothing is saved yet.
    const key = [...state.picked.keys()].sort().join('|');
    if (key && state.slugsFor !== key) {
      state.slugsFor = key;
      const picker = state.picker;
      rpc('setup.slugs', { paths: [...state.picked.values()].map((p) => p.path) }).then((list) => {
        picker.addLocal(list.map((x) => x.slug));
        // Clone the way the existing repositories were cloned: same SSH host alias.
        const hosts = new Map();
        for (const x of list) if (x.host && x.host !== 'github.com') hosts.set(x.host, (hosts.get(x.host) || 0) + 1);
        const top = [...hosts].sort((p, q) => q[1] - p[1])[0];
        if (top && !cloneDefaults().host && top[1] >= list.length / 2) { state.sshHost = top[0]; state.proto = 'ssh'; state.detected = true; if (state.step === 2) draw(); }
      }).catch(() => {});
    }
    const dests = [...state.picked.values()].map((p) => p.path);
    if (!dests.includes(state.dest)) state.dest = dests[0] || '';
    const destSel = h('select', { style: { maxWidth: '360px' }, onchange: async (e) => {
      if (e.target.value !== '__browse') { state.dest = e.target.value; return; }
      const p = await pickFolder('Clone into which folder?');
      if (p) { state.picked.set(norm(p), { path: p, count: null }); state.dest = p; }
      draw();
    } }, dests.map((d) => h('option', { value: d, selected: d === state.dest }, d)), h('option', { value: '__browse' }, dests.length ? 'Choose another folder…' : 'Choose a folder…'));
    if (!dests.length) destSel.selectedIndex = -1;
    const protoSel = h('select', { onchange: (e) => { state.proto = e.target.value; draw(); } }, h('option', { value: 'https', selected: state.proto === 'https' }, 'HTTPS'), h('option', { value: 'ssh', selected: state.proto === 'ssh' }, 'SSH'));
    const n = state.picker.chosen().length;
    return [h('section', { class: 'panel wizard-card' },
      h('div', { class: 'col', style: { gap: '4px' } }, h('h1', null, `Clone repositories of ${who}?`), h('span', { class: 'muted' }, 'Optional. Tick what you want on this computer; cloning starts only after you confirm on the next step.')),
      state.picker.el,
      h('div', { class: 'row wrap' }, h('span', { class: 'nowrap' }, 'Clone into'), destSel, h('span', { class: 'nowrap' }, 'using'), protoSel,
        state.proto === 'ssh' ? [h('span', { class: 'nowrap' }, 'host'), h('input', { type: 'text', value: state.sshHost, placeholder: 'github.com', style: { width: '170px' }, spellcheck: 'false', title: 'Host or alias from your SSH config', onchange: (e) => { state.sshHost = e.target.value.trim(); state.detected = false; } })] : null),
      state.detected && state.proto === 'ssh' ? h('div', { class: 'info-box' }, `Your existing repositories for this account use the SSH host “${state.sshHost}”, so new clones will too. Change it here or later in Settings → Account.`) : null),
    foot({ next: () => {
      if (state.picker.chosen().length && !state.dest) { banner({ level: 'warn', title: 'Choose the folder to clone into', timeout: 3000 }); return; }
      go(3);
    }, skip: n ? null : () => go(3), info: n ? `${plural(n, 'repository')} to clone` : 'Nothing selected to clone' })];
  }

  // ---- step 4: review
  function stepReview() {
    const folders = [...state.picked.values()];
    const clones = state.picker ? state.picker.chosen() : [];
    const who = store.config.currentAccount;
    const nothing = !folders.length && !clones.length;
    return [h('section', { class: 'panel wizard-card' },
      h('div', { class: 'col', style: { gap: '4px' } }, h('h1', null, 'Review'), h('span', { class: 'muted' }, nothing ? 'You have not chosen anything yet. You can finish anyway and add folders later in Settings.' : 'This is everything that will happen. Nothing has been saved yet.')),
      h('div', { class: 'col', style: { gap: '14px' } },
        h('div', null, h('div', { class: 'eyebrow', style: { marginBottom: '6px' } }, 'Account'), who ? h('strong', null, who) : h('span', { class: 'muted' }, 'No GitHub account (local repositories only)')),
        h('div', null, h('div', { class: 'eyebrow', style: { marginBottom: '6px' } }, `Folders to show (${folders.length})`),
          folders.length ? folders.map((f) => h('div', { class: 'row' }, icon('folder', 'sm'), h('span', { class: 'mono grow ellipsis' }, f.path), f.count != null ? h('span', { class: 'faint' }, plural(f.count, 'repository')) : null)) : h('span', { class: 'muted' }, 'None')),
        h('div', null, h('div', { class: 'eyebrow', style: { marginBottom: '6px' } }, `Repositories to clone (${clones.length})`),
          clones.length ? [h('div', { class: 'muted', style: { marginBottom: '4px' } }, 'Into ', h('span', { class: 'mono' }, state.dest), ` over ${state.proto.toUpperCase()}`), clones.map((c) => h('div', { class: 'row' }, icon('fetch', 'sm'), h('span', { class: 'grow ellipsis' }, c.nameWithOwner)))] : h('span', { class: 'muted' }, 'None')))),
    foot({ next: () => finish(folders, clones), nextLabel: clones.length ? `Save and clone ${clones.length}` : 'Finish' })];
  }

  async function finish(folders, clones) {
    state.busy = true; draw();
    try {
      const roots = folders.map((p) => ({ path: p.path, name: p.path.split(/[\\/]/).filter(Boolean).pop() }));
      const who = store.config.currentAccount;
      const patch = { roots, firstRunDone: true };
      if (who && (state.proto === 'ssh' || state.sshHost)) patch.accountSsh = { ...(store.config.accountSsh || {}), [who]: { protocol: state.proto, host: state.proto === 'ssh' ? state.sshHost : ((store.config.accountSsh || {})[who] || {}).host || '' } };
      store.config = await rpc('config.update', { patch });
      emit('config');
      if (clones.length) await cloneSelected(clones, state.dest, state.proto);
      await rpc('repos.scan');
      navigate('#/repo');
    } catch (e) { showError(e); state.busy = false; draw(); }
  }

  function draw() {
    const body = [stepAccount, stepFolders, stepClone, stepReview][state.step]();
    mount(wrap, header(), body);
  }

  const un = [subscribe('accounts', () => { loadAccounts(); state.picker = null; if (state.step > 0) draw(); })];
  draw();
  loadAccounts();
  discover();
  return () => un.forEach((u) => u());
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
