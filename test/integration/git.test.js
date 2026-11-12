'use strict';
// Every mutating git operation, exercised against throwaway repositories with a local bare remote.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.REPODECK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-data-'));
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir, git: g, write, makeRepo, rm } = require('../helpers');
const G = require('../../server/git');

const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const TEN = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';

function setup(t, files) {
  const root = tmpdir();
  t.after(() => rm(root));
  return { root, ...makeRepo(root, 'work', files) };
}

test('status summary counts and default branch detection', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', TEN.replace('two', 'TWO'));
  write(dir, 'new file.txt', 'x\n');
  write(dir, 'staged.txt', 's\n');
  g(dir, 'add', 'staged.txt');
  const s = await G.summary(repo);
  assert.equal(s.branch, 'main');
  assert.deepEqual(s.counts, { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 });
  assert.equal(s.defaultBranch, 'main');
  assert.equal(s.defaultRemoteRef, 'origin/main');
  assert.ok(s.statusHash);
});

test('stage one changed line out of several; the rest stays unstaged', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', TEN.replace('two', 'TWO').replace('nine', 'NINE'));
  const P = require('../../server/parse');
  const uiText = await G.fileDiff(repo, { kind: 'unstaged', file: 'a.txt' });
  const [uf] = P.parseDiff(uiText);
  const idx = uf.hunks[0].lines.findIndex((l) => l.t === '+' && l.s === 'TWO');
  const del = uf.hunks[0].lines.findIndex((l) => l.t === '-' && l.s === 'two');
  await G.applySelection(repo, { action: 'stage', file: 'a.txt', selection: { hunks: { 0: [del, idx] } }, expect: G.fingerprint(uiText) });
  const cached = g(dir, 'diff', '--cached');
  assert.match(cached, /-two\n\+TWO/);
  assert.doesNotMatch(cached, /NINE/);
  assert.match(g(dir, 'diff'), /-nine\n\+NINE/);
});

test('stage selected lines from a hunk with both removal and addition', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', TEN.replace('two\n', 'TWO\n'));
  const P = require('../../server/parse');
  const text = await G.fileDiff(repo, { kind: 'unstaged', file: 'a.txt' });
  const [f] = P.parseDiff(text);
  const del = f.hunks[0].lines.findIndex((l) => l.t === '-');
  const add = f.hunks[0].lines.findIndex((l) => l.t === '+');
  // stage only the addition: index gets both "two" (kept as context) and "TWO"
  await G.applySelection(repo, { action: 'stage', file: 'a.txt', selection: { hunks: { 0: [add] } }, expect: G.fingerprint(text) });
  const idx = g(dir, 'show', ':a.txt');
  assert.ok(idx.includes('two\nTWO\nthree'), idx);
  // unstage it again using the staged diff
  const st = await G.fileDiff(repo, { kind: 'staged', file: 'a.txt' });
  const [sf] = P.parseDiff(st);
  const sadd = sf.hunks[0].lines.findIndex((l) => l.t === '+');
  await G.applySelection(repo, { action: 'unstage', file: 'a.txt', selection: { hunks: { 0: [sadd] } }, expect: G.fingerprint(st) });
  assert.equal(g(dir, 'diff', '--cached'), '');
  assert.equal(read(dir, 'a.txt'), TEN.replace('two\n', 'TWO\n'), 'working tree untouched');
  void del;
});

test('stale selection is refused', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', TEN.replace('two', 'TWO'));
  const text = await G.fileDiff(repo, { kind: 'unstaged', file: 'a.txt' });
  write(dir, 'a.txt', TEN.replace('two', 'TWO').replace('ten', 'TEN'));
  await assert.rejects(G.applySelection(repo, { action: 'stage', file: 'a.txt', selection: { hunks: { 0: 'all' } }, expect: G.fingerprint(text) }), /changed since/);
});

