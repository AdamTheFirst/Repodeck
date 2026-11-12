// Settings and diagnostics.
import { h, mount, icon, btn, act, modal, banner, confirmDanger, showError, plural, copyText } from '../dom.js';
import { rpc } from '../api.js';
import { store, emit } from '../store.js';
import { navigate } from '../router.js';

const SECTIONS = [
  ['folders', 'Folders', 'folder'], ['git', 'Git', 'branch'], ['actions', 'Actions & notifications', 'bell'],
  ['account', 'Account', 'eye'], ['tools', 'Editor & terminal', 'terminal'], ['app', 'Appearance & app', 'gear'],
  ['diagnostics', 'Diagnostics', 'log'], ['about', 'About', 'star'],
];

export function render(main, parts) {
  const sub = parts[0] || 'folders';
  if (sub === 'setup') { import('../onboarding.js').then((m) => m.setup(main)); return null; }
  const active = SECTIONS.some(([k]) => k === sub) ? sub : 'folders';
  const content = h('div', { class: 'settings-content' });
  mount(main, h('div', { class: 'settings' },
    h('nav', { class: 'settings-nav' }, h('div', { class: 'settings-title' }, 'Settings'),
      SECTIONS.map(([k, label, ic]) => h('button', { class: `settings-link ${active === k ? 'active' : ''}`, onclick: () => navigate(`#/settings/${k}`) }, icon(ic, 'sm'), label))),
    h('div', { class: 'settings-scroll' }, content)));
  ({ folders, git, actions, account, tools, app, diagnostics, about })[active](content);
  return null;
}

// ---------- building blocks ----------
async function save(patch, msg = 'Saved') {
  try { store.config = await rpc('config.update', { patch }); emit('config'); banner({ level: 'success', title: msg, timeout: 1500 }); return true; } catch (e) { showError(e); return false; }
}
const head = (title, desc) => h('div', { class: 'set-head' }, h('h2', null, title), desc ? h('p', { class: 'muted' }, desc) : null);
const card = (...rows) => h('div', { class: 'panel set-card' }, rows);
const row = (title, desc, control) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('div', { class: 'set-name' }, title), desc ? h('div', { class: 'set-desc' }, desc) : null), h('div', { class: 'set-control' }, control));
const toggle = (key, title, desc) => row(title, desc, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: store.config[key], onchange: (e) => save({ [key]: e.target.checked }) }), h('span')));
const number = (key, title, desc, min = 5, unit = '') => row(title, desc, h('div', { class: 'row' },
  h('input', { type: 'number', min, value: store.config[key], style: { width: '90px' }, onchange: (e) => { const v = Math.max(min, +e.target.value || min); e.target.value = v; save({ [key]: v }); } }), unit ? h('span', { class: 'muted' }, unit) : null));
const choice = (key, title, desc, options) => row(title, desc, h('select', { style: { minWidth: '190px' }, onchange: (e) => save({ [key]: e.target.value }) }, options.map(([v, l]) => h('option', { value: v, selected: store.config[key] === v }, l))));

// ---------- folder picker (also used by setup and clone) ----------
export async function pickFolder(title = 'Choose a folder', start) {
  let cur = start || null;
  const list = h('div', { class: 'panel', style: { height: '46vh', overflow: 'auto' } });
  const pathLine = h('input', { type: 'text', style: { width: '100%' }, placeholder: 'Type or paste a path, then press Enter', value: cur || '', spellcheck: 'false' });
  async function go(dir) {
    try {
      const d = await rpc('fs.listDir', { dir });
      cur = d.dir;
      pathLine.value = cur || '';
      mount(list,
        d.dir ? h('div', { class: 'list-row', onclick: () => go(d.parent) }, icon('back', 'sm'), h('span', { class: 'muted' }, 'Up one level')) : null,
        d.entries.map((e) => h('div', { class: 'list-row', onclick: () => go(e.path) }, icon('folder', 'sm'), h('span', { class: 'grow ellipsis' }, e.name), e.git ? h('span', { class: 'badge accent' }, 'repository') : null)),
        !d.entries.length ? h('div', { class: 'empty' }, 'No subfolders.') : null);
    } catch (e) { banner({ level: 'error', title: e.message }); }
  }
  pathLine.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(pathLine.value.trim()); } });
  go(cur);
  const v = await modal({
    title, body: h('div', { class: 'col' }, pathLine, list),
    actions: [{ label: 'Cancel', value: null }, { label: 'Choose this folder', cls: 'primary', value: () => pathLine.value.trim() || cur }],
  });
  return v || null;
}

