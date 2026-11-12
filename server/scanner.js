// Discover git repositories under configured roots, including repos nested inside repos.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function globToRegex(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

function repoId(p) {
  return crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * Walk a root. A directory is a repo if it contains `.git` (dir = normal repo,
 * file = worktree or submodule). We keep descending into repos to find nested ones.
 */
async function scanRoot(root, { ignore = [], depth = 6 } = {}) {
  const ignoreRx = ignore.map(globToRegex);
  const found = [];
  const seen = new Set();

  async function walk(dir, level, parentRepo) {
    let real;
    try { real = (await fs.promises.realpath(dir)).toLowerCase(); } catch { return; }
    if (seen.has(real)) return; // avoid junction / symlink loops
    seen.add(real);

    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }

    let thisRepo = parentRepo;
    const gitEntry = entries.find((e) => e.name.toLowerCase() === '.git');
    if (gitEntry) {
      const kind = gitEntry.isDirectory() ? 'repo' : 'linked'; // linked = worktree or submodule
      const rec = { id: repoId(dir), path: dir, kind, parent: parentRepo ? parentRepo.id : null };
      found.push(rec);
      thisRepo = rec;
    }
    if (level >= depth) return;

    const subdirs = entries.filter((e) => e.isDirectory() && e.name.toLowerCase() !== '.git'
      && !ignoreRx.some((rx) => rx.test(e.name)));
    await Promise.all(subdirs.map((e) => walk(path.join(dir, e.name), level + 1, thisRepo)));
  }

  await walk(path.resolve(root), 0, null);
  found.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return found;
}

async function scanAll(roots, opts) {
  const out = [];
  for (const r of roots) {
    const repos = await scanRoot(r.path, opts);
    for (const rec of repos) {
      rec.root = path.resolve(r.path);
      rec.rootName = r.name || path.basename(r.path);
      rec.rel = path.relative(rec.root, rec.path) || '.';
      rec.name = path.basename(rec.path);
      out.push(rec);
    }
  }
  // One repo may appear under two overlapping roots: keep the first.
  const byId = new Map();
  for (const r of out) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

module.exports = { scanRoot, scanAll, repoId, globToRegex };