test('discard lines keeps a safety copy that can be restored', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', TEN.replace('two', 'TWO').replace('nine', 'NINE'));
  const P = require('../../server/parse');
  const text = await G.fileDiff(repo, { kind: 'unstaged', file: 'a.txt', context: 1 });
  void text;
  const ui = await G.fileDiff(repo, { kind: 'unstaged', file: 'a.txt' });
  const [f] = P.parseDiff(ui);
  const lines = f.hunks[0].lines.map((l, i) => (l.s === 'NINE' || l.s === 'nine' ? i : -1)).filter((i) => i >= 0);
  await G.applySelection(repo, { action: 'discard', file: 'a.txt', selection: { hunks: { [f.hunks.length - 1]: f.hunks.length === 1 ? lines : 'all' } }, expect: G.fingerprint(ui) });
  assert.equal(read(dir, 'a.txt'), TEN.replace('two', 'TWO'));
  const backups = G.listBackups(repo);
  assert.equal(backups[0].kind, 'lines');
  await G.restoreBackup(repo, backups[0].id);
  assert.equal(read(dir, 'a.txt'), TEN.replace('two', 'TWO').replace('nine', 'NINE'));
});

test('discard files and untracked files, then restore both', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', 'changed\n');
  write(dir, 'notes/new.txt', 'keep me\n');
  const res = await G.discard(repo, { files: ['a.txt'], untracked: ['notes/new.txt'] });
  assert.equal(read(dir, 'a.txt'), TEN);
  assert.equal(fs.existsSync(path.join(dir, 'notes/new.txt')), false);
  await G.restoreBackup(repo, res.backup);
  assert.equal(read(dir, 'a.txt'), 'changed\n');
  assert.equal(read(dir, 'notes/new.txt'), 'keep me\n');
});

test('discard all includes staged changes and is restorable', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', 'staged\n'); g(dir, 'add', 'a.txt');
  write(dir, 'b.txt', 'untracked\n');
  const res = await G.discardAll(repo, { includeUntracked: true });
  assert.equal(g(dir, 'status', '--porcelain'), '');
  await G.restoreBackup(repo, res.backup);
  assert.equal(read(dir, 'a.txt'), 'staged\n');
  assert.equal(read(dir, 'b.txt'), 'untracked\n');
});

