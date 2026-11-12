// Actions board: tracked runs (pushes/merges made here or elsewhere) and the latest
// default-branch run of every repository, grouped by outcome, updating live.
import { h, mount, icon, btn, iconBtn, act, ago, duration, statusBadge, runDot, banner } from '../dom.js';
import { rpc } from '../api.js';
import { store, subscribe, boardState, prefs } from '../store.js';
import { navigate } from '../router.js';

export function render(main) {
  let filter = prefs.get('boardFilter', 'all');
  let sort = prefs.get('boardSort', 'name');
  const order = (a, b) => {
    if (sort === 'recent') return Date.parse((b.b && (b.b.committedDate || '')) || 0) - Date.parse((a.b && (a.b.committedDate || '')) || 0);
    return a.r.label.localeCompare(b.r.label);
  };
  let text = '';
  const page = h('div', { class: 'page' });
  mount(main, page);
  let refreshing = false;

  function repoFor(slug) {
    const key = `${slug.owner}/${slug.repo}`.toLowerCase();
    return store.repos.find((r) => r.slug && `${r.slug.owner}/${r.slug.repo}`.toLowerCase() === key);
  }

  function draw() {
    const trackers = [...store.trackers].sort((a, b) => b.createdAt - a.createdAt);
    const activeT = trackers.filter((t) => t.state === 'waiting' || t.state === 'running');
    const doneT = trackers.filter((t) => !(t.state === 'waiting' || t.state === 'running')).slice(0, 12);
    const entries = [];
    const seen = new Set();
    for (const r of store.repos) {
      if (!r.slug || !r.slug.github) continue;
      const key = `${r.slug.owner}/${r.slug.repo}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const b = store.board[key];
      entries.push({ r, b, state: b ? (b.error ? 'error' : boardState(b) || 'none') : 'loading' });
    }
    const q = text.toLowerCase();
    const visible = entries.filter((e) => (!q || e.r.label.toLowerCase().includes(q)) && (filter === 'all' || (filter === 'attention' && ['failure', 'running'].includes(e.state)) || e.state === filter));
    const groups = [
      ['failure', 'Failing', 'bad'], ['running', 'Running', 'run'], ['other', 'Other results', ''], ['success', 'Passing', 'ok'],
      ['none', 'No runs on the latest commit', ''], ['error', 'Not available', 'bad'], ['loading', 'Loading', ''],
    ];
    const counts = Object.fromEntries(groups.map(([k]) => [k, entries.filter((e) => e.state === k).length]));
    const searchIn = h('input', { type: 'search', placeholder: 'Filter repositories', value: text, style: { width: '200px' }, oninput: (e) => { text = e.target.value; draw(); const el = page.querySelector('input[type=search]'); if (el) { el.focus(); el.setSelectionRange(text.length, text.length); } } });
    mount(page,
      h('div', { class: 'row', style: { marginBottom: '14px' } },
        h('div', { class: 'page-head', style: { margin: 0 } }, h('div', null, h('h1', null, 'Actions'), h('div', { class: 'muted' }, store.boardAt ? `Latest run on each default branch · updated ${ago(store.boardAt)}` : 'Loading…'))),
        h('span', { class: 'spacer' }),
        h('div', { class: 'pill-tabs' }, [['all', `All (${entries.length})`], ['attention', `Needs attention (${counts.failure + counts.running})`], ['failure', `Failing (${counts.failure})`], ['running', `Running (${counts.running})`]]
          .map(([k, l]) => h('button', { class: filter === k ? 'active' : '', onclick: () => { filter = k; prefs.set('boardFilter', k); draw(); } }, l))),
        searchIn,
        h('select', { title: 'Sort', onchange: (e) => { sort = e.target.value; prefs.set('boardSort', sort); draw(); } },
          [['name', 'Sort by name'], ['recent', 'Most recent commit first']].map(([v, l]) => h('option', { value: v, selected: sort === v }, l))),
        btn(refreshing ? 'Refreshing…' : 'Refresh', async () => { refreshing = true; draw(); await act(() => rpc('board.refresh')); await rpc('trackers.refresh').catch(() => {}); refreshing = false; draw(); }, { cls: 'small', iconName: 'refresh', disabled: refreshing })),

      h('div', { class: 'tiles' }, [[counts.failure, 'failing', 'var(--bad)'], [counts.running, 'running', 'var(--warn)'], [counts.success, 'passing', 'var(--ok)'], [counts.none + counts.other, 'no runs', 'var(--text)']]
        .map(([n, label, color]) => h('div', { class: 'tile', style: { cursor: 'default' } }, h('div', { class: 'tile-n', style: { color: n ? color : 'var(--faint)' } }, n), h('div', { class: 'muted' }, label)))),

      h('div', { class: 'section-title' }, h('h3', null, 'Tracked runs'), h('span', { class: 'faint' }, 'Your pushes and merges, followed until their workflows finish'),
        h('span', { class: 'spacer' }), doneT.length ? btn('Clear finished', () => act(() => rpc('trackers.clearDone')), { cls: 'small ghost' }) : null),
      activeT.length || doneT.length ? h('div', { class: 'panel', style: { marginBottom: '18px', overflow: 'hidden' } }, [...activeT, ...doneT].map(trackerCard))
        : h('div', { class: 'muted', style: { marginBottom: '18px' } }, 'Nothing tracked right now. Push, sync or merge a pull request and its workflow runs appear here.'),

      groups.filter(([k]) => visible.some((e) => e.state === k)).map(([k, label, cls]) => h('div', { class: 'board-group' },
        h('div', { class: 'section-title' }, h('span', { class: `dot ${cls}` }), h('h3', null, `${label}`), h('span', { class: 'badge' }, visible.filter((e) => e.state === k).length)),
        h('div', { class: 'panel', style: { overflow: 'hidden' } }, visible.filter((e) => e.state === k).sort(order).map(boardRow)))),
      !entries.length ? h('div', { class: 'empty' }, h('h3', null, 'No GitHub repositories'), h('div', null, 'Repositories whose remote points to GitHub show up here.')) : null);
  }

  function trackerCard(t) {
    const r = store.byId.get(t.repoId) || repoFor(t.slug);
    const stateText = t.state === 'waiting' ? `Waiting for workflows to start (${duration(new Date(t.createdAt).toISOString())})`
      : t.state === 'running' ? `${t.runs.filter((x) => x.status !== 'completed').length} of ${t.runs.length} running`
        : t.state === 'no-runs' ? 'No workflow runs started for this commit'
          : t.conclusion === 'success' ? 'All workflows passed' : t.conclusion === 'cancelled' ? 'Cancelled' : `${t.runs.filter((x) => ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(x.conclusion)).length} workflow(s) failed`;
    const cls = t.state === 'done' ? (t.conclusion === 'success' ? 'success' : t.conclusion === 'failure' ? 'failure' : '') : t.state;
    const failedRuns = t.runs.filter((x) => ['failure', 'timed_out', 'startup_failure'].includes(x.conclusion));
    return h('div', { class: `tracker ${cls}` },
      h('div', { style: { paddingTop: '3px' } }, t.state === 'done' ? runDot('completed', t.conclusion === 'success' ? 'success' : t.conclusion === 'failure' ? 'failure' : t.conclusion) : t.state === 'no-runs' ? h('span', { class: 'dot' }) : h('span', { class: 'dot run' })),
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'row' }, h('strong', null, t.slug.label || t.slug.repo), h('span', { class: 'muted ellipsis' }, t.reason), t.source === 'external' ? h('span', { class: 'badge' }, 'pushed elsewhere') : null),
        h('div', { class: 'sub muted', style: { fontSize: '12px', margin: '2px 0 6px' } }, `${stateText} · started ${ago(t.createdAt)}${t.sha ? ` · ${t.sha.slice(0, 8)}` : ''}`),
        t.runs.length ? h('div', { class: 'row wrap', style: { gap: '6px' } }, t.runs.map((x) => h('span', {
          class: 'badge', style: { cursor: 'pointer', height: '22px' }, title: `${x.workflow}: ${x.conclusion || x.status}`,
          onclick: () => (r ? navigate(`#/repo/${r.id}/actions/run/${x.id}`) : rpc('open.url', { url: x.url })),
        }, runDot(x.status, x.conclusion), x.workflow, h('span', { class: 'faint' }, x.status === 'completed' ? duration(x.startedAt || x.createdAt, x.updatedAt) : duration(x.startedAt || x.createdAt))))) : null),
      h('div', { class: 'row' },
        failedRuns.length && r ? btn('Re-run failed', async () => { for (const x of failedRuns) await act(() => rpc('run.rerun', { id: r.id, runId: x.id, failed: true, title: x.workflow })); banner({ level: 'info', title: 'Re-running failed jobs', timeout: 3000 }); }, { cls: 'small' }) : null,
        failedRuns.length && r ? btn('Show error', () => navigate(`#/repo/${r.id}/actions/run/${failedRuns[0].id}`), { cls: 'small primary' }) : null,
        iconBtn('x', t.state === 'done' || t.state === 'no-runs' ? 'Remove' : 'Stop tracking', () => act(() => rpc('trackers.remove', { trackerId: t.id })))));
  }

  function boardRow(e) {
    const { r, b } = e;
    if (!b) return h('div', { class: 'board-card' }, h('span', { class: 'dot' }), h('strong', null, r.label), h('span', { class: 'faint' }, 'loading…'), h('span'), h('span'), h('span'));
    if (b.error) return h('div', { class: 'board-card' }, h('span', { class: 'dot bad' }), h('strong', null, r.label), h('span', { class: 'muted ellipsis', title: b.error }, b.kind === 'no-access' ? `No access with the GitHub account used for ${r.slug.owner}. Change it in Settings → GitHub accounts.` : b.error.split('\n')[0]), h('span'), h('span'), h('span'));
    const running = b.runs.filter((x) => x.status !== 'completed');
    const longest = running.length ? running.reduce((a, x) => (Date.parse(x.createdAt) < Date.parse(a.createdAt) ? x : a)) : null;
    return h('div', { class: 'board-card', style: { cursor: 'pointer' }, onclick: () => navigate(`#/repo/${r.id}/actions`) },
      h('span', { class: `dot ${e.state === 'failure' ? 'bad' : e.state === 'running' ? 'run' : e.state === 'success' ? 'ok' : ''}` }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, r.label), h('div', { class: 'faint', style: { fontSize: '11px' } }, b.branch)),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'ellipsis', title: b.headline }, b.headline || ''), h('div', { class: 'faint', style: { fontSize: '11px' } }, `${(b.oid || '').slice(0, 8)} · ${b.author || ''}`)),
      h('div', { class: 'wf' }, b.runs.slice(0, 6).map((x) => h('span', { title: `${x.workflow}: ${x.conclusion || x.status}`, style: { display: 'inline-flex' } }, runDot(x.status, x.conclusion))), b.runs.length > 6 ? h('span', { class: 'faint' }, `+${b.runs.length - 6}`) : null),
      h('div', { class: 'faint', style: { fontSize: '12px' } }, longest ? `running ${duration(longest.createdAt)}` : b.committedDate ? ago(b.committedDate) : ''),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        e.state === 'failure' ? btn('Why?', (ev) => { ev.stopPropagation(); const f = b.runs.find((x) => ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(x.conclusion)); navigate(`#/repo/${r.id}/actions/run/${f.id}`); }, { cls: 'small primary' }) : null,
        iconBtn('external', 'Open on GitHub', () => rpc('open.url', { url: `https://github.com/${r.slug.owner}/${r.slug.repo}/actions` }))));
  }

  const unsubs = [subscribe('board', draw), subscribe('trackers', draw), subscribe('repos', draw)];
  const tick = setInterval(() => {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (store.trackers.some((t) => t.state === 'running' || t.state === 'waiting') || Object.values(store.board).some((b) => boardState(b) === 'running')) draw();
  }, 2000);
  draw();
  rpc('trackers.refresh').catch(() => {});
  return () => { unsubs.forEach((u) => u()); clearInterval(tick); };
}

export { statusBadge, icon };
