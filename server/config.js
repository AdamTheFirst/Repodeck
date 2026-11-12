'use strict';
const fs = require('node:fs');
const { paths, writeJsonAtomic } = require('./paths');

const DEFAULTS = {
  version: 1,
  port: 47821,
  currentAccount: '',        // GitHub login that was open last ('' = no account); each running window has its own
  accountRoots: {},          // login -> [{ path, name }]; each account has its own folders
  accountSsh: {},            // login -> { protocol: 'https' | 'ssh', host: 'github.com-work' } how git reaches GitHub for that account
  savedFilters: {},          // login -> [{ name, text, attention }] saved sidebar filters
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
  closeToTray: true,           // the window's close button hides it to the notification area
  keepRunningWhenClosed: false,
  editorCommand: 'code',       // program + args; {path} is replaced
  editorArgs: ['{path}'],
  terminalCommand: 'wt',
  terminalArgs: ['-d', '{path}'],
  theme: 'system',             // system | light | dark
  favourites: [],
  skipHiddenOnFetch: true,     // Fetch all and the background fetch leave hidden repositories alone
  skipHiddenInActions: true,   // the Actions board does not check or show hidden repositories
  hidden: [],                 // repository paths moved to the sidebar's Hidden section
  bulkConcurrency: 6,
  defaultPrFilter: 'all',
  firstRunDone: false,
};

const UNASSIGNED = '*';
const LOCAL = '_local';

let current = null;        // what is on disk (plus defaults)
let view = null;           // what the app sees
let loadProblem = null;
// The account this process shows. Several windows can run at once, one per account, and they
// share the settings file, so the open account lives in memory, not in the file.
let sessionAccount = null;

function readDisk() {
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
  return { ...DEFAULTS, ...saved };
}

function load() {
  current = readDisk();
  view = null;
  return get();
}
function problem() { return loadProblem; }

const account = () => (sessionAccount != null ? sessionAccount : current.currentAccount);

/** Which folder list is in effect: the open account's, else unassigned folders, else the no-account list. */
function rootsKey(cfg = current) {
  const a = account();
  if (a) return a;
  return cfg.accountRoots[UNASSIGNED] ? UNASSIGNED : LOCAL;
}

/** Settings as the rest of the app sees them: `currentAccount` is this window's account, `roots` its folders. */
function get() {
  if (!current) return load();
  if (!view) view = { ...current, currentAccount: account(), roots: current.accountRoots[rootsKey()] || [] };
  return view;
}

/** Give folders from before accounts existed to the first account that is used. */
function adoptUnassigned(login) {
  get();
  const disk = readDisk();
  const ar = { ...disk.accountRoots };
  if (!login || !ar[UNASSIGNED]) { current = disk; view = null; return; }
  if (!ar[login] || !ar[login].length) ar[login] = ar[UNASSIGNED];
  delete ar[UNASSIGNED];
  current = { ...disk, accountRoots: ar };
  writeJsonAtomic(paths.config, current);
  view = null;
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
  hidden: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  currentAccount: (v) => typeof v === 'string' && /^[A-Za-z0-9-]*$/.test(v),
  accountSsh: (v) => v && typeof v === 'object' && Object.values(v).every((x) => x && ['https', 'ssh'].includes(x.protocol) && (!x.host || /^[A-Za-z0-9._-]+$/.test(x.host))),
  savedFilters: (v) => v && typeof v === 'object',
};

function update(patch) {
  get();
  // Start from what is on disk now: another window may have saved since we last read.
  const cfg = readDisk();
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
    if (k === 'currentAccount') sessionAccount = v; // this window's account; the file remembers it as "last opened"
    cfg[k] = v;
  }
  writeJsonAtomic(paths.config, cfg);
  current = cfg;
  view = null;
  return get();
}

/** Pin this process to an account without touching the settings file (used by --account). */
function setSessionAccount(login) { get(); sessionAccount = login || ''; view = null; }

module.exports = { get, load, update, problem, adoptUnassigned, setSessionAccount, DEFAULTS };
