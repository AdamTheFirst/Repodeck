// Repositories whose remote could not be reached for a lasting reason: it does not exist, or this
// computer may not read it. "Fetch all" and the background fetch leave them alone instead of failing
// on them every time. Fetching such a repository on its own always tries again, and a success or a
// changed remote address clears the mark.
'use strict';
const { paths, writeJsonAtomic, readJson } = require('./paths');
const config = require('./config');

const file = () => paths.stateFor(config.get().currentAccount).replace(/state-([^\/]*)$/, 'unreachable-$1');
let cache = null;
let cacheFile = null;
function load() {
  const f = file();
  if (cacheFile !== f) { cache = readJson(f, {}) || {}; cacheFile = f; }
  return cache;
}
function save() { try { writeJsonAtomic(cacheFile, cache); } catch {} }

/** Pure: a short reason when the error will not go away by trying again, else null. */
function lasting(message) {
  const m = String(message || '');
  if (/Could not resolve host|timed out|Connection (refused|reset|closed)|Network is unreachable|unable to access .*(resolve|connect)/i.test(m)) return null; // offline: try again next time
  if (/Repository not found/i.test(m)) return 'the repository was not found on the server';
  if (/Permission denied|Authentication failed|access denied|HTTP 40[13]/i.test(m)) return 'access was denied';
  if (/does not appear to be a git repository|not a git repository/i.test(m)) return 'the remote address is not a repository';
  return null;
}

const key = (repo) => repo.path.toLowerCase();
const sig = (remotes) => remotes.map((r) => `${r.name}=${r.url}`).sort().join('\n');

/** After a failed fetch. Only repositories with one remote are marked: with several, the others may be fine. */
function note(repo, remotes, message) {
  const reason = lasting(message);
  if (!reason || remotes.length !== 1) return null;
  load()[key(repo)] = { reason, remotes: sig(remotes), at: Date.now() };
  save();
  return reason;
}
function clear(repo) {
  if (load()[key(repo)]) { delete cache[key(repo)]; save(); }
}
/** Why a bulk fetch should leave this repository alone, or null. */
function skipReason(repo, remotes) {
  if (!remotes.length) return 'no remote';
  const m = load()[key(repo)];
  if (!m) return null;
  if (m.remotes !== sig(remotes)) { clear(repo); return null; } // the address changed: worth another try
  return `${m.reason} last time; fetch it on its own to try again`;
}

module.exports = { lasting, note, clear, skipReason };
