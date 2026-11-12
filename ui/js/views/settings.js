// Settings: accounts and their folders, SSH connections, git configuration, app behaviour, guides, diagnostics.
import { h, mount, icon, btn, iconBtn, act, modal, form, banner, confirmDanger, showError, plural, copyText, menuBelow } from '../dom.js';
import { rpc } from '../api.js';
import { store, emit } from '../store.js';
import { navigate } from '../router.js';

const GROUPS = [
  ['Workspace', [['accounts', 'Accounts & folders', 'user'], ['ssh', 'SSH connections', 'key'], ['gitconfig', 'Git configuration', 'commit']]],
  ['Repodeck', [['behaviour', 'Behaviour', 'sliders'], ['actions', 'Actions & notifications', 'bell'], ['tools', 'Editor & terminal', 'terminal'], ['app', 'Appearance & app', 'gear']]],
  ['Help', [['guides', 'Guides', 'book'], ['diagnostics', 'Diagnostics', 'log'], ['about', 'About', 'star']]],
];
const ALIASES = { folders: 'accounts', account: 'accounts', git: 'behaviour' }; // links from older versions

export function render(main, parts) {
  const sub = ALIASES[parts[0]] || parts[0] || 'accounts';
  if (sub === 'setup') { let dispose = null; let gone = false; import('../onboarding.js').then((m) => { if (!gone) dispose = m.setup(main); }); return () => { gone = true; if (dispose) dispose(); }; }
  const views = { accounts, ssh, gitconfig, behaviour, actions, tools, app, guides, diagnostics, about };
  const active = views[sub] ? sub : 'accounts';
  const content = h('div', { class: 'settings-content' });
  mount(main, h('div', { class: 'settings' },
    h('nav', { class: 'settings-nav' },
      GROUPS.map(([title, items]) => [h('div', { class: 'settings-title' }, title),
        items.map(([k, label, ic]) => h('button', { class: `settings-link ${active === k ? 'active' : ''}`, onclick: () => navigate(`#/settings/${k}`) }, icon(ic, 'sm'), label))])),
    h('div', { class: 'settings-scroll' }, content)));
  Promise.resolve(views[active](content, parts[1])).catch((e) => mount(content, head('Settings'), h('div', { class: 'errbox' }, e.message)));
  return null;
}

// ---------- building blocks ----------
async function save(patch, msg = 'Saved') {
  try { store.config = await rpc('config.update', { patch }); emit('config'); banner({ level: 'success', title: msg, timeout: 1500 }); return true; } catch (e) { showError(e); return false; }
}
const head = (title, desc, ...tools) => h('div', { class: 'set-head' }, h('div', { class: 'grow' }, h('h2', null, title), desc ? h('p', { class: 'muted' }, desc) : null), tools.length ? h('div', { class: 'row set-tools' }, tools) : null);
const sub = (title, desc, ...tools) => h('div', { class: 'set-sub' }, h('div', { class: 'grow' }, h('h3', null, title), desc ? h('p', { class: 'muted' }, desc) : null), tools.length ? h('div', { class: 'row set-tools' }, tools) : null);
const card = (...rows) => h('div', { class: 'panel set-card' }, rows);
const row = (title, desc, control, lead) => h('div', { class: 'set-row' }, lead || null, h('div', { class: 'set-label' }, h('div', { class: 'set-name' }, title), desc ? h('div', { class: 'set-desc' }, desc) : null), control ? h('div', { class: 'set-control' }, control) : null);
const sw = (checked, onchange) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span'));
const toggle = (key, title, desc) => row(title, desc, sw(store.config[key], (v) => save({ [key]: v })));
const number = (key, title, desc, min = 5, unit = '') => row(title, desc, h('div', { class: 'row' },
  h('input', { type: 'number', min, value: store.config[key], class: 'num', onchange: (e) => { const v = Math.max(min, +e.target.value || min); e.target.value = v; save({ [key]: v }); } }), unit ? h('span', { class: 'muted unit' }, unit) : null));
const choice = (key, title, desc, options) => row(title, desc, h('select', { class: 'sel', onchange: (e) => save({ [key]: e.target.value }) }, options.map(([v, l]) => h('option', { value: v, selected: store.config[key] === v }, l))));
const seg = (value, options, onpick) => {
  const el = h('div', { class: 'pill-tabs' });
  const draw = (cur) => mount(el, options.map(([v, l]) => h('button', { type: 'button', class: cur === v ? 'active' : '', onclick: () => { draw(v); onpick(v); } }, l)));
  draw(value);
  return el;
};
const loading = (text = 'Loading…') => h('div', { class: 'skeleton' }, text);
const code = (text) => h('div', { class: 'cmd' }, h('code', null, text), iconBtn('copy', 'Copy', () => copyText(text)));
const note = (cls, ...c) => h('div', { class: `${cls} set-note` }, c);
const link = (label, to) => h('a', { onclick: (e) => { e.preventDefault(); if (/^https:/.test(to)) rpc('open.url', { url: to }); else navigate(to); } }, label);

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

