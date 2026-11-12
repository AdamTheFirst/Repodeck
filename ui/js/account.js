// GitHub accounts and commit identity: top-bar chip, account panel, sign-in dialog.
import { h, mount, icon, btn, act, modal, form, banner, confirmDanger, copyText, popover, showError, menuBelow, plural } from './dom.js';
import { rpc } from './api.js';
import { store, emit, setRepos } from './store.js';
import { navigate } from './router.js';

let info = null;      // { installed, accounts: [{ login, active, avatar, state }] }
let identity = null;  // { name, email }

export async function loadAccounts() {
  try { info = await rpc('account.list'); } catch { info = { installed: false, accounts: [] }; }
  store.accounts = info;
  emit('accounts');
  return info;
}

const current = () => (info && info.accounts.find((a) => a.current)) || null;
const avatar = (a, size = 22) => h('img', { class: 'avatar', src: a.avatar, alt: '', width: size, height: size, referrerpolicy: 'no-referrer', onerror: (e) => { e.target.style.visibility = 'hidden'; } });

/** The chip shown in the top bar: the account whose workspace is open. */
export function accountChip() {
  if (!info) return h('span');
  const a = current();
  if (!info.installed) return h('button', { class: 'chip warn', title: 'The GitHub CLI is not installed', onclick: () => navigate('#/settings/diagnostics') }, icon('warn', 'sm'), 'GitHub CLI missing');
  if (!a) return h('button', { class: 'chip primary', onclick: () => signIn() }, icon('external', 'sm'), 'Sign in to GitHub');
  const others = info.accounts.length - 1;
  return h('button', { class: 'chip', title: 'Switch account, sign in or out, commit identity', onclick: (e) => openPanel(e.currentTarget) },
    avatar(a), h('span', { class: 'ellipsis', style: { maxWidth: '140px' } }, a.login), others > 0 ? h('span', { class: 'faint' }, `+${others}`) : null, icon('chevronDown', 'sm'));
}

async function openPanel(anchor) {
  const body = h('div', { class: 'account-panel' }, h('div', { class: 'skeleton' }, 'Loading…'));
  const close = popover(anchor, body);
  await Promise.all([loadAccounts(), rpc('account.identity').then((x) => { identity = x; }).catch(() => { identity = null; })]);
  mount(body,
    h('div', { class: 'ap-section' }, h('div', { class: 'ap-title' }, 'GitHub accounts'),
      h('div', { class: 'faint', style: { fontSize: '12px' } }, 'Each account has its own folders and repositories. Switching shows only that account’s.'),
      info.accounts.map((a) => h('div', { class: `ap-account ${a.current ? 'active' : ''}`, style: { cursor: a.current ? 'default' : 'pointer' }, onclick: () => { if (!a.current) { close(); useAccount(a.login); } } },
        avatar(a, 32),
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'row', style: { gap: '6px' } }, h('strong', { class: 'ellipsis' }, a.login), a.current ? h('span', { class: 'badge accent' }, 'open') : null,
            a.state !== 'success' ? h('span', { class: 'badge bad' }, 'needs sign-in') : null),
          h('div', { class: 'sub ellipsis' }, a.folders ? plural(a.folders, 'folder') : 'No folders yet', a.active ? ' · default in terminal' : '')),
        h('div', { class: 'row', style: { gap: '4px' } },
          !a.current ? btn('Switch', (e) => { e.stopPropagation(); close(); useAccount(a.login); }, { cls: 'small primary' }) : null,
          btn('', (e) => {
            e.stopPropagation();
            menuBelow(e.currentTarget, [
              { label: 'Open profile on GitHub', icon: 'external', action: () => rpc('open.url', { url: `https://github.com/${a.login}` }) },
              { label: 'Also use for gh in the terminal', icon: 'terminal', disabled: a.active, action: () => act(() => rpc('account.makeDefault', { login: a.login }), { ok: `${a.login} is now the default for gh in terminals` }).then(loadAccounts) },
              a.state !== 'success' ? { label: 'Sign in again', icon: 'refresh', action: () => { close(); signIn(); } } : null,
              '-',
              { label: `Sign out ${a.login}`, icon: 'x', danger: true, action: () => { close(); signOut(a.login); } },
            ]);
          }, { cls: 'small icon ghost', iconName: 'more', title: 'More' })))),
      h('div', { class: 'row', style: { marginTop: '6px' } }, btn('Add another account', () => { close(); signIn(); }, { cls: 'small', iconName: 'plus' }))),
    h('div', { class: 'ap-section' }, h('div', { class: 'ap-title' }, 'Commits are signed as'),
      identity && (identity.name || identity.email)
        ? h('div', { class: 'row' }, h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'ellipsis' }, identity.name || h('span', { class: 'faint' }, 'no name')), h('div', { class: 'sub ellipsis' }, identity.email || 'no email')),
          btn('Change', () => { close(); editIdentity(); }, { cls: 'small' }))
        : h('div', { class: 'row' }, h('span', { class: 'warn-box grow' }, 'Not set: git will refuse to commit.'), btn('Set', () => { close(); editIdentity(); }, { cls: 'small primary' }))),
    h('div', { class: 'ap-foot' }, h('a', { onclick: () => { close(); navigate('#/github'); } }, 'Repositories on GitHub'), h('span', { class: 'spacer' }),
      h('a', { onclick: () => { close(); navigate('#/settings'); } }, 'Folders and settings')));
}

