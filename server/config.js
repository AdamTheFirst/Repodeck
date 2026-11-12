'use strict';
const fs = require('node:fs');
const { paths, writeJsonAtomic } = require('./paths');

const DEFAULTS = {
  version: 1,
  port: 47821,
  currentAccount: '',        // GitHub login whose workspace is shown ('' = no account)
  accountRoots: {},          // login -> [{ path, name }]; each account has its own folders
  ignore: ['node_modules', '.venv', '.venv*', 'venv', 'dist', 'build', 'out', 'target',
    '.pnpm-store', '.next', '.nuxt', '.cache', '.tmp', 'bin', 'obj', '__pycache__', '.gradle', '.idea'],
  scanDepth: 6,
  refreshSeconds: 30,
  actionsRefreshSeconds: 120,  // background default-branch checks (one GraphQL call per account)
  boardRefreshSeconds: 30,     // while the Actions board is open
  trackedRefreshSeconds: 10,   // pinned runs
  backgroundFetch: false,
  backgroundFetchMinutes: 15,
  trackExternalRuns: true,     // pin runs started by pushes made outside the app
  pullStrategy: 'merge',       // merge | rebase | ff-only
  updateFromDefault: 'merge',  // merge | rebase
  notifications: true,
  notifySound: false,
  notifyReviewRequests: true,
  keepRunningWhenClosed: false,
  editorCommand: 'code',       // program + args; {path} is replaced
  editorArgs: ['{path}'],
  terminalCommand: 'wt',
  terminalArgs: ['-d', '{path}'],
  theme: 'system',             // system | light | dark
  favourites: [],
  bulkConcurrency: 6,
  defaultPrFilter: 'all',
  firstRunDone: false,
};

let current = null;

let loadProblem = null;

function load() {
  let saved = {};
  let raw = null;
  try { raw = fs.readFileSync(paths.config, 'utf8'); } catch {}
  if (raw != null) {
    try {
      saved = JSON.parse(raw.replace(/^﻿/, ''));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not an object');
    } catch (e) {
      // Keep the unreadable file instead of silently overwriting it on the next save.
      const keep = `${paths.config}.unreadable-${Date.now()}`;
      try { fs.copyFileSync(paths.config, keep); } catch {}
      loadProblem = `Settings file could not be read (${e.message}). Defaults are in use; the old file was kept as ${keep}.`;
      saved = {};
    }
  }
  // Older settings had one shared folder list; park it until the first account is known.
  if (Array.isArray(saved.roots)) {
    saved.accountRoots = { ...(saved.accountRoots || {}) };
    if (saved.roots.length && !Object.keys(saved.accountRoots).length) saved.accountRoots[UNASSIGNED] = saved.roots;
    delete saved.roots;
  }
  delete saved.accountForOwner; delete saved.autoDetectAccounts;
  current = { ...DEFAULTS, ...saved };
  view = null;
  return get();
}

const UNASSIGNED = '*';
const LOCAL = '_local';
let view = null;
/** Which folder list is in effect: the current account's, else unassigned folders, else the no-account list. */
function rootsKey(cfg = current) {
  if (cfg.currentAccount) return cfg.currentAccount;
  return cfg.accountRoots[UNASSIGNED] ? UNASSIGNED : LOCAL;
}
/** Give folders from before accounts existed to the first account that is used. */
function adoptUnassigned(login) {
  get();
  const ar = { ...current.accountRoots };
  if (!login || !ar[UNASSIGNED]) return;
  if (!ar[login] || !ar[login].length) ar[login] = ar[UNASSIGNED];
  delete ar[UNASSIGNED];
  current = { ...current, accountRoots: ar };
  writeJsonAtomic(paths.config, current);
  view = null;
}
function problem() { return loadProblem; }

/** Settings as the rest of the app sees them: `roots` is the current account's folder list. */
function get() {
  if (!current) return load();
  if (!view) view = { ...current, roots: current.accountRoots[rootsKey()] || [] };
  return view;
}

const VALID = {
  port: (v) => Number.isInteger(v) && v > 1024 && v < 65536,
  roots: (v) => Array.isArray(v) && v.every((r) => r && typeof r.path === 'string'),
  ignore: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  pullStrategy: (v) => ['merge', 'rebase', 'ff-only'].includes(v),
  updateFromDefault: (v) => ['merge', 'rebase'].includes(v),
  theme: (v) => ['system', 'light', 'dark'].includes(v),
  editorArgs: (v) => Array.isArray(v),
  terminalArgs: (v) => Array.isArray(v),
  favourites: (v) => Array.isArray(v),
  currentAccount: (v) => typeof v === 'string' && /^[A-Za-z0-9-]*$/.test(v),
};

function update(patch) {
  get();
  const cfg = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'roots') {
      if (!VALID.roots(v)) throw new Error('Invalid value for setting "roots"');
      cfg.accountRoots = { ...cfg.accountRoots, [rootsKey(cfg)]: v };
      continue;
    }
    if (!(k in DEFAULTS) || k === 'accountRoots') continue;
    if (VALID[k] && !VALID[k](v)) throw new Error(`Invalid value for setting "${k}"`);
    if (typeof DEFAULTS[k] === 'number' && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new Error(`Setting "${k}" must be a positive number`);
    }
    if (typeof DEFAULTS[k] === 'boolean' && typeof v !== 'boolean') throw new Error(`Setting "${k}" must be true or false`);
    cfg[k] = v;
  }
  writeJsonAtomic(paths.config, cfg);
  current = cfg;
  view = null;
  return get();
}

module.exports = { get, load, update, problem, adoptUnassigned, DEFAULTS };
