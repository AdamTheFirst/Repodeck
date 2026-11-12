// Pure parsers for machine-readable git output. No I/O here, so it is easy to test.
'use strict';

// ---------- status --porcelain=v2 -z --branch --show-stash ----------

const XY_LABEL = { M: 'modified', T: 'type changed', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'unmerged', '.': '' };

function parseStatusV2(text) {
  const res = {
    oid: null, head: null, detached: false, upstream: null, ahead: 0, behind: 0, stash: 0,
    staged: [], unstaged: [], untracked: [], conflicted: [], ignored: [],
  };
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') res.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') { res.head = val === '(detached)' ? null : val; res.detached = val === '(detached)'; }
      else if (key === 'branch.upstream') res.upstream = val;
      else if (key === 'branch.ab') { const m = /\+(\d+) -(\d+)/.exec(val); if (m) { res.ahead = +m[1]; res.behind = +m[2]; } }
      else if (key === 'stash') res.stash = +val || 0;
      continue;
    }
    const kind = line[0];
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = splitN(line, 8);
      addEntry(res, f[1], f[2], f[8], null);
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = splitN(line, 9);
      const orig = parts[++i];
      addEntry(res, f[1], f[2], f[9], orig);
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = splitN(line, 10);
      res.conflicted.push({ path: f[10], xy: f[1], conflict: conflictKind(f[1]), sub: f[2] !== 'N...' });
    } else if (kind === '?') {
      res.untracked.push({ path: line.slice(2), status: '?', label: 'untracked' });
    } else if (kind === '!') {
      res.ignored.push({ path: line.slice(2) });
    }
  }
  return res;
}

function splitN(line, n) {
  // split into n fields by single spaces; the last field (path) may contain spaces
  const out = [];
  let idx = 0;
  for (let k = 0; k < n; k++) {
    const sp = line.indexOf(' ', idx);
    out.push(line.slice(idx, sp));
    idx = sp + 1;
  }
  out.push(line.slice(idx));
  return out;
}

function addEntry(res, xy, sub, path, orig) {
  const x = xy[0];
  const y = xy[1];
  const isSub = sub && sub[0] === 'S';
  if (x !== '.') res.staged.push({ path, orig: x === 'R' || x === 'C' ? orig : null, status: x, label: XY_LABEL[x] || x, submodule: isSub });
  if (y !== '.') res.unstaged.push({ path, orig: null, status: y, label: XY_LABEL[y] || y, submodule: isSub, subState: isSub ? sub : null });
}

function conflictKind(xy) {
  return ({
    DD: 'both deleted', AU: 'added by us', UD: 'deleted by them', UA: 'added by them',
    DU: 'deleted by us', AA: 'both added', UU: 'both modified',
  })[xy] || 'conflict';
}

// ---------- remotes ----------

/** Extract { host, owner, repo } from any git remote URL form, including SSH host aliases. */
function parseRemoteUrl(url) {
  if (!url) return null;
  url = url.trim();
  let host, p;
  let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url); // https://, ssh://, git://
  if (m) { host = m[1]; p = m[2]; } else {
    m = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url); // scp-like: git@alias:owner/repo.git
    if (!m) return null;
    host = m[1]; p = m[2];
  }
  p = p.replace(/\/+$/, '').replace(/\.git$/i, '');
  const segs = p.split('/').filter(Boolean);
  if (segs.length < 2) return null;
  const repo = segs[segs.length - 1];
  const owner = segs[segs.length - 2];
  return { host, owner, repo, slug: `${owner}/${repo}` };
}

/** Is this host GitHub (directly or via an ssh alias such as github.com-work)? */
function looksLikeGitHub(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === 'github.com' || h === 'ssh.github.com' || h.startsWith('github.com-') || h.startsWith('github.com_')
    || h.endsWith('.github.com') || h === 'github';
}

// ---------- log ----------

const FS = '\x1f';
const RS = '\x1e';
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%s'].join('%x1f') + '%x1e';

