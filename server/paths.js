'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const base = process.env.GIT_HELPER_DATA
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'git-helper');

const paths = {
  data: base,
  config: path.join(base, 'config.json'),
  state: path.join(base, 'state.json'),
  cache: path.join(base, 'cache.json'),
  instance: path.join(base, 'instance.json'),
  logs: path.join(base, 'logs'),
  backups: path.join(base, 'backups'),
  drafts: path.join(base, 'drafts'),
  neutral: path.join(base, 'neutral'), // cwd for gh so it never infers a repo
};

for (const p of [paths.data, paths.logs, paths.backups, paths.drafts, paths.neutral]) {
  fs.mkdirSync(p, { recursive: true });
}

/** Write JSON atomically: temp file, then rename over the target. */
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const acctKey = (login) => (login ? String(login).toLowerCase().replace(/[^a-z0-9-]/g, '') : '_none');
/** Each account keeps its own tracked runs and status cache, so two windows never overwrite each other. */
paths.stateFor = (login) => path.join(base, `state-${acctKey(login)}.json`);
paths.cacheFor = (login) => path.join(base, `cache-${acctKey(login)}.json`);

module.exports = { paths, writeJsonAtomic, readJson };