// ======================================================================
// Accounts & folders
// ======================================================================
async function accounts(el) {
  const title = () => head('Accounts & folders', 'Each GitHub account has its own folders, repositories, Actions board and pull requests. Nothing from one account shows under another.');
  mount(el, title(), loading());
  const A = await import('../account.js');
  const [info, conns] = await Promise.all([
    rpc('account.list').catch(() => ({ installed: false, accounts: [] })),
    rpc('ssh.list').catch(() => ({ connections: [] })),
  ]);
  const again = () => accounts(el);

  const folderRows = (a) => {
    if (!a.current) {
      return a.folderList.length
        ? a.folderList.map((f) => h('div', { class: 'set-row sub' }, icon('folder', 'sm'), h('div', { class: 'set-label' }, h('div', { class: 'set-name' }, f.name || f.path), h('div', { class: 'set-desc mono ellipsis', title: f.path }, f.path))))
        : h('div', { class: 'set-row sub muted' }, 'No folders yet. Switch to this account to choose them.');
    }
    const roots = store.config.roots;
    return [
      roots.length ? roots.map((rt, i) => h('div', { class: 'set-row sub' }, icon('folder', 'sm'),
        h('div', { class: 'set-label' },
          h('input', { type: 'text', class: 'ghost-input', value: rt.name || '', title: 'Display name (click to rename)', onchange: (e) => save({ roots: store.config.roots.map((x, k) => (k === i ? { ...x, name: e.target.value.trim() || x.name } : x)) }, 'Renamed') }),
          h('div', { class: 'set-desc mono ellipsis', title: rt.path }, rt.path)),
        h('span', { class: 'badge nowrap' }, plural(store.repos.filter((r) => r.root.toLowerCase() === rt.path.toLowerCase()).length, 'repository')),
        iconBtn('x', 'Remove this folder from the list', async () => {
          if (await confirmDanger({ title: 'Remove folder?', message: `Stop showing repositories under ${rt.path}. Nothing on disk is changed.`, confirmLabel: 'Remove', danger: false })) { await save({ roots: store.config.roots.filter((_, k) => k !== i) }, 'Folder removed'); again(); }
        })))
        : h('div', { class: 'set-row sub muted' }, 'No folders yet. Add the folder that holds this account’s repositories.'),
      h('div', { class: 'set-row sub set-actions' },
        btn('Add folder…', async () => {
          const p = await pickFolder('Add a folder that contains repositories');
          if (!p) return;
          if (store.config.roots.some((x) => x.path.toLowerCase() === p.toLowerCase())) { banner({ level: 'info', title: 'That folder is already added' }); return; }
          await save({ roots: [...store.config.roots, { path: p, name: p.split(/[\\/]/).filter(Boolean).pop() }] }, 'Folder added');
          again();
        }, { cls: 'small', iconName: 'plus' }),
        btn('Find repositories on this computer', () => navigate('#/settings/setup'), { cls: 'small', iconName: 'search' }),
        btn('Clone from GitHub', () => navigate('#/github'), { cls: 'small', iconName: 'fetch' })),
    ];
  };

  const accountCard = (a) => h('div', { class: `panel set-card account-card ${a.current ? 'current' : ''}` },
    h('div', { class: 'set-row account-head' },
      h('img', { class: 'avatar', src: a.avatar, width: 36, height: 36, alt: '', referrerpolicy: 'no-referrer' }),
      h('div', { class: 'set-label' },
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, h('span', { class: 'set-name big' }, a.login),
          a.current ? h('span', { class: 'badge accent' }, 'this window') : null,
          a.elsewhere ? h('span', { class: 'badge' }, 'open in another window') : null,
          a.active ? h('span', { class: 'badge', title: 'The account the gh command uses in a terminal' }, 'terminal default') : null,
          a.state !== 'success' ? h('span', { class: 'badge bad' }, 'needs sign-in') : null),
        h('div', { class: 'set-desc' }, a.folders ? plural(a.folders, 'folder') : 'No folders')),
      h('div', { class: 'set-control' },
        a.elsewhere ? btn('Go to window', () => act(() => rpc('account.openWindow', { login: a.login })), { cls: 'small primary' }) : null,
        !a.current && !a.elsewhere ? btn('Switch here', () => A.useAccount(a.login).then(again), { cls: 'small primary', title: 'Show this account in this window' }) : null,
        !a.current && !a.elsewhere ? btn('New window', () => act(() => rpc('account.openWindow', { login: a.login }), { ok: `Opening ${a.login} in a new window` }), { cls: 'small' }) : null,
        iconBtn('more', 'More', (e) => menuBelow(e.currentTarget, [
          !a.active ? { label: 'Make default in terminal', action: () => act(() => rpc('account.makeDefault', { login: a.login }), { ok: `gh now uses ${a.login} in terminals` }).then(again) } : null,
          { label: 'Open profile on GitHub', action: () => rpc('open.url', { url: `https://github.com/${a.login}` }) },
          { label: 'Sign out…', danger: true, action: () => A.signOut(a.login).then(again) },
        ].filter(Boolean))))),
    folderRows(a),
    a.current ? cloneRows(a.login, conns.connections.filter((c) => c.github)) : null);

  mount(el, title(),
    info.accounts.length ? info.accounts.map(accountCard)
      : card(h('div', { class: 'empty' }, h('h3', null, info.installed ? 'No GitHub account is signed in' : 'The GitHub CLI is not installed'),
        h('div', null, info.installed ? 'Sign in to see pull requests, Actions and your repositories on GitHub. Local repositories work without it.' : 'Run Repodeck Setup again and choose Repair.'))),
    info.installed ? h('div', { class: 'row set-below' }, btn(info.accounts.length ? 'Add another account' : 'Sign in to GitHub', () => A.signIn().then(again), { cls: info.accounts.length ? '' : 'primary', iconName: 'plus' })) : null,
    sub('Scanning', 'How repositories are found inside the folders.'),
    scanCard());
}

function cloneRows(login, conns) {
  const cur = { protocol: 'https', host: '', ...((store.config.accountSsh || {})[login] || {}) };
  const write = () => save({ accountSsh: { ...(store.config.accountSsh || {}), [login]: { protocol: cur.protocol, host: cur.host || '' } } }, 'Connection saved');
  const names = [...new Set(['github.com', ...conns.map((c) => c.alias), cur.host].filter(Boolean))];
  const hostSel = h('select', { class: 'sel', disabled: cur.protocol !== 'ssh', onchange: (e) => { cur.host = e.target.value === 'github.com' ? '' : e.target.value; write(); } },
    names.map((n) => h('option', { value: n, selected: (cur.host || 'github.com') === n }, n === 'github.com' ? 'github.com (default key)' : n)));
  return [
    h('div', { class: 'set-row sub set-divider' }, h('div', { class: 'set-label' }, h('div', { class: 'set-name' }, 'Connect to GitHub with'), h('div', { class: 'set-desc' }, 'HTTPS uses the GitHub sign-in. SSH uses a key, for new clones and for fetch, pull and push in every repository, including ones cloned with an https:// address.')),
      h('div', { class: 'set-control' }, seg(cur.protocol === 'ssh' ? 'ssh' : 'https', [['https', 'HTTPS'], ['ssh', 'SSH']], (v) => { cur.protocol = v; hostSel.disabled = v !== 'ssh'; write(); }))),
    h('div', { class: 'set-row sub' }, h('div', { class: 'set-label' }, h('div', { class: 'set-name' }, 'SSH connection'), h('div', { class: 'set-desc' }, 'The connection that holds this account’s key: git@<connection>:owner/repo.git. ', link('Manage SSH connections', '#/settings/ssh'))),
      h('div', { class: 'set-control' }, hostSel)),
  ];
}