test('commit, amend, undo last commit; undo refused once pushed', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', 'x\n'); g(dir, 'add', '-A');
  await G.commit(repo, { message: 'Subject line\n\nBody text' });
  assert.equal(g(dir, 'log', '-1', '--format=%B').trim(), 'Subject line\n\nBody text');
  await G.commit(repo, { message: 'Better subject', amend: true });
  assert.equal(g(dir, 'log', '-1', '--format=%s').trim(), 'Better subject');
  assert.equal(g(dir, 'rev-list', '--count', 'HEAD').trim(), '2');
  await G.undoLastCommit(repo);
  assert.equal(g(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
  assert.match(g(dir, 'diff', '--cached', '--name-only'), /a\.txt/);
  await assert.rejects(G.undoLastCommit(repo), /already on a remote/);
  await assert.rejects(G.commit(repo, { message: '   ' }), /commit message/);
});

test('hook failure surfaces the hook output and skip-hooks works', async (t) => {
  const { dir, repo } = setup(t);
  const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed: missing semicolon" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  write(dir, 'a.txt', 'y\n'); g(dir, 'add', '-A');
  await assert.rejects(G.commit(repo, { message: 'x' }), (e) => /lint failed/.test(e.message + e.stderr));
  await G.commit(repo, { message: 'x', noVerify: true });
  assert.equal(g(dir, 'log', '-1', '--format=%s').trim(), 'x');
});

test('push publishes a new branch, pull fast-forwards, sync', async (t) => {
  const { root, dir, repo, remote } = setup(t);
  await G.createBranch(repo, { name: 'feature/a', checkout: true });
  write(dir, 'f.txt', '1\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'f');
  const res = await G.push(repo, {});
  assert.equal(res.branch, 'feature/a');
  assert.match(g(dir, 'rev-parse', '--abbrev-ref', '@{u}'), /origin\/feature\/a/);
  // second clone pushes to main, first pulls
  const other = path.join(root, 'other');
  g(root, 'clone', '-q', remote, other);
  g(other, 'config', 'user.email', 't@e'); g(other, 'config', 'user.name', 't');
  write(other, 'b.txt', 'b\n'); g(other, 'add', '-A'); g(other, 'commit', '-qm', 'b'); g(other, 'push', '-q', 'origin', 'main');
  await G.switchBranch(repo, { name: 'main' });
  await G.fetch(repo, {});
  const s = await G.summary(repo);
  assert.equal(s.behind, 1);
  await G.pull(repo, { strategy: 'ff-only' });
  assert.equal(read(dir, 'b.txt'), 'b\n');
  write(dir, 'c.txt', 'c\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'c');
  await G.sync(repo, { strategy: 'merge' });
  assert.equal((await G.summary(repo)).ahead, 0);
});

test('push is rejected (not forced) when remote moved; force-with-lease is explicit', async (t) => {
  const { root, dir, repo, remote } = setup(t);
  const other = path.join(root, 'other');
  g(root, 'clone', '-q', remote, other);
  g(other, 'config', 'user.email', 't@e'); g(other, 'config', 'user.name', 't');
  write(other, 'x.txt', 'x\n'); g(other, 'add', '-A'); g(other, 'commit', '-qm', 'x'); g(other, 'push', '-q', 'origin', 'main');
  write(dir, 'y.txt', 'y\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'y');
  await assert.rejects(G.push(repo, {}), (e) => /rejected|fetch first|non-fast-forward/i.test(e.message + e.stderr));
  // lease protects: we have not fetched, so our view of origin/main is stale -> refused
  await assert.rejects(G.push(repo, { forceWithLease: true }), (e) => /stale info|rejected/i.test(e.message + e.stderr));
});

test('switch with stash mode, rename, delete merged and unmerged', async (t) => {
  const { dir, repo } = setup(t);
  await G.createBranch(repo, { name: 'topic', checkout: false });
  write(dir, 'a.txt', 'dirty\n');
  await G.switchBranch(repo, { name: 'topic', mode: 'stash' });
  assert.equal(read(dir, 'a.txt'), TEN);
  assert.equal((await G.stashList(repo)).length, 1);
  await G.renameBranch(repo, { from: 'topic', to: 'topic2' });
  write(dir, 't.txt', 't\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 't');
  await G.switchBranch(repo, { name: 'main' });
  await assert.rejects(G.deleteBranch(repo, { name: 'topic2' }), /not fully merged/);
  await G.deleteBranch(repo, { name: 'topic2', force: true });
  assert.equal(await G.refExists(repo, 'refs/heads/topic2'), false);
  await assert.rejects(G.createBranch(repo, { name: 'bad name' }), /not a valid/);
  await assert.rejects(G.createBranch(repo, { name: '--force' }), /not a valid/);
});

test('merge conflict: detected, resolved per hunk, continued', async (t) => {
  const { dir, repo } = setup(t, { 'c.txt': 'l1\nl2\nl3\n' });
  g(dir, 'switch', '-qc', 'other'); write(dir, 'c.txt', 'l1\nother\nl3\n'); g(dir, 'commit', '-qam', 'o');
  g(dir, 'switch', '-q', 'main'); write(dir, 'c.txt', 'l1\nmain\nl3\n'); g(dir, 'commit', '-qam', 'm');
  await assert.rejects(G.merge(repo, { rev: 'other' }), (e) => /CONFLICT/.test(e.message + e.stdout + e.stderr));
  const ch = await G.changes(repo);
  assert.deepEqual(ch.inProgress, ['merge']);
  assert.equal(ch.conflicted[0].path, 'c.txt');
  const parsed = await G.conflictFile(repo, 'c.txt');
  assert.equal(parsed.segs.filter((s) => s.type === 'conflict').length, 1);
  await G.resolveConflictFile(repo, { file: 'c.txt', choices: ['both'], markResolved: true });
  assert.equal(read(dir, 'c.txt'), 'l1\nmain\nother\nl3\n');
  await G.continueOp(repo, 'merge');
  assert.deepEqual((await G.opState(repo)).inProgress, []);
  assert.equal(g(dir, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3);
});

test('abort a conflicted rebase restores the branch', async (t) => {
  const { dir, repo } = setup(t, { 'c.txt': 'a\n' });
  g(dir, 'switch', '-qc', 'other'); write(dir, 'c.txt', 'b\n'); g(dir, 'commit', '-qam', 'o');
  g(dir, 'switch', '-q', 'main'); write(dir, 'c.txt', 'c\n'); g(dir, 'commit', '-qam', 'm');
  const before = g(dir, 'rev-parse', 'HEAD').trim();
  await assert.rejects(G.rebase(repo, { onto: 'other' }));
  assert.deepEqual((await G.opState(repo)).inProgress, ['rebase']);
  await G.abortOp(repo, 'rebase');
  assert.equal(g(dir, 'rev-parse', 'HEAD').trim(), before);
});

test('stash: push with untracked, files, apply, pop, drop, branch', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', 'mod\n'); write(dir, 'u.txt', 'untracked\n');
  await G.stashPush(repo, { message: 'wip', includeUntracked: true });
  const [s] = await G.stashList(repo);
  assert.equal(s.message.includes('wip'), true);
  assert.equal(s.hasUntracked, true);
  const files = await G.stashFiles(repo, 'stash@{0}');
  assert.deepEqual(files.map((f) => f.path).sort(), ['a.txt', 'u.txt']);
  await G.stashApply(repo, { ref: 'stash@{0}' });
  assert.equal(read(dir, 'a.txt'), 'mod\n');
  g(dir, 'checkout', '--', 'a.txt'); fs.unlinkSync(path.join(dir, 'u.txt'));
  await G.stashApply(repo, { ref: 'stash@{0}', pop: true });
  assert.equal((await G.stashList(repo)).length, 0);
  await G.stashPush(repo, { message: 'again', includeUntracked: true });
  await G.stashBranch(repo, { ref: 'stash@{0}', name: 'from-stash' });
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'from-stash');
  await G.stashPush(repo, { message: 'drop me', includeUntracked: true });
  await G.stashDrop(repo, { ref: 'stash@{0}' });
  assert.equal((await G.stashList(repo)).length, 0);
  await assert.rejects(G.stashDrop(repo, { ref: 'HEAD' }), /Invalid stash/);
});

test('tags: lightweight, annotated, push, delete local and remote', async (t) => {
  const { dir, repo, remote } = setup(t);
  await G.createTag(repo, { name: 'v1' });
  await G.createTag(repo, { name: 'v2', message: 'Release 2' });
  const refs = await G.refs(repo);
  assert.deepEqual(refs.tags.map((x) => [x.name, x.annotated]).sort(), [['v1', false], ['v2', true]]);
  await G.pushTag(repo, { name: 'v2' });
  assert.match(g(remote, 'tag'), /v2/);
  await G.deleteRemoteTag(repo, { name: 'v2' });
  assert.doesNotMatch(g(remote, 'tag'), /v2/);
  await G.deleteTag(repo, { name: 'v1' });
  assert.doesNotMatch(g(dir, 'tag'), /v1/);
});

test('hard reset keeps a safety copy of uncommitted work; drop commit; cherry-pick; revert', async (t) => {
  const { dir, repo } = setup(t);
  const base = g(dir, 'rev-parse', 'HEAD').trim();
  write(dir, 'x.txt', 'x\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'x');
  write(dir, 'y.txt', 'y\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'y');
  const x = g(dir, 'rev-parse', 'HEAD~1').trim();
  await G.dropCommit(repo, { rev: x });
  assert.equal(fs.existsSync(path.join(dir, 'x.txt')), false);
  assert.equal(read(dir, 'y.txt'), 'y\n');
  write(dir, 'a.txt', 'uncommitted\n');
  const r = await G.reset(repo, { rev: base, mode: 'hard' });
  assert.ok(r.backup);
  assert.equal(read(dir, 'a.txt'), TEN);
  await G.restoreBackup(repo, r.backup);
  assert.equal(read(dir, 'a.txt'), 'uncommitted\n');
  g(dir, 'checkout', '--', 'a.txt');
  await G.cherryPick(repo, { rev: x });
  assert.equal(read(dir, 'x.txt'), 'x\n');
  await G.revert(repo, { rev: 'HEAD' });
  assert.equal(fs.existsSync(path.join(dir, 'x.txt')), false);
  await assert.rejects(G.dropCommit(repo, { rev: base }), /already on a remote/);
});

test('squash unpushed commits and reword', async (t) => {
  const { dir, repo } = setup(t);
  for (const n of ['1', '2', '3']) { write(dir, `${n}.txt`, n); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', `c${n}`); }
  await G.squashLast(repo, 3, 'All three');
  assert.equal(g(dir, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(g(dir, 'log', '-1', '--format=%s').trim(), 'All three');
  await G.rewordLast(repo, 'Renamed');
  assert.equal(g(dir, 'log', '-1', '--format=%s').trim(), 'Renamed');
  await assert.rejects(G.squashLast(repo, 2, 'x'), /unpushed/);
});

test('log and commit detail for the graph; file history; blame', async (t) => {
  const { dir, repo } = setup(t);
  write(dir, 'a.txt', TEN.replace('one', 'ONE')); g(dir, 'commit', '-qam', 'upper one');
  const log = await G.log(repo, {});
  assert.equal(log[0].subject, 'upper one');
  assert.ok(log[0].refs.some((x) => x.type === 'branch' && x.name === 'main'));
  const d = await G.commitDetail(repo, log[0].hash);
  assert.deepEqual(d.files.map((f) => [f.status, f.path, f.add, f.del]), [['M', 'a.txt', 1, 1]]);
  const hist = await G.log(repo, { file: 'a.txt', follow: true });
  assert.equal(hist.length, 2);
  const b = await G.blame(repo, 'a.txt');
  assert.equal(b.lines[0].text, 'ONE');
  assert.equal(b.commits[b.lines[0].hash].summary, 'upper one');
  const grep = await G.log(repo, { grep: 'UPPER' });
  assert.equal(grep.length, 1);
});

test('non-ASCII names and CRLF content survive line staging', async (t) => {
  const { dir, repo } = setup(t, { 'ü file.txt': 'a\r\nb\r\nc\r\n' });
  write(dir, 'ü file.txt', 'a\r\nB\r\nc\r\nd\r\n');
  const P = require('../../server/parse');
  const s = await G.status(repo);
  assert.equal(s.unstaged[0].path, 'ü file.txt');
  const text = await G.fileDiff(repo, { kind: 'unstaged', file: 'ü file.txt' });
  const [f] = P.parseDiff(text);
  const dIdx = f.hunks[0].lines.findIndex((l) => l.t === '+' && l.s.startsWith('d'));
  await G.applySelection(repo, { action: 'stage', file: 'ü file.txt', selection: { hunks: { 0: [dIdx] } }, expect: G.fingerprint(text) });
  assert.equal(g(dir, 'show', ':ü file.txt'), 'a\r\nb\r\nc\r\nd\r\n');
});

test('worktrees, .gitignore, remotes', async (t) => {
  const { root, dir, repo } = setup(t);
  const wt = path.join(root, 'wt');
  await G.addWorktree(repo, { dir: wt, newBranch: 'wt-branch' });
  assert.equal((await G.worktrees(repo)).length, 2);
  await G.removeWorktree(repo, { dir: wt });
  assert.equal((await G.worktrees(repo)).length, 1);
  await G.addToGitignore(repo, '*.log');
  assert.deepEqual(await G.addToGitignore(repo, '*.log'), { already: true });
  assert.equal(read(dir, '.gitignore'), '*.log\n');
  await G.addRemote(repo, { name: 'upstream', url: 'git@github.com-work:acme/thing.git' });
  const rs = await G.remotes(repo);
  assert.equal(rs.find((x) => x.name === 'upstream').parsed.slug, 'acme/thing');
  await G.removeRemote(repo, { name: 'upstream' });
  await assert.rejects(G.addRemote(repo, { name: 'x', url: '--upload-pack=evil' }), /Invalid URL/);
});

test('paths outside the repository are refused', () => {
  assert.throws(() => G.safeJoin('C:\\repo', '..\\other\\file'), /outside/);
  assert.throws(() => G.safeJoin('/repo', '../etc/passwd'), /outside/);
});
