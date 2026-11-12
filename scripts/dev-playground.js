// Creates a throwaway playground of repositories in various states and starts the app
// against it with a separate data folder, so development never touches real repositories.
//   node scripts/dev-playground.js [--port 47900]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { git, write, makeRepo } = require('../test/helpers');

const base = path.join(os.tmpdir(), 'repodeck-playground');
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? +process.argv[portArg + 1] : 47900;
const fresh = process.argv.includes('--fresh');

if (fresh) fs.rmSync(base, { recursive: true, force: true });
const root = path.join(base, 'code');
const data = path.join(base, 'data');
const remotes = path.join(base, 'remotes');
if (!fs.existsSync(root)) {
  fs.mkdirSync(root, { recursive: true });
  // parent repo with nested service repos (not submodules)
  const parent = makeRepo(root, 'platform', { 'README.md': '# Platform\n', 'services/.gitkeep': '' }, remotes);
  const svc = path.join(parent.dir, 'services');
  const api = makeRepo(svc, 'api-service', { 'src/index.js': 'console.log("hi");\n'.repeat(5), 'README.md': '# API\n' }, remotes);
  const worker = makeRepo(svc, 'job-worker', { 'main.py': 'print("hello")\n' }, remotes);
  makeRepo(path.join(svc, 'ai'), 'translator', { 'app.py': 'x = 1\n' }, remotes);
  // dirty: modified + untracked + staged
  write(api.dir, 'src/index.js', 'console.log("hello");\n'.repeat(3) + 'const added = true;\n');
  write(api.dir, 'notes.txt', 'scratch\n');
  write(api.dir, 'README.md', '# API service\n\nUpdated readme.\n');
  git(api.dir, 'add', 'README.md');
  // feature branch with unpushed commits
  git(worker.dir, 'switch', '-q', '-c', 'feature/example');
  write(worker.dir, 'main.py', 'print("hello world")\n');
  git(worker.dir, 'commit', '-qam', 'Improve greeting');
  write(worker.dir, 'util.py', 'def f():\n    return 1\n');
  git(worker.dir, 'add', '-A');
  git(worker.dir, 'commit', '-qm', 'Add util');
  // a repo with a merge conflict in progress
  const conflict = makeRepo(root, 'conflicted', { 'app.txt': 'line 1\nline 2\nline 3\n' }, remotes);
  git(conflict.dir, 'switch', '-q', '-c', 'other');
  write(conflict.dir, 'app.txt', 'line 1\nline 2 from other\nline 3\n');
  git(conflict.dir, 'commit', '-qam', 'other change');
  git(conflict.dir, 'switch', '-q', 'main');
  write(conflict.dir, 'app.txt', 'line 1\nline 2 from main\nline 3\n');
  git(conflict.dir, 'commit', '-qam', 'main change');
  try { git(conflict.dir, 'merge', 'other'); } catch {}
  // a clean repo with history and tags
  const hist = makeRepo(root, 'history', { 'f.txt': '0\n' }, remotes);
  for (let i = 1; i <= 30; i++) {
    write(hist.dir, 'f.txt', `${i}\n`);
    git(hist.dir, 'commit', '-qam', `Change number ${i}`);
    if (i % 6 === 0) {
      git(hist.dir, 'switch', '-q', '-c', `topic-${i}`);
      write(hist.dir, `topic-${i}.txt`, 'a\n'); git(hist.dir, 'add', '-A'); git(hist.dir, 'commit', '-qm', `Topic ${i} part 1`);
      write(hist.dir, `topic-${i}.txt`, 'a\nb\n'); git(hist.dir, 'commit', '-qam', `Topic ${i} part 2`);
      git(hist.dir, 'switch', '-q', 'main');
      write(hist.dir, 'f.txt', `${i} main\n`); git(hist.dir, 'commit', '-qam', `Main work during topic ${i}`);
      if (i < 30) git(hist.dir, 'merge', '-q', '--no-ff', '-m', `Merge topic-${i}`, `topic-${i}`);
    }
    if (i % 10 === 0) git(hist.dir, 'tag', `v0.${i / 10}.0`);
  }
  git(hist.dir, 'push', '-q', 'origin', 'main');
  write(hist.dir, 'stash-me.txt', 'temp\n');
  git(hist.dir, 'stash', 'push', '-u', '-q', '-m', 'work in progress');
}
fs.mkdirSync(data, { recursive: true });
const cfgFile = path.join(data, 'config.json');
if (!fs.existsSync(cfgFile)) {
  fs.writeFileSync(cfgFile, JSON.stringify({ roots: [{ path: root, name: 'playground' }], firstRunDone: true, port, notifications: false, keepRunningWhenClosed: true }, null, 2));
}
console.log(`Playground: ${root}\nData: ${data}`);
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'main.js'), '--no-open'], {
  env: { ...process.env, REPODECK_DATA: data, REPODECK_PRINT_URL: '1' }, stdio: 'inherit',
});
child.on('exit', (c) => process.exit(c || 0));