// ---------- sections ----------
function folders(el) {
  const c = store.config;
  const who = c.currentAccount;
  const list = h('div');
  const draw = () => mount(list, store.config.roots.length
    ? store.config.roots.map((rt, i) => h('div', { class: 'set-row' },
      icon('folder'),
      h('div', { class: 'set-label' },
        h('input', { type: 'text', class: 'ghost-input', value: rt.name || '', title: 'Display name', onchange: (e) => save({ roots: store.config.roots.map((x, k) => (k === i ? { ...x, name: e.target.value.trim() || x.name } : x)) }) }),
        h('div', { class: 'set-desc mono ellipsis', title: rt.path }, rt.path)),
      h('span', { class: 'badge nowrap' }, plural(store.repos.filter((r) => r.root.toLowerCase() === rt.path.toLowerCase()).length, 'repository')),
      btn('Remove', async () => {
        if (await confirmDanger({ title: 'Remove folder?', message: `Stop showing repositories under ${rt.path}. Nothing on disk is changed.`, confirmLabel: 'Remove', danger: false })) { await save({ roots: store.config.roots.filter((_, k) => k !== i) }, 'Folder removed'); draw(); }
      }, { cls: 'small' })))
    : h('div', { class: 'empty' }, h('h3', null, 'No folders yet'), h('div', null, 'Find repositories automatically, or add a folder.')));
  draw();
  const ignore = h('textarea', { rows: 5, style: { width: '100%' }, spellcheck: 'false' }, c.ignore.join('\n'));
  mount(el,
    head('Folders', who ? `Folders for ${who}. Every repository inside them is listed, including repositories nested in other repositories. Other accounts have their own folders.` : 'Every repository inside these folders is listed, including repositories nested in other repositories.'),
    h('div', { class: 'row', style: { marginBottom: '10px' } },
      btn('Find repositories automatically', () => navigate('#/settings/setup'), { cls: 'primary', iconName: 'search' }),
      btn('Add folder…', async () => {
        const p = await pickFolder('Add a folder that contains repositories');
        if (!p) return;
        if (store.config.roots.some((x) => x.path.toLowerCase() === p.toLowerCase())) { banner({ level: 'info', title: 'That folder is already added' }); return; }
        await save({ roots: [...store.config.roots, { path: p, name: p.split(/[\\/]/).filter(Boolean).pop() }] }, 'Folder added');
        draw();
      }, { iconName: 'plus' }),
      btn('Clone from GitHub', () => navigate('#/github'), { iconName: 'fetch' })),
    card(list),
    head('Scanning'),
    card(
      number('scanDepth', 'Scan depth', 'How many folder levels to look into', 1, 'levels'),
      h('div', { class: 'set-row', style: { alignItems: 'flex-start' } }, h('div', { class: 'set-label' }, h('div', { class: 'set-name' }, 'Folders to skip'), h('div', { class: 'set-desc' }, 'One name per line; * matches anything. Skipped while looking for repositories.')),
        h('div', { style: { width: '320px' }, class: 'col' }, ignore, h('div', { class: 'row' }, h('span', { class: 'spacer' }), btn('Save', () => save({ ignore: ignore.value.split('\n').map((x) => x.trim()).filter(Boolean) }), { cls: 'small' }))))));
}

function git(el) {
  mount(el, head('Git'),
    card(
      choice('pullStrategy', 'Pull', 'How Pull and Sync bring in remote commits', [['merge', 'Merge'], ['rebase', 'Rebase'], ['ff-only', 'Fast-forward only']]),
      choice('updateFromDefault', 'Update from default branch', 'How "behind main" is fixed for feature branches', [['merge', 'Merge the default branch in'], ['rebase', 'Rebase onto the default branch']]),
      number('refreshSeconds', 'Status refresh', 'Also refreshes when the window gets focus and after every action', 5, 'seconds')),
    head('Background', 'Nothing changes in your repositories in the background unless you turn this on.'),
    card(
      toggle('backgroundFetch', 'Fetch all repositories periodically', 'Keeps ahead/behind counts current. Never pulls, merges or prunes.'),
      number('backgroundFetchMinutes', 'Fetch every', null, 1, 'minutes'),
      number('bulkConcurrency', 'Parallel repositories in bulk operations', null, 1)));
}

