// Finds folders that contain git repositories, for first-run setup. Read-only and time-boxed.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKIP = new Set([
  'node_modules', 'appdata', '.cache', '.npm', '.nuget', '.gradle', '.m2', '.cargo', '.rustup', 'scoop', '.vscode', '.vscode-server',
  '.android', '.dotnet', '.local', '.config', 'library', '$recycle.bin', 'system volume information', 'windows', 'program files',
  'program files (x86)', 'programdata', 'msocache', 'recovery', 'perflogs', 'intel', 'amd', 'nvidia', 'drivers', 'windows.old',
  '.venv', 'venv', 'dist', 'build', 'target', 'obj', 'bin', '.next', 'vendor', 'pagefile.sys', 'swapfile.sys', 'hiberfil.sys',
  'onedrivetemp', '.git', '.pnpm-store', '__pycache__', 'go', 'miniconda3', 'anaconda3', '.conda',
]);

function drives() {
  if (process.platform !== 'win32') return ['/'];
  const out = [];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { fs.accessSync(`${l}:\\`); out.push(`${l}:\\`); } catch {} }
  return out;
}

/**
 * Walk likely places for repositories. Stops descending into a repository (nested repos are found
 * later by the regular scan of whichever folder the user picks).
 * Returns [{ path, repos: [names], count }] sorted by count, where path is the parent folder of the repos.
 */
async function discover({ timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const home = os.homedir();
  const found = [];
  const seen = new Set();
  const starts = [{ dir: home, depth: 4 }];
  for (const d of drives()) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name.toLowerCase()) || e.name.toLowerCase() === 'users') continue;
      starts.push({ dir: path.join(d, e.name), depth: 3 });
    }
  }
  let timedOut = false;
  async function walk(dir, depth) {
    if (Date.now() > deadline) { timedOut = true; return; }
    let real;
    try { real = (await fs.promises.realpath(dir)).toLowerCase(); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === '.git')) { found.push(dir); return; }
    if (depth <= 0) return;
    const subs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name.toLowerCase()) && !e.name.startsWith('$') && !e.name.startsWith('.'));
    for (let i = 0; i < subs.length; i += 16) {
      await Promise.all(subs.slice(i, i + 16).map((e) => walk(path.join(dir, e.name), depth - 1)));
    }
  }
  await Promise.all(starts.map((s) => walk(s.dir, s.depth)));
  const groups = new Map();
  for (const r of found) {
    const parent = path.dirname(r);
    const key = parent.toLowerCase();
    if (!groups.has(key)) groups.set(key, { path: parent, repos: [] });
    groups.get(key).repos.push(path.basename(r));
  }
  // A group inside another group's folder is covered by it (the regular scan finds nested repos).
  const all = [...groups.values()];
  for (const g of all) {
    const outer = all.find((o) => o !== g && !isTooBroad(o.path, home) && g.path.toLowerCase().startsWith(o.path.toLowerCase() + path.sep));
    if (outer) { outer.repos.push(...g.repos.map((n) => `${path.relative(outer.path, g.path)}${path.sep}${n}`)); g.merged = true; }
  }
  const list = all.filter((g) => !g.merged).map((g) => ({ ...g, count: g.repos.length, repos: g.repos.sort().slice(0, 12) }))
    // a repo directly in a drive root or the home folder: suggest the repo itself, not the whole drive
    .flatMap((g) => (isTooBroad(g.path, home) ? g.repos.map((name) => ({ path: path.join(g.path, name), repos: [name], count: 1, single: true })) : [g]))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return { folders: list, timedOut, scanned: seen.size };
}

function isTooBroad(p, home) {
  const n = path.resolve(p).toLowerCase();
  return n === path.resolve(home).toLowerCase() || /^[a-z]:\\?$/.test(n) || n === '/';
}

module.exports = { discover };
