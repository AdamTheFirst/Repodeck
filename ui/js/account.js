// GitHub accounts and commit identity: top-bar chip, account panel, sign-in dialog.
import { h, mount, icon, btn, act, modal, form, banner, confirmDanger, copyText, popover, showError } from './dom.js';
import { rpc } from './api.js';
import { store, emit } from './store.js';
import { navigate } from './router.js';

let info = null;      // { installed, accounts: [{ login, active, avatar, state }] }
let identity = null;  // { name, email }

export async function loadAccounts() {
  try { info = await rpc('account.list'); } catch { info = { installed: false, accounts: [] }; }
  store.accounts = info;
  emit('accounts');
  return info;
}

const active = () => (info && info.accounts.find((a) => a.active)) || null;
const avatar = (a, size = 22) => h('img', { class: 'avatar', src: a.avatar, alt: '', width: size, height: size, referrerpolicy: 'no-referrer', onerror: (e) => { e.target.style.visibility = 'hidden'; } });

/** The chip shown in the top bar. */
export function accountChip() {
  if (!info) return h('span');
  const a = active();
  if (!info.installed) return h('button', { class: 'chip warn', title: 'The GitHub CLI is not installed', onclick: () => navigate('#/settings/diagnostics') }, icon('warn', 'sm'), 'GitHub CLI missing');
  if (!a) return h('button', { class: 'chip primary', onclick: () => signIn() }, icon('external', 'sm'), 'Sign in to GitHub');
  const others = info.accounts.length - 1;
  return h('button', { class: 'chip', title: 'GitHub accounts and commit identity', onclick: (e) => openPanel(e.currentTarget) },
    avatar(a), h('span', { class: 'ellipsis', style: { maxWidth: '140px' } }, a.login), others > 0 ? h('span', { class: 'faint' }, `+${others}`) : null, icon('chevronDown', 'sm'));
}

async function openPanel(anchor) {
  const body = h('div', { class: 'account-panel' }, h('div', { class: 'skeleton' }, 'Loading…'));
  const close = popover(anchor, body);
  await Promise.all([loadAccounts(), rpc('account.identity').then((x) => { identity = x; }).catch(() => { identity = null; })]);
  const owners = store.config.accountForOwner || {};
  const usedFor = (login) => Object.entries(owners).filter(([, l]) => l === login).map(([o]) => o);
  mount(body,
    h('div', { class: 'ap-section' }, h('div', { class: 'ap-title' }, 'GitHub accounts'),
      info.accounts.map((a) => h('div', { class: `ap-account ${a.active ? 'active' : ''}` },
        avatar(a, 32),
        h('div', { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'row', style: { gap: '6px' } }, h('strong', { class: 'ellipsis' }, a.login), a.active ? h('span', { class: 'badge accent' }, 'active') : null, a.state !== 'success' ? h('span', { class: 'badge bad' }, 'needs sign-in') : null),
          h('div', { class: 'sub ellipsis' }, usedFor(a.login).length ? `Used for ${usedFor(a.login).join(', ')}` : a.active ? 'Used for everything else' : 'Used automatically where it has access')),
        h('div', { class: 'row', style: { gap: '4px' } },
          !a.active ? btn('Make active', async () => { close(); await doSwitch(a.login); }, { cls: 'small', title: 'Also changes the active account for gh in your terminal' }) : null,
          a.state !== 'success' ? btn('Sign in again', () => { close(); signIn(); }, { cls: 'small' }) : null,
          btn('', () => { close(); signOut(a.login); }, { cls: 'small icon ghost', iconName: 'x', title: `Sign out ${a.login}` })))),
      h('div', { class: 'row', style: { marginTop: '6px' } }, btn('Add another account', () => { close(); signIn(); }, { cls: 'small', iconName: 'plus' }))),
    h('div', { class: 'ap-section' }, h('div', { class: 'ap-title' }, 'Commits are signed as'),
      identity && (identity.name || identity.email)
        ? h('div', { class: 'row' }, h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'ellipsis' }, identity.name || h('span', { class: 'faint' }, 'no name')), h('div', { class: 'sub ellipsis' }, identity.email || 'no email')),
          btn('Change', () => { close(); editIdentity(); }, { cls: 'small' }))
        : h('div', { class: 'row' }, h('span', { class: 'warn-box grow' }, 'Not set: git will refuse to commit.'), btn('Set', () => { close(); editIdentity(); }, { cls: 'small primary' }))),
    h('div', { class: 'ap-foot' }, h('a', { onclick: () => { close(); navigate('#/settings'); } }, 'Account settings'), h('span', { class: 'spacer' }),
      h('a', { onclick: () => { close(); navigate('#/settings/diagnostics'); } }, 'Check access per repository')));
}

async function refreshEverything() {
  await loadAccounts();
  rpc('board.refresh').catch(() => {});
  rpc('myprs.refresh').catch(() => {});
}

async function doSwitch(login) {
  const r = await act(() => rpc('account.switch', { login }), { ok: `${login} is now the active GitHub account` });
  if (r) refreshEverything();
}

async function signOut(login) {
  const ok = await confirmDanger({
    title: `Sign out ${login}?`,
    message: `git-helper and the gh command in your terminal will stop using ${login}. Repositories only it can see will show "no access" until you sign in again.`,
    confirmLabel: 'Sign out',
  });
  if (!ok) return;
  const r = await act(() => rpc('account.logout', { login }), { ok: `Signed out ${login}` });
  if (r) refreshEverything();
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
        await refreshEverything();
        const a = active();
        banner({ level: 'success', title: `Signed in${a ? ` as ${a.login}` : ''}`, timeout: 4000 });
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