function actions(el) {
  mount(el, head('Actions & notifications'),
    card(
      toggle('notifications', 'Windows notifications', 'When a tracked run finishes, a review is requested, or your pull request checks finish'),
      toggle('notifySound', 'Play a sound'),
      toggle('notifyReviewRequests', 'Watch my pull requests and review requests'),
      toggle('trackExternalRuns', 'Track pushes made outside git-helper', 'New commits on a default branch (from a terminal or a teammate) are followed on the Actions board too')),
    head('Refresh intervals'),
    card(
      number('actionsRefreshSeconds', 'Default-branch status', 'One GitHub request covers every repository', 30, 'seconds'),
      number('boardRefreshSeconds', 'While the Actions board is open', null, 10, 'seconds'),
      number('trackedRefreshSeconds', 'Tracked runs', null, 5, 'seconds')));
}

async function account(el) {
  mount(el, head('Account', 'Each GitHub account has its own folders, repositories, Actions board and pull requests. Switch from the account button at the top right.'), h('div', { class: 'skeleton' }, 'Loading…'));
  const A = await import('../account.js');
  const info = await rpc('account.list').catch(() => ({ installed: false, accounts: [] }));
  const id = await rpc('account.identity').catch(() => ({ name: '', email: '' }));
  mount(el, head('Account', 'Each GitHub account has its own folders, repositories, Actions board and pull requests.'),
    card(
      info.accounts.length ? info.accounts.map((a) => h('div', { class: 'set-row' },
        h('img', { class: 'avatar', src: a.avatar, width: 32, height: 32, alt: '', referrerpolicy: 'no-referrer' }),
        h('div', { class: 'set-label' }, h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'set-name' }, a.login), a.current ? h('span', { class: 'badge accent' }, 'open') : null, a.active ? h('span', { class: 'badge' }, 'default in terminal') : null, a.state !== 'success' ? h('span', { class: 'badge bad' }, 'needs sign-in') : null),
          h('div', { class: 'set-desc' }, a.folders ? plural(a.folders, 'folder') : 'No folders yet')),
        !a.current ? btn('Switch', () => A.useAccount(a.login), { cls: 'small primary' }) : null))
        : h('div', { class: 'empty' }, info.installed ? 'No GitHub account is signed in.' : 'The GitHub CLI is not installed. Run Setup again and choose Repair.')),
    h('div', { class: 'row', style: { margin: '10px 0 0' } }, info.installed ? btn(info.accounts.length ? 'Add another account' : 'Sign in to GitHub', () => A.signIn(), { cls: info.accounts.length ? '' : 'primary', iconName: 'plus' }) : null),
    head('Commit identity', 'The name and email recorded in every commit you make, in git-helper and in the terminal.'),
    card(row(id.name || 'No name set', id.email || 'No email set', btn('Change…', () => A.editIdentity().then(() => account(el)), { cls: 'small' }))));
}

function tools(el) {
  const c = store.config;
  const tool = (label, desc, cmdKey, argsKey, example) => {
    const cmd = h('input', { type: 'text', value: c[cmdKey], style: { width: '150px' }, spellcheck: 'false', placeholder: 'program' });
    const args = h('input', { type: 'text', value: c[argsKey].join(' '), style: { width: '230px' }, spellcheck: 'false', placeholder: 'arguments' });
    return row(label, `${desc} {path} is replaced by the file or folder. Example: ${example}`, h('div', { class: 'row' }, cmd, args,
      btn('Save', () => save({ [cmdKey]: cmd.value.trim(), [argsKey]: args.value.trim() ? args.value.trim().split(/\s+/) : [] }), { cls: 'small' })));
  };
  mount(el, head('Editor & terminal', 'Used by "Open in editor" and "Open terminal here".'),
    card(tool('Editor', 'Program used to open files and folders.', 'editorCommand', 'editorArgs', 'code {path}'),
      tool('Terminal', 'Program used to open a terminal in a repository.', 'terminalCommand', 'terminalArgs', 'wt -d {path}')));
}

