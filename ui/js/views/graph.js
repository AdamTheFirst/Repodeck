// Commit graph: lanes, refs, paging, virtualised rows, details, compare, context actions.
import { h, mount, icon, btn, iconBtn, act, menuAt, menuBelow, confirmDanger, form, prompt, banner, ago, fmtDate, copyText, debounce, showError } from '../dom.js';
import { rpc } from '../api.js';
import { fetchRepo } from '../fetch.js';
import { store, prefs } from '../store.js';
import { navigate } from '../router.js';
import { createDiffView } from '../diffview.js';
import { createBranchDialog, switchTo, push, pull } from '../repoview.js';

const ROW = 26;
const LANE_W = 14;
const PAGE = 400;
const laneColor = (i) => `var(--lane-${i % 8})`;

export function render(view, r, sub) {
  let commits = [];
  let layout = [];      // per row: { lane, top: [...], bottom: [...], node color }
  let lanes = [];       // running lane state: expected hash per lane
  let maxLanes = 1;
  let done = false;
  let loadingMore = false;
  let meta = null;      // refs, stashes, summary
  let selected = sub || null;
  let compareWith = null;
  let disposed = false;
  const filters = { branches: prefs.get(`gbranches.${r.id}`, []), author: '', grep: '', since: '', remotes: prefs.get('gRemotes', true), tags: prefs.get('gTags', true) };

  const toolbar = h('div', { class: 'diff-toolbar' });
  const head = h('div', { class: 'graph-head' });
  const rowsEl = h('div', { class: 'graph-rows' });
  const wrap = h('div', { class: 'graph-wrap', tabindex: '0' }, head, rowsEl);
  const detail = h('div', { class: 'detail-pane hidden' });
  mount(view, h('div', { class: 'pane', style: { flex: 1 } }, toolbar, wrap, detail));

  // ---------- toolbar ----------
  const search = h('input', { type: 'search', placeholder: 'Search message or hash', value: '', style: { width: '200px' } });
  let authors = null;   // [{ name, commits }], loaded once per visit
  rpc('repo.authors', { id: r.id }).then((a) => { authors = a; if (!disposed) renderToolbar(); }).catch(() => { authors = []; });
  search.addEventListener('input', debounce(() => { filters.grep = search.value.trim(); reset(); }, 400));
  function renderToolbar() {
    mount(toolbar,
      h('select', { title: 'Repository', style: { maxWidth: '220px' }, onchange: (e) => navigate(`#/repo/${e.target.value}/graph`) },
        store.repos.map((x) => h('option', { value: x.id, selected: x.id === r.id }, x.label))),
      h('button', { class: 'btn small', onclick: (e) => branchFilterMenu(e.currentTarget) }, icon('branch', 'sm'), filters.branches.length ? `${filters.branches.length} branch${filters.branches.length > 1 ? 'es' : ''}` : filters.remotes ? 'All branches' : 'Local branches', icon('chevronDown', 'sm')),
      search,
      h('select', { title: 'Only commits by this author', style: { maxWidth: '180px' }, onchange: (e) => { filters.author = e.target.value; reset(); } },
        h('option', { value: '', selected: !filters.author }, authors ? 'Any author' : 'Any author (loading…)'),
        (authors || (filters.author ? [{ name: filters.author }] : [])).map((a) => h('option', { value: a.name, selected: filters.author === a.name }, a.commits ? `${a.name} (${a.commits})` : a.name))),
      h('select', { title: 'Only commits after', onchange: (e) => { filters.since = e.target.value; reset(); } },
        [['', 'Any date'], ['1 week ago', 'Last week'], ['1 month ago', 'Last month'], ['3 months ago', 'Last 3 months'], ['1 year ago', 'Last year']].map(([v, l]) => h('option', { value: v, selected: filters.since === v }, l))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: filters.remotes, onchange: (e) => { filters.remotes = e.target.checked; prefs.set('gRemotes', filters.remotes); reset(); } }), 'Remote branches'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: filters.tags, onchange: (e) => { filters.tags = e.target.checked; prefs.set('gTags', filters.tags); reset(); } }), 'Tags'),
      h('span', { class: 'spacer' }),
      compareWith ? h('span', { class: 'badge accent' }, 'Comparing two commits', h('a', { onclick: () => { compareWith = null; showDetail(); renderRows(true); } }, ' ×')) : h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Ctrl+click a second commit to compare'),
      btn('Jump to HEAD', () => jumpTo(meta && meta.head), { cls: 'small' }),
      btn('Fetch', () => fetchRepo(r).then(reset), { cls: 'small', iconName: 'fetch' }),
      iconBtn('refresh', 'Reload graph', () => reset()));
  }
  function branchFilterMenu(el) {
    if (!meta) return;
    const chosen = new Set(filters.branches);
    const whole = (remotes) => { filters.branches = []; prefs.set(`gbranches.${r.id}`, []); filters.remotes = remotes; prefs.set('gRemotes', remotes); reset(); };
    const pick = (b) => ({ label: b, icon: chosen.has(b) ? 'check' : null, action: () => {
      if (chosen.has(b)) chosen.delete(b); else chosen.add(b);
      filters.branches = [...chosen]; prefs.set(`gbranches.${r.id}`, filters.branches); reset();
    } });
    const local = meta.refs.local.map((b) => b.name);
    const remote = filters.remotes ? meta.refs.remote.map((b) => b.name) : [];
    menuBelow(el, [
      { label: 'All branches', icon: !chosen.size && filters.remotes ? 'check' : null, action: () => whole(true) },
      { label: 'Local branches only', icon: !chosen.size && !filters.remotes ? 'check' : null, action: () => whole(false) },
      { label: 'Current branch only', action: () => { filters.branches = [meta.summary.branch || 'HEAD']; prefs.set(`gbranches.${r.id}`, filters.branches); reset(); } },
      '-',
      { header: true, label: 'Local' },
      ...local.slice(0, 60).map(pick),
      ...(remote.length ? ['-', { header: true, label: 'Remote' }, ...remote.slice(0, 60).map(pick)] : []),
    ]);
  }

  // ---------- data ----------
  async function reset() {
    commits = []; layout = []; lanes = []; maxLanes = 1; done = false;
    renderToolbar();
    mount(rowsEl, h('div', { class: 'skeleton' }, 'Loading history…'));
    try {
      meta = await rpc('repo.graphMeta', { id: r.id });
    } catch (e) { mount(rowsEl, h('div', { class: 'errbox', style: { margin: '10px' } }, e.message)); return; }
    renderToolbar();
    if (meta.summary.dirty && !graphOff()) {
      commits.push({ hash: 'WORKTREE', parents: meta.head ? [meta.head] : [], subject: `Uncommitted changes (${meta.summary.dirty})`, author: '', commitTime: Date.now() / 1000, refs: [], uncommitted: true });
    }
    await loadMore();
    if (selected) { jumpTo(selected); showDetail(); }
  }

  async function loadMore() {
    if (done || loadingMore) return;
    loadingMore = true;
    try {
      const skip = commits.filter((c) => !c.uncommitted).length;
      const res = await rpc('repo.log', { id: r.id, skip, limit: PAGE, branches: filters.branches, authorName: filters.author || undefined, grep: filters.grep, since: filters.since || undefined, remotes: filters.remotes, tags: filters.tags });
      if (disposed) return;
      const known = new Set(commits.map((c) => c.hash));
      const fresh = res.commits.filter((c) => !known.has(c.hash));
      if (res.commits.length < PAGE) done = true;
      commits.push(...fresh);
      computeLayout(layout.length); // includes the "uncommitted changes" row added before the first page
      renderRows(true);
    } catch (e) {
      mount(rowsEl, h('div', { class: 'errbox', style: { margin: '10px' } }, e.message));
    } finally { loadingMore = false; }
  }

  const graphOff = () => !!(filters.grep || filters.author || filters.since);

  /** Incremental lane assignment. Lanes stay put; free slots are reused. */
  function computeLayout(from) {
    for (let i = from; i < commits.length; i++) {
      const c = commits[i];
      const before = lanes.slice();
      let lane = lanes.indexOf(c.hash);
      if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) { lane = lanes.length; lanes.push(null); } }
      // merge every lane that expected this commit into the node
      const converging = [];
      lanes.forEach((x, k) => { if (x === c.hash && k !== lane) { converging.push(k); lanes[k] = null; } });
      lanes[lane] = c.parents[0] || null;
      const parentLanes = [lane];
      for (const p of c.parents.slice(1)) {
        let k = lanes.indexOf(p);
        if (k < 0) { k = lanes.indexOf(null); if (k < 0) { k = lanes.length; lanes.push(null); } lanes[k] = p; }
        parentLanes.push(k);
      }
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
      const pass = [];
      before.forEach((x, k) => { if (x && x !== c.hash && lanes[k] === x) pass.push(k); });
      layout[i] = { lane, converging, parentLanes: c.parents.length ? parentLanes : [], pass, entering: before[lane] === c.hash };
      maxLanes = Math.max(maxLanes, lanes.length, lane + 1, ...parentLanes.map((x) => x + 1));
    }
  }

  // ---------- rendering (virtualised) ----------
  const graphWidth = () => (graphOff() ? 8 : Math.min(maxLanes, 24) * LANE_W + 10);
  function renderHead() {
    mount(head, h('div', { style: { width: `${graphWidth()}px`, flex: 'none' } }), h('div', { class: 'c-desc' }, 'Description'), h('div', { class: 'c-date' }, 'Date'), h('div', { class: 'c-author' }, 'Author'), h('div', { class: 'c-hash' }, 'Commit'));
  }
  let rendered = { from: -1, to: -1 };
  function renderRows(force) {
    renderHead();
    rowsEl.style.height = `${commits.length * ROW + (done ? 0 : 60)}px`;
    const top = Math.max(0, wrap.scrollTop - 30);
    const from = Math.max(0, Math.floor(top / ROW) - 10);
    const to = Math.min(commits.length, Math.ceil((wrap.scrollTop + wrap.clientHeight) / ROW) + 20);
    if (!force && from === rendered.from && to === rendered.to) return;
    rendered = { from, to };
    const nodes = [];
    for (let i = from; i < to; i++) nodes.push(row(i));
    if (!done) nodes.push(h('div', { class: 'faint', style: { position: 'absolute', top: `${commits.length * ROW + 30}px`, left: '12px' } }, loadingMore ? 'Loading more…' : ''));
    if (!commits.length) nodes.push(h('div', { class: 'empty' }, filters.grep || filters.author ? 'No commits match.' : 'No commits yet.'));
    mount(rowsEl, nodes);
    if (!done && to >= commits.length - 30) loadMore();
  }
  wrap.addEventListener('scroll', () => requestAnimationFrame(() => renderRows(false)));

  function svgCell(i) {
    const ns = 'http://www.w3.org/2000/svg';
    const w = graphWidth();
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', w); svg.setAttribute('height', ROW); svg.setAttribute('class', 'g');
    if (graphOff()) return svg;
    const L = layout[i];
    const x = (k) => 8 + k * LANE_W;
    const mid = ROW / 2;
    const line = (x1, y1, x2, y2, color, dash) => {
      const p = document.createElementNS(ns, 'path');
      const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
      p.setAttribute('d', d); p.setAttribute('stroke', color); p.setAttribute('stroke-width', '2'); p.setAttribute('fill', 'none');
      if (dash) p.setAttribute('stroke-dasharray', '3 3');
      svg.append(p);
    };
    for (const k of L.pass) line(x(k), 0, x(k), ROW, laneColor(k));
    if (L.entering) line(x(L.lane), 0, x(L.lane), mid, laneColor(L.lane));
    for (const k of L.converging) line(x(k), 0, x(L.lane), mid, laneColor(k));
    L.parentLanes.forEach((k, idx) => line(x(L.lane), mid, x(k), ROW, laneColor(idx === 0 ? L.lane : k), commits[i].uncommitted));
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', x(L.lane)); c.setAttribute('cy', mid); c.setAttribute('r', commits[i].parents.length > 1 ? 3.5 : 4.5);
    const isHead = meta && commits[i].hash === meta.head;
    c.setAttribute('fill', commits[i].uncommitted ? 'var(--panel)' : isHead ? 'var(--panel)' : laneColor(L.lane));
    c.setAttribute('stroke', laneColor(L.lane)); c.setAttribute('stroke-width', isHead || commits[i].uncommitted ? '2.5' : '1.5');
    svg.append(c);
    return svg;
  }

  function refLabels(c) {
    if (!meta) return [];
    const localNames = new Set(meta.refs.local.map((b) => b.name));
    const out = [];
    const current = meta.summary.branch;
    for (const ref of c.refs) {
      if (ref.type === 'head') { if (meta.summary.detached) out.push(h('span', { class: 'ref head', title: 'Detached HEAD' }, 'HEAD')); continue; }
      if (ref.type === 'remote-head') continue;
      if (ref.type === 'tag') { out.push(h('span', { class: 'ref tag', oncontextmenu: (e) => menuAt(e, tagMenu(ref.name)) }, icon('tag', 'sm'), ref.name)); continue; }
      const name = ref.name;
      if (ref.type === 'branch' || localNames.has(name)) {
        out.push(h('span', { class: `ref branch ${name === current ? 'current' : ''}`, title: name === current ? 'Current branch' : 'Local branch', ondblclick: (e) => { e.stopPropagation(); if (name !== current) switchTo(r, { name }); }, oncontextmenu: (e) => menuAt(e, branchMenu(name, c)) }, icon('branch', 'sm'), name));
      } else {
        out.push(h('span', { class: 'ref remote', title: 'Remote branch', oncontextmenu: (e) => menuAt(e, remoteMenu(name)) }, name));
      }
    }
    for (const s of (meta.stashes || []).filter((st) => st.base === c.hash)) {
      out.push(h('span', { class: 'ref stash', title: s.message, oncontextmenu: (e) => menuAt(e, stashMenu(s)) }, icon('stash', 'sm'), s.ref));
    }
    return out;
  }

  function row(i) {
    const c = commits[i];
    const isSel = selected === c.hash;
    const isCmp = compareWith === c.hash;
    return h('div', {
      class: `grow-row ${isSel ? 'selected' : ''} ${isCmp ? 'compare' : ''}`, style: { top: `${i * ROW}px` },
      onclick: (e) => {
        if (e.ctrlKey && selected && selected !== c.hash) { compareWith = c.hash; } else { selected = c.hash; compareWith = null; }
        renderToolbar(); renderRows(true); showDetail();
      },
      oncontextmenu: (e) => menuAt(e, c.uncommitted ? [{ label: 'Open in Changes', icon: 'diff', action: () => navigate(`#/repo/${r.id}/changes`) }] : commitMenu(c)),
    },
    svgCell(i),
    h('div', { class: 'desc' }, refLabels(c), h('span', { class: 'ellipsis', style: { fontStyle: c.uncommitted ? 'italic' : '' } }, c.subject)),
    h('div', { class: 'date', title: c.uncommitted ? '' : fmtDate(c.commitTime) }, c.uncommitted ? '' : ago(c.commitTime)),
    h('div', { class: 'author', title: c.authorEmail || '' }, c.author),
    h('div', { class: 'hash' }, c.uncommitted ? '*' : c.hash.slice(0, 8)));
  }

  function jumpTo(hash) {
    if (!hash) return;
    const i = commits.findIndex((c) => c.hash === hash || c.hash.startsWith(hash));
    if (i < 0) { if (!done) loadMore().then(() => { if (commits.some((c) => c.hash.startsWith(hash))) jumpTo(hash); }); return; }
    selected = commits[i].hash;
    wrap.scrollTop = Math.max(0, i * ROW - wrap.clientHeight / 3);
    renderRows(true);
  }

  // ---------- details ----------
  let fileStats = new Map(); // path -> file entry of the open commit, for the banner above each diff
  let detailMax = prefs.get('gDetailMax', false);
  const diff = createDiffView({
    selectable: false, alwaysBanner: true,
    headerFor: (f) => {
      const s = fileStats.get(f.path);
      return s && s.add != null ? h('span', { class: 'cd-stat' }, h('span', { class: 'add' }, `+${s.add}`), ' ', h('span', { class: 'del' }, `−${s.del}`)) : null;
    },
  });
  function applyMax() { detail.classList.toggle('max', detailMax); wrap.classList.toggle('hidden', detailMax && !detail.classList.contains('hidden')); }
  function closeDetail() { selected = null; compareWith = null; detail.classList.add('hidden'); applyMax(); renderToolbar(); renderRows(true); }
  // Laid out like a commit page on GitHub: what the commit is across the top, then every changed file
  // one under the other, with a list on the left to jump between them.
  async function showDetail() {
    if (!selected) { detail.classList.add('hidden'); applyMax(); return; }
    detail.classList.remove('hidden');
    applyMax();
    const head = h('div', { class: 'cd-head' }, h('div', { class: 'skeleton' }, 'Loading…'));
    const filesList = h('div', { class: 'cd-files' });
    mount(detail, head, h('div', { class: 'cd-body' }, filesList, diff.el));
    diff.set({ files: [] });
    const tools = () => [
      btn(detailMax ? 'Show graph' : 'Expand', () => { detailMax = !detailMax; prefs.set('gDetailMax', detailMax); showDetail(); }, { cls: 'small', title: detailMax ? 'Show the commit list again' : 'Use the whole page for this commit' }),
      iconBtn('x', 'Close', closeDetail),
    ];
    const totals = (files) => {
      const add = files.reduce((n, f) => n + (f.add || 0), 0); const del = files.reduce((n, f) => n + (f.del || 0), 0);
      return h('span', { class: 'cd-stat' }, `${files.length} file${files.length === 1 ? '' : 's'} changed `, h('span', { class: 'add' }, `+${add}`), ' ', h('span', { class: 'del' }, `−${del}`));
    };
    const a = selected; const b = compareWith;
    try {
      if (b || a === 'WORKTREE') {
        const from = b || meta.head;
        const to = a === 'WORKTREE' ? null : a;
        const left = b && a !== 'WORKTREE' ? olderOf(a, b) : from;
        const right = b && a !== 'WORKTREE' ? (left === a ? b : a) : to;
        const files = await rpc('repo.compareFiles', { id: r.id, from: left, to: right || undefined });
        if (disposed || selected !== a) return;
        mount(head,
          h('div', { class: 'row' }, h('h3', { class: 'grow ellipsis' }, a === 'WORKTREE' && !b ? 'Uncommitted changes' : 'Comparison'),
            a === 'WORKTREE' ? btn('Open in Changes', () => navigate(`#/repo/${r.id}/changes`), { cls: 'small' }) : null, tools()),
          h('div', { class: 'cd-meta' }, h('span', null, 'From ', h('span', { class: 'mono' }, left.slice(0, 10))), h('span', null, 'to ', h('span', { class: 'mono' }, right ? right.slice(0, 10) : 'working tree')), totals(files)));
        renderFiles(filesList, files, () => rpc('repo.diff', { id: r.id, kind: 'range', from: left, to: right || undefined }));
        return;
      }
      const d = await rpc('repo.commit.detail', { id: r.id, rev: a });
      if (disposed || selected !== a) return;
      const body = d.message.split('\n').slice(1).join('\n').trim();
      mount(head,
        h('div', { class: 'row' }, h('h3', { class: 'grow ellipsis', title: d.message.split('\n')[0] }, d.message.split('\n')[0]),
          btn('Actions…', (e) => menuBelow(e.currentTarget, commitMenu({ hash: d.hash, subject: d.message.split('\n')[0], parents: d.parents })), { cls: 'small' }),
          r.slug && r.slug.github ? btn('Open on GitHub', () => rpc('open.url', { url: `https://github.com/${r.slug.owner}/${r.slug.repo}/commit/${d.hash}` }), { cls: 'small', iconName: 'external' }) : null,
          tools()),
        body ? h('div', { class: 'commit-msg muted' }, body) : null,
        h('div', { class: 'cd-meta' },
          h('span', { title: `${d.author} <${d.authorEmail}>${d.committer !== d.author ? `\nCommitted by ${d.committer}, ${fmtDate(d.commitTime)}` : ''}` }, h('b', null, d.author), ` committed ${ago(d.authorTime)}`),
          h('span', { class: 'faint', title: fmtDate(d.authorTime) }, fmtDate(d.authorTime)),
          h('span', null, h('a', { class: 'mono', title: 'Copy the full hash', onclick: () => copyText(d.hash) }, d.hash.slice(0, 10))),
          h('span', null, d.parents.length ? [d.parents.length > 1 ? 'parents ' : 'parent ', d.parents.map((p, i) => [i ? ', ' : '', h('a', { class: 'mono', onclick: () => { jumpTo(p); showDetail(); } }, p.slice(0, 8))])] : 'root commit'),
          d.pushed ? null : h('span', { class: 'badge info' }, 'not pushed'),
          totals(d.files)));
      renderFiles(filesList, d.files, () => rpc('repo.diff', { id: r.id, kind: 'commit', commit: d.hash }));
    } catch (e) { mount(head, h('div', { class: 'row' }, h('div', { class: 'errbox grow' }, e.message), tools())); }
  }
  function olderOf(a, b) {
    const ia = commits.findIndex((c) => c.hash === a); const ib = commits.findIndex((c) => c.hash === b);
    return ia > ib ? a : b; // further down = older
  }
  /** The list on the left jumps to a file; the diff on the right shows every file, one under the other. */
  async function renderFiles(el, files, getAll) {
    fileStats = new Map(files.map((f) => [f.path, f]));
    if (!files.length) { mount(el, h('div', { class: 'empty' }, 'No file changes.')); return; }
    const rows = files.map((f) => {
      const row = h('div', { class: 'file-row', title: f.orig ? `${f.orig} → ${f.path}` : f.path, onclick: () => {
        rows.forEach((x) => x.classList.remove('selected')); row.classList.add('selected');
        const banner = [...diff.el.querySelectorAll('.file-banner')].find((x) => x.dataset.path === f.path);
        if (banner) { const box = banner.closest('.diff'); box.scrollTop += banner.getBoundingClientRect().top - box.getBoundingClientRect().top; }
      } },
      h('span', { class: `st st-${f.status}` }, f.status), h('span', { class: 'name' }, f.path.split('/').pop(), f.path.includes('/') ? h('span', { class: 'faint' }, `  ${f.path.split('/').slice(0, -1).join('/')}`) : null),
      f.add != null ? h('span', { class: 'cd-stat' }, h('span', { class: 'add' }, `+${f.add}`), ' ', h('span', { class: 'del' }, `−${f.del}`)) : null);
      return row;
    });
    mount(el, rows);
    try { diff.set(await getAll()); } catch (e) { banner({ level: 'error', title: e.message }); }
  }

  // ---------- context menus ----------
  const cur = () => (meta ? meta.summary.branch : null);
  function commitMenu(c) {
    const branch = cur();
    return [
      { label: 'Check out this commit (detached)', icon: 'commit', action: () => checkoutDetached(c) },
      { label: 'Create branch here…', icon: 'branch', action: () => createBranchDialog(r, { from: c.hash }) },
      { label: 'Add tag…', icon: 'tag', action: () => addTag(c) },
      '-',
      { label: `Cherry-pick onto ${branch || 'HEAD'}`, icon: 'plus', action: async () => { if (await confirmDanger({ title: 'Cherry-pick?', message: `Apply the changes of "${c.subject}" as a new commit on ${branch || 'HEAD'}.`, confirmLabel: 'Cherry-pick', danger: false })) act(() => rpc('commit.cherryPick', { id: r.id, rev: c.hash }), { ok: 'Cherry-picked' }).then(reset); } },
      { label: 'Revert (create a reversing commit)', icon: 'undo', action: async () => { if (await confirmDanger({ title: 'Revert commit?', message: `Create a new commit on ${branch || 'HEAD'} that undoes "${c.subject}". History is not rewritten.`, confirmLabel: 'Revert', danger: false })) act(() => rpc('commit.revert', { id: r.id, rev: c.hash }), { ok: 'Revert commit created' }).then(reset); } },
      { label: `Merge into ${branch || 'current'}…`, icon: 'merge', disabled: !branch, action: () => mergeDialog(c.hash, c.hash.slice(0, 8)) },
      { label: `Rebase ${branch || 'current'} onto this commit…`, icon: 'branch', disabled: !branch, action: () => rebaseOnto(c.hash, c.hash.slice(0, 8)) },
      { label: `Reset ${branch || 'current branch'} to here…`, icon: 'undo', danger: true, action: () => resetTo(c) },
      { label: 'Drop this commit…', icon: 'trash', danger: true, action: () => dropCommit(c) },
      '-',
      { label: 'Compare with working tree', icon: 'diff', action: () => { selected = 'WORKTREE'; compareWith = c.hash; if (!commits.some((x) => x.hash === 'WORKTREE')) { selected = c.hash; compareWith = null; } renderToolbar(); renderRows(true); showDetail(); } },
      { label: 'Copy hash', icon: 'copy', action: () => copyText(c.hash) },
      { label: 'Copy message', icon: 'copy', action: async () => { const d = await rpc('repo.commit.detail', { id: r.id, rev: c.hash }); copyText(d.message); } },
      r.slug && r.slug.github ? { label: 'Open on GitHub', icon: 'external', action: () => rpc('open.url', { url: `https://github.com/${r.slug.owner}/${r.slug.repo}/commit/${c.hash}` }) } : null,
    ];
  }
  function branchMenu(name, c) {
    const isCur = name === cur();
    return [
      { header: true, label: name },
      { label: 'Check out', icon: 'branch', disabled: isCur, action: () => switchTo(r, { name }).then(reset) },
      { label: 'Rename…', icon: 'edit', action: async () => { const to = await prompt('Rename branch', 'New name', name); if (to && to !== name) act(() => rpc('branch.rename', { id: r.id, from: name, to }), { ok: 'Renamed' }).then(reset); } },
      { label: 'Delete…', icon: 'trash', danger: true, disabled: isCur, action: () => deleteBranch(name) },
      '-',
      { label: `Merge into ${cur() || 'current'}…`, icon: 'merge', disabled: isCur || !cur(), action: () => mergeDialog(name, name) },
      { label: `Rebase ${cur() || 'current'} onto ${name}…`, icon: 'branch', disabled: isCur || !cur(), action: () => rebaseOnto(name, name) },
      isCur ? { label: 'Push', icon: 'push', action: () => push(r).then(reset) } : null,
      isCur ? { label: 'Pull', icon: 'pull', action: () => pull(r).then(reset) } : null,
      { label: 'Create pull request', icon: 'pr', disabled: !r.slug || !r.slug.github, action: () => (isCur ? navigate(`#/repo/${r.id}/prs/new`) : banner({ level: 'info', title: 'Check out the branch first to create a pull request from it', timeout: 4000 })) },
      '-',
      { label: 'Copy name', icon: 'copy', action: () => copyText(name) },
      { label: 'Create branch from here…', icon: 'branch', action: () => createBranchDialog(r, { from: c.hash }) },
    ];
  }
  function remoteMenu(name) {
    const slash = name.indexOf('/');
    const remote = name.slice(0, slash); const bname = name.slice(slash + 1);
    return [
      { header: true, label: name },
      { label: `Check out as local "${bname}"`, icon: 'branch', action: () => switchTo(r, { remoteRef: name, name: bname }).then(reset) },
      { label: `Merge into ${cur() || 'current'}…`, icon: 'merge', disabled: !cur(), action: () => mergeDialog(name, name) },
      { label: `Rebase ${cur() || 'current'} onto ${name}…`, icon: 'branch', disabled: !cur(), action: () => rebaseOnto(name, name) },
      { label: 'Delete branch on remote…', icon: 'trash', danger: true, action: async () => {
        if (await confirmDanger({ title: 'Delete remote branch?', message: `Delete "${bname}" on ${remote}. Anyone who has not fetched it loses access to it; open pull requests from it are closed by GitHub.`, recover: 'Can be restored only by pushing it again from a clone that still has it.', confirmLabel: 'Delete on remote' })) act(() => rpc('branch.deleteRemote', { id: r.id, remote, name: bname }), { ok: 'Remote branch deleted' }).then(reset);
      } },
      { label: 'Copy name', icon: 'copy', action: () => copyText(name) },
    ];
  }
  function tagMenu(name) {
    return [
      { header: true, label: name },
      { label: 'Push tag to origin', icon: 'push', action: () => act(() => rpc('tag.push', { id: r.id, name }), { ok: 'Tag pushed' }) },
      { label: 'Delete tag locally…', icon: 'trash', danger: true, action: async () => { if (await confirmDanger({ title: 'Delete tag?', message: `Delete the local tag "${name}". The remote tag, if any, is kept.`, confirmLabel: 'Delete' })) act(() => rpc('tag.delete', { id: r.id, name }), { ok: 'Tag deleted' }).then(reset); } },
      { label: 'Delete tag on origin…', icon: 'trash', danger: true, action: async () => { if (await confirmDanger({ title: 'Delete remote tag?', message: `Delete "${name}" on origin. Releases or deployments that use it may break.`, confirmLabel: 'Delete on remote' })) act(() => rpc('tag.deleteRemote', { id: r.id, name }), { ok: 'Remote tag deleted' }); } },
      { label: 'Copy name', icon: 'copy', action: () => copyText(name) },
    ];
  }
  function stashMenu(s) {
    return [
      { header: true, label: `${s.ref}: ${s.message}` },
      { label: 'Apply', icon: 'check', action: () => act(() => rpc('stash.apply', { id: r.id, ref: s.ref }), { ok: 'Stash applied' }).then(reset) },
      { label: 'Pop (apply and drop)', icon: 'check', action: () => act(() => rpc('stash.apply', { id: r.id, ref: s.ref, pop: true }), { ok: 'Stash popped' }).then(reset) },
      { label: 'Create branch from stash…', icon: 'branch', action: async () => { const n = await prompt('Branch from stash', 'Branch name'); if (n) act(() => rpc('stash.branch', { id: r.id, ref: s.ref, name: n }), { ok: `Created ${n}` }).then(reset); } },
      { label: 'Drop…', icon: 'trash', danger: true, action: async () => { if (await confirmDanger({ title: 'Drop stash?', message: `Delete ${s.ref} "${s.message}".`, recover: 'Not recoverable from Repodeck (git fsck can sometimes find dropped stashes).', confirmLabel: 'Drop' })) act(() => rpc('stash.drop', { id: r.id, ref: s.ref }), { ok: 'Stash dropped' }).then(reset); } },
    ];
  }

  async function checkoutDetached(c) {
    if (meta.summary.dirty) { banner({ level: 'warn', title: 'Commit or stash your changes before checking out a commit', timeout: 4000 }); return; }
    if (await confirmDanger({ title: 'Check out commit?', message: `Switch to ${c.hash.slice(0, 8)} without a branch (detached HEAD). New commits made there belong to no branch unless you create one.`, confirmLabel: 'Check out', danger: false })) act(() => rpc('commit.checkout', { id: r.id, rev: c.hash }), { ok: 'Checked out' }).then(reset);
  }
  async function addTag(c) {
    const v = await form({ title: 'Add tag', fields: [{ name: 'name', label: 'Tag name', required: true, placeholder: 'v1.2.3' }, { name: 'message', label: 'Message (makes an annotated tag; leave empty for a lightweight tag)', type: 'textarea', rows: 3 }, { name: 'push', label: 'Push the tag to origin', type: 'checkbox', value: false }], submit: 'Add tag' });
    if (!v) return;
    const ok = await act(() => rpc('tag.create', { id: r.id, name: v.name.trim(), rev: c.hash, message: v.message.trim() || undefined }), { ok: `Tag ${v.name} added` });
    if (ok !== undefined && v.push) await act(() => rpc('tag.push', { id: r.id, name: v.name.trim() }), { ok: 'Tag pushed' });
    reset();
  }
  async function mergeDialog(rev, label) {
    const v = await form({ title: `Merge ${label} into ${cur()}`, fields: [{ name: 'noFf', label: 'Always create a merge commit (--no-ff)', type: 'checkbox', value: false }, { name: 'squash', label: 'Squash into a single change set (you commit it afterwards)', type: 'checkbox', value: false }], submit: 'Merge' });
    if (!v) return;
    try {
      const res = await rpc('branch.merge', { id: r.id, rev, noFf: v.noFf, squash: v.squash });
      banner({ level: 'success', title: 'Merged', body: (res.output || '').split('\n').slice(0, 3).join('\n'), timeout: 4000 });
    } catch (e) {
      if (/CONFLICT|Automatic merge failed/i.test(`${e.message}${e.stderr}`)) banner({ level: 'warn', title: 'Merge has conflicts', body: 'Resolve them in the Changes tab, then press Continue.', timeout: 0, actions: [{ label: 'Go to Changes', action: () => navigate(`#/repo/${r.id}/changes`) }] });
      else showError(e, 'Merge failed');
    }
    reset();
  }
  async function rebaseOnto(rev, label) {
    const pushed = meta.summary.upstream;
    if (!(await confirmDanger({ title: `Rebase ${cur()} onto ${label}?`, message: `Your commits on ${cur()} are replayed on top of ${label}.${pushed ? ' This branch is pushed: after rebasing you will need to force push.' : ''}`, confirmLabel: 'Rebase', danger: !!pushed }))) return;
    try { await rpc('branch.rebase', { id: r.id, onto: rev }); banner({ level: 'success', title: 'Rebased', timeout: 3000 }); } catch (e) {
      if (/CONFLICT|could not apply/i.test(`${e.message}${e.stderr}`)) banner({ level: 'warn', title: 'Rebase stopped on conflicts', body: 'Resolve them in Changes, then Continue (or Abort).', timeout: 0, actions: [{ label: 'Go to Changes', action: () => navigate(`#/repo/${r.id}/changes`) }] });
      else showError(e, 'Rebase failed');
    }
    reset();
  }
  async function resetTo(c) {
    const v = await form({
      title: `Reset ${cur() || 'HEAD'} to ${c.hash.slice(0, 8)}`,
      intro: h('div', { class: 'muted' }, `Moves ${cur() || 'HEAD'} to "${c.subject}". Commits after it leave the branch.`),
      fields: [{ name: 'mode', label: 'Mode', type: 'select', value: 'mixed', options: [
        { value: 'soft', label: 'Soft: keep all changes staged' }, { value: 'mixed', label: 'Mixed: keep all changes, unstaged' }, { value: 'hard', label: 'Hard: discard all changes (a safety copy of uncommitted work is kept)' }] }],
      submit: 'Reset', danger: true,
    });
    if (!v) return;
    if (v.mode === 'hard' && !(await confirmDanger({ title: 'Hard reset?', message: 'Uncommitted changes and the commits after this one are removed from the branch.', recover: 'Uncommitted changes get a safety copy under "Recently discarded". Removed commits stay reachable through git reflog for about 90 days.', confirmLabel: 'Hard reset' }))) return;
    act(() => rpc('commit.reset', { id: r.id, rev: c.hash, mode: v.mode }), { ok: `Reset (${v.mode})` }).then(reset);
  }
  async function dropCommit(c) {
    if (!(await confirmDanger({ title: 'Drop commit?', message: `Remove "${c.subject}" from ${cur()}. Later commits are replayed without it. Only allowed for commits that are not pushed.`, recover: 'The dropped commit stays reachable through git reflog for about 90 days.', confirmLabel: 'Drop commit' }))) return;
    act(() => rpc('commit.drop', { id: r.id, rev: c.hash }), { ok: 'Commit dropped' }).then(reset);
  }
  async function deleteBranch(name) {
    const m = await rpc('branch.isMerged', { id: r.id, name }).catch(() => ({ merged: false }));
    if (!(await confirmDanger({ title: `Delete branch ${name}?`, message: m.merged ? `"${name}" is fully merged into ${m.target}.` : `"${name}" is NOT merged into ${m.target || 'the default branch'}. Its unmerged commits will no longer be on any branch.`, recover: 'Recoverable through git reflog for about 90 days.', confirmLabel: 'Delete branch' }))) return;
    act(() => rpc('branch.delete', { id: r.id, name, force: !m.merged }), { ok: `Deleted ${name}` }).then(reset);
  }

  wrap.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const i = commits.findIndex((c) => c.hash === selected);
    const j = Math.max(0, Math.min(commits.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    selected = commits[j].hash; compareWith = null;
    if (j * ROW < wrap.scrollTop + 30 || j * ROW > wrap.scrollTop + wrap.clientHeight - 60) wrap.scrollTop = j * ROW - wrap.clientHeight / 2;
    renderRows(true); showDetail();
  });

  reset();
  return { dispose() { disposed = true; } };
}
