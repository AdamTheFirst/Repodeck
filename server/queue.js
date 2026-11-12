// One mutating operation per repository at a time. Reads do not queue.
'use strict';

const chains = new Map(); // repoId -> Promise
const busy = new Map();   // repoId -> { label, since }

function exclusive(repoId, label, fn) {
  const prev = chains.get(repoId) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    busy.set(repoId, { label, since: Date.now() });
    try { return await fn(); } finally { busy.delete(repoId); }
  });
  chains.set(repoId, next.catch(() => {}));
  return next;
}

function busyInfo(repoId) { return busy.get(repoId) || null; }

/** Run fn over items with a concurrency limit; never stops at a failure. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = { ok: true, value: await fn(items[idx], idx) }; } catch (e) { results[idx] = { ok: false, error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

module.exports = { exclusive, busyInfo, pool };