function app(el) {
  mount(el, head('Appearance & app'),
    card(
      choice('theme', 'Theme', null, [['system', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']]),
      toggle('keepRunningWhenClosed', 'Keep running after the window closes', 'So notifications still arrive. Reopen from the Start menu.'),
      number('port', 'Local port', 'Takes effect after a restart', 1025),
      row('Quit git-helper', 'Stops the background process', btn('Quit', async () => {
        if (await confirmDanger({ title: 'Quit git-helper?', message: 'Stops the background process. Start it again from the Start menu.', confirmLabel: 'Quit', danger: false })) { await rpc('app.quit'); mount(document.body, h('div', { class: 'empty' }, 'git-helper has stopped. You can close this window.')); }
      }, { cls: 'small danger' }))));
}

async function diagnostics(el) {
  mount(el, head('Diagnostics'), h('div', { class: 'skeleton' }, 'Collecting…'));
  let d;
  try { d = await rpc('app.diagnostics'); } catch (e) { mount(el, head('Diagnostics'), h('div', { class: 'errbox' }, e.message)); return; }
  const results = h('div');
  const ok = (v) => !/not available/.test(v);
  const tool = (name, v) => row(name, null, h('span', { class: `badge ${ok(v) ? 'ok' : 'bad'}` }, v));
  mount(el, head('Diagnostics', 'What git-helper found on this computer.'),
    card(tool('git', d.git), tool('GitHub CLI', d.gh), tool('Node.js', d.node), row('Windows', null, h('span', { class: 'muted' }, d.platform)),
      row('Data folder', 'Settings, logs and safety copies of discarded changes', h('div', { class: 'row' }, h('span', { class: 'mono muted ellipsis', style: { maxWidth: '300px' } }, d.dataDir), btn('Copy', () => copyText(d.dataDir), { cls: 'small' })))),
    head('Connectivity', `Checks that each repository's remote is reachable with git and visible to ${d.currentAccount || 'the signed-in account'}. Read-only.`),
    h('div', { class: 'row', style: { marginBottom: '10px' } }, btn('Run check', async (e) => {
      const b = e.currentTarget; b.disabled = true;
      mount(results, h('div', { class: 'progress' }), h('div', { class: 'skeleton' }, 'Checking every repository; this can take a minute…'));
      try {
        const res = await rpc('app.connectivity');
        const bad = res.filter((x) => x.git !== 'ok' || (!String(x.gh).startsWith('ok') && x.gh !== 'n/a' && x.gh !== 'not a GitHub remote'));
        mount(results, h('div', { class: bad.length ? 'warn-box' : 'info-box', style: { marginBottom: '8px' } }, bad.length ? `${plural(bad.length, 'repository')} need attention.` : `All ${res.length} repositories are reachable.`),
          h('table', { class: 'grid panel' }, h('tr', null, h('th', null, 'Repository'), h('th', null, 'Remote'), h('th', null, 'git'), h('th', null, 'GitHub')),
            res.map((x) => h('tr', null, h('td', null, x.label), h('td', { class: 'mono' }, x.remote || ''),
              h('td', { style: { color: x.git === 'ok' ? 'var(--ok)' : 'var(--bad)' } }, x.git), h('td', { style: { color: String(x.gh).startsWith('ok') ? 'var(--ok)' : x.gh === 'n/a' || x.gh === 'not a GitHub remote' ? '' : 'var(--bad)' } }, x.gh)))));
      } catch (err) { mount(results, h('div', { class: 'errbox' }, err.message)); }
      b.disabled = false;
    }, { cls: 'primary' })), results);
}

async function about(el) {
  const a = await rpc('app.about').catch(() => ({ version: '?' }));
  mount(el, head('About'),
    card(
      h('div', { class: 'set-row' }, h('img', { src: '/icon.svg', width: 44, height: 44, alt: '' }), h('div', { class: 'set-label' }, h('div', { class: 'set-name', style: { fontSize: '16px' } }, 'git-helper'), h('div', { class: 'set-desc' }, `Version ${a.version}`))),
      row('Installed in', null, h('span', { class: 'mono muted' }, a.installDir || '')),
      row('Logs', 'Every git and GitHub command is also listed under Activity', h('div', { class: 'row' }, btn('Open activity', () => navigate('#/activity'), { cls: 'small' }), btn('Copy log folder', () => copyText(a.logDir), { cls: 'small' }))),
      row('Keyboard shortcuts', null, btn('Show', () => import('../help.js').then((m) => m.showShortcuts()), { cls: 'small' })),
      row('Licence', 'MIT. No telemetry; nothing is sent anywhere except by git and the GitHub CLI.', null)));
}

export { setup, cloneDialog } from '../onboarding.js';
