// Diff viewer: unified or side-by-side, intra-line highlights, hunk/line selection,
// optional inline comment threads (for pull request reviews).
import { h, mount, icon, btn } from './dom.js';
import { prefs } from './store.js';

/**
 * opts:
 *  hunkActions(fileIdx, hunkIdx) -> [button nodes]
 *  selectionActions -> [{ label, cls, run(selection) }] where selection = { fileIdx, hunks: { [hunkIdx]: [lineIdx...] } }
 *  selectable: boolean
 *  onComment(info) -> called with { path, side, line, startLine, startSide }
 *  threadsFor(path, side, line) -> [nodes]
 *  toolbarExtra -> nodes
 *  onOptions({ ignoreWs, context }) when the user changes options that need a refetch
 *  headerFor(file) -> nodes in the sticky file banner
 */
export function createDiffView(opts = {}) {
  let mode = prefs.get('diffMode', 'unified');
  let ignoreWs = prefs.get('diffIgnoreWs', false);
  let data = null;
  let sel = new Map(); // key `${f}:${h}` -> Set(lineIdx)
  let anchor = null;

  const toolbar = h('div', { class: 'diff-toolbar' });
  const selBar = h('div', { class: 'selection-bar hidden' });
  const body = h('div', { class: 'diff', tabindex: '0' });
  const root = h('div', { class: 'pane', style: { flex: '1' } }, toolbar, selBar, body);

  function renderToolbar(extra) {
    mount(toolbar,
      extra || null,
      h('span', { class: 'spacer' }),
      data && data.truncated ? h('span', { class: 'badge warn' }, `Large diff: showing first ${data.totalLines > 6000 ? '6000' : ''} lines`) : null,
      data && data.truncated && opts.onFull ? btn('Show full diff', () => opts.onFull(), { cls: 'small' }) : null,
      h('label', { class: 'check', title: 'Hide changes that only touch whitespace' }, h('input', { type: 'checkbox', checked: ignoreWs, onchange: (e) => { ignoreWs = e.target.checked; prefs.set('diffIgnoreWs', ignoreWs); if (opts.onOptions) opts.onOptions({ ignoreWs }); } }), 'Ignore whitespace'),
      h('div', { class: 'pill-tabs' },
        h('button', { class: mode === 'unified' ? 'active' : '', onclick: () => setMode('unified') }, 'Unified'),
        h('button', { class: mode === 'split' ? 'active' : '', onclick: () => setMode('split') }, 'Side by side')));
  }
  function setMode(m) { mode = m; prefs.set('diffMode', m); renderToolbar(opts.toolbarExtra && opts.toolbarExtra()); renderBody(); }

  function selectionPayload() {
    // only a single file can be acted on at once
    const out = {};
    let fileIdx = null;
    for (const [k, set] of sel) {
      if (!set.size) continue;
      const [f, hk] = k.split(':').map(Number);
      if (fileIdx == null) fileIdx = f; else if (f !== fileIdx) continue;
      out[hk] = [...set].sort((a, b) => a - b);
    }
    return fileIdx == null ? null : { fileIdx, hunks: out };
  }
  function renderSelBar() {
    const p = selectionPayload();
    const n = p ? Object.values(p.hunks).reduce((a, x) => a + x.length, 0) : 0;
    selBar.classList.toggle('hidden', !n);
    if (!n) { clearNode(selBar); return; }
    const actions = (opts.selectionActions || []).map((a) => btn(a.label, () => a.run(p), { cls: `small ${a.cls || ''}` }));
    if (opts.onComment && p) {
      actions.push(btn('Comment on selected lines', () => commentOnSelection(p), { cls: 'small', iconName: 'edit' }));
    }
    mount(selBar, h('strong', null, `${n} line${n === 1 ? '' : 's'} selected`), ...actions, h('span', { class: 'spacer' }), btn('Clear', () => { sel.clear(); renderBody(); }, { cls: 'small ghost' }));
  }
  function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function commentOnSelection(p) {
    const f = data.files[p.fileIdx];
    const lines = [];
    for (const [hk, idxs] of Object.entries(p.hunks)) for (const li of idxs) lines.push(lineInfo(f, +hk, li));
    const valid = lines.filter(Boolean);
    if (!valid.length) return;
    const last = valid[valid.length - 1];
    const first = valid[0];
    opts.onComment({ path: f.path, side: last.side, line: last.line, startLine: first.line, startSide: first.side });
  }

  // numbering for a given line
  function lineInfo(f, hk, li) {
    const hunk = f.hunks[hk];
    let o = hunk.oldStart; let n = hunk.newStart;
    for (let i = 0; i < hunk.lines.length; i++) {
      const l = hunk.lines[i];
      if (i === li) {
        if (l.t === '-') return { side: 'LEFT', line: o };
        if (l.t === '+' || l.t === ' ') return { side: 'RIGHT', line: n };
        return null;
      }
      if (l.t === '-') o++; else if (l.t === '+') n++; else if (l.t === ' ') { o++; n++; }
    }
    return null;
  }

  function toggleLine(f, hk, li, e) {
    const key = `${f}:${hk}`;
    const line = data.files[f].hunks[hk].lines[li];
    if (!opts.onComment && line.t !== '+' && line.t !== '-') return;
    if (e.shiftKey && anchor && anchor.f === f && anchor.hk === hk) {
      const set = new Set();
      const [a, b] = [Math.min(anchor.li, li), Math.max(anchor.li, li)];
      for (let i = a; i <= b; i++) { const t = data.files[f].hunks[hk].lines[i].t; if (t === '+' || t === '-' || (opts.onComment && t === ' ')) set.add(i); }
      if (!e.ctrlKey) sel.clear();
      sel.set(key, set);
    } else if (e.ctrlKey) {
      const set = sel.get(key) || new Set();
      if (set.has(li)) set.delete(li); else set.add(li);
      sel.set(key, set);
      anchor = { f, hk, li };
    } else {
      const set = sel.get(key);
      const only = set && set.size === 1 && set.has(li) && [...sel.values()].reduce((a, s) => a + s.size, 0) === 1;
      sel.clear();
      if (!only) sel.set(key, new Set([li]));
      anchor = { f, hk, li };
    }
    renderBody();
  }

  function selectHunk(f, hk) {
    const set = new Set();
    data.files[f].hunks[hk].lines.forEach((l, i) => { if (l.t === '+' || l.t === '-') set.add(i); });
    sel.clear(); sel.set(`${f}:${hk}`, set); renderBody();
  }

  function renderBody() {
    const scroll = body.scrollTop;
    clearNode(body);
    if (!data) return;
    if (!data.files.length) { body.append(h('div', { class: 'empty' }, opts.emptyText || 'No differences.')); renderSelBar(); return; }
    data.files.forEach((f, fi) => {
      if (data.files.length > 1 || opts.alwaysBanner) {
        body.append(h('div', { class: 'file-banner' }, h('span', { class: 'mono grow ellipsis', title: f.path }, f.renameFrom ? `${f.renameFrom} → ${f.path}` : f.path), opts.headerFor ? opts.headerFor(f, fi) : null));
      }
      if (f.binary) { body.append(h('div', { class: 'empty' }, opts.binaryNode ? opts.binaryNode(f) : 'Binary file: contents not shown.')); return; }
      if (!f.hunks.length) {
        const note = f.isNew ? 'New empty file.' : f.isDeleted ? 'File deleted.' : f.renameFrom ? 'Renamed without changes.' : (f.header.find((x) => /mode/.test(x)) || 'No content changes.');
        body.append(h('div', { class: 'empty' }, note));
        return;
      }
      body.append(mode === 'split' ? splitTable(f, fi) : unifiedTable(f, fi));
    });
    body.scrollTop = scroll;
    renderSelBar();
  }

  function hunkRow(f, fi, hk, colspan) {
    const hunk = f.hunks[hk];
    const acts = opts.hunkActions ? opts.hunkActions(fi, hk) : [];
    if (opts.selectable) acts.push(h('a', { onclick: () => selectHunk(fi, hk), title: 'Select every changed line in this hunk' }, 'select'));
    return h('tr', { class: 'hunk' }, h('td', { colspan }, h('span', { class: 'hunk-acts' }, acts), `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.context || ''}`));
  }

  function unifiedTable(f, fi) {
    const tb = h('tbody');
    f.hunks.forEach((hunk, hk) => {
      tb.append(hunkRow(f, fi, hk, 4));
      const pairs = intraline(hunk.lines);
      let o = hunk.oldStart; let n = hunk.newStart;
      const set = sel.get(`${fi}:${hk}`);
      hunk.lines.forEach((l, li) => {
        if (l.t === '\\') { tb.append(h('tr', { class: 'meta' }, h('td', { colspan: 4 }, l.s.trim()))); return; }
        const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : '';
        const oldNo = l.t === '+' ? '' : o;
        const newNo = l.t === '-' ? '' : n;
        const side = l.t === '-' ? 'LEFT' : 'RIGHT';
        const ln = l.t === '-' ? o : n;
        const row = h('tr', { class: `${cls} ${set && set.has(li) ? 'sel' : ''}` },
          h('td', { class: 'ln', onclick: (e) => toggleLine(fi, hk, li, e) }, oldNo),
          h('td', { class: 'ln', onclick: (e) => toggleLine(fi, hk, li, e) }, newNo),
          h('td', { class: 'mark', onclick: (e) => toggleLine(fi, hk, li, e) },
            opts.onComment ? h('a', { class: 'ln-add', title: 'Add a review comment', onclick: (e) => { e.stopPropagation(); opts.onComment({ path: f.path, side, line: ln }); } }, '+') : (l.t === ' ' ? '' : l.t)),
          h('td', { class: 'code' }, pairs[li] || l.s));
        tb.append(row);
        if (opts.threadsFor) {
          const th = opts.threadsFor(f.path, side, ln);
          if (th && th.length) tb.append(h('tr', { class: 'comment-row' }, h('td', { colspan: 4 }, th)));
        }
        if (l.t === '-') o++; else if (l.t === '+') n++; else { o++; n++; }
      });
    });
    return h('table', null, h('colgroup', null, h('col', { style: { width: '52px' } }), h('col', { style: { width: '52px' } }), h('col', { style: { width: '18px' } }), h('col')), tb);
  }

  function splitTable(f, fi) {
    const tb = h('tbody');
    f.hunks.forEach((hunk, hk) => {
      tb.append(hunkRow(f, fi, hk, 6));
      const pairs = intraline(hunk.lines);
      const set = sel.get(`${fi}:${hk}`);
      let o = hunk.oldStart; let n = hunk.newStart;
      let i = 0;
      const L = hunk.lines;
      const cell = (li, num, side) => {
        if (li == null) return [h('td', { class: 'ln empty-side' }), h('td', { class: 'code empty-side' })];
        const l = L[li];
        const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : '';
        return [
          h('td', { class: `ln ${cls}`, onclick: (e) => toggleLine(fi, hk, li, e), title: opts.onComment ? 'Click to select; use + to comment' : '' },
            opts.onComment ? h('span', null, h('a', { class: 'ln-add', onclick: (e) => { e.stopPropagation(); opts.onComment({ path: f.path, side, line: num }); } }, '+ '), num) : num),
          h('td', { class: `code ${cls}` }, pairs[li] || l.s),
        ];
      };
      while (i < L.length) {
        const l = L[i];
        if (l.t === '\\') { i++; continue; }
        if (l.t === ' ') {
          const tr = h('tr', { class: set && set.has(i) ? 'sel' : '' }, ...cell(i, o, 'LEFT'), ...cell(i, n, 'RIGHT'));
          tb.append(tr);
          appendThreads(tb, f, [['RIGHT', n]], 4);
          i++; o++; n++; continue;
        }
        const dels = []; const adds = [];
        while (i < L.length && (L[i].t === '-' || L[i].t === '\\')) { if (L[i].t === '-') dels.push(i); i++; }
        while (i < L.length && (L[i].t === '+' || L[i].t === '\\')) { if (L[i].t === '+') adds.push(i); i++; }
        const rows = Math.max(dels.length, adds.length);
        for (let k = 0; k < rows; k++) {
          const d = dels[k]; const a = adds[k];
          const selected = (d != null && set && set.has(d)) || (a != null && set && set.has(a));
          const tr = h('tr', { class: selected ? 'sel' : '' });
          const left = cell(d, d != null ? o + k : null, 'LEFT');
          const right = cell(a, a != null ? n + k : null, 'RIGHT');
          if (d != null) left.forEach((c) => c.classList.add('delc'));
          tr.append(...left, ...right);
          tb.append(tr);
          const th = [];
          if (d != null) th.push(['LEFT', o + k]);
          if (a != null) th.push(['RIGHT', n + k]);
          appendThreads(tb, f, th, 4);
        }
        o += dels.length; n += adds.length;
      }
    });
    // colour the split cells
    tb.querySelectorAll('td.code.add, td.ln.add').forEach((c) => { c.style.background = 'var(--add-bg)'; });
    tb.querySelectorAll('td.code.del, td.ln.del').forEach((c) => { c.style.background = 'var(--del-bg)'; });
    return h('table', { class: 'split-table' }, h('colgroup', null, h('col', { style: { width: '52px' } }), h('col'), h('col', { style: { width: '52px' } }), h('col')), tb);
  }
  function appendThreads(tb, f, list, colspan) {
    if (!opts.threadsFor) return;
    for (const [side, line] of list) {
      const th = opts.threadsFor(f.path, side, line);
      if (th && th.length) tb.append(h('tr', { class: 'comment-row' }, h('td', { colspan }, th)));
    }
  }

  return {
    el: root,
    set(d, { keepSelection = false } = {}) {
      data = d;
      if (!keepSelection) { sel = new Map(); anchor = null; }
      renderToolbar(opts.toolbarExtra && opts.toolbarExtra());
      renderBody();
    },
    get data() { return data; },
    get ignoreWs() { return ignoreWs; },
    clearSelection() { sel = new Map(); renderBody(); },
    refreshToolbar() { renderToolbar(opts.toolbarExtra && opts.toolbarExtra()); },
    rerender() { renderBody(); },
  };
}

