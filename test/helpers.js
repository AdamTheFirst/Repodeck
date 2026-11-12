// Throwaway repositories for tests. Everything lives under the OS temp folder.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENV = {
  ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function tmpdir(prefix = 'gh-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function write(dir, file, content) {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** A repo with a bare "origin", one pushed commit on main. Returns { dir, remote, repo } where repo is the server-side record. */
function makeRepo(root, name = 'work', files = { 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, remotesDir = root) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(remotesDir, { recursive: true });
  const remote = path.join(remotesDir, `${name}.remote.git`);
  git(remotesDir, 'init', '--bare', '-q', remote);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'remote', 'set-head', 'origin', 'main');
  return { dir, remote, repo: { id: `t${Math.random().toString(36).slice(2, 8)}`, path: dir, name, label: name } };
}

function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }

module.exports = { tmpdir, git, write, makeRepo, rm, ENV };
