// RPC handlers. Every method is whitelisted here; repositories are looked up by id and
// only repositories discovered under configured roots can be addressed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');
const state = require('./state');
const git = require('./git');
const gh = require('./gh');
const P = require('./parse');
const queue = require('./queue');
const log = require('./log');
const { run } = require('./proc');
const { paths, writeJsonAtomic, readJson } = require('./paths');

const repo = (p) => state.get(p.id);
const slug = (p) => state.slugOf(p.id);

/** Run a mutating operation under the per-repo lock, then refresh that repo. */
async function mutate(p, label, fn) {
  const r = repo(p);
  state.bus.emit('summary', { id: r.id, summary: null, busy: { label, since: Date.now() } });
  try {
    return await queue.exclusive(r.id, label, () => fn(r));
  } finally {
    state.refresh(r.id);
  }
}

function utf8(s) { return Buffer.from(s, 'latin1').toString('utf8'); }

const MAX_DIFF_LINES = 6000;

function presentDiff(text, { full } = {}) {
  const files = P.parseDiff(text);
  let total = 0;
  let truncated = false;
  for (const f of files) {
    for (const h of f.hunks) {
      total += h.lines.length;
      if (!full && total > MAX_DIFF_LINES) { truncated = true; h.lines = h.lines.slice(0, Math.max(0, h.lines.length - (total - MAX_DIFF_LINES))); h.truncated = true; }
      for (const l of h.lines) l.s = utf8(l.s);
      h.header = utf8(h.header);
      h.context = utf8(h.context || '');
    }
    f.path = utf8(f.path || ''); f.oldPath = f.oldPath && utf8(f.oldPath); f.newPath = f.newPath && utf8(f.newPath);
    f.header = f.header.map(utf8);
  }
  return { files, fingerprint: git.fingerprint(text), truncated, totalLines: total };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|ico|svg)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };

function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened');
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** Find a program on PATH, honouring PATHEXT (so "code" finds code.cmd). */
function which(cmd) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = path.join(dir, cmd + ext.toLowerCase());
      try { if (fs.statSync(f).isFile()) return f; } catch {}
    }
  }
  return null;
}

