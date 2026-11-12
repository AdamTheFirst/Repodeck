// Repository registry, refresh loop, Actions tracking and notifications.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const config = require('./config');
const scanner = require('./scanner');
const git = require('./git');
const unreachable = require('./unreachable');
const gh = require('./gh');
const queue = require('./queue');
const log = require('./log');
const notify = require('./notify');
const { paths, writeJsonAtomic, readJson } = require('./paths');

const statePath = () => paths.stateFor(config.get().currentAccount);
const cachePath = () => paths.cacheFor(config.get().currentAccount);

const bus = new EventEmitter();
bus.setMaxListeners(100);

const repos = new Map();      // id -> repo record
const summaries = new Map();  // id -> { ...summary, error, at }
const slugs = new Map();      // id -> slug | null
let board = {};               // slug(lower) -> board entry
let boardAt = 0;
let lastScan = 0;
let scanning = null;

// ---------- persisted cache (instant startup) ----------

function loadCache() {
  const c = readJson(cachePath(), null);
  if (!c || (c.account || '') !== (config.get().currentAccount || '')) return; // never show another account's repositories
  for (const r of c.repos || []) repos.set(r.id, r);
  for (const [id, s] of Object.entries(c.summaries || {})) summaries.set(id, { ...s, stale: true });
  for (const [id, s] of Object.entries(c.slugs || {})) slugs.set(id, s);
  board = c.board || {};
}
let cacheTimer = null;
function saveCacheSoon() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    try {
      writeJsonAtomic(cachePath(), {
        account: config.get().currentAccount || '', repos: [...repos.values()], summaries: Object.fromEntries(summaries), slugs: Object.fromEntries(slugs), board,
      });
    } catch (e) { log.warn('Could not write cache', { error: e.message }); }
  }, 2000);
}

// ---------- scanning ----------

async function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    const cfg = config.get();
    const found = await scanner.scanAll(cfg.roots, { ignore: cfg.ignore, depth: cfg.scanDepth });
    const ids = new Set(found.map((r) => r.id));
    for (const id of [...repos.keys()]) if (!ids.has(id)) { repos.delete(id); summaries.delete(id); slugs.delete(id); unwatch(id); }
    for (const r of found) {
      r.label = r.rel === '.' ? r.name : r.rel.replace(/\\/g, '/');
      repos.set(r.id, { ...(repos.get(r.id) || {}), ...r });
    }
    lastScan = Date.now();
    bus.emit('repos', list());
    saveCacheSoon();
    await Promise.all(found.map((r) => resolveSlug(r).catch(() => null)));
    bus.emit('repos', list()); // again, now with owner/repo for each: "cloned or not" depends on it
    saveCacheSoon();
    for (const r of found) watch(r);
    return found;
  })();
  try { return await scanning; } finally { scanning = null; }
}

async function resolveSlug(r) {
  const s = await git.githubSlug(r);
  const v = s ? { owner: s.owner, repo: s.repo, host: s.host, github: s.github, remote: s.remote, label: r.label } : null;
  slugs.set(r.id, v);
  return v;
}

function list() {
  return [...repos.values()].map((r) => ({
    ...r, summary: summaries.get(r.id) || null, slug: slugs.get(r.id) || null,
    actions: slugs.get(r.id) ? boardFor(slugs.get(r.id)) : null,
    busy: queue.busyInfo(r.id),
  }));
}

function get(id) {
  const r = repos.get(id);
  if (!r) { const e = new Error('Unknown repository. Refresh the list.'); e.status = 404; throw e; }
  return r;
}

function slugOf(id) {
  const s = slugs.get(id);
  if (!s) { const e = new Error('This repository has no recognisable remote, so GitHub features are unavailable. Add a remote named origin that points to GitHub.'); e.kind = 'no-remote'; throw e; }
  if (!s.github) { const e = new Error(`The remote host "${s.host}" does not look like GitHub, so GitHub features are unavailable.`); e.kind = 'not-github'; throw e; }
  return s;
}

// ---------- refresh ----------

