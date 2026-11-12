// Settings, first-run setup, diagnostics, clone/init dialogs.
import { h, mount, icon, btn, act, modal, form, banner, confirmDanger, showError } from '../dom.js';
import { rpc } from '../api.js';
import { store, emit } from '../store.js';
import { navigate } from '../router.js';

export function render(main, parts) {
  const sub = parts[0] || 'general';
  if (sub === 'setup') { import('../onboarding.js').then((m) => m.setup(main)); return null; }
  const page = h('div', { class: 'page' });
  mount(main, h('div', { class: 'tabs' },
    [['general', 'Settings'], ['diagnostics', 'Diagnostics']].map(([k, l]) => h('button', { class: `tab ${sub === k ? 'active' : ''}`, onclick: () => navigate(`#/settings/${k}`) }, l))), page);
  if (sub === 'diagnostics') diagnostics(page); else general(page);
  return null;
}

// ---------- folder picker ----------
export async function pickFolder(title = 'Choose a folder', start) {
  let cur = start || null;
  const list = h('div', { class: 'panel', style: { height: '46vh', overflow: 'auto' } });
  const pathLine = h('input', { type: 'text', style: { width: '100%' }, placeholder: 'Type or paste a path', value: cur || '' });
  let resolveFn;
  async function go(dir) {
    try {
      const d = await rpc('fs.listDir', { dir });
      cur = d.dir;
      pathLine.value = cur || '';
      mount(list,
        d.dir ? h('div', { class: 'list-row', onclick: () => go(d.parent) }, icon('chevronRight', 'sm'), '..') : null,
        d.entries.map((e) => h('div', { class: 'list-row', ondblclick: () => go(e.path), onclick: () => go(e.path) }, icon('folder', 'sm'), h('span', { class: 'grow' }, e.name), e.git ? h('span', { class: 'badge accent' }, 'git') : null)));
    } catch (e) { banner({ level: 'error', title: e.message }); }
  }
  pathLine.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(pathLine.value.trim()); } });
  go(cur);
  const v = await modal({
    title, body: h('div', { class: 'col' }, pathLine, list, h('div', { class: 'faint' }, 'Click a folder to open it. The folder shown in the box is the one that will be chosen.')),
    actions: [{ label: 'Cancel', value: null }, { label: 'Choose this folder', cls: 'primary', value: () => pathLine.value.trim() || cur, default: false }],
  });
  void resolveFn;
  return v || null;
}

