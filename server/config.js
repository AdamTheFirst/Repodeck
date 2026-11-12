'use strict';
const fs = require('node:fs');
const { paths, writeJsonAtomic } = require('./paths');

const DEFAULTS = {
  version: 1,
  port: 47821,
  roots: [],                 // [{ path, name }]
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
  accountForOwner: {},         // owner -> gh account login (detected or set by user)
  autoDetectAccounts: true,    // try each signed-in gh account to find one that can see an owner
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
  current = { ...DEFAULTS, ...saved };
  return current;
}
function problem() { return loadProblem; }

function get() { return current || load(); }

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
  accountForOwner: (v) => v && typeof v === 'object',
};

function update(patch) {
  const cfg = { ...get() };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    if (VALID[k] && !VALID[k](v)) throw new Error(`Invalid value for setting "${k}"`);
    if (typeof DEFAULTS[k] === 'number' && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      throw new Error(`Setting "${k}" must be a positive number`);
    }
    if (typeof DEFAULTS[k] === 'boolean' && typeof v !== 'boolean') throw new Error(`Setting "${k}" must be true or false`);
    cfg[k] = v;
  }
  writeJsonAtomic(paths.config, cfg);
  current = cfg;
  return cfg;
}

module.exports = { get, load, update, problem, DEFAULTS };