function scanCard() {
  const ignore = h('textarea', { rows: 5, style: { width: '100%' }, spellcheck: 'false' }, store.config.ignore.join('\n'));
  const saveBtn = btn('Save', () => save({ ignore: ignore.value.split('\n').map((x) => x.trim()).filter(Boolean) }).then(() => { saveBtn.disabled = true; }), { cls: 'small primary', disabled: true });
  ignore.addEventListener('input', () => { saveBtn.disabled = false; });
  return card(
    number('scanDepth', 'Scan depth', 'How many folder levels to look into, including repositories nested in other repositories', 1, 'levels'),
    h('div', { class: 'set-row top' }, h('div', { class: 'set-label' }, h('div', { class: 'set-name' }, 'Folders to skip'), h('div', { class: 'set-desc' }, 'One name per line; * matches anything.')),
      h('div', { class: 'col', style: { width: '320px' } }, ignore, h('div', { class: 'row' }, h('span', { class: 'spacer' }), saveBtn))),
    row('Scan again now', 'Looks for new or removed repositories in every folder', btn('Rescan', () => act(() => rpc('repos.scan'), { ok: 'Scan finished' }), { cls: 'small', iconName: 'refresh' })));
}

// ======================================================================
// SSH connections
// ======================================================================
const shortFp = (fp) => (fp ? fp.replace(/^SHA256:/, '').slice(0, 12) + '…' : '');
const keyName = (file) => (file || '').split(/[\\/]/).pop();

async function copyPublicKey(file) {
  try { const r = await rpc('ssh.publicKey', { file }); copyText(r.key); return r.key; } catch (e) { showError(e, 'Could not read the public key'); return null; }
}

/** Copy the public key and open GitHub's "new SSH key" page. Nothing is uploaded by Repodeck. */
async function addKeyToGitHub(file) {
  const k = await copyPublicKey(file);
  if (!k) return;
  banner({ level: 'info', title: 'Public key copied', body: 'Paste it into the Key field on the GitHub page that just opened. Make sure the browser is signed in to the right account.', timeout: 9000 });
  rpc('open.url', { url: 'https://github.com/settings/ssh/new' });
}

