// Shared client state with a tiny subscribe mechanism.
const subs = new Map();

export const store = {
  repos: [],
  byId: new Map(),
  roots: [],
  config: null,
  board: {},
  boardAt: 0,
  trackers: [],
  myprs: null,
  selected: null,
  view: 'repo',
  tab: 'changes',
  connected: true,
};

export function emit(topic, data) { for (const fn of subs.get(topic) || []) { try { fn(data); } catch (e) { console.error(e); } } }
export function subscribe(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic).delete(fn);
}

export function setRepos(list) {
  store.repos = list;
  store.byId = new Map(list.map((r) => [r.id, r]));
  emit('repos');
}
export function updateSummary(id, summary, busy) {
  const r = store.byId.get(id);
  if (!r) return;
  if (summary) r.summary = summary;
  r.busy = busy || null;
  emit('summary', id);
}
export function current() { return store.selected ? store.byId.get(store.selected) : null; }

export function boardFor(r) {
  if (!r || !r.slug) return null;
  return store.board[`${r.slug.owner}/${r.slug.repo}`.toLowerCase()] || null;
}

/** Overall state of the latest default-branch runs: failure | running | success | null */
export function boardState(b) {
  if (!b || b.error || !b.runs) return null;
  if (!b.runs.length) return b.rollup === 'failure' || b.rollup === 'error' ? 'failure' : b.rollup === 'success' ? 'success' : null;
  if (b.runs.some((r) => r.status !== 'completed')) return 'running';
  if (b.runs.some((r) => ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(r.conclusion))) return 'failure';
  if (b.runs.every((r) => ['success', 'skipped', 'neutral'].includes(r.conclusion))) return 'success';
  return 'other';
}

export const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`gh.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`gh.${k}`, JSON.stringify(v)); } catch {} },
};
