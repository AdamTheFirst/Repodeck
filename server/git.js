// All git operations. Every command is spawned with an argument array (see proc.js).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { run, ProcError } = require('./proc');
const P = require('./parse');
const { paths } = require('./paths');
const config = require('./config');
const unreachable = require('./unreachable');

const GIT_BASE = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.pager=cat',
  '-c', 'advice.detachedHead=false', '-c', 'i18n.logOutputEncoding=UTF-8'];

const NETWORK_TIMEOUT = 5 * 60_000;

// ---------------- how git reaches GitHub ----------------
// An account set to SSH talks to GitHub over SSH in every repository, also in ones that were cloned
// with an https:// address. The address is rewritten for the one command only; the repository's own
// settings are not touched, so it behaves as before in a terminal.
const NETWORK = new Set(['fetch', 'pull', 'push', 'ls-remote', 'clone', 'submodule']);
const SSH_HOST = /^[A-Za-z0-9._-]+$/;

/** Pure: the "-c" options for an account's connection setting ({ protocol, host }). */
function transportArgs(setting) {
  if (!setting || setting.protocol !== 'ssh') return [];
  const host = setting.host && SSH_HOST.test(setting.host) ? setting.host : 'github.com';
  return ['-c', `url.git@${host}:.insteadOf=https://github.com/`];
}

const ownSsh = new Map(); // folder -> the user set their own ssh command there
async function transport(cwd, args) {
  if (!NETWORK.has(args[0])) return { args: [], env: {} };
  const cfg = config.get();
  const extra = transportArgs((cfg.accountSsh || {})[cfg.currentAccount]);
  const env = {};
  // A host that was never used before is added to known_hosts instead of failing: nobody can answer
  // ssh's "are you sure" question here. A host whose key CHANGED is still refused.
  if (!process.env.GIT_SSH_COMMAND && !process.env.GIT_SSH) {
    if (!ownSsh.has(cwd)) {
      const r = await run('git', ['config', '--get', 'core.sshCommand'], { cwd, quiet: true, okCodes: [0, 1], timeout: 15_000 }).catch(() => null);
      ownSsh.set(cwd, !!(r && r.stdout.trim()));
    }
    if (!ownSsh.get(cwd)) env.GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=accept-new';
  }
  return { args: extra, env };
}

async function git(repo, args, opts = {}) {
  const t = await transport(repo.path, args);
  const p = run('git', [...GIT_BASE, ...t.args, ...args], { cwd: repo.path, repo: repo.label || repo.name, timeout: opts.timeout ?? 60_000, displayArgs: args, ...opts, env: { ...t.env, ...(opts.env || {}) } });
  if (!NETWORK.has(args[0])) return p;
  return p.catch((e) => {
    // GitHub answers "not found" for a missing repository and for one the account may not see.
    if (/Repository not found|ERROR: Repository not found/i.test(e.message || '')) {
      const who = config.get().currentAccount;
      e.message += `
${who ? `The open account (${who})` : 'This sign-in'} cannot see this repository on GitHub: it was deleted or renamed, or it belongs to another account.`;
    }
    throw e;
  });
}
const out = async (repo, args, opts) => (await git(repo, args, opts)).stdout;
const quiet = (repo, args, opts = {}) => git(repo, args, { quiet: true, ...opts });
const qout = async (repo, args, opts) => (await quiet(repo, args, opts)).stdout;

// Non-interactive editor for continue operations, so git never opens one.
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

// ---------------- basics ----------------