// ---------- general settings ----------
async function general(page) {
  const c = store.config;
  const save = async (patch, msg = 'Saved') => {
    try { store.config = await rpc('config.update', { patch }); emit('config'); banner({ level: 'success', title: msg, timeout: 1500 }); } catch (e) { showError(e); }
  };
  const num = (key, label, hint, min = 5) => h('label', { class: 'field' }, h('span', null, label),
    h('input', { type: 'number', min, value: c[key], style: { width: '120px' }, onchange: (e) => { const v = Math.max(min, +e.target.value || min); save({ [key]: v }); } }), hint ? h('span', { class: 'faint' }, hint) : null);
  const check = (key, label, hint) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c[key], onchange: (e) => save({ [key]: e.target.checked }) }), label, hint ? h('span', { class: 'faint' }, ` — ${hint}`) : null);
  const select = (key, label, options) => h('label', { class: 'field' }, h('span', null, label),
    h('select', { style: { width: '220px' }, onchange: (e) => save({ [key]: e.target.value }) }, options.map(([v, l]) => h('option', { value: v, selected: c[key] === v }, l))));

  const rootsBox = h('div', { class: 'col' });
  function renderRoots() {
    mount(rootsBox,
      c.roots.length ? h('table', { class: 'grid panel' }, h('tr', null, h('th', null, 'Name'), h('th', null, 'Folder'), h('th', null, 'Repositories'), h('th', null, '')),
        store.config.roots.map((rt, i) => h('tr', null,
          h('td', null, h('input', { type: 'text', value: rt.name || '', onchange: (e) => { const roots = store.config.roots.map((x, k) => (k === i ? { ...x, name: e.target.value.trim() } : x)); save({ roots }); } })),
          h('td', { class: 'mono' }, rt.path),
          h('td', null, String(store.repos.filter((r) => r.root.toLowerCase() === rt.path.toLowerCase() || r.root.toLowerCase().startsWith(rt.path.toLowerCase())).length)),
          h('td', null, btn('Remove', async () => { if (await confirmDanger({ title: 'Remove folder?', message: `Stop showing repositories under ${rt.path}? Nothing on disk is changed.`, confirmLabel: 'Remove', danger: false })) { await save({ roots: store.config.roots.filter((_, k) => k !== i) }); renderRoots(); } }, { cls: 'small' })))))
        : h('div', { class: 'warn-box' }, 'No folders yet. Add the folders that contain your repositories.'),
      h('div', { class: 'row' }, btn('Find repositories automatically', () => navigate('#/settings/setup'), { iconName: 'search' }), btn('Add folder…', async () => {
        const p = await pickFolder('Add a folder that contains repositories');
        if (!p) return;
        if (store.config.roots.some((x) => x.path.toLowerCase() === p.toLowerCase())) { banner({ level: 'info', title: 'That folder is already added' }); return; }
        await save({ roots: [...store.config.roots, { path: p, name: p.split(/[\\/]/).filter(Boolean).pop() }] }, 'Folder added; scanning…');
        renderRoots();
      }, { iconName: 'plus' })));
  }
  renderRoots();

  const ignore = h('textarea', { rows: 4, style: { width: '100%' } }, c.ignore.join('\n'));
  const accountsBox = h('div', { class: 'col' }, h('div', { class: 'faint' }, 'Loading accounts…'));
  const tools = h('div', { class: 'col' });
  mount(tools,
    toolRow('Editor', 'editorCommand', 'editorArgs', 'Program and arguments. {path} is replaced by the file or folder. Example: code {path}'),
    toolRow('Terminal', 'terminalCommand', 'terminalArgs', 'Example: wt -d {path}   or   pwsh -NoExit -WorkingDirectory {path}'));
  function toolRow(label, cmdKey, argsKey, hint) {
    const cmd = h('input', { type: 'text', value: c[cmdKey], style: { width: '180px' } });
    const args = h('input', { type: 'text', value: c[argsKey].join(' '), style: { flex: 1 } });
    return h('div', { class: 'field' }, h('span', null, label), h('div', { class: 'row' }, cmd, args, btn('Save', () => save({ [cmdKey]: cmd.value.trim(), [argsKey]: args.value.trim() ? args.value.trim().split(/\s+/) : [] }), { cls: 'small' })), h('span', { class: 'faint' }, hint));
  }

  mount(page,
    section('Repository folders', 'Every git repository inside these folders is listed, including repositories nested inside other repositories.', rootsBox,
      h('label', { class: 'field' }, h('span', null, 'Folders to skip while scanning (one pattern per line, * allowed)'), ignore),
      h('div', { class: 'row' }, num('scanDepth', 'Scan depth', 'How many folder levels to look into', 1), h('span', { class: 'spacer' }), btn('Save skip list', () => save({ ignore: ignore.value.split('\n').map((x) => x.trim()).filter(Boolean) }), { cls: 'small' }))),
    section('Git', null,
      h('div', { class: 'row wrap', style: { gap: '18px', alignItems: 'flex-start' } },
        select('pullStrategy', 'Pull strategy', [['merge', 'Merge'], ['rebase', 'Rebase'], ['ff-only', 'Fast-forward only']]),
        select('updateFromDefault', 'Update branch from default by', [['merge', 'Merging'], ['rebase', 'Rebasing']]),
        num('refreshSeconds', 'Status refresh (seconds)', 'Also refreshes on window focus and after every action')),
      check('backgroundFetch', 'Fetch all repositories in the background', 'off by default; nothing else happens in the background'),
      num('backgroundFetchMinutes', 'Background fetch every (minutes)', null, 1),
      num('bulkConcurrency', 'Repositories processed in parallel by bulk operations', null, 1)),
    section('GitHub Actions and notifications', null,
      check('notifications', 'Windows notifications', 'when tracked runs finish, review requests arrive, or your pull request checks finish'),
      check('notifySound', 'Play a sound with notifications'),
      check('notifyReviewRequests', 'Watch my pull requests and review requests'),
      check('trackExternalRuns', 'Also track runs started by pushes made outside this app (e.g. from a terminal or by a teammate)'),
      h('div', { class: 'row wrap', style: { gap: '18px' } },
        num('actionsRefreshSeconds', 'Default-branch status refresh (seconds)', 'One request per GitHub account for all repositories', 30),
        num('boardRefreshSeconds', 'While the Actions board is open (seconds)', null, 10),
        num('trackedRefreshSeconds', 'Tracked runs (seconds)', null, 5))),
    section('GitHub accounts', 'Each repository owner is matched to a signed-in gh account automatically (the first that can see it). Change the choice here if needed.',
      check('autoDetectAccounts', 'Detect the right account automatically', 'tries each signed-in account; turn off to always use the active account unless set below'), accountsBox),
    section('Tools', null, tools),
    section('Appearance and app', null,
      select('theme', 'Theme', [['system', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']]),
      check('keepRunningWhenClosed', 'Keep running in the background after the window closes', 'so notifications still arrive; reopen from the Start menu, quit below'),
      num('port', 'Local port (takes effect after restart)', null, 1025),
      h('div', null, btn('Quit git-helper', async () => { if (await confirmDanger({ title: 'Quit?', message: 'Stops the background server. Open git-helper again from the Start menu.', confirmLabel: 'Quit', danger: false })) { await rpc('app.quit'); document.body.textContent = 'git-helper has stopped. You can close this window.'; } }, { cls: 'danger' }))));

  // accounts
  try {
    const accs = await rpc('gh.accounts');
    const owners = [...new Set(store.repos.filter((r) => r.slug && r.slug.github).map((r) => r.slug.owner))].sort();
    const map = { ...store.config.accountForOwner };
    mount(accountsBox,
      accs.length ? h('div', null, 'Signed in: ', accs.map((a, i) => [i ? ', ' : '', h('strong', null, a.login), a.active ? ' (active)' : '', a.state !== 'success' ? h('span', { class: 'badge bad' }, a.state) : null]))
        : h('div', { class: 'warn-box' }, 'No GitHub account is signed in yet.'),
      h('div', { class: 'row' },
        btn(accs.length ? 'Add another account' : 'Sign in to GitHub', () => import('../account.js').then((m) => m.signIn()), { cls: accs.length ? 'small' : 'small primary', iconName: 'plus' }),
        btn('Commit identity…', () => import('../account.js').then((m) => m.editIdentity()), { cls: 'small' }),
        h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Switch or sign out from the account menu at the top right.')),
      owners.length ? h('table', { class: 'grid panel' }, h('tr', null, h('th', null, 'Owner'), h('th', null, 'Account')),
        owners.map((o) => h('tr', null, h('td', null, o), h('td', null,
          h('select', { onchange: (e) => { if (e.target.value) map[o] = e.target.value; else delete map[o]; save({ accountForOwner: map }, `Account for ${o} saved`); } },
            h('option', { value: '' }, 'Automatic'), accs.map((a) => h('option', { value: a.login, selected: map[o] === a.login }, a.login))))))) : null);
  } catch (e) { mount(accountsBox, h('div', { class: 'errbox' }, e.message)); }
}

function section(title, desc, ...children) {
  return h('div', { class: 'panel', style: { marginBottom: '16px' } },
    h('div', { class: 'panel-head' }, h('h3', null, title)),
    h('div', { class: 'panel-body col', style: { gap: '12px' } }, desc ? h('div', { class: 'muted' }, desc) : null, children));
}

// ---------- diagnostics ----------
async function diagnostics(page) {
  mount(page, h('div', { class: 'skeleton' }, 'Collecting…'));
  let d;
  try { d = await rpc('app.diagnostics'); } catch (e) { mount(page, h('div', { class: 'errbox' }, e.message)); return; }
  const results = h('div');
  mount(page,
    section('Versions', null, h('div', { class: 'kv' },
      h('div', null, 'git'), h('div', { class: 'mono' }, d.git), h('div', null, 'GitHub CLI'), h('div', { class: 'mono' }, d.gh),
      h('div', null, 'Node.js'), h('div', { class: 'mono' }, d.node), h('div', null, 'System'), h('div', { class: 'mono' }, d.platform),
      h('div', null, 'Data folder'), h('div', { class: 'mono' }, d.dataDir, ' ', h('a', { onclick: () => navigator.clipboard.writeText(d.dataDir) }, 'copy')),
      h('div', null, 'Repositories'), h('div', null, String(d.repos)))),
    section('GitHub accounts', 'Tokens are never shown or stored by git-helper; gh keeps them in the Windows credential store.',
      d.accounts.length ? h('table', { class: 'grid' }, h('tr', null, h('th', null, 'Account'), h('th', null, 'Host'), h('th', null, 'Active'), h('th', null, 'State'), h('th', null, 'Scopes')),
        d.accounts.map((a) => h('tr', null, h('td', null, a.login), h('td', null, a.host), h('td', null, a.active ? 'yes' : ''), h('td', null, a.state), h('td', { class: 'mono' }, a.scopes || ''))))
        : h('div', { class: 'warn-box' }, 'Not signed in. Run "gh auth login".'),
      Object.keys(d.owners || {}).length ? h('div', { class: 'muted' }, 'Owner mapping: ', Object.entries(d.owners).map(([o, l]) => `${o} → ${l}`).join(', ')) : null),
    section('Connectivity check', 'Checks that each repository\'s remote is reachable with git and visible to the GitHub account used for its owner. Read-only.',
      h('div', null, btn('Run check', async (e) => {
        e.currentTarget.disabled = true;
        mount(results, h('div', { class: 'progress' }), h('div', { class: 'skeleton' }, 'Checking every repository; this can take a minute…'));
        try {
          const res = await rpc('app.connectivity');
          mount(results, h('table', { class: 'grid' }, h('tr', null, h('th', null, 'Repository'), h('th', null, 'Remote'), h('th', null, 'git'), h('th', null, 'GitHub')),
            res.map((x) => h('tr', null, h('td', null, x.label), h('td', { class: 'mono' }, x.remote || ''),
              h('td', { style: { color: x.git === 'ok' ? 'var(--ok)' : 'var(--bad)' } }, x.git), h('td', { style: { color: String(x.gh).startsWith('ok') ? 'var(--ok)' : x.gh === 'n/a' || x.gh === 'not a GitHub remote' ? '' : 'var(--bad)' } }, x.gh)))));
        } catch (err) { mount(results, h('div', { class: 'errbox' }, err.message)); }
      }, { cls: 'primary' })), results));
}

export { setup, cloneDialog } from '../onboarding.js';