const inflight = new Map();
async function refresh(id) {
  if (inflight.has(id)) return inflight.get(id);
  const r = repos.get(id);
  if (!r) return null;
  const p = (async () => {
    const s = slugs.get(id);
    const hint = s && board[`${s.owner}/${s.repo}`.toLowerCase()] ? board[`${s.owner}/${s.repo}`.toLowerCase()].branch : null;
    r.defaultHint = hint || null;
    try {
      const sum = await git.summary(r);
      summaries.set(id, { ...sum, at: Date.now() });
    } catch (e) {
      summaries.set(id, { ...(summaries.get(id) || {}), error: e.message, at: Date.now() });
    }
    bus.emit('summary', { id, summary: summaries.get(id), busy: queue.busyInfo(id) });
    saveCacheSoon();
    return summaries.get(id);
  })();
  inflight.set(id, p);
  try { return await p; } finally { inflight.delete(id); }
}

async function refreshAll() {
  await queue.pool([...repos.keys()], 8, refresh);
}

// ---------- .git watchers for instant updates ----------

const watchers = new Map();
const debounce = new Map();
function watch(r) {
  if (watchers.has(r.id)) return;
  git.info(r).then(({ gitDir }) => {
    try {
      const w = fs.watch(gitDir, { persistent: false }, (ev, name) => {
        if (!name || !/^(HEAD|index|MERGE_HEAD|ORIG_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|packed-refs|rebase-merge|rebase-apply)$/.test(name)) return;
        clearTimeout(debounce.get(r.id));
        debounce.set(r.id, setTimeout(() => refresh(r.id), 400));
      });
      w.on('error', () => unwatch(r.id));
      watchers.set(r.id, w);
    } catch {}
  }).catch(() => {});
}
function unwatch(id) { const w = watchers.get(id); if (w) { try { w.close(); } catch {} watchers.delete(id); } }

// ---------- Actions: default-branch board ----------

function boardFor(s) { return board[`${s.owner}/${s.repo}`.toLowerCase()] || null; }