const infoCache = new Map();
async function info(repo) {
  if (infoCache.has(repo.id)) return infoCache.get(repo.id);
  const o = await qout(repo, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']);
  const [gitDir, commonDir, top] = o.trim().split('\n');
  const i = { gitDir, commonDir, top };
  infoCache.set(repo.id, i);
  return i;
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

async function opState(repo) {
  const { gitDir } = await info(repo);
  const st = [];
  if (exists(path.join(gitDir, 'rebase-merge')) || exists(path.join(gitDir, 'rebase-apply'))) {
    st.push(exists(path.join(gitDir, 'rebase-apply', 'applying')) ? 'am' : 'rebase');
  }
  if (exists(path.join(gitDir, 'MERGE_HEAD'))) st.push('merge');
  if (exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) st.push('cherry-pick');
  if (exists(path.join(gitDir, 'REVERT_HEAD'))) st.push('revert');
  if (exists(path.join(gitDir, 'BISECT_LOG'))) st.push('bisect');
  const locked = exists(path.join(gitDir, 'index.lock'));
  return { inProgress: st, locked };
}

async function remotes(repo) {
  let o = '';
  try { o = await qout(repo, ['config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { okCodes: [0, 1] }); } catch { o = ''; }
  const map = new Map();
  for (const rec of o.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = rec.slice(0, nl);
    const val = rec.slice(nl + 1);
    const m = /^remote\.(.+)\.(url|pushurl)$/.exec(key);
    if (!m) continue;
    const r = map.get(m[1]) || { name: m[1], url: null, pushUrl: null };
    if (m[2] === 'url') r.url = val; else r.pushUrl = val;
    map.set(m[1], r);
  }
  return [...map.values()].map((r) => ({ ...r, parsed: P.parseRemoteUrl(r.url) }));
}

/** owner/repo for GitHub calls, from origin (or the first GitHub-looking remote). */
async function githubSlug(repo) {
  const rs = await remotes(repo);
  const pick = rs.find((r) => r.name === 'origin' && r.parsed) || rs.find((r) => r.parsed && P.looksLikeGitHub(r.parsed.host)) || rs.find((r) => r.parsed);
  if (!pick || !pick.parsed) return null;
  return { ...pick.parsed, remote: pick.name, url: pick.url, github: P.looksLikeGitHub(pick.parsed.host) };
}

async function refExists(repo, ref) {
  try { await quiet(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']); return true; } catch { return false; }
}

const defaultCache = new Map();
/** Default branch: origin/HEAD, then the caller-supplied hint (from GitHub), then main/master. */
async function defaultBranch(repo, { remote = 'origin', hint = null } = {}) {
  const key = repo.id + ':' + remote;
  if (!hint && defaultCache.has(key)) return defaultCache.get(key);
  let name = null;
  try {
    const o = await qout(repo, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    name = o.trim().replace(new RegExp(`^${remote}/`), '') || null;
  } catch {}
  if (!name && hint) name = hint;
  if (!name) {
    for (const cand of ['main', 'master', 'trunk', 'develop']) {
      if (await refExists(repo, `refs/remotes/${remote}/${cand}`) || await refExists(repo, `refs/heads/${cand}`)) { name = cand; break; }
    }
  }
  const res = name ? { name, remoteRef: (await refExists(repo, `refs/remotes/${remote}/${name}`)) ? `${remote}/${name}` : null, source: hint ? 'github' : 'local' } : null;
  defaultCache.set(key, res);
  return res;
}
function forgetDefault(repo) { for (const k of defaultCache.keys()) if (k.startsWith(repo.id + ':')) defaultCache.delete(k); }

async function status(repo) {
  const o = await qout(repo, ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', '--untracked-files=all', '--ignore-submodules=none'], { timeout: 30_000 });
  const st = P.parseStatusV2(o);
  st.hash = require('node:crypto').createHash('sha1').update(o).digest('hex').slice(0, 12);
  return st;
}

/** Lightweight summary for the sidebar. */
async function summary(repo) {
  const [st, ops] = await Promise.all([status(repo), opState(repo)]);
  const def = await defaultBranch(repo, { hint: repo.defaultHint || null }).catch(() => null);
  let behindDefault = 0;
  let aheadDefault = 0;
  if (def && def.remoteRef && st.head && st.head !== def.name && st.oid) {
    try {
      const o = await qout(repo, ['rev-list', '--left-right', '--count', `HEAD...${def.remoteRef}`]);
      const [a, b] = o.trim().split(/\s+/).map(Number);
      aheadDefault = a; behindDefault = b;
    } catch {}
  }
  let unpushed = 0;
  if (st.oid && !st.upstream) {
    try { unpushed = +(await qout(repo, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim() || 0; } catch {}
  }
  return {
    branch: st.head, detached: st.detached, oid: st.oid, upstream: st.upstream, statusHash: st.hash,
    ahead: st.ahead, behind: st.behind, stash: st.stash, unpushed,
    counts: { staged: st.staged.length, unstaged: st.unstaged.length, untracked: st.untracked.length, conflicted: st.conflicted.length },
    dirty: st.staged.length + st.unstaged.length + st.untracked.length + st.conflicted.length,
    inProgress: ops.inProgress, locked: ops.locked,
    defaultBranch: def ? def.name : null, defaultRemoteRef: def ? def.remoteRef : null, behindDefault, aheadDefault,
  };
}

async function changes(repo) {
  const [st, ops] = await Promise.all([status(repo), opState(repo)]);
  return { ...st, ...ops };
}

// ---------------- diff ----------------

function diffArgs({ ignoreWs, context = 3 } = {}) {
  const a = ['--no-color', '--no-ext-diff', `-U${context}`, '-M', '--submodule=short'];
  if (ignoreWs) a.push('-w');
  return a;
}

/** Diff as raw buffer, decoded latin1 so patch building is byte-exact. */
async function rawDiff(repo, args, opts = {}) {
  const r = await quiet(repo, args, { binary: true, okCodes: [0, 1], maxBuffer: 256 * 1024 * 1024, ...opts });
  return r.stdout.toString('latin1');
}

/**
 * kind: 'unstaged' | 'staged' | 'untracked' | 'commit' | 'range' | 'worktree-vs'
 */
async function fileDiff(repo, { kind, file, orig, commit, from, to, ignoreWs, context }) {
  if (commit) assertRev(commit);
  if (from) assertRev(from);
  if (to) assertRev(to);
  const da = diffArgs({ ignoreWs, context: Math.max(0, Math.min(+context || 3, 1000)) });
  let text;
  if (kind === 'unstaged') text = await rawDiff(repo, ['diff', ...da, '--', file]);
  else if (kind === 'staged') text = await rawDiff(repo, ['diff', '--cached', ...da, '--', ...(orig ? [orig, file] : [file])]);
  else if (kind === 'untracked') {
    const nul = process.platform === 'win32' ? 'NUL' : '/dev/null';
    text = await rawDiff(repo, ['diff', '--no-index', ...da, '--', nul, file]);
  } else if (kind === 'commit') {
    const parents = (await qout(repo, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ').slice(1);
    const base = parents[0] || emptyTree;
    text = await rawDiff(repo, ['diff', ...da, base, commit, '--', ...(orig ? [orig, file] : [file])]);
  } else if (kind === 'range') {
    text = await rawDiff(repo, ['diff', ...da, from, ...(to ? [to] : []), '--', ...(file ? [file] : [])]);
  } else throw new Error('Unknown diff kind');
  return text;
}
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Files changed in a commit (first parent) or between two revisions. */
async function changedFiles(repo, { commit, from, to }) {
  for (const x of [commit, from, to]) if (x) assertRev(x);
  let args;
  if (commit) {
    const parents = (await qout(repo, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ').slice(1);
    args = ['diff', '--name-status', '-z', '-M', parents[0] || emptyTree, commit];
  } else args = ['diff', '--name-status', '-z', '-M', from, ...(to ? [to] : [])];
  const o = await qout(repo, args);
  const parts = o.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const code = s[0];
    if (code === 'R' || code === 'C') files.push({ status: code, orig: parts[++i], path: parts[++i] });
    else files.push({ status: code, path: parts[++i] });
  }
  // numstat for +/- counts
  try {
    const ns = await qout(repo, ['diff', '--numstat', '-z', '-M', ...args.slice(4)]);
    const recs = ns.split('\0');
    const stats = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!r) continue;
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(r);
      if (!m) continue;
      let p = m[3];
      if (p === '') { p = recs[i + 2]; i += 2; } // rename: "a\td\t\0old\0new"
      stats.push({ add: m[1] === '-' ? null : +m[1], del: m[2] === '-' ? null : +m[2], path: p });
    }
    for (const f of files) { const s = stats.find((x) => x.path === f.path); if (s) { f.add = s.add; f.del = s.del; } }
  } catch {}
  return files;
}

// ---------------- staging ----------------

async function stage(repo, files) {
  if (!files.length) return;
  await git(repo, ['add', '-A', '--', ...files]);
}
async function stageAll(repo) { await git(repo, ['add', '-A']); }

async function hasHead(repo) { return refExists(repo, 'HEAD'); }

async function unstage(repo, files) {
  if (!files.length) return;
  if (await hasHead(repo)) await git(repo, ['restore', '--staged', '--', ...files]);
  else await git(repo, ['rm', '--cached', '-r', '-q', '--', ...files]);
}
async function unstageAll(repo) {
  if (await hasHead(repo)) await git(repo, ['reset', '-q']);
  else await git(repo, ['rm', '--cached', '-r', '-q', '.']);
}

/**
 * Apply a partial patch built from the current diff.
 * action: 'stage' (from unstaged), 'unstage' (from staged), 'discard' (from unstaged)
 * selection: { hunks: { [hunkIndex]: 'all' | [lineIndex...] } }
 * expect: fingerprint of the diff the UI showed; refuses if the file changed since.
 */
async function applySelection(repo, { action, file, selection, expect }) {
  const kind = action === 'unstage' ? 'staged' : 'unstaged';
  const text = await fileDiff(repo, { kind, file });
  if (expect && fingerprint(text) !== expect) {
    throw new Error('The file changed since the diff was shown. The diff has been refreshed; select the lines again.');
  }
  const files = P.parseDiff(text);
  if (!files.length) throw new Error('Nothing to apply: no differences for this file.');
  const f = files[0];
  if (f.binary) throw new Error('Binary files cannot be staged by hunk; stage the whole file.');
  const sel = new Map();
  for (const [k, v] of Object.entries(selection.hunks || {})) sel.set(+k, v === 'all' ? 'all' : new Set(v));
  const patch = P.buildPatch(f, sel, action === 'stage' ? 'forward' : 'reverse');
  if (!patch) throw new Error('The selection contains no changed lines.');
  const buf = Buffer.from(patch, 'latin1');
  if (action === 'stage') await git(repo, ['apply', '--cached', '--whitespace=nowarn', '-'], { input: buf });
  else if (action === 'unstage') await git(repo, ['apply', '--cached', '--reverse', '--whitespace=nowarn', '-'], { input: buf });
  else {
    const b = saveBackup(repo, { kind: 'lines', files: [file], patch: buf, note: 'Discarded selected lines' });
    try {
      await git(repo, ['apply', '--reverse', '--whitespace=nowarn', '-'], { input: buf });
    } catch (e) { dropBackup(b); throw e; }
  }
}

function fingerprint(text) {
  return require('node:crypto').createHash('sha1').update(text, 'latin1').digest('hex').slice(0, 16);
}

// ---------------- discard with safety copies ----------------

function backupDir(repo) {
  const d = path.join(paths.backups, repo.id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function saveBackup(repo, { kind, files, patch, untracked, note }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dir = path.join(backupDir(repo), id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id, repoPath: repo.path, repoName: repo.name, kind, files, time: Date.now(), note, hasPatch: !!patch, untracked: [] };
  if (patch && patch.length) fs.writeFileSync(path.join(dir, 'changes.patch'), patch);
  for (const u of untracked || []) {
    const src = path.join(repo.path, u);
    const dst = path.join(dir, 'untracked', u);
    try {
      const st = fs.statSync(src);
      if (st.isDirectory()) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      meta.untracked.push(u);
    } catch {}
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  pruneBackups(repo);
  return { dir, meta };
}
function dropBackup(b) { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch {} }

function pruneBackups(repo) {
  const d = backupDir(repo);
  const entries = fs.readdirSync(d).sort();
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const excess = entries.length - 100;
  entries.forEach((e, i) => {
    const t = +e.split('-')[0];
    if (i < excess || t < cutoff) fs.rmSync(path.join(d, e), { recursive: true, force: true });
  });
}

function listBackups(repo) {
  const d = backupDir(repo);
  return fs.readdirSync(d).sort().reverse().map((e) => {
    try { return JSON.parse(fs.readFileSync(path.join(d, e, 'meta.json'), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

async function restoreBackup(repo, id) {
  if (!/^[0-9]+-[a-z0-9]+$/.test(id)) throw new Error('Invalid backup id');
  const dir = path.join(backupDir(repo), id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const msgs = [];
  if (meta.hasPatch) {
    const patch = fs.readFileSync(path.join(dir, 'changes.patch'));
    try {
      await git(repo, ['apply', '--binary', '--whitespace=nowarn', '-'], { input: patch });
    } catch (e) {
      await git(repo, ['apply', '--binary', '--3way', '--whitespace=nowarn', '-'], { input: patch });
      msgs.push('Restored with a 3-way merge; check for conflicts.');
    }
  }
  const skipped = [];
  for (const u of meta.untracked) {
    const dst = path.join(repo.path, u);
    if (exists(dst)) { skipped.push(u); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(dir, 'untracked', u), dst);
  }
  if (skipped.length) msgs.push(`Not restored because a file with the same name now exists: ${skipped.join(', ')}`);
  fs.renameSync(dir, dir + '.restored');
  return { messages: msgs };
}

const MAX_UNTRACKED_BACKUP = 200 * 1024 * 1024;

/** Discard working-tree changes of tracked files (unstaged only), and/or delete untracked files. */
async function discard(repo, { files = [], untracked = [] }) {
  const notBackedUp = [];
  let patch = null;
  if (files.length) patch = (await quiet(repo, ['diff', '--binary', '--', ...files], { binary: true, maxBuffer: 512 * 1024 * 1024 })).stdout;
  let total = 0;
  const copyable = [];
  for (const u of untracked) {
    try { const s = fs.statSync(path.join(repo.path, u)); total += s.size; if (total <= MAX_UNTRACKED_BACKUP) copyable.push(u); else notBackedUp.push(u); } catch {}
  }
  const b = saveBackup(repo, { kind: 'discard', files: [...files, ...untracked], patch, untracked: copyable, note: `Discarded ${files.length + untracked.length} file(s)` });
  try {
    if (files.length) await git(repo, ['restore', '--worktree', '--', ...files]);
    if (untracked.length) await git(repo, ['clean', '-f', '-q', '--', ...untracked]);
  } catch (e) { throw e; }
  return { backup: b.meta.id, notBackedUp };
}

/** Discard everything: staged and unstaged changes to tracked files, plus optionally untracked files. */
async function discardAll(repo, { includeUntracked }) {
  const st = await status(repo);
  const head = await hasHead(repo);
  let patch = null;
  if (head) patch = (await quiet(repo, ['diff', 'HEAD', '--binary'], { binary: true, maxBuffer: 512 * 1024 * 1024 })).stdout;
  const untracked = includeUntracked ? st.untracked.map((u) => u.path) : [];
  let total = 0;
  const copyable = [];
  const notBackedUp = [];
  for (const u of untracked) {
    try { const s = fs.statSync(path.join(repo.path, u)); total += s.size; if (total <= MAX_UNTRACKED_BACKUP) copyable.push(u); else notBackedUp.push(u); } catch {}
  }
  const b = saveBackup(repo, { kind: 'discard-all', files: [...st.staged, ...st.unstaged].map((f) => f.path).concat(untracked), patch, untracked: copyable, note: 'Discarded all changes' });
  if (head) await git(repo, ['reset', '--hard', '-q', 'HEAD']);
  if (untracked.length) await git(repo, ['clean', '-f', '-q', '--', ...untracked]);
  return { backup: b.meta.id, notBackedUp };
}

// ---------------- commit ----------------

async function commit(repo, { message, amend, signoff, noVerify, all, allowEmpty }) {
  if (!message || !message.trim()) {
    if (!amend) throw new Error('Enter a commit message first.');
  }
  const args = ['commit'];
  if (all) args.push('-a');
  if (amend) args.push('--amend');
  if (signoff) args.push('--signoff');
  if (noVerify) args.push('--no-verify');
  if (allowEmpty) args.push('--allow-empty');
  if (message && message.trim()) args.push('--cleanup=strip', '-F', '-');
  else args.push('--no-edit');
  const r = await git(repo, args, { input: message && message.trim() ? message : undefined, timeout: 10 * 60_000, env: NO_EDITOR, logOutput: true });
  return { output: (r.stdout + r.stderr).trim() };
}

async function isPushed(repo, rev = 'HEAD') {
  const o = await qout(repo, ['branch', '-r', '--contains', rev]).catch(() => '');
  return o.trim().length > 0;
}

async function undoLastCommit(repo) {
  if (await isPushed(repo, 'HEAD')) {
    const e = new Error('The last commit is already on a remote. Undoing it would rewrite published history. Use "Revert" to create a commit that reverses it instead.');
    e.hint = 'revert';
    throw e;
  }
  const hasParent = await refExists(repo, 'HEAD~1');
  if (hasParent) await git(repo, ['reset', '--soft', 'HEAD~1']);
  else await git(repo, ['update-ref', '-d', 'HEAD']);
}

async function lastCommitMessage(repo) {
  return (await qout(repo, ['log', '-1', '--format=%B'])).replace(/\n+$/, '');
}

async function rewordLast(repo, message) {
  if (await isPushed(repo, 'HEAD')) throw new Error('The last commit is already pushed; rewording it would rewrite published history.');
  await git(repo, ['commit', '--amend', '--only', '--cleanup=strip', '-F', '-'], { input: message, env: NO_EDITOR });
}

async function unpushedCount(repo) {
  const st = await status(repo);
  const range = st.upstream ? ['@{u}..HEAD'] : ['HEAD', '--not', '--remotes'];
  return +(await qout(repo, ['rev-list', '--count', ...range])).trim() || 0;
}

async function squashLast(repo, n, message) {
  n = +n;
  if (!(n >= 2)) throw new Error('Choose at least two commits to squash.');
  const avail = await unpushedCount(repo);
  if (n > avail) throw new Error(`Only ${avail} commit(s) are unpushed; squashing ${n} would rewrite published history.`);
  if (!(await refExists(repo, `HEAD~${n}`))) throw new Error('Not enough history to squash that many commits.');
  const merges = (await qout(repo, ['rev-list', '--merges', `HEAD~${n}..HEAD`])).trim();
  if (merges) throw new Error('The range contains a merge commit; squash it from the command line instead.');
  const st = await status(repo);
  if (st.staged.length) throw new Error('You have staged changes. Commit or unstage them first so they are not folded into the squashed commit.');
  const before = (await qout(repo, ['rev-parse', 'HEAD'])).trim();
  await git(repo, ['reset', '--soft', `HEAD~${n}`]);
  try {
    await git(repo, ['commit', '--cleanup=strip', '-F', '-'], { input: message, env: NO_EDITOR });
  } catch (e) {
    await git(repo, ['reset', '--soft', before]); // put everything back
    throw e;
  }
}

// ---------------- remote sync ----------------

async function fetch(repo, { prune = false, all = true, remote } = {}) {
  const args = ['fetch', '--quiet'];
  if (prune) args.push('--prune');
  if (remote) args.push(remote); else if (all) args.push('--all');
  try { await git(repo, args, { timeout: NETWORK_TIMEOUT }); }
  catch (e) { if (!remote) unreachable.note(repo, await remotes(repo), e.message); throw e; }
  unreachable.clear(repo);
  forgetDefault(repo);
}

async function pull(repo, { strategy = 'merge' } = {}) {
  const st = await status(repo);
  if (!st.upstream) throw new Error('This branch has no upstream. Publish it first.');
  const flag = strategy === 'rebase' ? '--rebase' : strategy === 'ff-only' ? '--ff-only' : '--no-rebase';
  const r = await git(repo, ['pull', flag, '--no-edit'], { timeout: NETWORK_TIMEOUT, env: NO_EDITOR, logOutput: true });
  return { output: (r.stdout + r.stderr).trim() };
}

async function push(repo, { setUpstream, remote, forceWithLease, tags, branch } = {}) {
  const st = await status(repo);
  if (!st.head && !tags) throw new Error('HEAD is detached; switch to a branch before pushing.');
  const args = ['push'];
  if (forceWithLease) args.push('--force-with-lease');
  if (tags) { args.push(remote || 'origin', '--tags'); }
  else if (setUpstream || !st.upstream) args.push('-u', remote || 'origin', `HEAD:refs/heads/${branch || st.head}`);
  const r = await git(repo, args, { timeout: NETWORK_TIMEOUT, logOutput: true });
  return { output: (r.stdout + r.stderr).trim(), branch: st.head, oid: st.oid };
}

async function sync(repo, opts) {
  const p = await pull(repo, opts);
  const q = await push(repo, {});
  return { output: [p.output, q.output].filter(Boolean).join('\n'), branch: q.branch };
}

// ---------------- branches & refs ----------------

async function refs(repo) {
  const o = await qout(repo, ['for-each-ref', `--format=${P.REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
  const all = P.parseRefs(o);
  return {
    local: all.filter((r) => r.ref.startsWith('refs/heads/')),
    remote: all.filter((r) => r.ref.startsWith('refs/remotes/') && !r.ref.endsWith('/HEAD')),
    tags: all.filter((r) => r.ref.startsWith('refs/tags/')).map((t) => ({ ...t, target: t.peeled || t.hash, annotated: t.objectType === 'tag' })),
  };
}

function validBranchName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.startsWith('-')) return false;
  return !/[\s~^:?*\[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|\/$|\.lock$|^\.|\/\./.test(name) && name !== '@';
}
function assertName(name, what = 'branch') {
  if (!validBranchName(name)) throw new Error(`"${name}" is not a valid ${what} name.`);
}
function assertRev(rev) {
  if (!rev || typeof rev !== 'string' || rev.startsWith('-') || /[\s\x00-\x1f]/.test(rev)) throw new Error('Invalid revision');
}

async function createBranch(repo, { name, from, checkout }) {
  assertName(name);
  if (from) assertRev(from);
  if (checkout) await git(repo, ['switch', '-c', name, ...(from ? [from] : [])]);
  else await git(repo, ['branch', name, ...(from ? [from] : [])]);
}

/** mode: 'carry' (default git behaviour), 'stash' (stash first, including untracked) */
async function switchBranch(repo, { name, mode = 'carry', remoteRef }) {
  if (remoteRef) {
    assertRev(remoteRef);
    const local = name || remoteRef.replace(/^[^/]+\//, '');
    assertName(local);
    if (await refExists(repo, `refs/heads/${local}`)) {
      if (mode === 'stash') await stashPush(repo, { message: `Repodeck: before switching to ${local}`, includeUntracked: true });
      await git(repo, ['switch', local]);
    } else {
      if (mode === 'stash') await stashPush(repo, { message: `Repodeck: before switching to ${local}`, includeUntracked: true });
      await git(repo, ['switch', '-c', local, '--track', remoteRef]);
    }
    return { branch: local };
  }
  assertName(name);
  if (mode === 'stash') {
    const st = await status(repo);
    if (st.staged.length + st.unstaged.length + st.untracked.length) {
      await stashPush(repo, { message: `Repodeck: before switching to ${name}`, includeUntracked: true });
    }
  }
  await git(repo, ['switch', name]);
  return { branch: name };
}

async function checkoutDetached(repo, rev) { assertRev(rev); await git(repo, ['switch', '--detach', rev]); }

async function renameBranch(repo, { from, to }) { assertName(from); assertName(to); await git(repo, ['branch', '-m', from, to]); }

async function branchMergedInto(repo, branch, target) {
  try { await quiet(repo, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, target]); return true; } catch { return false; }
}

async function deleteBranch(repo, { name, force }) {
  assertName(name);
  await git(repo, ['branch', force ? '-D' : '-d', name]);
}
async function deleteRemoteBranch(repo, { remote, name }) {
  assertName(name); assertName(remote, 'remote');
  await git(repo, ['push', remote, '--delete', `refs/heads/${name}`], { timeout: NETWORK_TIMEOUT });
}
async function setUpstream(repo, { branch, upstream }) { assertName(branch); assertRev(upstream); await git(repo, ['branch', `--set-upstream-to=${upstream}`, branch]); }

async function merge(repo, { rev, noFf, squash, message }) {
  assertRev(rev);
  const args = ['merge'];
  if (noFf) args.push('--no-ff');
  if (squash) args.push('--squash');
  if (message) args.push('-m', message); else args.push('--no-edit');
  args.push(rev);
  const r = await git(repo, args, { env: NO_EDITOR, timeout: 10 * 60_000, logOutput: true });
  return { output: (r.stdout + r.stderr).trim() };
}
async function rebase(repo, { onto }) {
  assertRev(onto);
  const r = await git(repo, ['rebase', onto], { env: NO_EDITOR, timeout: 10 * 60_000, logOutput: true });
  return { output: (r.stdout + r.stderr).trim() };
}

async function isMergeCommit(repo, rev) {
  return (await qout(repo, ['rev-list', '--parents', '-n', '1', rev])).trim().split(' ').length > 2;
}
async function cherryPick(repo, { rev }) {
  assertRev(rev);
  const args = ['cherry-pick'];
  if (await isMergeCommit(repo, rev)) args.push('-m', '1');
  args.push(rev);
  await git(repo, args, { env: NO_EDITOR, logOutput: true });
}
async function revert(repo, { rev }) {
  assertRev(rev);
  const args = ['revert', '--no-edit'];
  if (await isMergeCommit(repo, rev)) args.push('-m', '1');
  args.push(rev);
  await git(repo, args, { env: NO_EDITOR, logOutput: true });
}

async function reset(repo, { rev, mode }) {
  assertRev(rev);
  if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Invalid reset mode');
  let backup = null;
  if (mode === 'hard') {
    const patch = (await quiet(repo, ['diff', 'HEAD', '--binary'], { binary: true, maxBuffer: 512 * 1024 * 1024 })).stdout;
    const head = (await qout(repo, ['rev-parse', 'HEAD'])).trim();
    if (patch.length) backup = saveBackup(repo, { kind: 'reset', files: [], patch, note: `Uncommitted changes before hard reset (HEAD was ${head.slice(0, 8)})` }).meta.id;
  }
  await git(repo, ['reset', `--${mode}`, rev]);
  return { backup };
}

async function dropCommit(repo, { rev }) {
  assertRev(rev);
  if (await isPushed(repo, rev)) throw new Error('That commit is already on a remote; dropping it would rewrite published history. Use Revert instead.');
  const st = await status(repo);
  if (!st.head) throw new Error('Switch to a branch first.');
  if (st.staged.length + st.unstaged.length) throw new Error('Commit or stash your changes before dropping a commit.');
  const merges = (await qout(repo, ['rev-list', '--merges', `${rev}~1..HEAD`]).catch(() => '')).trim();
  if (merges) throw new Error('There are merge commits after this commit; drop it from the command line instead.');
  try { await quiet(repo, ['merge-base', '--is-ancestor', rev, 'HEAD']); } catch { throw new Error('That commit is not on the current branch.'); }
  await git(repo, ['rebase', '--onto', `${rev}~1`, rev, st.head], { env: NO_EDITOR, logOutput: true });
}

async function continueOp(repo, op) {
  const map = { merge: ['commit', '--no-edit'], rebase: ['rebase', '--continue'], 'cherry-pick': ['cherry-pick', '--continue'], revert: ['revert', '--continue'], am: ['am', '--continue'] };
  if (!map[op]) throw new Error('Nothing to continue');
  const r = await git(repo, map[op], { env: NO_EDITOR, logOutput: true });
  return { output: (r.stdout + r.stderr).trim() };
}
async function abortOp(repo, op) {
  const map = { merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'], am: ['am', '--abort'], bisect: ['bisect', 'reset'] };
  if (!map[op]) throw new Error('Nothing to abort');
  await git(repo, map[op]);
}
async function skipOp(repo, op) {
  if (!['rebase', 'cherry-pick', 'revert'].includes(op)) throw new Error('Cannot skip here');
  await git(repo, [op, '--skip'], { env: NO_EDITOR });
}

// ---------------- conflicts ----------------

async function conflictFile(repo, file) {
  const abs = safeJoin(repo.path, file);
  const text = fs.readFileSync(abs, 'utf8');
  return P.parseConflicts(text);
}
async function resolveConflictFile(repo, { file, choices, markResolved }) {
  const abs = safeJoin(repo.path, file);
  const parsed = P.parseConflicts(fs.readFileSync(abs, 'utf8'));
  const text = P.resolveConflicts(parsed, choices);
  fs.writeFileSync(abs, text);
  if (markResolved) await git(repo, ['add', '--', file]);
}
async function takeSide(repo, { file, side }) {
  if (!['ours', 'theirs'].includes(side)) throw new Error('Invalid side');
  await git(repo, ['checkout', `--${side}`, '--', file]);
  await git(repo, ['add', '--', file]);
}
async function acceptDeletion(repo, { file }) { await git(repo, ['rm', '-q', '--', file]); }
async function markResolved(repo, files) { await git(repo, ['add', '--', ...files]); }

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  if (abs !== r && !abs.toLowerCase().startsWith(r.toLowerCase() + path.sep)) throw new Error('Path is outside the repository');
  return abs;
}

// ---------------- tags ----------------

async function createTag(repo, { name, rev, message }) {
  assertName(name, 'tag');
  if (rev) assertRev(rev);
  if (message) await git(repo, ['tag', '-a', name, '-F', '-', ...(rev ? [rev] : [])], { input: message });
  else await git(repo, ['tag', name, ...(rev ? [rev] : [])]);
}
async function deleteTag(repo, { name }) { assertName(name, 'tag'); await git(repo, ['tag', '-d', name]); }
async function pushTag(repo, { name, remote = 'origin' }) { assertName(name, 'tag'); await git(repo, ['push', remote, `refs/tags/${name}`], { timeout: NETWORK_TIMEOUT }); }
async function deleteRemoteTag(repo, { name, remote = 'origin' }) { assertName(name, 'tag'); await git(repo, ['push', remote, '--delete', `refs/tags/${name}`], { timeout: NETWORK_TIMEOUT }); }

// ---------------- stash ----------------

async function stashList(repo) {
  const o = await qout(repo, ['stash', 'list', '--format=%H%x1f%P%x1f%gd%x1f%gs%x1f%at%x1e']).catch(() => '');
  return o.split('\x1e').map((s) => s.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const f = r.split('\x1f');
    const parents = f[1].split(' ');
    return { hash: f[0], base: parents[0], hasUntracked: parents.length > 2, ref: f[2], message: f[3], time: +f[4] };
  });
}
async function stashPush(repo, { message, includeUntracked, keepIndex, files }) {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('--include-untracked');
  if (keepIndex) args.push('--keep-index');
  if (message) args.push('-m', message);
  if (files && files.length) args.push('--', ...files);
  await git(repo, args);
}
function assertStash(ref) { if (!/^stash@\{\d+\}$/.test(ref)) throw new Error('Invalid stash reference'); }
async function stashApply(repo, { ref, pop, index }) {
  assertStash(ref);
  const r = await git(repo, ['stash', pop ? 'pop' : 'apply', ...(index ? ['--index'] : []), ref], { logOutput: true });
  return { output: (r.stdout + r.stderr).trim() };
}
async function stashDrop(repo, { ref }) { assertStash(ref); await git(repo, ['stash', 'drop', ref]); }
async function stashClear(repo) { await git(repo, ['stash', 'clear']); }
async function stashBranch(repo, { ref, name }) { assertStash(ref); assertName(name); await git(repo, ['stash', 'branch', name, ref]); }
async function stashFiles(repo, ref) {
  assertStash(ref);
  const files = await changedFiles(repo, { from: `${ref}^1`, to: ref });
  // untracked files are stored in the third parent
  let untracked = [];
  try {
    const o = await qout(repo, ['ls-tree', '-r', '--name-only', '-z', `${ref}^3`]);
    untracked = o.split('\0').filter(Boolean).map((p) => ({ status: '?', path: p }));
  } catch {}
  return [...files, ...untracked];
}

// ---------------- log / graph ----------------

/** Pure: a --author pattern that matches exactly this name (git matches a basic regular expression against "Name <email>"). */
function authorPattern(name) {
  return `^${String(name).replace(/[.*[\]^$\\]/g, '\\$&')} <`;
}

/** Everyone who has commits on any branch, most commits first. */
async function authors(repo) {
  if (!(await hasHead(repo))) return [];
  const o = await qout(repo, ['shortlog', '-sn', '--branches', '--remotes', 'HEAD'], { timeout: 60_000 });
  return o.split('\n').map((l) => /^\s*(\d+)\t(.+)$/.exec(l)).filter(Boolean).map((m) => ({ name: m[2], commits: +m[1] })).slice(0, 300);
}

async function log(repo, { skip = 0, limit = 300, branches, author, authorName, since, until, grep, remotes = true, tags = true, order = 'date', file, follow } = {}) {
  const args = ['log', `--format=${P.LOG_FORMAT}`, `--skip=${+skip || 0}`, `-n${Math.min(+limit || 300, 2000)}`];
  args.push(order === 'topo' ? '--topo-order' : '--date-order');
  if (authorName) args.push(`--author=${authorPattern(authorName)}`);
  else if (author) args.push(`--author=${author}`, '--regexp-ignore-case');
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  if (grep) args.push(`--grep=${grep}`, '--regexp-ignore-case');
  if (file) {
    if (follow) args.push('--follow');
    args.push('--', file);
  } else if (branches && branches.length) {
    branches.forEach(assertRev);
    args.push(...branches);
  } else {
    args.push('--branches');
    if (remotes) args.push('--remotes');
    if (tags) args.push('--tags');
    args.push('HEAD');
  }
  if (!(await hasHead(repo)) && !(branches && branches.length)) {
    // empty repository
    return [];
  }
  const o = await qout(repo, args, { timeout: 60_000 });
  return P.parseLog(o);
}

async function searchByHash(repo, prefix) {
  if (!/^[0-9a-f]{4,40}$/i.test(prefix)) return [];
  try {
    const o = await qout(repo, ['log', '-1', `--format=${P.LOG_FORMAT}`, prefix]);
    return P.parseLog(o);
  } catch { return []; }
}

async function commitDetail(repo, rev) {
  assertRev(rev);
  const o = await qout(repo, ['log', '-1', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B', rev]);
  const f = o.split('\x1f');
  const files = await changedFiles(repo, { commit: f[0] });
  return {
    hash: f[0], parents: f[1] ? f[1].split(' ') : [], author: f[2], authorEmail: f[3], authorTime: +f[4],
    committer: f[5], committerEmail: f[6], commitTime: +f[7], refs: P.parseDecorations(f[8]), message: f.slice(9).join('\x1f').replace(/\n+$/, ''),
    files, pushed: await isPushed(repo, f[0]),
  };
}

async function blame(repo, file, rev) {
  const args = ['blame', '--porcelain'];
  if (rev) { assertRev(rev); args.push(rev); }
  args.push('--', file);
  const o = await qout(repo, args, { timeout: 60_000 });
  const lines = o.split('\n');
  const commits = {};
  const result = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('\t')) { result.push({ hash: cur, text: l.slice(1) }); continue; }
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(l);
    if (m) { cur = m[1]; commits[cur] = commits[cur] || { hash: cur }; continue; }
    const sp = l.indexOf(' ');
    if (cur && sp > 0) {
      const k = l.slice(0, sp);
      const v = l.slice(sp + 1);
      if (k === 'author') commits[cur].author = v;
      else if (k === 'author-time') commits[cur].time = +v;
      else if (k === 'summary') commits[cur].summary = v;
    }
  }
  return { lines: result, commits };
}

async function fileAt(repo, rev, file) {
  assertRev(rev);
  const r = await quiet(repo, ['show', `${rev}:${file.replace(/\\/g, '/')}`], { binary: true, maxBuffer: 50 * 1024 * 1024 });
  return r.stdout;
}

// ---------------- remotes, clone, init ----------------

async function addRemote(repo, { name, url }) { assertName(name, 'remote'); if (!url || url.startsWith('-')) throw new Error('Invalid URL'); await git(repo, ['remote', 'add', name, url]); }
async function setRemoteUrl(repo, { name, url }) { assertName(name, 'remote'); if (!url || url.startsWith('-')) throw new Error('Invalid URL'); await git(repo, ['remote', 'set-url', name, url]); }
async function removeRemote(repo, { name }) { assertName(name, 'remote'); await git(repo, ['remote', 'remove', name]); }

async function clone({ url, dest }) {
  if (!url || url.startsWith('-')) throw new Error('Invalid URL');
  if (exists(dest)) throw new Error(`"${dest}" already exists.`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const t = await transport(path.dirname(dest), ['clone']);
  await run('git', [...GIT_BASE, ...t.args, 'clone', '--', url, dest], { env: t.env, cwd: path.dirname(dest), timeout: 30 * 60_000, repo: path.basename(dest) });
}
async function init({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  await run('git', [...GIT_BASE, 'init', '--', dir], { cwd: dir, repo: path.basename(dir) });
}

// ---------------- .gitignore ----------------

async function addToGitignore(repo, pattern) {
  if (!pattern || /[\r\n]/.test(pattern)) throw new Error('Invalid pattern');
  const f = path.join(repo.path, '.gitignore');
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch {}
  const lines = txt.split(/\r?\n/);
  if (lines.includes(pattern)) return { already: true };
  const eol = txt.includes('\r\n') ? '\r\n' : '\n';
  const prefix = txt.length && !txt.endsWith('\n') ? eol : '';
  fs.writeFileSync(f, txt + prefix + pattern + eol);
  return { already: false };
}

// ---------------- worktrees & submodules ----------------

async function worktrees(repo) {
  const o = await qout(repo, ['worktree', 'list', '--porcelain', '-z']);
  const list = [];
  let cur = null;
  for (const rec of o.split('\0')) {
    if (!rec) { if (cur) { list.push(cur); cur = null; } continue; }
    const sp = rec.indexOf(' ');
    const k = sp < 0 ? rec : rec.slice(0, sp);
    const v = sp < 0 ? '' : rec.slice(sp + 1);
    if (k === 'worktree') cur = { path: path.normalize(v) };
    else if (!cur) continue;
    else if (k === 'HEAD') cur.head = v;
    else if (k === 'branch') cur.branch = v.replace(/^refs\/heads\//, '');
    else if (k === 'detached') cur.detached = true;
    else if (k === 'bare') cur.bare = true;
    else if (k === 'locked') cur.locked = v || true;
    else if (k === 'prunable') cur.prunable = v || true;
  }
  if (cur) list.push(cur);
  return list;
}
async function addWorktree(repo, { dir, branch, newBranch, base }) {
  if (!dir || dir.startsWith('-')) throw new Error('Invalid folder');
  if (newBranch) { assertName(newBranch); if (base) assertRev(base); await git(repo, ['worktree', 'add', '-b', newBranch, dir, ...(base ? [base] : [])]); }
  else { assertName(branch); await git(repo, ['worktree', 'add', dir, branch]); }
}
async function removeWorktree(repo, { dir }) { if (!dir || dir.startsWith('-')) throw new Error('Invalid folder'); await git(repo, ['worktree', 'remove', dir]); }

async function submodules(repo) {
  if (!exists(path.join(repo.path, '.gitmodules'))) return [];
  const o = await qout(repo, ['submodule', 'status', '--recursive']).catch(() => '');
  return o.split('\n').filter(Boolean).map((l) => {
    const m = /^([ +\-U])([0-9a-f]+) (\S+)(?: \((.*)\))?$/.exec(l);
    if (!m) return null;
    return { state: { ' ': 'up to date', '+': 'different commit checked out', '-': 'not initialised', U: 'merge conflict' }[m[1]], code: m[1], hash: m[2], path: m[3], describe: m[4] || '' };
  }).filter(Boolean);
}
async function updateSubmodules(repo) { await git(repo, ['submodule', 'update', '--init', '--recursive'], { timeout: NETWORK_TIMEOUT }); }

// ---------------- misc ----------------

async function compareBranches(repo, a, b) {
  assertRev(a); assertRev(b);
  const o = await qout(repo, ['rev-list', '--left-right', '--count', `${a}...${b}`]);
  const [ahead, behind] = o.trim().split(/\s+/).map(Number);
  const onlyA = P.parseLog(await qout(repo, ['log', `--format=${P.LOG_FORMAT}`, '-n200', `${b}..${a}`]));
  const onlyB = P.parseLog(await qout(repo, ['log', `--format=${P.LOG_FORMAT}`, '-n200', `${a}..${b}`]));
  const files = await changedFiles(repo, { from: `${b}...${a}` });
  return { ahead, behind, onlyA, onlyB, files };
}

async function mergedBranches(repo, target) {
  assertRev(target);
  const o = await qout(repo, ['for-each-ref', '--merged', target, '--format=%(refname:short)', 'refs/heads']);
  return o.split('\n').filter(Boolean);
}

async function lastCommitTime(repo) {
  try { return +(await qout(repo, ['log', '-1', '--format=%ct'])).trim(); } catch { return 0; }
}

module.exports = {
  transportArgs,
  git, info, opState, remotes, githubSlug, defaultBranch, forgetDefault, status, summary, changes, refExists, hasHead,
  fileDiff, changedFiles, fingerprint, stage, stageAll, unstage, unstageAll, applySelection,
  discard, discardAll, listBackups, restoreBackup,
  commit, undoLastCommit, lastCommitMessage, rewordLast, squashLast, unpushedCount, isPushed,
  fetch, pull, push, sync,
  refs, createBranch, switchBranch, checkoutDetached, renameBranch, deleteBranch, deleteRemoteBranch, setUpstream, branchMergedInto,
  merge, rebase, cherryPick, revert, reset, dropCommit, continueOp, abortOp, skipOp,
  conflictFile, resolveConflictFile, takeSide, acceptDeletion, markResolved,
  createTag, deleteTag, pushTag, deleteRemoteTag,
  stashList, stashPush, stashApply, stashDrop, stashClear, stashBranch, stashFiles,
  log, authors, authorPattern, searchByHash, commitDetail, blame, fileAt,
  addRemote, setRemoteUrl, removeRemote, clone, init, addToGitignore,
  worktrees, addWorktree, removeWorktree, submodules, updateSubmodules,
  compareBranches, mergedBranches, lastCommitTime, validBranchName, safeJoin, ProcError, emptyTree,
};
