// Fetch one repository and say plainly where its branch stands afterwards.
import { act, banner, plural } from './dom.js';
import { rpc } from './api.js';

/** Pure: the notice to show after a fetch, from the repository's state ({ branch, upstream, behind, ahead, ... }). */
export function fetchNotice(label, s, pruned) {
  const done = pruned ? 'Fetched and pruned' : 'Fetched';
  if (!s || s.detached || !s.branch) return { level: 'success', title: `${done} ${label}` };
  if (!s.upstream) return { level: 'success', title: `${done} ${label}`, body: `${s.branch} is not published, so there is nothing to compare it with.` };
  const lines = [];
  if (s.behind) lines.push(s.ahead ? `It also has ${plural(s.ahead, 'commit')} of yours that ${s.upstream} does not have, so pulling will ${s.pullStrategy === 'rebase' ? 'rebase them' : 'merge'}.` : 'Pull to bring them in.');
  if (s.behindDefault && s.defaultBranch && s.branch !== s.defaultBranch) lines.push(`${s.branch} is also ${plural(s.behindDefault, 'commit')} behind ${s.defaultBranch}.`);
  if (s.behind) return { level: 'warn', behind: true, title: `${s.branch} is ${plural(s.behind, 'commit')} behind ${s.upstream}`, body: lines.join('\n') };
  return { level: 'success', title: `${done} · ${s.branch} is up to date with ${s.upstream}`, body: lines.join('\n') || undefined };
}

export async function fetchRepo(r, { prune = false } = {}) {
  const s = await act(() => rpc('repo.fetch', { id: r.id, prune }));
  if (s === undefined) return false; // failed; the error is already shown
  const n = fetchNotice(r.label, s, prune);
  banner({
    level: n.level, title: n.title, body: n.body, timeout: n.behind ? 12000 : 4000,
    actions: n.behind ? [{ label: `Pull ${s.behind}`, action: () => import('./repoview.js').then((m) => m.pull(r)) }] : [],
  });
  return true;
}
