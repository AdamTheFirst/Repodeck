// GitHub sign-in / switch / sign-out through the GitHub CLI, and the global git identity.
// Sign-in uses GitHub's device flow: gh prints a one-time code, the user enters it in the browser.
'use strict';
const { spawn } = require('node:child_process');
const { run } = require('./proc');
const { paths } = require('./paths');
const gh = require('./gh');
const log = require('./log');

const HOST = 'github.com';
let session = null; // { id, child, code, url, state, error, output, started }

function startLogin() {
  if (session && (session.state === 'starting' || session.state === 'waiting')) return publicSession();
  const id = `l${Date.now().toString(36)}`;
  const child = spawn('gh', ['auth', 'login', '--hostname', HOST, '--web', '--clipboard', '--git-protocol', 'https', '--skip-ssh-key', '--scopes', 'workflow'], {
    cwd: paths.neutral, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  session = { id, child, code: null, url: 'https://github.com/login/device', state: 'starting', error: null, output: '', started: Date.now() };
  const s = session;
  const onData = (d) => {
    s.output += d.toString('utf8');
    // "! First copy your one-time code: ABCD-1234"  or  "! One-time code (ABCD-1234) copied to clipboard"
    const m = /one-time code[^A-Z0-9]*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(s.output);
    if (m && !s.code) {
      s.code = m[1];
      s.state = 'waiting';
      const u = /(https:\/\/github\.com\/login\/device\S*)/.exec(s.output);
      if (u) s.url = u[1];
      // Without a terminal gh does not open a browser; the app opens the device page. The code is on the clipboard.
      try { child.stdin.write('\n'); } catch {}
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  child.on('error', (e) => { s.state = 'failed'; s.error = e.code === 'ENOENT' ? 'The GitHub CLI (gh) is not installed.' : e.message; });
  child.on('close', (code) => {
    if (s.state === 'cancelled') return;
    if (code === 0) { s.state = 'done'; gh.forgetAccounts(); log.info('GitHub sign-in completed'); }
    else { s.state = 'failed'; s.error = s.output.trim().split('\n').filter((l) => !/one-time code|Press Enter/i.test(l)).slice(-3).join('\n') || `gh exited with code ${code}`; }
  });
  // device codes expire after 15 minutes
  setTimeout(() => { if (s.state === 'waiting' || s.state === 'starting') cancelLogin(s.id, 'The sign-in code expired. Start again.'); }, 15 * 60_000);
  return publicSession();
}

function cancelLogin(id, reason) {
  if (!session || (id && session.id !== id)) return publicSession();
  if (session.state === 'starting' || session.state === 'waiting') {
    session.state = reason ? 'failed' : 'cancelled';
    session.error = reason || null;
    try { spawn('taskkill', ['/pid', String(session.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { try { session.child.kill(); } catch {} }
  }
  return publicSession();
}

function publicSession() {
  if (!session) return null;
  const { id, code, url, state, error, started } = session;
  return { id, code, url, state, error, started };
}

async function switchTo(login) {
  if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error('Invalid account name');
  await run('gh', ['auth', 'switch', '--hostname', HOST, '--user', login], { cwd: paths.neutral, timeout: 20_000 });
  gh.forgetAccounts();
}

async function logout(login) {
  if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error('Invalid account name');
  await run('gh', ['auth', 'logout', '--hostname', HOST, '--user', login], { cwd: paths.neutral, timeout: 20_000, input: 'y\n' });
  gh.forgetAccounts();
}

/** Accounts with profile info. Avatars come from github.com/<login>.png. */
async function list() {
  let accs = [];
  try { accs = await gh.accounts(true); } catch (e) { return { installed: !/not installed/.test(e.message), accounts: [], error: e.message }; }
  return {
    installed: true,
    accounts: accs.filter((a) => a.host === HOST).map((a) => ({ login: a.login, active: a.active, state: a.state, scopes: a.scopes, avatar: `https://github.com/${encodeURIComponent(a.login)}.png?size=64` })),
  };
}

async function identity() {
  const get = async (k) => { try { return (await run('git', ['config', '--global', '--get', k], { quiet: true, timeout: 10_000, okCodes: [0, 1] })).stdout.trim(); } catch { return ''; } };
  return { name: await get('user.name'), email: await get('user.email') };
}

async function setIdentity({ name, email }) {
  if (typeof name !== 'string' || typeof email !== 'string' || /[\r\n]/.test(name + email)) throw new Error('Invalid name or email');
  if (name.trim()) await run('git', ['config', '--global', 'user.name', name.trim()], { timeout: 10_000 });
  if (email.trim()) {
    if (!/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new Error('That does not look like an email address.');
    await run('git', ['config', '--global', 'user.email', email.trim()], { timeout: 10_000 });
  }
  return identity();
}

/** The private noreply address GitHub gives every account, for keeping your email out of commits. */
async function noreply(login) {
  const accs = await gh.accounts();
  const a = accs.find((x) => x.login === login);
  const r = await run('gh', ['api', 'user', '--jq', '.id'], { cwd: paths.neutral, quiet: true, timeout: 20_000, env: a && !a.active ? { GH_TOKEN: await ghToken(login) } : {} });
  return `${r.stdout.trim()}+${login}@users.noreply.github.com`;
}
async function ghToken(login) {
  const r = await run('gh', ['auth', 'token', '--hostname', HOST, '--user', login], { cwd: paths.neutral, quiet: true, timeout: 15_000 });
  return r.stdout.trim();
}

module.exports = { startLogin, cancelLogin, loginStatus: publicSession, switchTo, logout, list, identity, setIdentity, noreply };