async function ssh(el, focus) {
  const title = (...tools) => head('SSH connections', 'A connection is a name that tells git which key to use. With one connection per GitHub account, each account pushes with its own key.', ...tools);
  mount(el, title(), loading());
  const d = await rpc('ssh.list');
  const who = store.config.currentAccount;
  const mine = (store.config.accountSsh || {})[who] || {};
  const again = () => ssh(el);
  const results = new Map();

  const useForAccount = async (alias) => {
    if (await save({ accountSsh: { ...(store.config.accountSsh || {}), [who]: { protocol: 'ssh', host: alias } } }, `${who} now connects with ${alias}`)) again();
  };

  const runTest = async (c, box, b) => {
    b.disabled = true;
    mount(box, h('div', { class: 'set-test muted' }, icon('refresh', 'sm spin'), `Connecting to ${c.hostName}…`));
    let r;
    try { r = await rpc('ssh.test', { alias: c.alias }); } catch (e) { r = { ok: false, output: e.message }; }
    b.disabled = false;
    results.set(c.alias, r);
    mount(box, r.ok
      ? h('div', { class: 'set-test ok' }, icon('check', 'sm'), h('div', null, 'Works. GitHub recognises this key as ', h('strong', null, r.login), who && r.login.toLowerCase() !== who.toLowerCase() && c.accounts.includes(who) ? h('span', { class: 'warn-text' }, ` — but it is set for ${who}’s clones.`) : '.'))
      : h('div', { class: 'set-test bad' }, icon('warn', 'sm'), h('div', { class: 'grow' }, h('div', null, r.hint || 'The connection did not work.'), r.output ? h('pre', { class: 'set-out' }, r.output) : null,
        c.key && c.key.hasPublic && /does not know this key/.test(r.hint || '') ? h('div', { class: 'row', style: { marginTop: '6px' } }, btn('Copy key and open GitHub', () => addKeyToGitHub(c.identityFile), { cls: 'small primary', iconName: 'external' })) : null)));
  };

  const connRow = (c) => {
    const box = h('div');
    const testBtn = btn('Test', () => runTest(c, box, testBtn), { cls: 'small', title: `Try to sign in to ${c.hostName} with this connection` });
    const usage = [c.repos ? plural(c.repos, 'repository') + ' here' : null, c.accounts.length ? `used by ${c.accounts.join(', ')}` : null].filter(Boolean).join(' · ');
    const problems = [!c.identityFile ? 'no key set, ssh tries your default keys' : null, c.key && !c.key.exists ? 'key file is missing' : null].filter(Boolean);
    return h('div', { class: 'set-block', id: `conn-${c.alias}` },
      h('div', { class: 'set-row' }, h('span', { class: 'set-ico' }, icon('key')),
        h('div', { class: 'set-label' },
          h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, h('span', { class: 'set-name mono' }, c.alias), c.github ? h('span', { class: 'badge accent' }, 'GitHub') : h('span', { class: 'badge' }, c.hostName),
            c.accounts.includes(who) ? h('span', { class: 'badge ok' }, `used by ${who}`) : null, problems.map((p) => h('span', { class: 'badge warn' }, p))),
          h('div', { class: 'set-desc' }, c.identityFile ? ['Key ', h('span', { class: 'mono' }, keyName(c.identityFile)), c.key && c.key.fingerprint ? h('span', { class: 'faint', title: c.key.fingerprint }, ` · ${shortFp(c.key.fingerprint)}`) : null] : `Host ${c.hostName}`, usage ? ` · ${usage}` : '')),
        h('div', { class: 'set-control' }, testBtn,
          c.key && c.key.hasPublic ? btn('Copy public key', () => copyPublicKey(c.identityFile), { cls: 'small', iconName: 'copy' }) : null,
          iconBtn('more', 'More', (e) => menuBelow(e.currentTarget, [
            c.github && who && !c.accounts.includes(who) ? { label: `Use for ${who}`, action: () => useForAccount(c.alias) } : null,
            c.github && c.key && c.key.hasPublic ? { label: 'Add this key to GitHub…', action: () => addKeyToGitHub(c.identityFile) } : null,
            { label: 'Copy clone address pattern', action: () => copyText(`git@${c.alias}:OWNER/REPO.git`) },
            { label: 'Remove connection…', danger: true, action: () => removeConn(c) },
          ].filter(Boolean))))),
      box);
  };

  const removeConn = async (c) => {
    const ok = await confirmDanger({
      title: `Remove connection ${c.alias}?`,
      message: `Removes the “Host ${c.alias}” entry from your SSH config file.`,
      items: [c.repos ? `${plural(c.repos, 'repository')} in this workspace use git@${c.alias}:… and will no longer be able to fetch or push until their remote address is changed.` : null,
        c.accounts.length ? `${c.accounts.join(', ')} connects to GitHub with it.` : null].filter(Boolean),
      recover: 'A copy of the config file is saved in Repodeck’s data folder first. The key files are not deleted.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    const r = await act(() => rpc('ssh.removeHost', { alias: c.alias }), { ok: `Removed ${c.alias}` });
    if (r) again();
  };

  const usedBy = (k) => d.connections.filter((c) => keyName(c.identityFile) === keyName(k.file)).map((c) => c.alias);
  const keyRow = (k) => {
    const u = usedBy(k);
    return h('div', { class: 'set-row' }, h('span', { class: 'set-ico' }, icon('log')),
      h('div', { class: 'set-label' },
        h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, h('span', { class: 'set-name mono' }, keyName(k.file)), k.type ? h('span', { class: 'badge' }, k.type) : null, !k.exists ? h('span', { class: 'badge warn' }, 'private key missing') : null),
        h('div', { class: 'set-desc' }, k.comment ? `${k.comment} · ` : '', k.fingerprint ? h('span', { class: 'mono faint', title: k.fingerprint }, shortFp(k.fingerprint)) : null, u.length ? ` · used by ${u.join(', ')}` : ' · not used by any connection')),
      h('div', { class: 'set-control' },
        btn('Copy public key', () => copyPublicKey(k.file), { cls: 'small', iconName: 'copy' }),
        k.exists && !u.length ? btn('Create connection…', () => newConnection(d, who, again, k.file), { cls: 'small' }) : null));
  };

  mount(el,
    title(btn('New connection…', () => newConnection(d, who, again), { cls: 'primary', iconName: 'plus' }), iconBtn('folder', 'Show the SSH config file in Explorer', () => rpc('ssh.openFolder')), iconBtn('refresh', 'Reload', again)),
    !d.ssh ? note('warn-box', 'OpenSSH was not found on this computer. Install it from Windows Settings → System → Optional features → OpenSSH Client.') : null,
    who && mine.protocol !== 'ssh' ? note('info-box', `${who} connects to GitHub with HTTPS, so no SSH connection is needed. `, link('Change in Accounts & folders', '#/settings/accounts')) : null,
    card(d.connections.length ? d.connections.map(connRow)
      : h('div', { class: 'empty' }, h('h3', null, 'No connections yet'), h('div', null, 'Create one to give a GitHub account its own key. Without connections, SSH uses your default key for github.com.'),
        h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } }, btn('New connection…', () => newConnection(d, who, again), { cls: 'primary', iconName: 'plus' })))),
    sub('Keys', 'Key pairs in your .ssh folder. Only the public half is ever read or copied; private keys stay where they are.'),
    card(d.keys.length ? d.keys.map(keyRow) : h('div', { class: 'empty' }, 'No keys yet. Creating a connection can make one for you.')),
    h('div', { class: 'set-foot faint' }, h('span', { class: 'mono' }, d.configFile), d.ssh ? ` · ${d.ssh}` : '', ' · ', link('How SSH connections work', '#/settings/guides/two-accounts')));
  if (focus) { const t = document.getElementById(`conn-${focus}`); if (t) t.scrollIntoView({ block: 'center' }); }
}

/** Create a connection, optionally with a new key, then walk through adding the key to GitHub and testing. */
async function newConnection(d, who, done, presetKey) {
  const NEW = '__new__';
  const suggested = (() => { const base = who ? `github-${who.toLowerCase()}` : 'github-work'; return d.connections.some((c) => c.alias === base) ? '' : base; })();
  const id = await rpc('account.identity').catch(() => ({ email: '' }));
  const v = await form({
    title: 'New SSH connection',
    intro: h('div', { class: 'muted' }, 'Adds a “Host” entry to your SSH config. Repositories cloned through it use the key you choose here.'),
    fields: [
      { name: 'alias', label: 'Connection name', value: suggested, required: true, placeholder: 'github-work', hint: 'Used in clone addresses: git@<name>:owner/repo.git',
        validate: (x) => (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(x.trim()) ? 'Use letters, digits, dots, dashes and underscores only.' : d.connections.some((c) => c.alias === x.trim()) ? 'A connection with that name already exists.' : null) },
      { name: 'hostName', label: 'Server', value: 'github.com', required: true, hint: 'Keep github.com unless you use GitHub Enterprise or another host.' },
      { name: 'key', label: 'Key', type: 'select', value: presetKey || NEW, options: [{ value: NEW, label: 'Create a new key for this connection' }, ...d.keys.filter((k) => k.exists).map((k) => ({ value: k.file, label: `${keyName(k.file)}${k.comment ? ` (${k.comment})` : ''}` }))] },
      { name: 'keyName', label: 'Name for the new key', value: '', placeholder: 'leave empty to use id_ed25519_<connection name>', hint: 'Only used when creating a new key. Keys are created without a passphrase so git can use them unattended.',
        validate: (x, all) => (all.key === NEW && x.trim() && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(x.trim()) ? 'Use letters, digits, dots, dashes and underscores for the key name.' : null) },
    ],
    submit: 'Create connection',
  });
  if (!v) return;
  const alias = v.alias.trim();
  let file = v.key;
  let created = false;
  try {
    if (v.key === NEW) {
      const k = await rpc('ssh.generateKey', { name: v.keyName.trim() || `id_ed25519_${alias.replace(/[^A-Za-z0-9._-]/g, '_')}`, comment: id.email || who || alias });
      file = k.file; created = true;
    }
    await rpc('ssh.addHost', { alias, hostName: v.hostName.trim(), identityFile: file });
  } catch (e) { showError(e, 'Could not create the connection'); done(); return; }
  await finishConnection({ alias, file, created, who, github: /(^|\.)github\.com$/i.test(v.hostName.trim()) });
  done();
}