function parseLog(text) {
  const out = [];
  for (const rec of text.split(RS)) {
    const r = rec.replace(/^\n/, '');
    if (!r) continue;
    const f = r.split(FS);
    if (f.length < 10) continue;
    out.push({
      hash: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2], authorEmail: f[3], authorTime: +f[4],
      committer: f[5], committerEmail: f[6], commitTime: +f[7],
      refs: parseDecorations(f[8]),
      subject: f.slice(9).join(FS),
    });
  }
  return out;
}

function parseDecorations(d) {
  if (!d) return [];
  return d.split(', ').filter(Boolean).map((s) => {
    if (s.startsWith('HEAD -> ')) return [{ type: 'head', name: 'HEAD' }, { type: 'branch', name: s.slice(8), current: true }];
    if (s === 'HEAD') return [{ type: 'head', name: 'HEAD' }];
    if (s.startsWith('tag: ')) return [{ type: 'tag', name: s.slice(5) }];
    if (s.endsWith('/HEAD')) return [{ type: 'remote-head', name: s }];
    return [{ type: 'ref', name: s }];
  }).flat();
}

// ---------- refs ----------

const REF_FORMAT = ['%(refname)', '%(refname:short)', '%(objectname)', '%(upstream:short)', '%(upstream:track,nobracket)',
  '%(committerdate:unix)', '%(subject)', '%(HEAD)', '%(objecttype)', '%(*objectname)', '%(authorname)'].join('%1f');

function parseRefs(text) {
  return text.split('\n').filter(Boolean).map((l) => {
    const f = l.split(FS);
    const track = f[4] || '';
    const a = /ahead (\d+)/.exec(track);
    const b = /behind (\d+)/.exec(track);
    return {
      ref: f[0], name: f[1], hash: f[2], upstream: f[3] || null,
      gone: track === 'gone', ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0,
      time: +f[5] || 0, subject: f[6], current: f[7] === '*', objectType: f[8], peeled: f[9] || null, author: f[10] || '',
    };
  });
}

// ---------- diff ----------

/**
 * Parse unified diff text (decoded as latin1 so bytes survive round-trips).
 * Returns [{ header: [lines], oldPath, newPath, binary, hunks: [{ header, oldStart, oldLines, newStart, newLines, lines: [{t, s}] }] }]
 * line t: ' ', '+', '-', '\\' (no-newline marker). s is the raw line without the leading char.
 */
function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ') || (line.startsWith('diff --cc ') || line.startsWith('diff --combined '))) {
      file = { header: [line], oldPath: null, newPath: null, binary: false, hunks: [], combined: !line.startsWith('diff --git') };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk || !/^[ +\-\\]/.test(line) || line.startsWith('@@')) {
      if (line.startsWith('@@')) {
        const m = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+(.*)$/.exec(line);
        hunk = {
          header: line,
          oldStart: m ? +m[1] : 0, oldLines: m ? (m[2] == null ? 1 : +m[2]) : 0,
          newStart: m ? +m[3] : 0, newLines: m ? (m[4] == null ? 1 : +m[4]) : 0,
          context: m ? m[5] : '', lines: [],
        };
        file.hunks.push(hunk);
        continue;
      }
      if (hunk && line === '') { hunk.lines.push({ t: ' ', s: '' }); continue; }
      hunk = null;
      file.header.push(line);
      if (line.startsWith('--- ')) file.oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith('+++ ')) file.newPath = stripPrefix(line.slice(4));
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
      else if (line.startsWith('rename from ')) file.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) file.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) file.isNew = true;
      else if (line.startsWith('deleted file mode')) file.isDeleted = true;
      continue;
    }
    hunk.lines.push({ t: line[0], s: line.slice(1) });
  }
  for (const f of files) {
    if (!f.oldPath && !f.newPath) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(f.header[0]);
      if (m) { f.oldPath = m[1]; f.newPath = m[2]; }
    }
    f.path = f.newPath && f.newPath !== '/dev/null' ? f.newPath : f.oldPath;
  }
  return files;
}

