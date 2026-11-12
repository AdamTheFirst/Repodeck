'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpdir, rm } = require('../helpers');

// The marks are saved in the data folder: keep the test away from the real one.
const dataDir = tmpdir('unreachable-data');
process.env.REPODECK_DATA = dataDir;
const work = tmpdir('unreachable-work');
test.after(() => { rm(dataDir); rm(work); });

const unreachable = require('../../server/unreachable');
const git = require('../../server/git');

test('only errors that will not go away by trying again count', () => {
  assert.ok(unreachable.lasting('remote: Repository not found.\nfatal: repository not found'));
  assert.ok(unreachable.lasting('git@example.com: Permission denied (publickey).'));
  assert.ok(unreachable.lasting("fatal: 'x' does not appear to be a git repository"));
  assert.equal(unreachable.lasting('fatal: unable to access: Could not resolve host: github.com'), null);
  assert.equal(unreachable.lasting('ssh: connect to host github.com port 22: Connection timed out'), null);
  assert.equal(unreachable.lasting('something else'), null);
});

test('a repository without a remote is left alone', () => {
  assert.equal(unreachable.skipReason({ path: path.join(work, 'none') }, []), 'no remote');
});

test('a failed fetch marks the repository until it works or its address changes', async () => {
  const dir = path.join(work, 'gone');
  fs.mkdirSync(dir);
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('remote', 'add', 'origin', path.join(work, 'does-not-exist'));
  const repo = { path: dir, name: 'gone', id: 'gone' };
  assert.equal(unreachable.skipReason(repo, await git.remotes(repo)), null);
  await assert.rejects(git.fetch(repo, { all: true }));
  assert.match(unreachable.skipReason(repo, await git.remotes(repo)), /not a repository last time/);

  // a new address is worth another try
  g('remote', 'set-url', 'origin', path.join(work, 'elsewhere'));
  assert.equal(unreachable.skipReason(repo, await git.remotes(repo)), null);

  // and a fetch that works clears the mark
  await assert.rejects(git.fetch(repo, { all: true }));
  const bare = path.join(work, 'real.git');
  execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' });
  g('remote', 'set-url', 'origin', bare);
  await git.fetch(repo, { all: true });
  assert.equal(unreachable.skipReason(repo, await git.remotes(repo)), null);
});

test('with several remotes nothing is marked: the others may be fine', async () => {
  const dir = path.join(work, 'two');
  fs.mkdirSync(dir);
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('remote', 'add', 'origin', path.join(work, 'real.git'));
  g('remote', 'add', 'old', path.join(work, 'does-not-exist'));
  const repo = { path: dir, name: 'two', id: 'two' };
  await assert.rejects(git.fetch(repo, { all: true }));
  assert.equal(unreachable.skipReason(repo, await git.remotes(repo)), null);
});