/** After the open account changed: reload settings and lists, and land somewhere sensible. */
async function afterAccountChange() {
  await loadAccounts();
  store.config = await rpc('config.get');
  emit('config');
  const { repos, roots } = await rpc('repos.list');
  store.roots = roots;
  store.selected = null;
  store.board = {}; store.trackers = await rpc('trackers.list').catch(() => []); store.myprs = null;
  setRepos(repos);
  emit('board'); emit('trackers'); emit('myprs');
  if (current() && !store.config.roots.length) navigate('#/settings/setup');
  else navigate('#/repo');
}

export async function useAccount(login) {
  const r = await act(() => rpc('account.use', { login }));
  if (!r) return;
  await afterAccountChange();
  banner({ level: 'success', title: `Now showing ${login}`, body: store.config.roots.length ? null : 'This account has no folders yet. Pick its folders or clone its repositories.', timeout: 4000 });
}

async function signOut(login) {
  const a = info.accounts.find((x) => x.login === login);
  const ok = await confirmDanger({
    title: `Sign out ${login}?`,
    message: `git-helper and the gh command in your terminal will stop using ${login}.${a && a.folders ? ` Its ${plural(a.folders, 'folder')} stay assigned to it and come back when you sign in again.` : ''} Nothing on disk is deleted.`,
    confirmLabel: 'Sign out',
  });
  if (!ok) return;
  const r = await act(() => rpc('account.logout', { login }), { ok: `Signed out ${login}` });
  if (r) afterAccountChange();
}

/** Device-flow sign-in: show the code, open GitHub, wait for approval. */
export async function signIn() {
  let s;
  try { s = await rpc('account.login'); } catch (e) { showError(e, 'Could not start sign-in'); return; }
  const codeEl = h('div', { class: 'device-code' }, '…');
  const status = h('div', { class: 'row muted' }, icon('refresh', 'sm spin'), 'Starting…');
  const openBtn = btn('Open GitHub', () => rpc('open.url', { url: s.url || 'https://github.com/login/device' }), { cls: 'primary', iconName: 'external' });
  const copyBtn = btn('Copy code', () => s.code && copyText(s.code), { cls: '', iconName: 'copy' });
  let opened = false;
  let stop = false;
  const body = h('div', { class: 'col', style: { gap: '14px' } },
    h('div', null, 'Sign in with your browser. The code below is already on your clipboard: paste it on the GitHub page, then approve access for the GitHub CLI.'),
    codeEl, h('div', { class: 'row' }, openBtn, copyBtn), status,
    h('div', { class: 'faint', style: { fontSize: '12px' } }, 'Signing in with a different GitHub account? Sign out of github.com in the browser first, or use a private window.'));
  const dlg = modal({ title: 'Sign in to GitHub', body, actions: [{ label: 'Cancel', value: 'cancel' }], onClose: () => { stop = true; } });
  (async () => {
    while (!stop) {
      try { s = await rpc('account.loginStatus'); } catch { break; }
      if (!s) break;
      if (s.code) {
        codeEl.textContent = s.code;
        if (!opened) { opened = true; rpc('open.url', { url: s.url }).catch(() => {}); }
        mount(status, icon('refresh', 'sm spin'), 'Waiting for you to approve in the browser…');
      }
      if (s.state === 'done') {
        stop = true;
        const dlgEl = codeEl.closest('.modal');
        if (dlgEl && dlgEl.closeModal) dlgEl.closeModal('done');
        await loadAccounts();
        const fresh = info.accounts.find((x) => x.active);
        if (fresh && !fresh.current) await rpc('account.use', { login: fresh.login }).catch(() => {});
        await afterAccountChange();
        banner({ level: 'success', title: `Signed in${fresh ? ` as ${fresh.login}` : ''}`, timeout: 4000 });
        break;
      }
      if (s.state === 'failed' || s.state === 'cancelled') {
        mount(status, h('div', { class: 'errbox grow' }, s.error || 'Sign-in did not complete.'));
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  const v = await dlg;
  if (v === 'cancel' || v === undefined) {
    const cur = await rpc('account.loginStatus').catch(() => null);
    if (cur && (cur.state === 'waiting' || cur.state === 'starting')) rpc('account.loginCancel', { sessionId: cur.id }).catch(() => {});
  }
}

export async function editIdentity() {
  const cur = identity || (await rpc('account.identity').catch(() => ({ name: '', email: '' })));
  const accs = (info && info.accounts) || [];
  const noreplyLinks = (input) => (accs.length ? h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Your email is public in every commit you push. Keep it private with the GitHub noreply address of ',
    accs.map((a, i) => [i ? ', ' : '', h('a', { onclick: async (e) => { e.preventDefault(); const v = await rpc('account.noreply', { login: a.login }).catch((err) => { banner({ level: 'error', title: err.message }); return null; }); if (v) input.value = v; } }, a.login)]), '.') : null);
  const v = await form({
    title: 'Commit identity',
    intro: h('div', { class: 'muted' }, 'Stored in your global git config and used for every commit, in git-helper and in the terminal.'),
    fields: [{ name: 'name', label: 'Name', value: cur.name, required: true }, { name: 'email', label: 'Email', value: cur.email, required: true, extra: noreplyLinks }],
    submit: 'Save',
  });
  if (!v) return;
  const r = await act(() => rpc('account.setIdentity', v), { ok: 'Commit identity saved' });
  if (r) identity = r;
}

export { showError };