let boardRunning = null;
async function pollBoard() {
  if (boardRunning) return boardRunning;
  boardRunning = (async () => {
    const targets = [];
    const seen = new Set();
    const cfg = config.get();
    const hidden = new Set(cfg.skipHiddenInActions ? cfg.hidden || [] : []);
    for (const [id, s] of slugs) {
      if (!s || !s.github || !repos.has(id)) continue;
      if (hidden.has(repos.get(id).path)) continue; // hidden: no checks, no run tracking, no notifications
      const key = `${s.owner}/${s.repo}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(s);
    }
    if (!targets.length) return;
    const login = config.get().currentAccount || null;
    let next = {};
    try { next = await gh.boardBatch(targets, login); } catch (e) {
      for (const t of targets) next[`${t.owner}/${t.repo}`.toLowerCase()] = { error: e.message, kind: e.kind };
    }
    if (login !== (config.get().currentAccount || null)) return; // account changed while loading
    detectExternalPushes(board, next);
    for (const [k, v] of Object.entries(next)) {
      if (v.error && board[k] && !board[k].error && v.kind !== 'no-access') next[k] = { ...board[k], stale: true, error: v.error };
      else next[k] = { ...v, at: Date.now() };
    }
    board = next;
    boardAt = Date.now();
    bus.emit('board', { board, at: boardAt });
    saveCacheSoon();
  })();
  try { return await boardRunning; } catch (e) { log.warn('Board poll failed', { error: e.message }); } finally { boardRunning = null; }
}

function detectExternalPushes(prev, next) {
  if (!config.get().trackExternalRuns) return;
  for (const [k, v] of Object.entries(next)) {
    const old = prev[k];
    if (!old || old.error || v.error || !old.oid || !v.oid || old.oid === v.oid) continue;
    if (trackers.some((t) => t.sha === v.oid)) continue;
    const id = [...slugs].find(([, s]) => s && `${s.owner}/${s.repo}`.toLowerCase() === k);
    if (!id) continue;
    const s = id[1];
    addTracker({ repoId: id[0], slug: s, sha: v.oid, branch: v.branch, reason: `New commit on ${v.branch}: ${v.headline || v.oid.slice(0, 7)}`, source: 'external' });
  }
}

// ---------- Actions: tracked runs ----------
/** Only the open account's tracked runs are shown or polled; the others wait until you switch back. */
function visibleTrackers() { const mine = config.get().currentAccount || ''; return trackers.filter((t) => (t.account || '') === mine); }

let trackers = readJson(statePath(), {}).trackers || [];

function saveTrackers() {
  const st = readJson(statePath(), {});
  st.trackers = trackers.slice(-50);
  writeJsonAtomic(statePath(), st);
}

function addTracker({ repoId, slug, sha, branch, reason, source = 'app', pr }) {
  if (!slug || !sha) return null;
  const existing = trackers.find((t) => t.sha === sha && t.slug.owner === slug.owner && t.slug.repo === slug.repo && t.state !== 'done');
  if (existing) return existing;
  const t = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    repoId, slug: { owner: slug.owner, repo: slug.repo, label: slug.label, account: config.get().currentAccount || '' }, account: config.get().currentAccount || '', sha, branch, reason, source, pr: pr || null,
    createdAt: Date.now(), state: 'waiting', runs: [], conclusion: null, pinned: true, notified: false,
  };
  trackers.push(t);
  saveTrackers();
  bus.emit('trackers', visibleTrackers());
  pollTrackersSoon();
  return t;
}

function trackRun({ repoId, slug, runId, title }) {
  const t = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    repoId, slug: { owner: slug.owner, repo: slug.repo, label: slug.label, account: config.get().currentAccount || '' }, account: config.get().currentAccount || '', sha: null, runId: +runId, reason: title || `Run ${runId}`,
    source: 'manual', createdAt: Date.now(), state: 'running', runs: [], conclusion: null, pinned: true, notified: false,
  };
  trackers.push(t);
  saveTrackers();
  bus.emit('trackers', visibleTrackers());
  pollTrackersSoon();
  return t;
}

function removeTracker(id) {
  trackers = trackers.filter((t) => t.id !== id);
  saveTrackers();
  bus.emit('trackers', visibleTrackers());
}
function clearDoneTrackers() {
  const mine = config.get().currentAccount || '';
  trackers = trackers.filter((t) => (t.account || '') !== mine || (t.state !== 'done' && t.state !== 'no-runs'));
  saveTrackers();
  bus.emit('trackers', visibleTrackers());
}

const FAIL = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

let trackersRunning = false;
async function pollTrackers() {
  if (trackersRunning) return;
  trackersRunning = true;
  try {
    const mine = config.get().currentAccount || '';
    const active = trackers.filter((t) => (t.state === 'waiting' || t.state === 'running') && (t.account || '') === mine);
    await queue.pool(active, 4, async (t) => {
      let runs;
      if (t.runId) runs = [await gh.runView(t.slug, t.runId)].filter(Boolean);
      else runs = await gh.runList(t.slug, { commit: t.sha, limit: 30 });
      if (!t.runId && t.pr == null) runs = runs.filter((r) => !t.branch || r.headBranch === t.branch || r.event !== 'pull_request');
      t.runs = runs.map((r) => ({
        id: r.databaseId, workflow: r.workflowName || r.name, title: r.displayTitle, status: r.status, conclusion: r.conclusion,
        url: r.url, createdAt: r.createdAt, startedAt: r.startedAt, updatedAt: r.updatedAt, event: r.event, attempt: r.attempt,
      }));
      t.checkedAt = Date.now();
      if (!t.runs.length) {
        if (Date.now() - t.createdAt > 4 * 60_000) { t.state = 'no-runs'; t.conclusion = 'none'; }
        return;
      }
      const allDone = t.runs.every((r) => r.status === 'completed');
      t.state = allDone ? 'done' : 'running';
      if (allDone) {
        t.conclusion = t.runs.some((r) => FAIL.has(r.conclusion)) ? 'failure'
          : t.runs.some((r) => r.conclusion === 'cancelled') ? 'cancelled' : 'success';
        t.finishedAt = Date.now();
        if (!t.notified) { t.notified = true; announce(t); }
      }
    });
  } catch (e) {
    log.warn('Tracker poll failed', { error: e.message });
  } finally {
    trackersRunning = false;
    saveTrackers();
    bus.emit('trackers', visibleTrackers());
  }
}
let soon = null;
function pollTrackersSoon() { clearTimeout(soon); soon = setTimeout(pollTrackers, 3000); }

function announce(t) {
  const failed = t.runs.filter((r) => FAIL.has(r.conclusion));
  const name = t.slug.label || t.slug.repo;
  const title = t.conclusion === 'success' ? `${name}: checks passed`
    : t.conclusion === 'cancelled' ? `${name}: run cancelled`
      : `${name}: ${failed.length} workflow(s) failed`;
  const body = t.conclusion === 'failure' ? `${failed.map((r) => r.workflow).join(', ')}\n${t.reason}` : t.reason;
  const url = (failed[0] || t.runs[0] || {}).url;
  // In the app the toast icon shows the outcome; Windows notifications get a symbol instead.
  bus.emit('notify', { level: t.conclusion === 'success' ? 'success' : t.conclusion === 'failure' ? 'error' : 'info', title, body, url, trackerId: t.id, repoId: t.repoId, runId: (failed[0] || {}).id });
  const cfg = config.get();
  const symbol = t.conclusion === 'success' ? '✔' : t.conclusion === 'failure' ? '✖' : '■';
  if (cfg.notifications) notify.toast({ title: `${symbol} ${title}`, body, url, sound: cfg.notifySound });
}

// ---------- PR notifications ----------

let prState = readJson(statePath(), {}).prs || null;
async function pollMyPrs() {
  const cfg = config.get();
  if (!cfg.notifications || !cfg.notifyReviewRequests) return;
  try {
    const login = cfg.currentAccount;
    if (!login) { prState = null; bus.emit('myprs', { review: [], mine: [] }); return; }
    const next = { review: {}, mine: {}, account: login };
    const d = await gh.myPrs(login).catch(() => null);
    if (!d || login !== config.get().currentAccount) return;
    for (const p of d.review) next.review[`${p.repo}#${p.number}`] = p;
    for (const p of d.mine) next.mine[`${p.repo}#${p.number}`] = p;
    if (prState && prState.account !== login) prState = null; // the first poll after a switch never notifies
    if (prState) {
      for (const [k, p] of Object.entries(next.review)) {
        if (!prState.review[k]) emitAndToast({ level: 'info', title: `Review requested: ${p.repo}#${p.number}`, body: `${p.title} (by ${p.author})`, url: p.url });
      }
      for (const [k, p] of Object.entries(next.mine)) {
        const old = prState.mine[k];
        if (old && old.head === p.head && old.checks === 'pending' && (p.checks === 'success' || p.checks === 'failure' || p.checks === 'error')) {
          emitAndToast({ level: p.checks === 'success' ? 'success' : 'error', title: `${p.checks === 'success' ? '✔ Checks passed' : '✖ Checks failed'}: ${p.repo}#${p.number}`, body: p.title, url: p.url });
        }
      }
    }
    prState = next;
    const st = readJson(statePath(), {});
    st.prs = prState;
    writeJsonAtomic(statePath(), st);
    bus.emit('myprs', { review: Object.values(next.review), mine: Object.values(next.mine) });
  } catch (e) { log.warn('PR notification poll failed', { error: e.message }); }
}
function emitAndToast(n) {
  bus.emit('notify', n);
  const cfg = config.get();
  if (cfg.notifications) notify.toast({ ...n, sound: cfg.notifySound });
}
function myPrsSnapshot() { return prState ? { review: Object.values(prState.review), mine: Object.values(prState.mine) } : null; }

// ---------- account workspaces ----------
/** Tracked runs and PR snapshot of the open account. */
function loadAccountState() {
  const st = readJson(statePath(), {});
  trackers = st.trackers || [];
  prState = st.prs || null;
}

/** Make sure the open account is one that is signed in; fall back to gh's active account, else none. */
async function ensureAccount() {
  let accs = [];
  try { accs = (await gh.accounts(true)).filter((x) => x.host === 'github.com'); } catch {}
  const cur = config.get().currentAccount;
  let want = cur;
  if (!cur || !accs.some((x) => x.login === cur)) want = (accs.find((x) => x.active) || accs[0] || { login: '' }).login;
  if (want !== cur) config.update({ currentAccount: want });
  config.adoptUnassigned(want);
  return want;
}

/** Open another account's workspace: its folders, repositories, board and pull requests. Nothing carries over. */
async function switchAccount(login) {
  if (login) {
    const accs = await gh.accounts(true);
    if (!accs.some((x) => x.login === login && x.host === 'github.com')) throw new Error(`${login} is not signed in.`);
  }
  config.update({ currentAccount: login || '' });
  gh.forgetAccounts();
  loadAccountState();
  for (const id of [...watchers.keys()]) unwatch(id);
  repos.clear(); summaries.clear(); slugs.clear(); inflight.clear();
  board = {}; boardAt = 0;
  bus.emit('repos', []);
  bus.emit('board', { board, at: boardAt });
  bus.emit('trackers', visibleTrackers());
  bus.emit('myprs', { review: [], mine: [] });
  await scan();
  refreshAll().then(pollBoard).then(pollMyPrs).catch(() => {});
  return login;
}

// ---------- timers ----------

let boardVisible = 0;
function setBoardVisible(v) { boardVisible = v ? Date.now() : 0; if (v) pollBoard(); }

const timers = [];
function start() {
  const tick = (fn, secondsFn) => {
    const loop = async () => {
      try { await fn(); } catch (e) { log.warn('Timer task failed', { error: e.message }); }
      timers.push(setTimeout(loop, Math.max(5, secondsFn()) * 1000));
    };
    timers.push(setTimeout(loop, 1000));
  };
  ensureAccount().then(() => { loadAccountState(); loadCache(); bus.emit('repos', list()); bus.emit('trackers', visibleTrackers()); }).then(scan).then(refreshAll).then(pollBoard).catch((e) => log.error('Initial scan failed', { error: e.message }));
  tick(async () => { if (Date.now() - lastScan > 10 * 60_000) await scan(); await refreshAll(); }, () => config.get().refreshSeconds);
  tick(pollBoard, () => (boardVisible && Date.now() - boardVisible < 5 * 60_000 ? config.get().boardRefreshSeconds : config.get().actionsRefreshSeconds));
  tick(pollTrackers, () => config.get().trackedRefreshSeconds);
  tick(pollMyPrs, () => Math.max(60, config.get().actionsRefreshSeconds));
  tick(async () => {
    const cfg = config.get();
    if (!cfg.backgroundFetch) return;
    const hidden = new Set(cfg.skipHiddenOnFetch ? cfg.hidden || [] : []);
    await queue.pool([...repos.values()].filter((r) => !hidden.has(r.path)), 4, async (r) => {
      if (unreachable.skipReason(r, await git.remotes(r).catch(() => []))) return; // no remote, or one that is known to be gone
      return queue.exclusive(r.id, 'Background fetch', () => git.fetch(r, { all: true })).then(() => refresh(r.id)).catch(() => {});
    });
  }, () => config.get().backgroundFetchMinutes * 60);
}

function stop() { for (const t of timers) clearTimeout(t); for (const id of watchers.keys()) unwatch(id); }

module.exports = {
  bus, scan, list, get, slugOf, refresh, refreshAll, resolveSlug, pollBoard, boardFor, setBoardVisible,
  addTracker, trackRun, removeTracker, clearDoneTrackers, pollTrackers, trackers: visibleTrackers, switchAccount, ensureAccount,
  board: () => ({ board, at: boardAt }), myPrsSnapshot, pollMyPrs, start, stop, repos, slugs,
};