function stripPrefix(p) {
  if (p === '/dev/null') return p;
  p = p.replace(/\t$/, '');
  if (p.startsWith('"')) { try { p = JSON.parse(p); } catch {} }
  return p.replace(/^[ab]\//, '');
}

/**
 * Build a patch that contains only selected changes.
 * selection: Map hunkIndex -> Set(lineIndex) | 'all'. Hunks not in the map are dropped.
 * mode 'forward': patch will be applied forward (stage from unstaged diff).
 * mode 'reverse': patch will be applied with --reverse (unstage from staged diff, discard from unstaged diff).
 * Forward rule: unselected '+' lines are dropped, unselected '-' lines become context.
 * Reverse rule: unselected '+' lines become context, unselected '-' lines are dropped.
 */
function buildPatch(file, selection, mode = 'forward') {
  const out = [...file.header];
  let any = false;
  let delta = 0;
  file.hunks.forEach((h, hi) => {
    const sel = selection.get(hi);
    if (!sel) return;
    const body = [];
    let oldCount = 0;
    let newCount = 0;
    let changed = false;
    let lastKept = null; // track whether the previous source line was kept, for "\ No newline" markers
    h.lines.forEach((ln, li) => {
      if (ln.t === '\\') { if (lastKept) body.push('\\' + ln.s); return; }
      const picked = sel === 'all' || sel.has(li);
      let t = ln.t;
      if (t === '+' && !picked) t = mode === 'forward' ? null : ' ';
      else if (t === '-' && !picked) t = mode === 'forward' ? ' ' : null;
      if (t === null) { lastKept = false; return; }
      lastKept = true;
      if (t !== ' ') changed = true;
      if (t === ' ' || t === '-') oldCount++;
      if (t === ' ' || t === '+') newCount++;
      body.push(t + ln.s);
    });
    if (!changed) return;
    any = true;
    // The side the patch is applied to keeps its original positions; the other side is
    // derived from the running line delta of the hunks we kept. A zero-length side is
    // addressed by the line before it, per unified diff syntax.
    let oldStart;
    let newStart;
    if (mode === 'forward') {
      const a = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
      const b = a + delta;
      oldStart = oldCount === 0 ? a - 1 : a;
      newStart = newCount === 0 ? b - 1 : b;
    } else {
      const a = h.newLines === 0 ? h.newStart + 1 : h.newStart;
      const b = a - delta;
      newStart = newCount === 0 ? a - 1 : a;
      oldStart = oldCount === 0 ? b - 1 : b;
    }
    delta += newCount - oldCount;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${h.context || ''}`);
    out.push(...body);
  });
  if (!any) return null;
  return out.join('\n') + '\n';
}

// ---------- conflict markers ----------

/** Split a conflicted file into segments: { type: 'text', lines } | { type: 'conflict', ours, base, theirs, oursLabel, theirsLabel } */
function parseConflicts(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const segs = [];
  let buf = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('<<<<<<<')) {
      if (buf.length) { segs.push({ type: 'text', lines: buf }); buf = []; }
      const c = { type: 'conflict', oursLabel: l.slice(7).trim(), ours: [], base: null, theirs: [], theirsLabel: '' };
      let part = 'ours';
      i++;
      let closed = false;
      for (; i < lines.length; i++) {
        const x = lines[i];
        if (x.startsWith('|||||||') && part === 'ours') { part = 'base'; c.base = []; continue; }
        if (x.startsWith('=======') && part !== 'theirs') { part = 'theirs'; continue; }
        if (x.startsWith('>>>>>>>') && part === 'theirs') { c.theirsLabel = x.slice(7).trim(); closed = true; i++; break; }
        c[part].push(x);
      }
      if (!closed) { // malformed: treat as text so nothing is lost
        segs.push({ type: 'text', lines: [l, ...c.ours, ...(c.base || []), ...c.theirs] });
        continue;
      }
      segs.push(c);
      continue;
    }
    buf.push(l);
    i++;
  }
  if (buf.length) segs.push({ type: 'text', lines: buf });
  return { segs, eol };
}

/** Rebuild file text from segments, given a resolution per conflict index: ours|theirs|both|both-theirs-first|null(keep markers). */
function resolveConflicts(parsed, choices) {
  const out = [];
  let ci = 0;
  for (const s of parsed.segs) {
    if (s.type === 'text') { out.push(...s.lines); continue; }
    const ch = choices[ci++];
    if (ch === 'ours') out.push(...s.ours);
    else if (ch === 'theirs') out.push(...s.theirs);
    else if (ch === 'both') out.push(...s.ours, ...s.theirs);
    else if (ch === 'both-theirs-first') out.push(...s.theirs, ...s.ours);
    else {
      out.push(`<<<<<<< ${s.oursLabel}`.trimEnd(), ...s.ours);
      if (s.base) out.push('|||||||', ...s.base);
      out.push('=======', ...s.theirs, `>>>>>>> ${s.theirsLabel}`.trimEnd());
    }
  }
  return out.join(parsed.eol);
}

// ---------- workflow_dispatch inputs (tiny YAML subset) ----------

/** Extract on.workflow_dispatch.inputs from a workflow YAML without a full YAML parser. */
function parseDispatchInputs(yaml) {
  const lines = yaml.replace(/\r/g, '').split('\n');
  const indentOf = (l) => l.match(/^ */)[0].length;
  const clean = (v) => {
    v = v.replace(/\s+#.*$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  };
  let hasDispatch = false;
  let i = 0;
  // find 'workflow_dispatch' key (under on:) or inline list form `on: [push, workflow_dispatch]`
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(['"]?on['"]?|true)\s*:.*\bworkflow_dispatch\b/.test(l)) { hasDispatch = true; return { hasDispatch, inputs: [] }; }
    if (/^\s*-?\s*workflow_dispatch\s*:?\s*(\{\s*\})?\s*(#.*)?$/.test(l)) { hasDispatch = true; break; }
  }
  if (!hasDispatch) return { hasDispatch: false, inputs: [] };
  const wdIndent = indentOf(lines[i]);
  const inputs = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    if (indentOf(l) <= wdIndent) return { hasDispatch, inputs };
    if (/^\s*inputs\s*:/.test(l)) break;
  }
  if (j >= lines.length) return { hasDispatch, inputs };
  const inIndent = indentOf(lines[j]);
  let cur = null;
  let curIndent = -1;
  let optionsMode = false;
  for (j = j + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const ind = indentOf(l);
    if (ind <= inIndent) break;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(l);
    if (cur === null || ind <= curIndent) {
      if (m) { cur = { name: m[1], type: 'string', required: false, default: '', description: '', options: [] }; curIndent = ind; inputs.push(cur); optionsMode = false; }
      continue;
    }
    const li = /^\s*-\s*(.*)$/.exec(l);
    if (optionsMode && li) { cur.options.push(clean(li[1])); continue; }
    if (m) {
      const k = m[1];
      const v = clean(m[2]);
      optionsMode = false;
      if (k === 'options') {
        if (v.startsWith('[')) cur.options = v.slice(1, -1).split(',').map((x) => clean(x)).filter(Boolean);
        else optionsMode = true;
      } else if (k === 'required') cur.required = v === 'true';
      else if (k === 'type') cur.type = v;
      else if (k === 'default') cur.default = v;
      else if (k === 'description') cur.description = v;
    }
  }
  return { hasDispatch, inputs };
}

module.exports = {
  parseStatusV2, parseRemoteUrl, looksLikeGitHub, parseLog, LOG_FORMAT, parseDecorations,
  parseRefs, REF_FORMAT, parseDiff, buildPatch, parseConflicts, resolveConflicts, parseDispatchInputs,
};