async function finishConnection({ alias, file, created, who, github }) {
  const pub = await rpc('ssh.publicKey', { file }).then((r) => r.key).catch(() => '');
  const result = h('div');
  const step = (n, title, ...body) => h('div', { class: 'set-step' }, h('div', { class: 'step-no' }, String(n)), h('div', { class: 'grow' }, h('div', { class: 'set-name' }, title), body));
  const testBtn = btn('Test connection', async () => {
    testBtn.disabled = true;
    mount(result, h('div', { class: 'set-test muted' }, icon('refresh', 'sm spin'), 'Connecting…'));
    const r = await rpc('ssh.test', { alias }).catch((e) => ({ ok: false, output: e.message }));
    testBtn.disabled = false;
    mount(result, r.ok ? h('div', { class: 'set-test ok' }, icon('check', 'sm'), h('div', null, 'Works. GitHub recognises this key as ', h('strong', null, r.login), '.'))
      : h('div', { class: 'set-test bad' }, icon('warn', 'sm'), h('div', { class: 'grow' }, r.hint || 'The connection did not work.', r.output ? h('pre', { class: 'set-out' }, r.output) : null)));
  }, { cls: 'small' });
  const useBtn = who && github ? btn(`Use for ${who}`, async () => {
    if (await save({ accountSsh: { ...(store.config.accountSsh || {}), [who]: { protocol: 'ssh', host: alias } } }, `${who} now connects with ${alias}`)) { useBtn.disabled = true; useBtn.textContent = 'Set'; }
  }, { cls: 'small' }) : null;
  await modal({
    title: `Connection ${alias} created`,
    wide: true,
    body: h('div', { class: 'col', style: { gap: '14px' } },
      created ? note('info-box', 'A new key pair was created. GitHub does not know it yet.') : null,
      step(1, github ? 'Add the public key to the GitHub account' : 'Add the public key on the server', h('div', { class: 'set-desc' }, github ? 'Sign in to the right account in your browser, open GitHub → Settings → SSH and GPG keys → New SSH key, and paste the key.' : 'Paste this key where the server lists your SSH keys.'),
        pub ? h('pre', { class: 'set-out key' }, pub) : null,
        h('div', { class: 'row', style: { marginTop: '8px' } }, btn('Copy public key', () => copyText(pub), { cls: 'small primary', iconName: 'copy' }), github ? btn('Open GitHub', () => rpc('open.url', { url: 'https://github.com/settings/ssh/new' }), { cls: 'small', iconName: 'external' }) : null)),
      step(2, 'Check that it works', h('div', { class: 'row', style: { marginTop: '6px' } }, testBtn), result),
      useBtn ? step(3, 'Use it for this account', h('div', { class: 'set-desc' }, `Optional. Repositories you clone for ${who} will then use git@${alias}:owner/repo.git.`), h('div', { class: 'row', style: { marginTop: '6px' } }, useBtn)) : null),
    actions: [{ label: 'Done', cls: 'primary', value: true, default: true }],
  });
}