/** Pair adjacent -/+ runs and highlight the changed middle of each pair. Returns map lineIdx -> node. */
function intraline(lines) {
  const out = {};
  let i = 0;
  while (i < lines.length) {
    if (lines[i].t !== '-') { i++; continue; }
    const dels = []; const adds = [];
    while (i < lines.length && lines[i].t === '-') dels.push(i++);
    while (i < lines.length && lines[i].t === '\\') i++;
    while (i < lines.length && lines[i].t === '+') adds.push(i++);
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const a = lines[dels[k]].s; const b = lines[adds[k]].s;
      if (a.length > 2000 || b.length > 2000) continue;
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      let s = 0;
      while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
      const changedA = a.length - p - s; const changedB = b.length - p - s;
      if (changedA + changedB === 0 || (changedA > a.length * 0.8 && changedB > b.length * 0.8)) continue;
      out[dels[k]] = frag(a.slice(0, p), a.slice(p, a.length - s), a.slice(a.length - s), 'del');
      out[adds[k]] = frag(b.slice(0, p), b.slice(p, b.length - s), b.slice(b.length - s), 'ins');
    }
  }
  return out;
}
function frag(pre, mid, post, tag) {
  const f = document.createDocumentFragment();
  f.append(pre);
  if (mid) f.append(h(tag, null, mid));
  f.append(post);
  return f;
}
