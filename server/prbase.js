// Which branch a new pull request opens into: the one set for the repository, else the one set
// for every repository, else the repository's default branch. A set branch is used only where it exists.
'use strict';

const key = (s) => `${s.owner}/${s.repo}`.toLowerCase();

/** A plausible branch name ('' = not set). Not git's full rule set: enough to keep nonsense out of the settings file. */
function validName(v) {
  return typeof v === 'string' && v.length <= 200 && (v === '' || !/[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|^[-/.]|[/.]$|\/\/|\.lock$/.test(v));
}

/** The branches the user asked for, most specific first: [{ branch, from: 'repo' | 'all' }]. */
function wanted(cfg, s) {
  const out = [];
  const mine = s && cfg.prBaseByRepo ? cfg.prBaseByRepo[key(s)] : '';
  if (mine) out.push({ branch: mine, from: 'repo' });
  if (cfg.prBase && cfg.prBase !== mine) out.push({ branch: cfg.prBase, from: 'all' });
  return out;
}

/**
 * Pick the base for a pull request from `head`.
 * exists(branch) says whether the repository on GitHub has that branch.
 * Returns { base, from: 'repo' | 'all' | 'default', missing: [set branches this repository does not have] }.
 */
async function choose({ cfg, slug, head, fallback, exists }) {
  const missing = [];
  for (const w of wanted(cfg, slug)) {
    if (w.branch === head) continue; // a branch is never merged into itself: on develop, develop goes to the default branch
    if (w.branch === fallback || await exists(w.branch)) return { base: w.branch, from: w.from, missing };
    missing.push(w.branch);
  }
  return { base: fallback, from: 'default', missing };
}

/** The per-repository map with one repository's branch set, or removed when branch is ''. */
function withRepo(map, s, branch) {
  const next = { ...(map || {}) };
  if (branch) next[key(s)] = branch; else delete next[key(s)];
  return next;
}

module.exports = { key, validName, wanted, choose, withRepo };