// ======================================================================
// Git configuration
// ======================================================================
async function gitconfig(el) {
  const title = (...t) => head('Git configuration', 'Your global git settings. They apply to every repository on this computer, in Repodeck and in the terminal, unless a repository overrides them.', ...t);
  mount(el, title(), loading());
  const A = await import('../account.js');
  let g = await rpc('gitconfig.get');
  const accs = await rpc('account.list').catch(() => ({ accounts: [] }));
  const again = () => gitconfig(el);
  const set = async (key, value) => {
    try { g = await rpc('gitconfig.set', { key, value }); banner({ level: 'success', title: value === '' ? `${key} cleared` : `${key} = ${value}`, timeout: 1800 }); return true; } catch (e) { showError(e); return false; }
  };
  const gsel = (key, title2, desc, options) => row(title2, [desc, h('span', { class: 'faint mono set-key' }, key)], h('select', { class: 'sel', onchange: (e) => set(key, e.target.value) },
    options.map(([v, l]) => h('option', { value: v, selected: (g.values[key] || '') === v }, l)),
    options.some(([v]) => v === (g.values[key] || '')) ? null : h('option', { value: g.values[key], selected: true, disabled: true }, `${g.values[key]} (custom)`)));
  const gtext = (key, title2, desc, placeholder) => row(title2, [desc, h('span', { class: 'faint mono set-key' }, key)], h('input', { type: 'text', class: 'txt', value: g.values[key] || '', placeholder, spellcheck: 'false',
    onchange: async (e) => { if (!(await set(key, e.target.value.trim()))) e.target.value = g.values[key] || ''; } }));
  const name = g.values['user.name']; const email = g.values['user.email'];
  const logins = accs.accounts.map((a) => a.login.toLowerCase());
  const noreply = /@users\.noreply\.github\.com$/i.test(email || '');
  const all = h('div');
  let shown = false;
  const drawAll = () => mount(all, shown ? h('table', { class: 'grid panel set-table' }, g.all.map((x) => h('tr', null, h('td', { class: 'mono' }, x.key), h('td', { class: 'mono wrapcell' }, x.value)))) : null);

  mount(el, title(iconBtn('folder', 'Show the .gitconfig file in Explorer', () => act(() => rpc('gitconfig.reveal'))), iconBtn('refresh', 'Reload', again)),
    sub('Commit identity', 'Recorded in every commit you make.'),
    card(
      h('div', { class: 'set-row' }, h('span', { class: 'set-ico' }, icon('user')),
        h('div', { class: 'set-label' }, h('div', { class: 'set-name' }, name || 'No name set'), h('div', { class: 'set-desc' }, email || 'No email set', noreply ? ' · private noreply address' : '')),
        h('div', { class: 'set-control' }, btn('Change…', () => A.editIdentity().then(again), { cls: 'small' }))),
      !name || !email ? note('warn-box flat', 'Git refuses to commit without a name and an email.') : null,
      email && !noreply && logins.length ? h('div', { class: 'set-row sub muted' }, 'This email is visible in every commit you push. “Change…” offers the private noreply address of your GitHub account.') : null),
    sub('Pulling and pushing', ['Used by git in the terminal. Repodeck’s own Pull button follows ', link('Behaviour', '#/settings/behaviour'), '.']),
    card(
      gsel('pull.rebase', 'git pull', 'What a plain git pull does when both sides have new commits', [['', 'Not set (merge)'], ['false', 'Merge'], ['true', 'Rebase']]),
      gsel('pull.ff', 'Fast-forward', '“Only” makes git pull stop instead of creating a merge commit', [['', 'Not set (fast-forward when possible)'], ['only', 'Only fast-forward'], ['true', 'When possible'], ['false', 'Always create a merge commit']]),
      gsel('push.autosetupremote', 'Set upstream on first push', 'Lets git push work on a new branch without extra arguments', [['', 'Not set (off)'], ['true', 'On'], ['false', 'Off']]),
      gsel('push.default', 'Which branch git push sends', null, [['', 'Not set (simple)'], ['simple', 'Simple: the branch of the same name'], ['current', 'Current branch'], ['upstream', 'Its upstream branch']]),
      gsel('fetch.prune', 'Prune on fetch', 'Forget remote branches that were deleted on GitHub', [['', 'Not set (off)'], ['true', 'On'], ['false', 'Off']])),
    sub('New repositories and merging'),
    card(
      gtext('init.defaultbranch', 'Default branch name', 'For repositories created with git init', 'main'),
      gsel('merge.conflictstyle', 'Conflict markers', 'diff3 and zdiff3 also show the original text between the two sides', [['', 'Not set (merge)'], ['merge', 'merge: two sides'], ['diff3', 'diff3: two sides and the original'], ['zdiff3', 'zdiff3: compact diff3']]),
      gsel('rerere.enabled', 'Remember conflict resolutions', 'Reuses how you resolved a conflict when the same one comes back', [['', 'Not set (off)'], ['true', 'On'], ['false', 'Off']])),
    sub('Windows'),
    card(
      gsel('core.autocrlf', 'Line endings', 'How Windows line endings are converted', [['', 'Not set'], ['true', 'Convert to CRLF on checkout, LF on commit'], ['input', 'Keep as is on checkout, LF on commit'], ['false', 'Never convert']]),
      gsel('core.longpaths', 'Long paths', 'Allow paths over 260 characters', [['', 'Not set (off)'], ['true', 'On'], ['false', 'Off']]),
      gtext('credential.helper', 'Credential helper', 'Stores HTTPS sign-ins. “manager” is Git Credential Manager, installed with Git for Windows', 'manager'),
      gtext('core.editor', 'Editor for commit messages', 'Used by git in the terminal, for example during a rebase', 'code --wait')),
    h('div', { class: 'row set-below' }, btn('Show every setting', (e) => { shown = !shown; e.currentTarget.lastChild.textContent = shown ? 'Hide every setting' : 'Show every setting'; drawAll(); }, { cls: 'small', iconName: 'list' }),
      h('span', { class: 'faint' }, [g.version, g.file ? h('span', { class: 'mono' }, ` · ${g.file}`) : null])),
    all);
}

// ======================================================================
// Repodeck behaviour
// ======================================================================
function behaviour(el) {
  mount(el, head('Behaviour', 'How Repodeck’s own buttons work. These do not change your git configuration.'),
    card(
      choice('pullStrategy', 'Pull and Sync', 'How remote commits are brought in', [['merge', 'Merge'], ['rebase', 'Rebase'], ['ff-only', 'Fast-forward only']]),
      choice('updateFromDefault', 'Update from default branch', 'How a feature branch that is behind main is brought up to date', [['merge', 'Merge the default branch in'], ['rebase', 'Rebase onto the default branch']]),
      number('refreshSeconds', 'Status refresh', 'Also refreshes when the window gets focus and after every action', 5, 'seconds'),
      number('bulkConcurrency', 'Repositories handled at once', 'For bulk operations such as Fetch all', 1)),
    sub('Background', 'Nothing changes in your repositories in the background unless you turn this on.'),
    card(
      toggle('backgroundFetch', 'Fetch all repositories periodically', 'Keeps ahead/behind counts current. Never pulls, merges or prunes.'),
      number('backgroundFetchMinutes', 'Fetch every', null, 1, 'minutes'),
      toggle('skipHiddenOnFetch', 'Do not fetch hidden repositories', 'Fetch all and the periodic fetch leave repositories in the sidebar’s Hidden section alone. Fetching one on its own still works.')));
}

function actions(el) {
  mount(el, head('Actions & notifications'),
    card(
      toggle('notifications', 'Windows notifications', 'When a tracked run finishes, a review is requested, or your pull request checks finish'),
      toggle('notifySound', 'Play a sound'),
      toggle('notifyReviewRequests', 'Watch my pull requests and review requests'),
      toggle('trackExternalRuns', 'Track pushes made outside Repodeck', 'New commits on a default branch, from a terminal or a teammate, are followed on the Actions board too'),
      toggle('skipHiddenInActions', 'Leave hidden repositories out of Actions', 'Repositories in the sidebar’s Hidden section are not checked, shown on the Actions board or tracked for new runs.')),
    sub('Refresh intervals', 'Shorter intervals use more of your GitHub API allowance.'),
    card(
      number('actionsRefreshSeconds', 'Default-branch status', 'One GitHub request covers every repository', 30, 'seconds'),
      number('boardRefreshSeconds', 'While the Actions board is open', null, 10, 'seconds'),
      number('trackedRefreshSeconds', 'Tracked runs', null, 5, 'seconds')));
}