function launch(cmd, args, dir) {
  let a = (args || []).map((x) => String(x).split('{path}').join(dir));
  let program = which(cmd) || cmd;
  let verbatim = false;
  if (/\.(cmd|bat)$/i.test(program)) {
    // Batch files need cmd.exe. Quote every argument and refuse characters cmd would still interpret.
    for (const x of [program, ...a]) if (/["%\r\n]/.test(x)) throw new Error('This path contains characters that cannot be passed safely to a .cmd launcher.');
    a = ['/d', '/s', '/c', `"${[program, ...a].map((x) => `"${x}"`).join(' ')}"`];
    program = process.env.ComSpec || 'cmd.exe';
    verbatim = true;
  }
  return new Promise((resolve, reject) => {
    const c = spawn(program, a, { cwd: dir, detached: true, stdio: 'ignore', windowsHide: verbatim, shell: false, windowsVerbatimArguments: verbatim });
    c.on('error', (e) => reject(new Error(`Could not start "${cmd}": ${e.code === 'ENOENT' ? 'not found. Set the command in Settings.' : e.message}`)));
    c.on('spawn', () => { c.unref(); resolve(); });
  });
}

function underRoot(dir) {
  const d = path.resolve(dir).toLowerCase();
  return config.get().roots.some((r) => { const root = path.resolve(r.path).toLowerCase(); return d === root || d.startsWith(root + path.sep); });
}

async function afterPush(r, res, reason) {
  try {
    const s = state.slugs.get(r.id);
    if (!s || !s.github) return;
    const sha = (await git.git(r, ['rev-parse', 'HEAD'], { quiet: true })).stdout.trim();
    state.addTracker({ repoId: r.id, slug: s, sha, branch: res.branch, reason });
  } catch (e) { log.warn('Could not start tracking', { error: e.message }); }
}

// ---------------- PR drafts (pending inline review comments) ----------------

function draftFile(p) { return path.join(paths.drafts, `${p.id}-${+p.number}.json`); }
function readDraft(p) { return readJson(draftFile(p), { comments: [] }); }
function writeDraft(p, d) { writeJsonAtomic(draftFile(p), d); }

// ---------------- helpers for multi-repo ----------------

async function repoBranchInfo(r, branch) {
  const sum = await git.summary(r);
  const s = state.slugs.get(r.id);
  const remote = s ? s.remote : 'origin';
  const local = await git.refExists(r, `refs/heads/${branch}`);
  const remoteRef = await git.refExists(r, `refs/remotes/${remote}/${branch}`);
  if (!local && !remoteRef) return null;
  const tip = local ? `refs/heads/${branch}` : `refs/remotes/${remote}/${branch}`;
  const info = { id: r.id, label: r.label, local, remote: remoteRef, current: sum.branch === branch, dirty: sum.dirty, inProgress: sum.inProgress, defaultBranch: sum.defaultBranch };
  if (local && remoteRef) {
    const o = (await git.git(r, ['rev-list', '--left-right', '--count', `refs/heads/${branch}...refs/remotes/${remote}/${branch}`], { quiet: true })).stdout.trim().split(/\s+/).map(Number);
    info.ahead = o[0]; info.behind = o[1];
  }
  if (sum.defaultRemoteRef) {
    const o = (await git.git(r, ['rev-list', '--left-right', '--count', `${tip}...${sum.defaultRemoteRef}`], { quiet: true })).stdout.trim().split(/\s+/).map(Number);
    info.aheadDefault = o[0]; info.behindDefault = o[1];
    try { await git.git(r, ['merge-base', '--is-ancestor', tip, sum.defaultRemoteRef], { quiet: true }); info.merged = true; } catch { info.merged = false; }
  }
  return info;
}

const BULK = {
  fetch: { label: 'Fetch', check: () => null, run: (r) => git.fetch(r, { all: true }) },
  pull: {
    label: 'Pull',
    check: (s) => s.inProgress.length ? `${s.inProgress[0]} in progress` : s.detached ? 'detached HEAD' : !s.upstream ? 'no upstream' : s.dirty ? 'uncommitted changes' : s.behind === 0 ? 'already up to date' : null,
    run: (r) => git.pull(r, { strategy: config.get().pullStrategy }),
  },
  push: {
    label: 'Push',
    check: (s) => s.inProgress.length ? `${s.inProgress[0]} in progress` : s.detached ? 'detached HEAD' : s.upstream && s.ahead === 0 ? 'nothing to push' : s.upstream && s.behind > 0 ? 'behind upstream: pull first' : null,
    run: async (r) => { const res = await git.push(r, {}); await afterPush(r, res, `Push ${res.branch}`); return res; },
  },
  switch: {
    label: 'Switch branch',
    check: async (s, r, a) => {
      if (s.inProgress.length) return `${s.inProgress[0]} in progress`;
      if (s.branch === a.branch) return 'already on this branch';
      if (s.dirty) return 'uncommitted changes';
      const rem = (state.slugs.get(r.id) || {}).remote || 'origin';
      if (!(await git.refExists(r, `refs/heads/${a.branch}`)) && !(await git.refExists(r, `refs/remotes/${rem}/${a.branch}`))) return 'branch not found';
      return null;
    },
    run: async (r, a) => {
      if (await git.refExists(r, `refs/heads/${a.branch}`)) return git.switchBranch(r, { name: a.branch });
      const rem = (state.slugs.get(r.id) || {}).remote || 'origin';
      return git.switchBranch(r, { remoteRef: `${rem}/${a.branch}` });
    },
  },
  createBranch: {
    label: 'Create branch',
    check: async (s, r, a) => {
      if (!git.validBranchName(a.branch)) return 'invalid branch name';
      if (await git.refExists(r, `refs/heads/${a.branch}`)) return 'branch already exists';
      if (s.inProgress.length) return `${s.inProgress[0]} in progress`;
      if (a.fromDefault && !s.defaultRemoteRef && !s.defaultBranch) return 'default branch unknown';
      if (a.fromDefault && a.checkout && s.dirty) return 'uncommitted changes';
      return null;
    },
    run: (r, a, s) => git.createBranch(r, { name: a.branch, from: a.fromDefault ? (s.defaultRemoteRef || s.defaultBranch) : undefined, checkout: !!a.checkout }),
  },
  stash: {
    label: 'Stash changes',
    check: (s) => s.dirty ? (s.counts.conflicted ? 'has conflicts' : null) : 'nothing to stash',
    run: (r, a) => git.stashPush(r, { message: a.message || 'Repodeck bulk stash', includeUntracked: true }),
  },
  returnDefault: {
    label: 'Return to default branch',
    check: (s) => s.inProgress.length ? `${s.inProgress[0]} in progress` : !s.defaultBranch ? 'default branch unknown' : s.branch === s.defaultBranch ? 'already on default' : s.dirty ? 'uncommitted changes' : null,
    run: async (r, a, s) => {
      if (await git.refExists(r, `refs/heads/${s.defaultBranch}`)) await git.switchBranch(r, { name: s.defaultBranch });
      else await git.switchBranch(r, { remoteRef: s.defaultRemoteRef });
      if (a.pull) { const st = await git.summary(r); if (st.upstream && st.behind > 0) await git.pull(r, { strategy: 'ff-only' }); }
    },
  },
  deleteBranch: {
    label: 'Delete branch',
    check: async (s, r, a) => {
      if (!(await git.refExists(r, `refs/heads/${a.branch}`))) return 'branch not found';
      if (s.branch === a.branch) return 'it is the current branch';
      if (!a.force && s.defaultRemoteRef && !(await git.branchMergedInto(r, a.branch, s.defaultRemoteRef)) && !(await git.branchMergedInto(r, a.branch, 'HEAD'))) return 'not merged (enable "also unmerged" to force)';
      return null;
    },
    run: (r, a) => git.deleteBranch(r, { name: a.branch, force: !!a.force }),
  },
  updateFromDefault: {
    label: 'Update from default branch',
    check: (s) => s.inProgress.length ? `${s.inProgress[0]} in progress` : !s.defaultRemoteRef ? 'default branch unknown' : s.branch === s.defaultBranch ? 'on the default branch' : s.dirty ? 'uncommitted changes' : s.behindDefault === 0 ? 'already up to date' : s.detached ? 'detached HEAD' : null,
    run: (r, a, s) => (config.get().updateFromDefault === 'rebase' ? git.rebase(r, { onto: s.defaultRemoteRef }) : git.merge(r, { rev: s.defaultRemoteRef })),
  },
};

async function bulkPreview({ op, ids, args = {} }) {
  const def = BULK[op];
  if (!def) throw new Error('Unknown bulk operation');
  const results = await queue.pool(ids, 8, async (id) => {
    const r = state.get(id);
    const s = await git.summary(r);
    const reason = await def.check(s, r, args);
    return { id, label: r.label, branch: s.branch, skip: reason || null };
  });
  return results.map((x, i) => (x.ok ? x.value : { id: ids[i], skip: x.error.message }));
}

async function bulkRun({ op, ids, args = {} }) {
  const def = BULK[op];
  if (!def) throw new Error('Unknown bulk operation');
  const results = await queue.pool(ids, config.get().bulkConcurrency, async (id) => {
    const r = state.get(id);
    return queue.exclusive(r.id, `${def.label} (bulk)`, async () => {
      const s = await git.summary(r);
      const reason = await def.check(s, r, args); // re-check: state may have changed since the preview
      if (reason) return { id, label: r.label, status: 'skipped', message: reason };
      try {
        const out = await def.run(r, args, s);
        return { id, label: r.label, status: 'ok', message: (out && out.output) || '' };
      } catch (e) {
        return { id, label: r.label, status: 'failed', message: e.message };
      } finally { state.refresh(r.id); }
    });
  });
  return results.map((x, i) => (x.ok ? x.value : { id: ids[i], status: 'failed', message: x.error.message }));
}

// ---------------- the handler table ----------------

const H = {
  // ----- app -----
  'app.ping': () => ({ ok: true }),
  'config.get': () => ({ ...config.get(), _problem: config.problem() }),
  'config.update': async (p) => {
    const before = config.get();
    const cfg = config.update(p.patch);
    if (JSON.stringify(before.roots) !== JSON.stringify(cfg.roots) || JSON.stringify(before.ignore) !== JSON.stringify(cfg.ignore) || before.scanDepth !== cfg.scanDepth) {
      state.scan().then(state.refreshAll).then(state.pollBoard);
    }
    return cfg;
  },
  'activity.list': (p) => log.list(p.repoId ? repo({ id: p.repoId }).label : null, p.limit || 500),
  'fs.listDir': (p) => {
    const dir = p.dir ? path.resolve(p.dir) : null;
    if (!dir) {
      // drive roots on Windows
      const drives = [];
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { fs.accessSync(`${l}:\\`); drives.push({ name: `${l}:\\`, path: `${l}:\\` }); } catch {} }
      return { dir: null, parent: null, entries: drives };
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name), git: fs.existsSync(path.join(dir, e.name, '.git')) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
    return { dir, parent, entries };
  },
  'app.diagnostics': async () => {
    const v = async (cmd, args) => { try { return (await run(cmd, args, { quiet: true, timeout: 10_000, cwd: paths.neutral })).stdout.split('\n')[0].trim(); } catch (e) { return `not available (${e.message.split('\n')[0]})`; } };
    let accounts = [];
    try { accounts = (await gh.accounts(true)).map((a) => ({ host: a.host, login: a.login, active: a.active, state: a.state, scopes: a.scopes })); } catch {}
    return {
      git: await v('git', ['--version']), gh: await v('gh', ['--version']), node: process.version, platform: `${process.platform} ${require('node:os').release()}`,
      dataDir: paths.data, accounts, currentAccount: config.get().currentAccount,
      repos: state.list().length,
    };
  },
  'app.connectivity': async () => {
    const list = state.list();
    const owners = new Map();
    const res = await queue.pool(list, 6, async (r) => {
      const out = { id: r.id, label: r.label, remote: r.slug ? `${r.slug.host}:${r.slug.owner}/${r.slug.repo}` : null };
      if (!r.slug) return { ...out, git: 'no remote', gh: 'n/a' };
      try {
        await git.git(r, ['ls-remote', '--heads', r.slug.remote || 'origin', 'HEAD'], { quiet: true, timeout: 30_000 });
        out.git = 'ok';
      } catch (e) {
        const m = e.stderr || e.message;
        out.git = /Could not resolve hostname/i.test(m) ? `host "${r.slug.host}" not found: is it an alias missing from your SSH config?`
          : /Permission denied \(publickey\)/i.test(m) ? 'SSH key rejected: add your key to the agent and to GitHub'
            : /Host key verification failed/i.test(m) ? 'unknown host key: connect once with ssh to accept it'
              : /Authentication failed|could not read Username/i.test(m) ? 'HTTPS sign-in needed: run a git command once in a terminal or configure Git Credential Manager'
                : e.timedOut ? 'timed out (a password or passphrase prompt cannot be answered here)' : m.trim().split('\n').pop();
      }
      if (!r.slug.github) { out.gh = 'not a GitHub remote'; return out; }
      const key = r.slug.owner.toLowerCase();
      if (!owners.has(key)) owners.set(key, gh.checkAccess(r.slug));
      const a = await owners.get(key);
      out.gh = a.ok ? `ok (account ${a.login})` : `${a.kind === 'no-access' ? 'no access' : a.kind} with account ${a.login || '?'}: ${a.message || ''}`;
      return out;
    });
    return res.map((x) => (x.ok ? x.value : { error: x.error.message }));
  },
  'app.about': () => ({ version: require('../package.json').version, installDir: path.resolve(__dirname, '..'), logDir: paths.logs, dataDir: paths.data }),
  'app.quit': () => { setTimeout(() => process.exit(0), 200); return { ok: true }; },
  'app.boardVisible': (p) => { state.setBoardVisible(!!p.visible); return { ok: true }; },
  'open.url': (p) => { openExternal(p.url); return { ok: true }; },
  'open.explorer': (p) => { const r = repo(p); const target = p.file ? git.safeJoin(r.path, p.file) : r.path; spawn('explorer.exe', p.file ? [`/select,${target}`] : [target], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; },
  'open.terminal': (p) => { const r = repo(p); const c = config.get(); return launch(c.terminalCommand, c.terminalArgs, r.path); },
  'open.editor': (p) => {
    const r = repo(p); const c = config.get();
    const target = p.file ? git.safeJoin(r.path, p.file) : r.path;
    return launch(c.editorCommand, c.editorArgs.map((a) => String(a).split('{path}').join(target)), r.path);
  },

  // ----- repositories -----
  'repos.list': () => ({ repos: state.list(), roots: config.get().roots }),
  'repos.scan': async () => { await state.scan(); state.refreshAll().then(state.pollBoard); return { repos: state.list() }; },
  'repos.refresh': async (p) => { if (p.id) await state.refresh(p.id); else await state.refreshAll(); return { ok: true }; },
  'repo.summary': async (p) => state.refresh(p.id),
  'repo.remotes': (p) => git.remotes(repo(p)),
  'repo.addRemote': (p) => mutate(p, 'Add remote', (r) => git.addRemote(r, p)).then(() => state.resolveSlug(repo(p))),
  'repo.setRemoteUrl': (p) => mutate(p, 'Change remote', (r) => git.setRemoteUrl(r, p)).then(() => state.resolveSlug(repo(p))),
  'repo.removeRemote': (p) => mutate(p, 'Remove remote', (r) => git.removeRemote(r, p)).then(() => state.resolveSlug(repo(p))),
  'repo.clone': async (p) => {
    const dest = path.resolve(p.parent, p.name);
    if (!underRoot(dest)) throw new Error('Clone into a folder inside one of your configured root folders.');
    if (!/^[^<>:"|?*\\/]+$/.test(p.name)) throw new Error('Invalid folder name');
    await git.clone({ url: p.url, dest });
    await state.scan(); state.refreshAll();
    return { path: dest };
  },
  'account.list': async () => {
    await state.ensureAccount(); // the open account must be decided before anything is listed
    const r = await require('./accounts').list();
    const cfg = config.get();
    const open = new Set((await require('./instances').others()).map((i) => i.account));
    return { ...r, current: cfg.currentAccount, accounts: r.accounts.map((acc) => ({ ...acc, current: acc.login === cfg.currentAccount, elsewhere: open.has(acc.login), folders: (cfg.accountRoots[acc.login] || []).length })) };
  },
  'account.login': () => require('./accounts').startLogin(),
  'account.loginStatus': () => require('./accounts').loginStatus(),
  'account.loginCancel': (p) => require('./accounts').cancelLogin(p.sessionId),
  // Open that account's workspace in Repodeck. Does not change which account gh uses in a terminal.
  'account.use': async (p) => {
    const inst = require('./instances');
    if (p.login && await inst.find(p.login)) { const e = new Error(`${p.login} is already open in another window. Only one window per account is allowed.`); e.kind = 'open-elsewhere'; throw e; }
    await state.switchAccount(p.login);
    inst.rename(config.get().currentAccount);
    return H['account.list']();
  },
  // A second window for another account, or bring that account's window forward if it has one.
  'account.openWindow': async (p) => {
    if (!/^[A-Za-z0-9-]+$/.test(p.login || '')) throw new Error('Invalid account name');
    const inst = require('./instances');
    const running = await inst.find(p.login);
    if (running) { await inst.rpc(running, 'app.focusWindow', {}, 20_000); return { focused: true }; }
    spawn(process.execPath, [path.join(__dirname, 'main.js'), '--account', p.login], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.join(__dirname, '..') }).unref();
    return { started: true };
  },
  'app.focusWindow': () => require('./window').focusOrOpen(),
  'app.title': () => require('./window').title(),
  // Also make it the default for the gh command in terminals.
  'account.makeDefault': async (p) => { await require('./accounts').switchTo(p.login); return H['account.list'](); },
  'account.logout': async (p) => {
    await require('./accounts').logout(p.login);
    if (config.get().currentAccount === p.login) { await state.switchAccount(await pickOther()); require('./instances').rename(config.get().currentAccount); }
    return H['account.list']();
  },
  'account.identity': () => require('./accounts').identity(),
  'account.setIdentity': (p) => require('./accounts').setIdentity(p),
  'account.noreply': (p) => require('./accounts').noreply(p.login),
  'setup.discover': () => require('./discover').discover(),
  // Which GitHub repositories already exist inside these folders (before they are added to the workspace).
  'setup.slugs': async (p) => {
    const scanner = require('./scanner');
    const cfg = config.get();
    const found = await scanner.scanAll((p.paths || []).map((x) => ({ path: x })), { ignore: cfg.ignore, depth: cfg.scanDepth });
    const res = await queue.pool(found, 8, async (r) => { const sl = await git.githubSlug({ ...r, name: path.basename(r.path) }); return sl ? { slug: `${sl.owner}/${sl.repo}`, host: sl.host, path: r.path } : null; });
    return res.filter((x) => x.ok && x.value).map((x) => x.value);
  },
  // Host aliases from the user's ssh config (names only), and the hosts this account's repositories already use.
  'ssh.hosts': async () => {
    const out = new Set();
    try {
      const txt = fs.readFileSync(path.join(require('node:os').homedir(), '.ssh', 'config'), 'utf8');
      for (const m of txt.matchAll(/^\s*Host\s+(.+)$/gim)) for (const hname of m[1].trim().split(/\s+/)) if (!/[*?!]/.test(hname)) out.add(hname);
    } catch {}
    const used = new Map();
    for (const sl of state.slugs.values()) if (sl && sl.host && sl.host !== 'github.com') used.set(sl.host, (used.get(sl.host) || 0) + 1);
    return { hosts: [...out].filter((x) => P.looksLikeGitHub(x)), used: [...used].sort((x, y) => y[1] - x[1]).map(([host, count]) => ({ host, count })) };
  },
  'gh.repoListAll': () => gh.repoListAll(),
  'repo.cloneMany': async (p) => {
    const parent = path.resolve(p.parent);
    if (!underRoot(parent)) throw new Error('Clone into one of your repository folders (add the folder first).');
    const out = [];
    for (const it of p.items || []) {
      const name = String(it.name || '').trim();
      try {
        if (!/^[^<>:"|?*\\/]+$/.test(name)) throw new Error('Invalid folder name');
        await git.clone({ url: it.url, dest: path.join(parent, name) });
        out.push({ name, status: 'ok' });
      } catch (e) { out.push({ name, status: 'failed', message: (e.stderr || e.message || '').trim().split('\n').slice(-3).join('\n') }); }
    }
    await state.scan(); state.refreshAll().then(state.pollBoard);
    return out;
  },
  'repo.init': async (p) => {
    const dir = path.resolve(p.dir);
    if (!underRoot(dir)) throw new Error('Create the repository inside one of your configured root folders.');
    await git.init({ dir });
    await state.scan(); state.refreshAll();
    return { path: dir };
  },
  'repo.gitignore': (p) => mutate(p, 'Add to .gitignore', (r) => git.addToGitignore(r, p.pattern)),
  'repo.worktrees': (p) => git.worktrees(repo(p)),
  'repo.addWorktree': (p) => mutate(p, 'Add worktree', (r) => git.addWorktree(r, p)).then(async (x) => { await state.scan(); return x; }),
  'repo.removeWorktree': (p) => mutate(p, 'Remove worktree', (r) => git.removeWorktree(r, p)).then(async (x) => { await state.scan(); return x; }),
  'repo.submodules': (p) => git.submodules(repo(p)),
  'repo.updateSubmodules': (p) => mutate(p, 'Update submodules', (r) => git.updateSubmodules(r)),

  // ----- changes & diff -----
  'repo.changes': async (p) => {
    const r = repo(p);
    const c = await git.changes(r);
    return { ...c, summary: await state.refresh(r.id) };
  },
  'repo.diff': async (p) => {
    const r = repo(p);
    const text = await git.fileDiff(r, p);
    const d = presentDiff(text, { full: p.full });
    const file = p.file || (d.files[0] && d.files[0].path);
    if (file && IMAGE_EXT.test(file)) d.image = true;
    return d;
  },
  'repo.image': async (p) => {
    const r = repo(p);
    const ext = (p.file.split('.').pop() || '').toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    let buf = null;
    try {
      if (p.rev === 'WORKTREE') buf = fs.readFileSync(git.safeJoin(r.path, p.file));
      else if (p.rev === 'INDEX') buf = (await git.git(r, ['show', `:${p.file.replace(/\\/g, '/')}`], { quiet: true, binary: true })).stdout;
      else buf = await git.fileAt(r, p.rev, p.file);
    } catch { return { data: null }; }
    if (buf.length > 20 * 1024 * 1024) return { data: null, tooLarge: true };
    if (mime === 'image/svg+xml') return { data: null, svgText: buf.toString('utf8').slice(0, 200_000) };
    return { data: `data:${mime};base64,${buf.toString('base64')}` };
  },
  'repo.stage': (p) => mutate(p, 'Stage', (r) => git.stage(r, p.files)),
  'repo.stageAll': (p) => mutate(p, 'Stage all', (r) => git.stageAll(r)),
  'repo.unstage': (p) => mutate(p, 'Unstage', (r) => git.unstage(r, p.files)),
  'repo.unstageAll': (p) => mutate(p, 'Unstage all', (r) => git.unstageAll(r)),
  'repo.applySelection': (p) => mutate(p, p.action === 'stage' ? 'Stage selection' : p.action === 'unstage' ? 'Unstage selection' : 'Discard selection', (r) => git.applySelection(r, p)),
  'repo.discard': (p) => mutate(p, 'Discard changes', (r) => git.discard(r, p)),
  'repo.discardAll': (p) => mutate(p, 'Discard all changes', (r) => git.discardAll(r, p)),
  'repo.backups': (p) => git.listBackups(repo(p)),
  'repo.restoreBackup': (p) => mutate(p, 'Restore discarded changes', (r) => git.restoreBackup(r, p.backupId)),

  // ----- commit -----
  'repo.commit': async (p) => {
    const res = await mutate(p, 'Commit', (r) => git.commit(r, p));
    if (p.then === 'push' || p.then === 'sync') {
      const r = repo(p);
      const pushed = await mutate(p, p.then === 'sync' ? 'Sync' : 'Push', (rr) => (p.then === 'sync' ? git.sync(rr, { strategy: config.get().pullStrategy }) : git.push(rr, {})));
      await afterPush(r, pushed, `Commit and ${p.then}: ${(p.message || '').split('\n')[0]}`);
      return { ...res, pushed };
    }
    return res;
  },
  'repo.lastMessage': (p) => git.lastCommitMessage(repo(p)),
  'repo.undoCommit': (p) => mutate(p, 'Undo last commit', (r) => git.undoLastCommit(r)),
  'repo.reword': (p) => mutate(p, 'Reword commit', (r) => git.rewordLast(r, p.message)),
  'repo.squash': (p) => mutate(p, 'Squash commits', (r) => git.squashLast(r, p.count, p.message)),
  'repo.unpushedCount': (p) => git.unpushedCount(repo(p)),
  'repo.unpushedLog': async (p) => {
    const r = repo(p);
    const n = await git.unpushedCount(r);
    if (!n) return [];
    return P.parseLog((await git.git(r, ['log', `--format=${P.LOG_FORMAT}`, `-n${Math.min(n, 50)}`, 'HEAD'], { quiet: true })).stdout);
  },

  // ----- sync -----
  'repo.fetch': (p) => mutate(p, p.prune ? 'Fetch (prune)' : 'Fetch', (r) => git.fetch(r, { prune: !!p.prune, all: true })),
  'repo.pull': (p) => mutate(p, 'Pull', (r) => git.pull(r, { strategy: p.strategy || config.get().pullStrategy })),
  'repo.push': async (p) => {
    const r = repo(p);
    const res = await mutate(p, p.forceWithLease ? 'Force push (with lease)' : 'Push', (rr) => git.push(rr, { forceWithLease: !!p.forceWithLease, setUpstream: !!p.setUpstream, remote: p.remote }));
    await afterPush(r, res, `Push ${res.branch}`);
    return res;
  },
  'repo.pushTags': (p) => mutate(p, 'Push tags', (r) => git.push(r, { tags: true, remote: p.remote })),
  'repo.sync': async (p) => {
    const r = repo(p);
    const res = await mutate(p, 'Sync', (rr) => git.sync(rr, { strategy: config.get().pullStrategy }));
    await afterPush(r, res, `Sync ${res.branch}`);
    return res;
  },

  // ----- branches, tags, refs -----
  'repo.refs': async (p) => {
    const r = repo(p);
    const [refs, sum] = await Promise.all([git.refs(r), git.summary(r)]);
    let merged = [];
    if (sum.defaultRemoteRef) merged = await git.mergedBranches(r, sum.defaultRemoteRef).catch(() => []);
    for (const b of refs.local) b.merged = merged.includes(b.name);
    return { ...refs, defaultBranch: sum.defaultBranch, defaultRemoteRef: sum.defaultRemoteRef, current: sum.branch };
  },
  'branch.create': (p) => mutate(p, 'Create branch', (r) => git.createBranch(r, p)),
  'branch.switch': (p) => mutate(p, 'Switch branch', (r) => git.switchBranch(r, p)),
  'branch.rename': (p) => mutate(p, 'Rename branch', (r) => git.renameBranch(r, p)),
  'branch.delete': (p) => mutate(p, 'Delete branch', (r) => git.deleteBranch(r, p)),
  'branch.deleteRemote': (p) => mutate(p, 'Delete remote branch', (r) => git.deleteRemoteBranch(r, p)),
  'branch.setUpstream': (p) => mutate(p, 'Set upstream', (r) => git.setUpstream(r, p)),
  'branch.merge': (p) => mutate(p, 'Merge', (r) => git.merge(r, p)),
  'branch.rebase': (p) => mutate(p, 'Rebase', (r) => git.rebase(r, p)),
  'branch.compare': (p) => git.compareBranches(repo(p), p.a, p.b),
  'branch.isMerged': async (p) => {
    const r = repo(p);
    const s = await git.summary(r);
    const target = s.defaultRemoteRef || 'HEAD';
    return { merged: await git.branchMergedInto(r, p.name, target) || await git.branchMergedInto(r, p.name, 'HEAD'), target };
  },
  'tag.create': (p) => mutate(p, 'Create tag', (r) => git.createTag(r, p)),
  'tag.delete': (p) => mutate(p, 'Delete tag', (r) => git.deleteTag(r, p)),
  'tag.push': (p) => mutate(p, 'Push tag', (r) => git.pushTag(r, p)),
  'tag.deleteRemote': (p) => mutate(p, 'Delete remote tag', (r) => git.deleteRemoteTag(r, p)),

  // ----- stash -----
  'stash.list': (p) => git.stashList(repo(p)),
  'stash.push': (p) => mutate(p, 'Stash', (r) => git.stashPush(r, p)),
  'stash.apply': (p) => mutate(p, p.pop ? 'Pop stash' : 'Apply stash', (r) => git.stashApply(r, p)),
  'stash.drop': (p) => mutate(p, 'Drop stash', (r) => git.stashDrop(r, p)),
  'stash.clear': (p) => mutate(p, 'Clear stashes', (r) => git.stashClear(r)),
  'stash.branch': (p) => mutate(p, 'Branch from stash', (r) => git.stashBranch(r, p)),
  'stash.files': (p) => git.stashFiles(repo(p), p.ref),

  // ----- history & graph -----
  'repo.log': async (p) => {
    const r = repo(p);
    const commits = await git.log(r, p);
    let extra = [];
    if (p.grep && /^[0-9a-f]{4,40}$/i.test(p.grep) && !p.skip) extra = await git.searchByHash(r, p.grep);
    return { commits: [...extra.filter((e) => !commits.some((c) => c.hash === e.hash)), ...commits] };
  },
  'repo.graphMeta': async (p) => {
    const r = repo(p);
    const [refs, stashes, sum] = await Promise.all([git.refs(r), git.stashList(r), git.summary(r)]);
    return { refs, stashes, summary: sum, head: sum.oid };
  },
  'repo.commit.detail': (p) => git.commitDetail(repo(p), p.rev),
  'repo.compareFiles': (p) => git.changedFiles(repo(p), { from: p.from, to: p.to }),
  'repo.blame': (p) => git.blame(repo(p), p.file, p.rev),
  'repo.fileHistory': (p) => git.log(repo(p), { file: p.file, follow: true, limit: p.limit || 200, skip: p.skip || 0 }),
  'repo.fileAt': async (p) => {
    const buf = await git.fileAt(repo(p), p.rev, p.file);
    if (buf.includes(0)) return { binary: true, size: buf.length };
    return { text: buf.toString('utf8').slice(0, 2_000_000), size: buf.length };
  },
  'commit.checkout': (p) => mutate(p, 'Checkout commit', (r) => git.checkoutDetached(r, p.rev)),
  'commit.cherryPick': (p) => mutate(p, 'Cherry-pick', (r) => git.cherryPick(r, p)),
  'commit.revert': (p) => mutate(p, 'Revert', (r) => git.revert(r, p)),
  'commit.reset': (p) => mutate(p, `Reset (${p.mode})`, (r) => git.reset(r, p)),
  'commit.drop': (p) => mutate(p, 'Drop commit', (r) => git.dropCommit(r, p)),
  'op.continue': (p) => mutate(p, `Continue ${p.op}`, (r) => git.continueOp(r, p.op)),
  'op.abort': (p) => mutate(p, `Abort ${p.op}`, (r) => git.abortOp(r, p.op)),
  'op.skip': (p) => mutate(p, `Skip (${p.op})`, (r) => git.skipOp(r, p.op)),

  // ----- conflicts -----
  'conflict.get': (p) => git.conflictFile(repo(p), p.file),
  'conflict.resolve': (p) => mutate(p, 'Resolve conflicts', (r) => git.resolveConflictFile(r, p)),
  'conflict.take': (p) => mutate(p, `Take ${p.side}`, (r) => git.takeSide(r, p)),
  'conflict.acceptDeletion': (p) => mutate(p, 'Accept deletion', (r) => git.acceptDeletion(r, p)),
  'conflict.markResolved': (p) => mutate(p, 'Mark resolved', (r) => git.markResolved(r, p.files)),

  // ----- GitHub: general -----
  'gh.accounts': () => gh.accounts(true).then((l) => l.map((a) => ({ host: a.host, login: a.login, active: a.active, state: a.state, scopes: a.scopes }))),
  'gh.access': (p) => gh.checkAccess(slug(p)),
  'gh.meta': (p) => gh.repoMeta(slug(p)),
  'gh.repoList': (p) => gh.repoList(p.owner, p.login),
  'gh.collaborators': (p) => gh.collaborators(slug(p)),
  'gh.labels': (p) => gh.labels(slug(p)),
  'gh.milestones': (p) => gh.milestones(slug(p)),

  // ----- pull requests -----
  'pr.list': (p) => gh.prList(slug(p), p),
  'pr.view': async (p) => {
    const s = slug(p);
    const pr = await gh.prView(s, p.number);
    const r = repo(p);
    const local = await git.refs(r).catch(() => ({ local: [] }));
    pr.localBranch = (local.local.find((b) => !pr.isCrossRepository && b.name === pr.headRefName) || {}).name || null;
    return pr;
  },
  'pr.diff': async (p) => presentDiff(Buffer.from(await gh.prDiff(slug(p), p.number), 'utf8').toString('latin1'), { full: p.full }),
  'pr.threads': (p) => gh.prThreads(slug(p), p.number),
  'pr.forBranch': async (p) => {
    const s = slug(p);
    const list = await gh.prList(s, { filter: 'recent', search: `head:${p.branch}`, limit: 5 });
    return list.filter((x) => x.headRefName === p.branch);
  },
  'pr.prefill': async (p) => {
    const r = repo(p);
    const s = slug(p);
    const sum = await git.summary(r);
    const meta = await gh.repoMeta(s).catch(() => null);
    const base = p.base || (meta && meta.default_branch) || sum.defaultBranch || 'main';
    const rem = s.remote || 'origin';
    const baseRef = (await git.refExists(r, `refs/remotes/${rem}/${base}`)) ? `${rem}/${base}` : base;
    let commits = [];
    try { commits = P.parseLog((await git.git(r, ['log', `--format=${P.LOG_FORMAT}`, '-n50', `${baseRef}..HEAD`], { quiet: true })).stdout); } catch {}
    const template = await gh.prTemplate(s, base);
    const title = commits.length === 1 ? commits[0].subject : (sum.branch || '').replace(/^[^/]+\//, '').replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    let body = template;
    if (!body && commits.length > 1) body = commits.slice().reverse().map((c) => `- ${c.subject}`).join('\n');
    if (commits.length === 1 && !template) {
      const full = (await git.git(r, ['log', '-1', '--format=%b', commits[0].hash], { quiet: true })).stdout.trim();
      body = full;
    }
    // Branches made from an issue ("123-short-title") link back to it so merging closes the issue.
    const issue = /^(?:[^/]+\/)?(\d+)[-_]/.exec(sum.branch || '');
    if (issue && !/\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #\d+/i.test(body)) body = `${body ? `${body}\n\n` : ''}Closes #${issue[1]}`;
    return { base, head: sum.branch, title, body, commits, needsPush: !sum.upstream || sum.ahead > 0, upstream: sum.upstream, ahead: sum.ahead };
  },
  'pr.create': async (p) => {
    const r = repo(p);
    const s = slug(p);
    const sum = await git.summary(r);
    if (p.pushFirst && (!sum.upstream || sum.ahead > 0)) {
      const res = await mutate(p, 'Push', (rr) => git.push(rr, { setUpstream: !sum.upstream, remote: s.remote }));
      await afterPush(r, res, `Push ${res.branch}`);
    }
    return gh.prCreate(s, { ...p, head: p.head || sum.branch });
  },
  'pr.comment': (p) => gh.prComment(slug(p), p.number, p.body),
  'pr.editComment': (p) => (p.review ? gh.editReviewComment(slug(p), p.commentId, p.body) : gh.editIssueComment(slug(p), p.commentId, p.body)),
  'pr.deleteComment': (p) => (p.review ? gh.deleteReviewComment(slug(p), p.commentId) : gh.deleteIssueComment(slug(p), p.commentId)),
  'pr.reply': (p) => gh.replyReviewComment(slug(p), p.number, p.commentId, p.body),
  'pr.resolveThread': (p) => gh.setThreadResolved(slug(p), p.threadId, !!p.resolved),
  'pr.viewed': (p) => gh.setFileViewed(slug(p), p.prId, p.path, !!p.viewed),
  'pr.draft.get': (p) => readDraft(p),
  'pr.draft.add': (p) => {
    const d = readDraft(p);
    d.comments.push({ id: `c${Date.now()}`, path: p.path, line: +p.line, side: p.side || 'RIGHT', startLine: p.startLine ? +p.startLine : null, startSide: p.startSide || null, body: p.body });
    writeDraft(p, d);
    return d;
  },
  'pr.draft.remove': (p) => { const d = readDraft(p); d.comments = d.comments.filter((c) => c.id !== p.commentId); writeDraft(p, d); return d; },
  'pr.draft.update': (p) => { const d = readDraft(p); const c = d.comments.find((x) => x.id === p.commentId); if (c) c.body = p.body; writeDraft(p, d); return d; },
  'pr.review': async (p) => {
    const d = readDraft(p);
    const res = await gh.submitReview(slug(p), p.number, { event: p.event, body: p.body, comments: d.comments, commitId: p.commitId });
    writeDraft(p, { comments: [] }); // cleared only after GitHub accepted it
    return res;
  },
  'pr.edit': (p) => gh.prEdit(slug(p), p.number, p),
  'pr.ready': (p) => gh.prReady(slug(p), p.number, !!p.ready),
  'pr.close': (p) => gh.prClose(slug(p), p.number),
  'pr.reopen': (p) => gh.prReopen(slug(p), p.number),
  'pr.updateBranch': (p) => gh.prUpdateBranch(slug(p), p.number),
  'pr.disableAuto': (p) => gh.prDisableAuto(slug(p), p.number),
  'pr.merge': async (p) => {
    const s = slug(p);
    const res = await gh.prMerge(s, p.number, p);
    if (!p.auto) trackMergeCommit(p.id, s, p.number);
    return res;
  },
  'pr.checkout': (p) => mutate(p, `Check out PR #${p.number}`, async (r) => {
    const s = slug(p);
    const pr = await gh.prView(s, p.number);
    const rem = s.remote || 'origin';
    const st = await git.status(r);
    if (st.staged.length + st.unstaged.length && p.mode !== 'carry' && p.mode !== 'stash') {
      const e = new Error('You have uncommitted changes.'); e.kind = 'dirty'; throw e;
    }
    if (p.mode === 'stash' && st.staged.length + st.unstaged.length + st.untracked.length) await git.stashPush(r, { message: `Repodeck: before checking out PR #${pr.number}`, includeUntracked: true });
    if (!pr.isCrossRepository) {
      await git.fetch(r, { remote: rem });
      return git.switchBranch(r, { name: pr.headRefName, remoteRef: `${rem}/${pr.headRefName}` });
    }
    const local = `pr-${pr.number}-${pr.headRefName}`.replace(/[^A-Za-z0-9._/-]/g, '-');
    await git.git(r, ['fetch', rem, `refs/pull/${pr.number}/head`], { timeout: 5 * 60_000 });
    if (await git.refExists(r, `refs/heads/${local}`)) {
      await git.git(r, ['switch', local]);
      await git.git(r, ['merge', '--ff-only', 'FETCH_HEAD']);
    } else await git.git(r, ['switch', '-c', local, 'FETCH_HEAD']);
    return { branch: local, note: 'This PR comes from a fork; the local branch has no upstream, so pushes go nowhere unless you add the fork as a remote.' };
  }),

  // ----- issues -----
  'issue.list': (p) => gh.issueList(slug(p), p),
  'issue.view': (p) => gh.issueView(slug(p), p.number),
  'issue.create': (p) => gh.issueCreate(slug(p), p),
  'issue.comment': (p) => gh.issueComment(slug(p), p.number, p.body),
  'issue.close': (p) => gh.issueClose(slug(p), p.number, p.reason),
  'issue.reopen': (p) => gh.issueReopen(slug(p), p.number),
  'issue.edit': (p) => gh.issueEdit(slug(p), p.number, p),
  'issue.branch': (p) => mutate(p, `Branch for issue #${p.number}`, async (r) => {
    const sum = await git.summary(r);
    const name = p.name;
    if (!git.validBranchName(name)) throw new Error('Invalid branch name');
    await git.createBranch(r, { name, from: p.fromDefault ? (sum.defaultRemoteRef || sum.defaultBranch) : undefined, checkout: true });
    return { branch: name };
  }),

  // ----- actions -----
  'run.list': (p) => gh.runList(slug(p), p),
  'run.view': (p) => gh.runView(slug(p), p.runId),
  'run.log': async (p) => {
    const text = await gh.runLog(slug(p), p.runId, p);
    const max = 3_000_000;
    return { text: text.length > max ? text.slice(-max) : text, truncated: text.length > max };
  },
  'run.rerun': async (p) => { await gh.runRerun(slug(p), p.runId, p); if (p.track !== false) state.trackRun({ repoId: p.id, slug: slug(p), runId: p.runId, title: `Re-run ${p.title || p.runId}` }); },
  'run.cancel': (p) => gh.runCancel(slug(p), p.runId),
  'run.track': (p) => state.trackRun({ repoId: p.id, slug: slug(p), runId: p.runId, title: p.title }),
  'workflow.list': (p) => gh.workflows(slug(p)),
  'workflow.inputs': async (p) => P.parseDispatchInputs(await gh.workflowYaml(slug(p), p.workflowId, p.ref)),
  'workflow.dispatch': async (p) => {
    const s = slug(p);
    await gh.workflowDispatch(s, p.workflowId, p.ref, p.inputs);
    // the run appears after a moment; track the newest dispatch run on that ref
    setTimeout(async () => {
      try {
        const runs = await gh.runList(s, { workflow: p.workflowId, branch: p.ref, event: 'workflow_dispatch', limit: 1 });
        if (runs[0]) state.trackRun({ repoId: p.id, slug: s, runId: runs[0].databaseId, title: `Dispatched ${runs[0].workflowName}` });
      } catch {}
    }, 6000);
  },
  'deploy.list': (p) => gh.deployments(slug(p)),
  'board.get': () => state.board(),
  'board.refresh': async () => { await state.pollBoard(); return state.board(); },
  'trackers.list': () => state.trackers(),
  'trackers.remove': (p) => state.removeTracker(p.trackerId),
  'trackers.clearDone': () => state.clearDoneTrackers(),
  'trackers.refresh': async () => { await state.pollTrackers(); return state.trackers(); },
  'myprs.get': () => state.myPrsSnapshot(),
  'myprs.refresh': async () => { await state.pollMyPrs(); return state.myPrsSnapshot(); },

  // ----- multi-repo -----
  'feature.find': async (p) => {
    if (!git.validBranchName(p.branch)) throw new Error('Invalid branch name');
    const all = [...state.repos.values()];
    const res = await queue.pool(all, 8, (r) => repoBranchInfo(r, p.branch));
    const found = res.filter((x) => x.ok && x.value).map((x) => x.value);
    if (p.withPrs) {
      await queue.pool(found, 6, async (f) => {
        try {
          const s = state.slugOf(f.id);
          const prs = await gh.prList(s, { filter: 'recent', search: `head:${p.branch}`, limit: 5 });
          f.pr = prs.find((x) => x.headRefName === p.branch) || null;
        } catch (e) { f.prError = e.message; }
      });
    }
    return found;
  },
  'feature.branches': async () => {
    // branch names that exist in more than one repo, most widespread first
    const counts = new Map();
    await queue.pool([...state.repos.values()], 8, async (r) => {
      const o = (await git.git(r, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { quiet: true })).stdout;
      for (const b of o.split('\n').filter(Boolean)) counts.set(b, (counts.get(b) || 0) + 1);
    });
    return [...counts].filter(([b]) => !['main', 'master', 'develop', 'trunk'].includes(b)).sort((a, b) => b[1] - a[1]).slice(0, 100).map(([name, count]) => ({ name, count }));
  },
  'feature.createPrs': async (p) => {
    const results = [];
    for (const id of p.ids) {
      try {
        const r = state.get(id);
        const s = state.slugOf(id);
        const sum = await git.summary(r);
        if (sum.branch !== p.branch) {
          if (!(await git.refExists(r, `refs/remotes/${s.remote || 'origin'}/${p.branch}`))) throw new Error('branch not pushed and not checked out');
        } else if (!sum.upstream || sum.ahead > 0) {
          const res = await queue.exclusive(r.id, 'Push', () => git.git(r, ['push', '-u', s.remote || 'origin', `refs/heads/${p.branch}:refs/heads/${p.branch}`], { timeout: 5 * 60_000 }));
          void res;
        }
        const meta = await gh.repoMeta(s).catch(() => null);
        const base = (meta && meta.default_branch) || sum.defaultBranch;
        const pr = await gh.prCreate(s, { head: p.branch, base, title: p.title, body: p.body, draft: p.draft });
        results.push({ id, label: r.label, status: 'ok', ...pr, slug: s });
      } catch (e) {
        results.push({ id, label: state.repos.get(id) ? state.repos.get(id).label : id, status: 'failed', message: e.message });
      }
    }
    const ok = results.filter((x) => x.status === 'ok');
    if (ok.length > 1 && p.crossLink !== false) {
      const links = ok.map((x) => `- ${x.slug.owner}/${x.slug.repo}#${x.number}`).join('\n');
      for (const x of ok) {
        try {
          const others = links.split('\n').filter((l) => !l.endsWith(`${x.slug.owner}/${x.slug.repo}#${x.number}`)).join('\n');
          await gh.prEdit(x.slug, x.number, { body: `${p.body || ''}\n\n---\nRelated pull requests:\n${others}\n` });
        } catch (e) { x.message = `Created, but could not add cross-links: ${e.message}`; }
      }
    }
    return results.map(({ slug: _s, ...rest }) => rest);
  },
  'feature.mergePrs': async (p) => {
    // p.items: [{ id, number, headOid }], merged in order, stopping at the first failure
    const results = [];
    let stopped = false;
    for (const it of p.items) {
      const label = state.repos.get(it.id) ? state.repos.get(it.id).label : it.id;
      if (stopped) { results.push({ ...it, label, status: 'skipped', message: 'not attempted because an earlier merge failed' }); continue; }
      try {
        const s = state.slugOf(it.id);
        const res = await gh.prMerge(s, it.number, { method: p.method, headOid: it.headOid, deleteBranch: p.deleteBranch, headRef: p.branch });
        trackMergeCommit(it.id, s, it.number);
        results.push({ ...it, label, status: 'ok', message: res.deleteError ? `merged; branch not deleted: ${res.deleteError}` : 'merged' });
      } catch (e) {
        results.push({ ...it, label, status: 'failed', message: e.message });
        stopped = true;
      }
    }
    return results;
  },
  'bulk.ops': () => Object.fromEntries(Object.entries(BULK).map(([k, v]) => [k, v.label])),
  'bulk.preview': (p) => bulkPreview(p),
  'bulk.run': (p) => bulkRun(p),
  'cleanup.list': async () => {
    const all = [...state.repos.values()];
    const res = await queue.pool(all, 8, async (r) => {
      const [refs, sum] = await Promise.all([git.refs(r), git.summary(r)]);
      const merged = sum.defaultRemoteRef ? await git.mergedBranches(r, sum.defaultRemoteRef).catch(() => []) : [];
      return refs.local
        .filter((b) => b.name !== sum.branch && b.name !== sum.defaultBranch && (b.gone || merged.includes(b.name)))
        .map((b) => ({ id: r.id, label: r.label, branch: b.name, gone: b.gone, merged: merged.includes(b.name), time: b.time, subject: b.subject, upstream: b.upstream }));
    });
    return res.filter((x) => x.ok).flatMap((x) => x.value);
  },
  'cleanup.delete': async (p) => {
    // p.items: [{ id, branch, force }]; force only for "upstream gone" branches the user ticked explicitly
    const out = [];
    for (const it of p.items) {
      const r = state.get(it.id);
      try {
        await queue.exclusive(r.id, 'Delete branch', () => git.deleteBranch(r, { name: it.branch, force: !!it.force }));
        out.push({ ...it, label: r.label, status: 'ok' });
      } catch (e) { out.push({ ...it, label: r.label, status: 'failed', message: e.message }); }
      state.refresh(r.id);
    }
    return out;
  },
  'overview.get': () => state.list().filter((r) => r.summary).map((r) => ({
    id: r.id, label: r.label, branch: r.summary.branch, defaultBranch: r.summary.defaultBranch, dirty: r.summary.dirty,
    ahead: r.summary.ahead, behind: r.summary.behind, unpushed: r.summary.unpushed, stash: r.summary.stash, upstream: r.summary.upstream,
    behindDefault: r.summary.behindDefault, inProgress: r.summary.inProgress, detached: r.summary.detached,
  })),
  'search.commits': async (p) => {
    const all = [...state.repos.values()];
    const res = await queue.pool(all, 8, async (r) => {
      const commits = await git.log(r, { grep: p.grep, author: p.author, since: p.since, until: p.until, limit: p.limit || 30, remotes: true, tags: false });
      return commits.map((c) => ({ ...c, repoId: r.id, repo: r.label }));
    });
    return res.filter((x) => x.ok).flatMap((x) => x.value).sort((a, b) => b.commitTime - a.commitTime).slice(0, 300);
  },
};

async function pickOther() {
  const accs = (await gh.accounts(true)).filter((acc) => acc.host === 'github.com');
  return (accs.find((acc) => acc.active) || accs[0] || { login: '' }).login;
}

/** After a PR merge, wait for GitHub to report the merge commit, then track its runs. */
function trackMergeCommit(id, s, number, attempt = 0) {
  setTimeout(async () => {
    try {
      const m = await gh.prMergeCommit(s, number);
      if (m.state === 'MERGED' && m.mergeCommit && m.mergeCommit.oid) {
        state.addTracker({ repoId: id, slug: s, sha: m.mergeCommit.oid, branch: m.baseRefName, reason: `Merged PR #${number} into ${m.baseRefName}`, pr: number });
        return;
      }
    } catch {}
    if (attempt < 20) trackMergeCommit(id, s, number, attempt + 1);
  }, attempt === 0 ? 1500 : 15_000);
}

async function call(method, params) {
  const fn = Object.prototype.hasOwnProperty.call(H, method) ? H[method] : null;
  if (!fn) { const e = new Error(`Unknown method ${method}`); e.status = 404; throw e; }
  const v = await fn(params || {});
  return v === undefined ? { ok: true } : v;
}

module.exports = { call, methods: Object.keys(H), presentDiff };