function tools(el) {
  const c = store.config;
  const tool = (label, desc, cmdKey, argsKey, presets) => {
    const write = () => save({ [cmdKey]: cmd.value.trim(), [argsKey]: args.value.trim() ? args.value.trim().split(/\s+/) : [] });
    const cmd = h('input', { type: 'text', class: 'txt short', value: c[cmdKey], spellcheck: 'false', placeholder: 'program', onchange: write });
    const args = h('input', { type: 'text', class: 'txt', value: c[argsKey].join(' '), spellcheck: 'false', placeholder: 'arguments', onchange: write });
    return row(label, desc, h('div', { class: 'row' }, cmd, args,
      iconBtn('chevronDown', 'Common choices', (e) => menuBelow(e.currentTarget, presets.map(([l, p, a]) => ({ label: l, action: () => { cmd.value = p; args.value = a; write(); } }))))));
  };
  mount(el, head('Editor & terminal', 'Programs started by “Open in editor” and “Open terminal here”. {path} is replaced by the file or folder.'),
    card(
      tool('Editor', 'Opens files and folders', 'editorCommand', 'editorArgs', [['Visual Studio Code', 'code', '{path}'], ['Cursor', 'cursor', '{path}'], ['Notepad++', 'notepad++', '{path}'], ['Notepad', 'notepad', '{path}']]),
      tool('Terminal', 'Opens in the repository folder', 'terminalCommand', 'terminalArgs', [['Windows Terminal', 'wt', '-d {path}'], ['PowerShell 7', 'pwsh', '-NoExit -WorkingDirectory {path}'], ['Windows PowerShell', 'powershell', '-NoExit -Command Set-Location {path}'], ['Command Prompt', 'cmd', '/K cd /d {path}']])));
}

function app(el) {
  mount(el, head('Appearance & app'),
    card(
      row('Theme', null, seg(store.config.theme, [['system', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']], (v) => save({ theme: v }))),
      toggle('closeToTray', 'Close button hides the window to the tray', 'Repodeck keeps running next to the clock. Click its icon to open it again; right-click it to quit.'),
      toggle('keepRunningWhenClosed', 'Keep running after the window really closes', 'When you quit from the tray, or the tray option is off: notifications still arrive. Reopen from the Start menu.'),
      number('port', 'Local port', 'Takes effect after a restart', 1025)),
    sub('Stop'),
    card(row('Quit Repodeck', 'Stops the background process for this account', btn('Quit', async () => {
      if (await confirmDanger({ title: 'Quit Repodeck?', message: 'Stops the background process. Start it again from the Start menu.', confirmLabel: 'Quit', danger: false })) { await rpc('app.quit'); mount(document.body, h('div', { class: 'empty' }, 'Repodeck has stopped. You can close this window.')); try { window.chrome.webview.postMessage('close'); } catch { /* browser tab: stays open */ } }
    }, { cls: 'small danger' }))));
}

// ======================================================================
// Guides
// ======================================================================
const GUIDES = [
  ['two-accounts', 'Use two GitHub accounts on one computer', 'key', () => [
    h('p', null, 'GitHub accepts a key for one account only, so each account needs its own key. An SSH connection is a nickname for github.com that selects one of those keys.'),
    h('ol', null,
      h('li', null, 'Open ', link('SSH connections', '#/settings/ssh'), ' and choose New connection. Name it after the account, for example ', h('code', null, 'github-work'), ', and let Repodeck create a new key.'),
      h('li', null, 'Copy the public key and add it on GitHub while the browser is signed in to that account.'),
      h('li', null, 'Press Test. GitHub answers with the account name the key belongs to.'),
      h('li', null, 'In ', link('Accounts & folders', '#/settings/accounts'), ', set “Connect to GitHub with” to SSH and pick the connection.')),
    h('p', null, 'A repository cloned through the connection has an address like this, and always uses that account’s key:'),
    code('git@github-work:owner/repo.git')]],
  ['add-key', 'Add an SSH key to GitHub', 'plus', () => [
    h('ol', null,
      h('li', null, 'In ', link('SSH connections', '#/settings/ssh'), ', press Copy public key next to the key. The public key is safe to share; the private key never leaves this computer.'),
      h('li', null, 'On GitHub open Settings → SSH and GPG keys → New SSH key.'),
      h('li', null, 'Give it a title such as the name of this computer, keep the type “Authentication Key”, paste, and save.'),
      h('li', null, 'If the organisation uses single sign-on, press Configure SSO next to the key and authorise it for the organisation.')),
    h('div', { class: 'row' }, btn('Open GitHub key settings', () => rpc('open.url', { url: 'https://github.com/settings/keys' }), { cls: 'small', iconName: 'external' }))]],
  ['switch-remote', 'Move an existing repository to SSH or to another connection', 'sync', () => [
    h('p', null, 'The address of the remote decides how git connects. In Repodeck, open the repository, then Branches → Remotes → Change URL…. Or in a terminal inside the repository:'),
    code('git remote set-url origin git@github-work:owner/repo.git'),
    h('p', null, 'Back to HTTPS:'),
    code('git remote set-url origin https://github.com/owner/repo.git'),
    h('p', null, 'Check the result with:'),
    code('git remote -v')]],
  ['private-email', 'Keep your email private in commits', 'eye', () => [
    h('p', null, 'The email in your commit identity is public in every commit you push. GitHub gives each account a noreply address that still links commits to your profile.'),
    h('ol', null,
      h('li', null, 'On GitHub open Settings → Emails and turn on “Keep my email addresses private”.'),
      h('li', null, 'In ', link('Git configuration', '#/settings/gitconfig'), ' press Change… and pick the noreply address of your account.')),
    h('p', null, 'For a different identity in one repository only, run inside it:'),
    code('git config user.email "you@example.com"')]],
  ['per-folder', 'A different name and email per folder', 'folder', () => [
    h('p', null, 'Useful when work repositories live in one folder and personal ones in another. Add this to the end of your global .gitconfig, with a second file that holds the other identity:'),
    code('[includeIf "gitdir/i:C:/work/"]\n    path = ~/.gitconfig-work'),
    h('p', null, 'and in ', h('code', null, '~/.gitconfig-work'), ':'),
    code('[user]\n    name = Your Name\n    email = you@company.example'),
    h('p', { class: 'muted' }, 'The trailing slash matters: it makes the rule cover every repository under that folder.')]],
  ['port-443', 'SSH is blocked on this network', 'warn', () => [
    h('p', null, 'Some networks block port 22. GitHub also accepts SSH on port 443 through a different server name. Create a connection with the server ', h('code', null, 'ssh.github.com'), ' and add a Port line to it in the SSH config file:'),
    code('Host github-443\n    HostName ssh.github.com\n    Port 443\n    User git\n    IdentityFile ~/.ssh/id_ed25519'),
    h('p', null, 'Or switch the account to HTTPS in ', link('Accounts & folders', '#/settings/accounts'), ', which works everywhere.')]],
  ['passphrase', 'Keys with a passphrase', 'pin', () => [
    h('p', null, 'Repodeck cannot type a passphrase, so a protected key must be unlocked by the Windows ssh-agent. In PowerShell as administrator, once:'),
    code('Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent'),
    h('p', null, 'Then add the key, typing its passphrase one time:'),
    code('ssh-add $env:USERPROFILE\\.ssh\\id_ed25519'),
    h('p', null, 'Make git use the Windows OpenSSH that talks to that agent:'),
    code('git config --global core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe"')]],
  ['line-endings', 'Line endings on Windows', 'diff', () => [
    h('p', null, 'If whole files show as changed after a checkout, line endings are being converted. The safest shared fix is a ', h('code', null, '.gitattributes'), ' file committed to the repository:'),
    code('* text=auto'),
    h('p', null, 'For your own computer, set Line endings in ', link('Git configuration', '#/settings/gitconfig'), '. “Keep as is on checkout, LF on commit” suits most editors today.')]],
];

function guides(el, open) {
  mount(el, head('Guides', 'Short answers for the things that usually need a web search.'),
    GUIDES.map(([id, title, ic, body]) => {
      const d = h('details', { class: 'panel guide', id: `guide-${id}` }, h('summary', null, h('span', { class: 'set-ico' }, icon(ic)), h('span', { class: 'grow set-name' }, title), icon('chevronDown', 'sm chev')), h('div', { class: 'guide-body' }, body()));
      if (open === id) d.open = true;
      return d;
    }));
  if (open) { const t = document.getElementById(`guide-${open}`); if (t) t.scrollIntoView({ block: 'start' }); }
}

// ======================================================================
// Diagnostics and About
// ======================================================================
async function diagnostics(el) {
  mount(el, head('Diagnostics', 'What Repodeck found on this computer.'), loading('Collecting…'));
  const d = await rpc('app.diagnostics');
  const results = h('div');
  const ok = (v) => !/not available/.test(v);
  const tool = (name, v) => row(name, null, h('span', { class: `badge ${ok(v) ? 'ok' : 'bad'}` }, v));
  mount(el, head('Diagnostics', 'What Repodeck found on this computer.'),
    card(tool('git', d.git), tool('GitHub CLI', d.gh), tool('Node.js', d.node), row('Windows', null, h('span', { class: 'muted' }, d.platform)),
      row('Data folder', 'Settings, logs and safety copies of discarded changes', h('div', { class: 'row' }, h('span', { class: 'mono muted ellipsis', style: { maxWidth: '300px' } }, d.dataDir), iconBtn('copy', 'Copy path', () => copyText(d.dataDir))))),
    sub('Connectivity', `Checks that each repository’s remote is reachable with git and visible to ${d.currentAccount || 'the signed-in account'}. Read-only.`,
      btn('Run check', async (e) => {
        const b = e.currentTarget; b.disabled = true;
        mount(results, h('div', { class: 'progress' }), loading('Checking every repository; this can take a minute…'));
        try {
          const res = await rpc('app.connectivity');
          const bad = res.filter((x) => x.git !== 'ok' || (!String(x.gh).startsWith('ok') && x.gh !== 'n/a' && x.gh !== 'not a GitHub remote'));
          mount(results, note(bad.length ? 'warn-box' : 'info-box', bad.length ? `${plural(bad.length, 'repository')} need attention.` : `All ${res.length} repositories are reachable.`),
            h('table', { class: 'grid panel' }, h('tr', null, h('th', null, 'Repository'), h('th', null, 'Remote'), h('th', null, 'git'), h('th', null, 'GitHub')),
              res.map((x) => h('tr', null, h('td', null, x.label), h('td', { class: 'mono' }, x.remote || ''),
                h('td', { class: 'wrapcell', style: { color: x.git === 'ok' ? 'var(--ok)' : 'var(--bad)' } }, x.git), h('td', { class: 'wrapcell', style: { color: String(x.gh).startsWith('ok') ? 'var(--ok)' : x.gh === 'n/a' || x.gh === 'not a GitHub remote' ? '' : 'var(--bad)' } }, x.gh)))));
        } catch (err) { mount(results, h('div', { class: 'errbox' }, err.message)); }
        b.disabled = false;
      }, { cls: 'small primary' })),
    results);
}

async function about(el) {
  const a = await rpc('app.about').catch(() => ({ version: '?' }));
  mount(el, head('About'),
    card(
      h('div', { class: 'set-row' }, h('img', { src: '/icon.svg', width: 44, height: 44, alt: '' }), h('div', { class: 'set-label' }, h('div', { class: 'set-name big' }, 'Repodeck'), h('div', { class: 'set-desc' }, `Version ${a.version}`))),
      row('Installed in', null, h('span', { class: 'mono muted' }, a.installDir || '')),
      row('Logs', 'Every git and GitHub command is also listed under Activity', h('div', { class: 'row' }, btn('Open activity', () => navigate('#/activity'), { cls: 'small' }), btn('Copy log folder', () => copyText(a.logDir), { cls: 'small' }))),
      row('Keyboard shortcuts', null, btn('Show', () => import('../help.js').then((m) => m.showShortcuts()), { cls: 'small' })),
      row('Licence', 'MIT. No telemetry; nothing is sent anywhere except by git and the GitHub CLI.', null)));
}

export { setup, cloneDialog } from '../onboarding.js';
