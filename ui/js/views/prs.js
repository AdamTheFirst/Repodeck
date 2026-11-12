// Pull requests: list, detail (conversation, files with inline review, commits, checks), create, merge.
import { h, mount, icon, btn, iconBtn, act, menuAt, menuBelow, confirmDanger, form, modal, banner, ago, fmtDate, markdown, statusBadge, showError, debounce, copyText } from '../dom.js';
import { rpc } from '../api.js';
import { prefs, store } from '../store.js';
import { navigate } from '../router.js';
import { createDiffView } from '../diffview.js';
import { switchTo } from '../repoview.js';

export function render(view, r, sub) {
  if (!r.slug || !r.slug.github) return unavailable(view, r);
  if (sub === 'new') return createPr(view, r);
  if (sub && /^\d+$/.test(sub)) return detail(view, r, +sub);
  return list(view, r);
}

export function unavailable(view, r, what = 'Pull requests') {
  mount(view, h('div', { class: 'empty' }, h('h3', null, `${what} are not available for this repository`),
    h('div', null, !r.slug ? 'It has no remote. Add a remote that points to GitHub in Branches & tags → Remotes.' : `Its remote host "${r.slug.host}" does not look like GitHub.`)));
  return null;
}

function ghErrorView(e, r) {
  const noAccess = e.kind === 'no-access';
  return h('div', { class: 'empty' },
    h('h3', null, noAccess ? 'GitHub says this repository does not exist or is not visible to your account' : 'Could not load from GitHub'),
    h('div', { class: 'errbox', style: { textAlign: 'left', margin: '10px auto', maxWidth: '720px' } }, e.message),
    noAccess ? h('div', null, 'If you have several GitHub accounts, pick the right one for ', h('strong', null, r.slug.owner), ' in ', h('a', { onclick: () => navigate('#/settings') }, 'Settings → GitHub accounts'), ', or sign in with "gh auth login".') : null);
}

// ---------------- list ----------------
const FILTERS = [['all', 'Open'], ['mine', 'Created by me'], ['review', 'Review requested'], ['assigned', 'Assigned to me'], ['merged', 'Merged'], ['closed', 'Closed']];

function list(view, r) {
  let filter = prefs.get('prFilter', 'all');
  let search = '';
  let label = ''; let author = ''; let base = '';
  const bar = h('div', { class: 'diff-toolbar' });
  const body = h('div', { class: 'pane-scroll' });
  mount(view, h('div', { class: 'pane', style: { flex: 1 } }, bar, body));
  const searchIn = h('input', { type: 'search', placeholder: 'Search pull requests', style: { width: '200px' } });
  const labelIn = h('input', { type: 'search', placeholder: 'Label', style: { width: '100px' } });
  const authorIn = h('input', { type: 'search', placeholder: 'Author', style: { width: '100px' } });
  const baseIn = h('input', { type: 'search', placeholder: 'Base branch', style: { width: '110px' } });
  const reload = debounce(() => { search = searchIn.value.trim(); label = labelIn.value.trim(); author = authorIn.value.trim(); base = baseIn.value.trim(); load(); }, 400);
  [searchIn, labelIn, authorIn, baseIn].forEach((i) => i.addEventListener('input', reload));
  function renderBar() {
    mount(bar, h('div', { class: 'pill-tabs' }, FILTERS.map(([k, l]) => h('button', { class: filter === k ? 'active' : '', onclick: () => { filter = k; prefs.set('prFilter', k); renderBar(); load(); } }, l))),
      searchIn, labelIn, authorIn, baseIn, h('span', { class: 'spacer' }),
      iconBtn('refresh', 'Refresh', () => load()),
      btn('New pull request', () => navigate(`#/repo/${r.id}/prs/new`), { cls: 'primary small', iconName: 'plus' }));
  }
  async function load() {
    mount(body, h('div', { class: 'progress' }));
    try {
      const prs = await rpc('pr.list', { id: r.id, filter, search, label, author, base });
      const cur = r.summary && r.summary.branch;
      mount(body, prs.length ? prs.map((p) => h('div', { class: 'list-row', onclick: () => navigate(`#/repo/${r.id}/prs/${p.number}`) },
        icon('pr'),
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('span', { class: 't ellipsis' }, p.title), p.isDraft ? h('span', { class: 'badge' }, 'draft') : null,
            p.headRefName === cur && !p.isCrossRepository ? h('span', { class: 'badge accent' }, 'your current branch') : null,
            (p.labels || []).slice(0, 4).map((l) => h('span', { class: 'badge', style: { borderColor: `#${l.color}` } }, l.name))),
          h('div', { class: 'sub' }, `#${p.number} · ${p.author ? p.author.login : ''} · ${p.baseRefName} ← ${p.headRefName} · updated ${ago(p.updatedAt)}`)),
        p.reviewDecision ? h('span', { class: `badge ${p.reviewDecision === 'APPROVED' ? 'ok' : p.reviewDecision === 'CHANGES_REQUESTED' ? 'bad' : ''}` }, p.reviewDecision.replace(/_/g, ' ').toLowerCase()) : null,
        p.checks ? h('span', { class: `badge ${p.checks === 'success' ? 'ok' : p.checks === 'failure' ? 'bad' : 'run'}` }, `checks ${p.checks}`) : null,
        p.state !== 'OPEN' ? h('span', { class: `badge ${p.state === 'MERGED' ? 'accent' : ''}` }, p.state.toLowerCase()) : null))
        : h('div', { class: 'empty' }, 'No pull requests match.'));
    } catch (e) { mount(body, ghErrorView(e, r)); }
  }
  renderBar(); load();
  return null;
}

// ---------------- detail ----------------
function detail(view, r, number) {
  let pr = null;
  let threads = { threads: [], viewed: {}, id: null };
  let draft = { comments: [] };
  let meta = null;
  let tab = prefs.get('prTab', 'conversation');
  let disposed = false;
  const top = h('div', { class: 'repo-head', style: { background: 'var(--panel)' } });
  const tabs = h('div', { class: 'tabs' });
  const body = h('div', { class: 'view' });
  mount(view, h('div', { class: 'pane', style: { flex: 1 } }, top, tabs, body));

  async function load(full = true) {
    try {
      const [p, t, d] = await Promise.all([rpc('pr.view', { id: r.id, number }), rpc('pr.threads', { id: r.id, number }).catch(() => threads), rpc('pr.draft.get', { id: r.id, number })]);
      if (disposed) return;
      pr = p; threads = t; draft = d;
      if (!meta) meta = await rpc('gh.meta', { id: r.id }).catch(() => null);
      renderTop(); renderTabs();
      if (full) renderBody();
    } catch (e) { mount(body, ghErrorView(e, r)); }
  }

  function renderTop() {
    const stateCls = pr.state === 'OPEN' ? (pr.isDraft ? '' : 'ok') : pr.state === 'MERGED' ? 'accent' : 'bad';
    mount(top,
      iconBtn('back', 'Back to the list', () => navigate(`#/repo/${r.id}/prs`)),
      h('div', { class: 'col grow', style: { gap: '2px' } },
        h('div', { class: 'row' }, h('span', { class: 'title ellipsis' }, pr.title), h('span', { class: 'muted' }, `#${pr.number}`)),
        h('div', { class: 'row', style: { fontSize: '12px' } },
          h('span', { class: `badge ${stateCls}` }, pr.isDraft && pr.state === 'OPEN' ? 'draft' : pr.state.toLowerCase()),
          h('span', { class: 'muted' }, `${pr.author ? pr.author.login : ''} wants to merge ${pr.commits.length} commit(s) into `), h('code', null, pr.baseRefName), h('span', { class: 'muted' }, 'from'), h('code', null, pr.isCrossRepository ? `${pr.headRepositoryOwner.login}:${pr.headRefName}` : pr.headRefName),
          h('span', { class: 'faint' }, `+${pr.additions} −${pr.deletions}`))),
      pr.state === 'OPEN' ? btn(pr.localBranch && r.summary && r.summary.branch === pr.localBranch ? 'Checked out' : 'Check out', () => checkout(), { cls: 'small', iconName: 'branch', disabled: pr.localBranch && r.summary && r.summary.branch === pr.localBranch }) : null,
      btn('Edit', () => editPr(), { cls: 'small', iconName: 'edit' }),
      btn('', (e) => menuBelow(e.currentTarget, moreMenu()), { cls: 'small icon', iconName: 'more', title: 'More' }),
      btn('GitHub', () => rpc('open.url', { url: pr.url }), { cls: 'small', iconName: 'external' }));
  }
  function moreMenu() {
    return [
      pr.state === 'OPEN' ? { label: pr.isDraft ? 'Mark ready for review' : 'Convert to draft', icon: 'eye', action: () => act(() => rpc('pr.ready', { id: r.id, number, ready: pr.isDraft }), { ok: pr.isDraft ? 'Ready for review' : 'Converted to draft' }).then(() => load()) } : null,
      pr.state === 'OPEN' ? { label: 'Update branch from base', icon: 'merge', action: () => act(() => rpc('pr.updateBranch', { id: r.id, number }), { ok: 'Branch update requested' }).then(() => load()) } : null,
      pr.state === 'OPEN' ? { label: 'Close pull request…', icon: 'x', danger: true, action: async () => { if (await confirmDanger({ title: 'Close pull request?', message: `Close #${number} without merging. It can be reopened later.`, confirmLabel: 'Close' })) act(() => rpc('pr.close', { id: r.id, number }), { ok: 'Closed' }).then(() => load()); } } : null,
      pr.state === 'CLOSED' ? { label: 'Reopen', icon: 'undo', action: () => act(() => rpc('pr.reopen', { id: r.id, number }), { ok: 'Reopened' }).then(() => load()) } : null,
      { label: 'Copy link', icon: 'copy', action: () => copyText(pr.url) },
    ];
  }
  function renderTabs() {
    const failing = pr.checks.filter((c) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'error'].includes(c.conclusion)).length;
    mount(tabs, [['conversation', 'Conversation', (pr.comments || []).length + threads.threads.length], ['files', 'Files changed', pr.files.length], ['commits', 'Commits', pr.commits.length], ['checks', 'Checks', pr.checks.length]]
      .map(([k, l, n]) => h('button', { class: `tab ${tab === k ? 'active' : ''}`, onclick: () => { tab = k; prefs.set('prTab', k); renderTabs(); renderBody(); } }, l, h('span', { class: 'badge' }, n),
        k === 'checks' && failing ? h('span', { class: 'dot bad' }) : null, k === 'files' && draft.comments.length ? h('span', { class: 'badge accent' }, `${draft.comments.length} pending`) : null)));
  }
  function renderBody() {
    if (tab === 'files') return files();
    if (tab === 'commits') return commits();
    if (tab === 'checks') return checks();
    return conversation();
  }

  // ----- conversation -----
  function conversation() {
    const page = h('div', { class: 'page' });
    const main = h('div', { class: 'grow', style: { minWidth: 0 } });
    const side = h('div', { style: { width: '280px', flex: 'none' }, class: 'col' });
    mount(body, h('div', { class: 'page', style: { padding: 0 } }, h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '18px', padding: '14px 18px' } }, main, side)));
    void page;
    const events = [
      ...(pr.comments || []).map((c) => ({ t: Date.parse(c.createdAt), node: commentNode(c, 'issue') })),
      ...(pr.reviews || []).filter((rv) => rv.body || rv.state !== 'COMMENTED').map((rv) => ({ t: Date.parse(rv.submittedAt || rv.createdAt || 0), node: reviewNode(rv) })),
      ...threads.threads.map((th) => ({ t: Date.parse(th.comments.nodes[0] ? th.comments.nodes[0].createdAt : 0), node: threadNode(th, true) })),
    ].sort((a, b) => a.t - b.t);
    const commentBox = h('textarea', { rows: 4, placeholder: 'Leave a comment (Markdown supported)', style: { width: '100%' } });
    mount(main,
      h('div', { class: 'comment' }, h('div', { class: 'chead' }, h('strong', null, pr.author ? pr.author.login : ''), h('span', { class: 'muted' }, `opened ${ago(pr.createdAt)}`)), h('div', { class: 'cbody' }, markdown(pr.body))),
      events.map((e) => e.node),
      pr.state === 'OPEN' ? mergeBox() : pr.state === 'MERGED' ? h('div', { class: 'info-box', style: { marginBottom: '10px' } }, `Merged ${pr.mergedAt ? ago(pr.mergedAt) : ''}${pr.mergedBy ? ` by ${pr.mergedBy.login}` : ''}${pr.mergeCommit ? ` as ${pr.mergeCommit.oid.slice(0, 8)}` : ''}.`, ' ',
        h('a', { onclick: () => navigate('#/board') }, 'See its workflow runs on the Actions board')) : null,
      h('div', { class: 'col' }, commentBox, h('div', { class: 'row' }, h('span', { class: 'spacer' }),
        btn('Comment', async () => { if (!commentBox.value.trim()) return; const ok = await act(() => rpc('pr.comment', { id: r.id, number, body: commentBox.value }), { ok: 'Comment posted' }); if (ok !== undefined) { commentBox.value = ''; load(); } }, { cls: 'primary' }))));
    // sidebar
    const reviewers = new Map();
    for (const rq of pr.reviewRequests || []) reviewers.set(rq.login || rq.name || rq.slug, { state: 'requested' });
    for (const rv of pr.latestReviews || []) reviewers.set(rv.author.login, { state: rv.state.toLowerCase().replace(/_/g, ' ') });
    mount(side,
      sideBlock('Reviewers', [...reviewers].map(([n, v]) => h('div', { class: 'row' }, h('span', { class: 'grow' }, n), h('span', { class: `badge ${v.state === 'approved' ? 'ok' : v.state === 'changes requested' ? 'bad' : ''}` }, v.state))), () => editPeople('reviewers')),
      sideBlock('Assignees', (pr.assignees || []).map((a) => h('div', null, a.login)), () => editPeople('assignees')),
      sideBlock('Labels', h('div', { class: 'row wrap' }, (pr.labels || []).map((l) => h('span', { class: 'badge', style: { borderColor: `#${l.color}` } }, l.name))), () => editLabels()),
      sideBlock('Milestone', pr.milestone ? pr.milestone.title : h('span', { class: 'faint' }, 'none'), () => editMilestone()),
      sideBlock('Linked issues', (pr.closingIssuesReferences || []).length ? pr.closingIssuesReferences.map((i) => h('div', null, h('a', { onclick: () => navigate(`#/repo/${r.id}/issues/${i.number}`) }, `#${i.number}`), ' ', i.title || '')) : h('span', { class: 'faint' }, 'Add "Closes #123" to the description to link an issue.')));
  }
  function sideBlock(title, content, onEdit) {
    return h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', { class: 'grow' }, title), onEdit && pr.state === 'OPEN' ? iconBtn('edit', `Edit ${title.toLowerCase()}`, onEdit) : null), h('div', { class: 'panel-body col', style: { gap: '4px' } }, content));
  }
  function commentNode(c, kind) {
    const id = c.id; // GraphQL node id from gh pr view; REST id needed for edit/delete:
    const dbId = c.databaseId || (c.url ? +(/(\d+)$/.exec(c.url) || [])[1] : null);
    const mine = c.viewerDidAuthor;
    return h('div', { class: 'comment' },
      h('div', { class: 'chead' }, h('strong', null, c.author ? c.author.login : ''), h('span', { class: 'muted' }, ago(c.createdAt)), h('span', { class: 'spacer' }),
        mine && dbId ? h('a', { onclick: () => editComment(dbId, c.body, kind) }, 'edit') : null, mine && dbId ? h('a', { style: { color: 'var(--bad)' }, onclick: () => deleteComment(dbId, kind) }, 'delete') : null),
      h('div', { class: 'cbody' }, markdown(c.body)));
    void id;
  }
  function reviewNode(rv) {
    const map = { APPROVED: ['ok', 'approved'], CHANGES_REQUESTED: ['bad', 'requested changes'], COMMENTED: ['', 'reviewed'], DISMISSED: ['', 'review dismissed'] };
    const [cls, txt] = map[rv.state] || ['', rv.state.toLowerCase()];
    return h('div', { class: 'comment' }, h('div', { class: 'chead' }, h('strong', null, rv.author ? rv.author.login : ''), h('span', { class: `badge ${cls}` }, txt), h('span', { class: 'muted' }, ago(rv.submittedAt))), rv.body ? h('div', { class: 'cbody' }, markdown(rv.body)) : null);
  }
  function threadNode(th, withPath) {
    const reply = h('textarea', { rows: 2, placeholder: 'Reply…', style: { width: '100%' } });
    const first = th.comments.nodes[0];
    return h('div', { class: `thread ${th.isResolved ? 'resolved' : ''}` },
      h('div', { class: 'chead', style: { display: 'flex', gap: '8px', padding: '6px 10px', background: 'var(--panel-2)', fontSize: '12px', alignItems: 'center' } },
        withPath ? h('a', { class: 'mono', onclick: () => { tab = 'files'; renderTabs(); renderBody(); } }, `${th.path}${th.line ? `:${th.line}` : ''}`) : null,
        th.isOutdated ? h('span', { class: 'badge warn' }, 'outdated') : null, th.isResolved ? h('span', { class: 'badge ok' }, 'resolved') : null, h('span', { class: 'spacer' }),
        h('a', { onclick: () => act(() => rpc('pr.resolveThread', { id: r.id, threadId: th.id, resolved: !th.isResolved }), { ok: th.isResolved ? 'Unresolved' : 'Resolved' }).then(() => load()) }, th.isResolved ? 'Unresolve' : 'Resolve')),
      th.comments.nodes.map((c) => h('div', { style: { padding: '6px 10px', borderTop: '1px solid var(--border)' } },
        h('div', { class: 'row', style: { fontSize: '12px' } }, h('strong', null, c.author ? c.author.login : ''), h('span', { class: 'muted' }, ago(c.createdAt)), h('span', { class: 'spacer' }),
          c.viewerCanUpdate ? h('a', { onclick: () => editComment(c.databaseId, c.body, 'review') }, 'edit') : null,
          c.viewerCanDelete ? h('a', { style: { color: 'var(--bad)' }, onclick: () => deleteComment(c.databaseId, 'review') }, 'delete') : null),
        markdown(c.body))),
      pr.state === 'OPEN' && first ? h('div', { style: { padding: '6px 10px', borderTop: '1px solid var(--border)' }, class: 'col' }, reply,
        h('div', { class: 'row' }, h('span', { class: 'spacer' }), btn('Reply', async () => { if (!reply.value.trim()) return; const ok = await act(() => rpc('pr.reply', { id: r.id, number, commentId: first.databaseId, body: reply.value }), { ok: 'Reply posted' }); if (ok !== undefined) load(); }, { cls: 'small' }))) : null);
  }
  async function editComment(dbId, body, kind) {
    const v = await form({ title: 'Edit comment', fields: [{ name: 'b', label: 'Comment', type: 'textarea', value: body, required: true }], submit: 'Save' });
    if (v) act(() => rpc('pr.editComment', { id: r.id, commentId: dbId, body: v.b, review: kind === 'review' }), { ok: 'Comment updated' }).then(() => load());
  }
  async function deleteComment(dbId, kind) {
    if (await confirmDanger({ title: 'Delete comment?', message: 'The comment is deleted on GitHub.', confirmLabel: 'Delete' })) act(() => rpc('pr.deleteComment', { id: r.id, commentId: dbId, review: kind === 'review' }), { ok: 'Comment deleted' }).then(() => load());
  }

  // ----- merge box -----
  function mergeBox() {
    const allowed = meta ? [['merge', meta.allow_merge_commit, 'Create a merge commit'], ['squash', meta.allow_squash_merge, 'Squash and merge'], ['rebase', meta.allow_rebase_merge, 'Rebase and merge']].filter((x) => x[1] !== false) : [['merge', true, 'Create a merge commit'], ['squash', true, 'Squash and merge'], ['rebase', true, 'Rebase and merge']];
    let method = prefs.get(`mergeMethod.${r.id}`, allowed[0] ? allowed[0][0] : 'merge');
    if (!allowed.some((a) => a[0] === method)) method = allowed[0][0];
    const conflicts = pr.mergeable === 'CONFLICTING';
    const blocked = pr.mergeStateStatus === 'BLOCKED';
    const behind = pr.mergeStateStatus === 'BEHIND';
    const cs = pr.checksState;
    const status = [];
    if (pr.isDraft) status.push(h('div', { class: 'warn-box' }, 'This is a draft. Mark it ready for review before merging.'));
    if (conflicts) status.push(h('div', { class: 'danger-box' }, `This branch has conflicts with ${pr.baseRefName}. Check it out, merge ${pr.baseRefName} into it and resolve them, or use "Update branch" if GitHub can do it.`));
    if (behind) status.push(h('div', { class: 'warn-box' }, `The branch is behind ${pr.baseRefName} and the repository requires it to be up to date. `, h('a', { onclick: () => act(() => rpc('pr.updateBranch', { id: r.id, number }), { ok: 'Update requested' }).then(() => load()) }, 'Update branch')));
    if (blocked) status.push(h('div', { class: 'warn-box' }, 'Merging is blocked by branch protection (required reviews or checks). You can enable auto-merge so it merges once the requirements are met.'));
    if (cs) status.push(h('div', { class: cs === 'success' ? 'info-box' : cs === 'failure' ? 'danger-box' : 'warn-box' }, cs === 'success' ? 'All checks passed.' : cs === 'failure' ? 'Some checks failed. ' : 'Checks are still running. ', cs !== 'success' ? h('a', { onclick: () => { tab = 'checks'; renderTabs(); renderBody(); } }, 'View checks') : null));
    if (pr.autoMergeRequest) status.push(h('div', { class: 'info-box' }, `Auto-merge (${(pr.autoMergeRequest.mergeMethod || '').toLowerCase()}) is enabled. `, h('a', { onclick: () => act(() => rpc('pr.disableAuto', { id: r.id, number }), { ok: 'Auto-merge disabled' }).then(() => load()) }, 'Disable')));
    const subj = h('input', { type: 'text', style: { width: '100%' }, value: method === 'squash' ? `${pr.title} (#${pr.number})` : `Merge pull request #${pr.number} from ${pr.headRepositoryOwner ? pr.headRepositoryOwner.login : ''}/${pr.headRefName}` });
    const msgBody = h('textarea', { rows: 3, style: { width: '100%' } }, method === 'squash' ? pr.commits.map((c) => `* ${c.messageHeadline}`).join('\n') : pr.title);
    const delBranch = h('input', { type: 'checkbox', checked: meta ? !!meta.delete_branch_on_merge || prefs.get('deleteAfterMerge', true) : prefs.get('deleteAfterMerge', true), disabled: pr.isCrossRepository });
    const sel = h('select', { onchange: (e) => { prefs.set(`mergeMethod.${r.id}`, e.target.value); renderBody(); } }, allowed.map(([k, , l]) => h('option', { value: k, selected: k === method }, l)));
    return h('div', { class: 'panel', style: { marginBottom: '12px' } },
      h('div', { class: 'panel-head' }, icon('merge'), h('h3', { class: 'grow' }, 'Merge'), sel),
      h('div', { class: 'panel-body col' }, status,
        method !== 'rebase' ? h('label', { class: 'field' }, h('span', null, 'Commit title'), subj) : null,
        method !== 'rebase' ? h('label', { class: 'field' }, h('span', null, 'Commit message'), msgBody) : null,
        h('label', { class: 'check' }, delBranch, `Delete branch ${pr.headRefName} on GitHub after merging`, pr.isCrossRepository ? h('span', { class: 'faint' }, ' (fork: not possible)') : null),
        h('div', { class: 'row' }, h('span', { class: 'spacer' }),
          meta && meta.allow_auto_merge !== false && !pr.autoMergeRequest ? btn('Enable auto-merge', () => doMerge(true), { cls: '', title: 'Merge automatically when requirements are met' }) : null,
          btn('Merge pull request', () => doMerge(false), { cls: 'primary', disabled: conflicts || pr.isDraft }))));
    async function doMerge(auto) {
      prefs.set('deleteAfterMerge', delBranch.checked);
      const ok = await confirmDanger({
        title: auto ? 'Enable auto-merge?' : `Merge #${number}?`,
        message: `${auto ? 'When all requirements are met, GitHub will merge' : 'Merge'} ${pr.commits.length} commit(s) from ${pr.headRefName} into ${pr.baseRefName} using "${allowed.find((a) => a[0] === method)[2]}". Only the commits you see here (head ${pr.headRefOid.slice(0, 8)}) will be merged.${delBranch.checked && !auto ? ` The branch ${pr.headRefName} will be deleted on GitHub.` : ''}`,
        confirmLabel: auto ? 'Enable auto-merge' : 'Merge', danger: false,
      });
      if (!ok) return;
      try {
        const res = await rpc('pr.merge', { id: r.id, number, method, subject: subj.value, body: msgBody.value, auto, headOid: pr.headRefOid, deleteBranch: delBranch.checked, headRef: pr.headRefName, crossRepo: pr.isCrossRepository });
        banner({ level: 'success', title: auto ? 'Auto-merge enabled' : `Merged #${number}`, body: auto ? null : `Tracking the workflow runs on ${pr.baseRefName}. You will get a notification when they finish.${res.deleteError ? `\nBranch not deleted: ${res.deleteError}` : ''}`, timeout: 8000, actions: auto ? [] : [{ label: 'Open Actions board', action: () => navigate('#/board') }] });
        load();
      } catch (e) { showError(e, 'Merge failed'); }
    }
  }

  // ----- files with inline review -----
  function files() {
    const fileList = h('div', { class: 'pane-scroll', style: { width: '300px', flex: 'none', borderRight: '1px solid var(--border)', background: 'var(--panel)' } });
    const reviewBar = h('div', { class: 'selection-bar' });
    const diff = createDiffView({
      alwaysBanner: true,
      onComment: pr.state === 'OPEN' ? (info) => addComment(info) : null,
      threadsFor: (path, side, line) => {
        const out = [];
        for (const th of threads.threads) if (th.path === path && th.line === line && (th.diffSide || 'RIGHT') === side) out.push(threadNode(th, false));
        for (const c of draft.comments) if (c.path === path && c.line === line && c.side === side) out.push(pendingNode(c));
        return out;
      },
      headerFor: (f) => [
        draft.comments.filter((c) => c.path === f.path).length ? h('span', { class: 'badge accent' }, `${draft.comments.filter((c) => c.path === f.path).length} pending`) : null,
        threads.id ? h('label', { class: 'check', style: { fontSize: '12px' } }, h('input', { type: 'checkbox', checked: threads.viewed[f.path] === 'VIEWED', onchange: (e) => setViewed(f.path, e.target.checked) }), 'Viewed') : null,
      ],
      onFull: () => loadDiff(true),
    });
    mount(body, h('div', { class: 'pane', style: { flex: 1 } }, reviewBar, h('div', { class: 'split' }, fileList, h('div', { class: 'right' }, diff.el))));
    function renderReviewBar() {
      mount(reviewBar, h('span', null, draft.comments.length ? h('strong', null, `${draft.comments.length} pending comment(s)`) : 'Click + next to a line (or select lines) to comment. Comments are collected into one review.'),
        h('span', { class: 'spacer' }), pr.state === 'OPEN' ? btn('Submit review…', () => submitReview(), { cls: 'primary small' }) : null);
    }
    renderReviewBar();
    mount(fileList, pr.files.map((f) => h('div', { class: 'file-row', onclick: () => { const el = [...diff.el.querySelectorAll('.file-banner')].find((b) => b.textContent.includes(f.path)); if (el) el.scrollIntoView({ block: 'start' }); } },
      h('input', { type: 'checkbox', checked: threads.viewed[f.path] === 'VIEWED', title: 'Viewed', onclick: (e) => e.stopPropagation(), onchange: (e) => setViewed(f.path, e.target.checked) }),
      h('span', { class: 'name', title: f.path }, f.path), h('span', { class: 'faint', style: { fontSize: '11px' } }, h('span', { style: { color: 'var(--ok)' } }, `+${f.additions}`), ' ', h('span', { style: { color: 'var(--bad)' } }, `−${f.deletions}`)))));
    {
      const approvals = (pr.latestReviews || []).filter((x) => x.state === 'APPROVED').length;
      const changes = (pr.latestReviews || []).filter((x) => x.state === 'CHANGES_REQUESTED').length;
      const item = (cls, text, action) => h('div', { class: 'row' }, h('span', { class: `dot ${cls}` }), h('span', { class: 'grow' }, text), action || null);
      const goChecks = h('a', { onclick: () => { tab = 'checks'; renderTabs(); renderBody(); } }, 'Why?');
      fileList.append(h('div', { style: { margin: '14px 14px 0', paddingTop: '14px', borderTop: '1px solid var(--border)' }, class: 'col' },
        h('span', { class: 'eyebrow' }, 'Merge readiness'),
        changes ? item('bad', `${changes} change request(s)`) : approvals ? item('ok', `${approvals} approval(s)`) : item('', 'No review yet'),
        pr.checksState === 'failure' ? item('bad', 'Checks failing', goChecks) : pr.checksState === 'pending' ? item('run', 'Checks running') : pr.checksState === 'success' ? item('ok', 'Checks passing') : item('', 'No checks'),
        pr.mergeable === 'CONFLICTING' ? item('bad', `Conflicts with ${pr.baseRefName}`) : pr.mergeStateStatus === 'BEHIND' ? item('warn', `Behind ${pr.baseRefName}`, h('a', { onclick: () => act(() => rpc('pr.updateBranch', { id: r.id, number }), { ok: 'Update requested' }).then(() => load()) }, 'Update')) : item('ok', `Up to date with ${pr.baseRefName}`)));
    }
    async function loadDiff(full) {
      try { diff.set(await rpc('pr.diff', { id: r.id, number, full })); } catch (e) { banner({ level: 'error', title: 'Could not load the diff', body: e.message }); }
    }
    loadDiff(false);
    async function addComment(info) {
      const fields = [{ name: 'body', label: 'Comment (Markdown)', type: 'textarea', rows: 5 }];
      if (info.text != null) fields.push({ name: 'suggestion', label: 'Suggested change (optional): edit the lines below to propose exact replacement code; leave unchanged for a plain comment', type: 'textarea', rows: Math.min(12, info.text.split('\n').length + 1), value: info.text });
      const v = await form({
        title: `Comment on ${info.path}:${info.startLine && info.startLine !== info.line ? `${info.startLine}-` : ''}${info.line}`, wide: info.text != null, fields, submit: 'Add to review',
      });
      if (!v) return;
      let body = v.body.trim();
      if (info.text != null && v.suggestion !== info.text) body = `${body}${body ? '\n\n' : ''}\`\`\`suggestion\n${v.suggestion}\n\`\`\``;
      if (!body) { banner({ level: 'warn', title: 'Write a comment or change the suggested lines', timeout: 3000 }); return; }
      const { text: _t, ...where } = info;
      draft = await rpc('pr.draft.add', { id: r.id, number, ...where, body });
      diff.rerender(); renderReviewBar(); renderTabs();
    }
    function pendingNode(c) {
      return h('div', { class: 'thread' }, h('div', { class: 'row', style: { padding: '6px 10px', background: 'var(--accent-soft)', fontSize: '12px' } }, h('strong', null, 'Pending'), h('span', { class: 'spacer' }),
        h('a', { onclick: async () => { const v = await form({ title: 'Edit pending comment', fields: [{ name: 'b', label: 'Comment', type: 'textarea', value: c.body, required: true }], submit: 'Save' }); if (v) { draft = await rpc('pr.draft.update', { id: r.id, number, commentId: c.id, body: v.b }); diff.rerender(); } } }, 'edit'),
        h('a', { style: { color: 'var(--bad)' }, onclick: async () => { draft = await rpc('pr.draft.remove', { id: r.id, number, commentId: c.id }); diff.rerender(); renderReviewBar(); renderTabs(); } }, 'remove')),
      h('div', { style: { padding: '6px 10px' } }, markdown(c.body)));
    }
    async function setViewed(path, viewed) {
      await act(() => rpc('pr.viewed', { id: r.id, prId: threads.id, path, viewed }));
      threads.viewed[path] = viewed ? 'VIEWED' : 'UNVIEWED';
    }
  }

  async function submitReview() {
    const v = await form({
      title: 'Submit review',
      intro: h('div', { class: 'muted' }, draft.comments.length ? `${draft.comments.length} inline comment(s) will be included.` : 'No inline comments.'),
      fields: [
        { name: 'event', label: 'Review', type: 'select', value: 'COMMENT', options: [{ value: 'COMMENT', label: 'Comment' }, { value: 'APPROVE', label: 'Approve' }, { value: 'REQUEST_CHANGES', label: 'Request changes' }] },
        { name: 'body', label: 'Summary (optional for Approve)', type: 'textarea', rows: 5 },
      ],
      submit: 'Submit review',
    });
    if (!v) return;
    if (v.event !== 'APPROVE' && !v.body.trim() && !draft.comments.length) { banner({ level: 'warn', title: 'Write a summary or add inline comments first', timeout: 3500 }); return; }
    const ok = await act(() => rpc('pr.review', { id: r.id, number, event: v.event, body: v.body, commitId: pr.headRefOid }), { ok: 'Review submitted' });
    if (ok !== undefined) load();
  }

  // ----- commits & checks -----
  function commits() {
    mount(body, h('div', { class: 'page' }, h('div', { class: 'panel' }, pr.commits.map((c) => h('div', { class: 'list-row', onclick: () => navigate(`#/repo/${r.id}/graph/${c.oid}`) },
      h('span', { class: 'mono muted' }, c.oid.slice(0, 8)), h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, c.messageHeadline), h('div', { class: 'sub' }, `${(c.authors || []).map((a) => a.login || a.name).join(', ')} · ${ago(c.committedDate)}`)))))));
  }
  function checks() {
    const failed = pr.checks.filter((c) => ['failure', 'timed_out', 'cancelled', 'startup_failure'].includes(c.conclusion) && c.runId);
    const runIds = [...new Set(failed.map((c) => c.runId))];
    mount(body, h('div', { class: 'page' },
      h('div', { class: 'row', style: { marginBottom: '10px' } }, h('strong', { class: 'grow' }, `${pr.checks.length} checks`),
        runIds.length ? btn(`Re-run failed (${runIds.length} run${runIds.length > 1 ? 's' : ''})`, async () => { for (const id of runIds) await act(() => rpc('run.rerun', { id: r.id, runId: id, failed: true }), { ok: `Re-running ${id}` }); load(); }, { cls: 'small' }) : null,
        iconBtn('refresh', 'Refresh', () => load())),
      pr.checks.length ? h('div', { class: 'panel' }, pr.checks.map((c) => h('div', { class: 'run-row', onclick: () => (c.runId ? navigate(`#/repo/${r.id}/actions/run/${c.runId}`) : c.url && rpc('open.url', { url: c.url })) },
        statusBadge(c.status === 'completed' || c.conclusion ? 'completed' : c.status, c.conclusion), h('div', { class: 'grow' }, h('div', null, c.name), h('div', { class: 'sub' }, c.workflow || '')),
        c.startedAt && c.completedAt ? h('span', { class: 'faint' }, `${Math.round((Date.parse(c.completedAt) - Date.parse(c.startedAt)) / 1000)}s`) : null,
        c.url ? iconBtn('external', 'Open on GitHub', () => rpc('open.url', { url: c.url })) : null))) : h('div', { class: 'empty' }, 'No checks reported.')));
  }

  // ----- edits -----
  async function checkout() {
    const s = r.summary || {};
    let mode = 'carry';
    if (s.dirty) {
      const { modal: m } = await import('../dom.js');
      const choice = await m({ title: 'Uncommitted changes', body: h('div', null, `You have ${s.dirty} uncommitted change(s). Stash them before checking out the pull request?`), actions: [{ label: 'Cancel', value: null }, { label: 'Bring changes', value: 'carry' }, { label: 'Stash and check out', cls: 'primary', default: true, value: 'stash' }] });
      if (!choice) return;
      mode = choice;
    }
    const res = await act(() => rpc('pr.checkout', { id: r.id, number, mode }), { ok: (x) => `Checked out ${x.branch}` });
    if (res && res.note) banner({ level: 'info', title: 'Pull request from a fork', body: res.note, timeout: 10000 });
    load();
  }
  async function editPr() {
    const v = await form({ title: `Edit #${number}`, wide: true, fields: [
      { name: 'title', label: 'Title', value: pr.title, required: true },
      { name: 'body', label: 'Description (Markdown)', type: 'textarea', rows: 12, value: pr.body },
      { name: 'base', label: 'Base branch', value: pr.baseRefName, required: true },
    ], submit: 'Save' });
    if (!v) return;
    await act(() => rpc('pr.edit', { id: r.id, number, title: v.title, body: v.body, base: v.base !== pr.baseRefName ? v.base : undefined }), { ok: 'Pull request updated' });
    load();
  }
  async function editPeople(kind) {
    const current = kind === 'reviewers' ? (pr.reviewRequests || []).map((x) => x.login).filter(Boolean) : (pr.assignees || []).map((a) => a.login);
    const people = await rpc('gh.collaborators', { id: r.id }).catch(() => []);
    const boxes = people.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: p, checked: current.includes(p) }), p));
    const extra = h('input', { type: 'text', placeholder: 'Other logins, comma separated', style: { width: '100%' } });
    const v = await modal({ title: `Edit ${kind}`, body: h('div', { class: 'col' }, people.length ? h('div', { class: 'col', style: { maxHeight: '300px', overflow: 'auto' } }, boxes) : h('div', { class: 'faint' }, 'Could not list collaborators; type logins below.'), extra),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', default: true, value: () => [...boxes.filter((b) => b.firstChild.checked).map((b) => b.firstChild.value), ...extra.value.split(',').map((x) => x.trim()).filter(Boolean)] }] });
    if (!v) return;
    const add = v.filter((x) => !current.includes(x)); const remove = current.filter((x) => !v.includes(x));
    await act(() => rpc('pr.edit', { id: r.id, number, ...(kind === 'reviewers' ? { addReviewers: add, removeReviewers: remove } : { addAssignees: add, removeAssignees: remove }) }), { ok: 'Updated' });
    load();
  }
  async function editLabels() {
    const all = await rpc('gh.labels', { id: r.id }).catch(() => []);
    const current = (pr.labels || []).map((l) => l.name);
    const boxes = all.map((l) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: l.name, checked: current.includes(l.name) }), h('span', { class: 'badge', style: { borderColor: `#${l.color}` } }, l.name)));
    const v = await modal({ title: 'Labels', body: h('div', { class: 'col', style: { maxHeight: '360px', overflow: 'auto' } }, boxes.length ? boxes : h('div', { class: 'faint' }, 'This repository has no labels.')),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', default: true, value: () => boxes.filter((b) => b.firstChild.checked).map((b) => b.firstChild.value) }] });
    if (!v) return;
    await act(() => rpc('pr.edit', { id: r.id, number, addLabels: v.filter((x) => !current.includes(x)), removeLabels: current.filter((x) => !v.includes(x)) }), { ok: 'Labels updated' });
    load();
  }
  async function editMilestone() {
    const ms = await rpc('gh.milestones', { id: r.id }).catch(() => []);
    const v = await form({ title: 'Milestone', fields: [{ name: 'm', label: 'Milestone', type: 'select', value: pr.milestone ? pr.milestone.title : '', options: [{ value: '', label: 'None' }, ...ms.map((m) => ({ value: m.title, label: m.title }))] }], submit: 'Save' });
    if (!v) return;
    await act(() => rpc('pr.edit', { id: r.id, number, milestone: v.m || null }), { ok: 'Milestone updated' });
    load();
  }

  load();
  return { dispose() { disposed = true; } };
}

// ---------------- create ----------------
function createPr(view, r) {
  const page = h('div', { class: 'page', style: { maxWidth: '900px' } });
  mount(view, page);
  mount(page, h('div', { class: 'skeleton' }, 'Preparing…'));
  (async () => {
    let pre; let refs; let labels; let people;
    try {
      [pre, refs, labels, people] = await Promise.all([rpc('pr.prefill', { id: r.id }), rpc('repo.refs', { id: r.id }), rpc('gh.labels', { id: r.id }).catch(() => []), rpc('gh.collaborators', { id: r.id }).catch(() => [])]);
    } catch (e) { mount(page, ghErrorView(e, r)); return; }
    if (!pre.head) { mount(page, h('div', { class: 'empty' }, 'Switch to a branch first (HEAD is detached).')); return; }
    if (pre.head === pre.base) { mount(page, h('div', { class: 'empty' }, h('h3', null, `You are on ${pre.base}, the base branch`), h('div', null, 'Create a branch for your change first (branch button at the top).'))); return; }
    const remote = r.slug.remote || 'origin';
    const bases = [...new Set([pre.base, ...refs.remote.filter((b) => b.name.startsWith(`${remote}/`)).map((b) => b.name.slice(remote.length + 1))])].filter((b) => b && b !== 'HEAD' && b !== pre.head);
    const base = h('select', null, bases.map((b) => h('option', { value: b, selected: b === pre.base }, b)));
    const title = h('input', { type: 'text', value: pre.title, style: { width: '100%' } });
    const bodyIn = h('textarea', { rows: 14, style: { width: '100%' } }, pre.body || '');
    const preview = h('div', { class: 'panel panel-body hidden', style: { minHeight: '200px' } });
    const draft = h('input', { type: 'checkbox' });
    const pushFirst = h('input', { type: 'checkbox', checked: pre.needsPush });
    const reviewerBoxes = people.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: p }), p));
    const assignMe = h('input', { type: 'checkbox' });
    const labelBoxes = labels.map((l) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: l.name }), h('span', { class: 'badge', style: { borderColor: `#${l.color}` } }, l.name)));
    const tabsEl = h('div', { class: 'pill-tabs' });
    const setTab = (t) => { mount(tabsEl, h('button', { class: t === 'write' ? 'active' : '', onclick: () => setTab('write') }, 'Write'), h('button', { class: t === 'preview' ? 'active' : '', onclick: () => setTab('preview') }, 'Preview')); bodyIn.classList.toggle('hidden', t !== 'write'); preview.classList.toggle('hidden', t === 'write'); if (t === 'preview') mount(preview, markdown(bodyIn.value)); };
    setTab('write');
    mount(page,
      h('h2', { style: { marginBottom: '12px' } }, 'New pull request'),
      h('div', { class: 'row', style: { marginBottom: '10px' } }, h('span', null, 'Merge'), h('code', null, pre.head), h('span', null, 'into'), base,
        h('span', { class: 'muted' }, `${pre.commits.length} commit(s)`)),
      pre.needsPush ? h('label', { class: 'check warn-box', style: { marginBottom: '10px' } }, pushFirst, pre.upstream ? `Push ${pre.ahead} local commit(s) first` : `Publish ${pre.head} to ${remote} first (required)`) : null,
      h('label', { class: 'field' }, h('span', null, 'Title'), title),
      h('div', { class: 'row', style: { margin: '10px 0 4px' } }, h('span', { class: 'muted grow' }, 'Description'), tabsEl),
      bodyIn, preview,
      h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '24px', marginTop: '12px' } },
        h('div', { class: 'col grow' }, h('strong', null, 'Reviewers'), reviewerBoxes.length ? h('div', { class: 'col', style: { maxHeight: '160px', overflow: 'auto' } }, reviewerBoxes) : h('span', { class: 'faint' }, 'No collaborators found')),
        h('div', { class: 'col grow' }, h('strong', null, 'Labels'), labelBoxes.length ? h('div', { class: 'col', style: { maxHeight: '160px', overflow: 'auto' } }, labelBoxes) : h('span', { class: 'faint' }, 'No labels')),
        h('div', { class: 'col' }, h('strong', null, 'Options'), h('label', { class: 'check' }, draft, 'Create as draft'), h('label', { class: 'check' }, assignMe, 'Assign to me'))),
      h('div', { class: 'row', style: { marginTop: '16px' } }, h('span', { class: 'spacer' }), btn('Cancel', () => navigate(`#/repo/${r.id}/prs`)),
        btn('Create pull request', async (e) => {
          if (!title.value.trim()) { title.focus(); return; }
          if (!pre.upstream && !pushFirst.checked) { banner({ level: 'warn', title: 'The branch must be published before creating a pull request', timeout: 4000 }); return; }
          e.currentTarget.disabled = true;
          try {
            const res = await rpc('pr.create', { id: r.id, base: base.value, head: pre.head, title: title.value.trim(), body: bodyIn.value, draft: draft.checked, pushFirst: pushFirst.checked,
              reviewers: reviewerBoxes.filter((b) => b.firstChild.checked).map((b) => b.firstChild.value), assignees: assignMe.checked ? ['@me'] : [], labels: labelBoxes.filter((b) => b.firstChild.checked).map((b) => b.firstChild.value) });
            banner({ level: 'success', title: `Created pull request #${res.number}`, timeout: 4000 });
            navigate(res.number ? `#/repo/${r.id}/prs/${res.number}` : `#/repo/${r.id}/prs`);
          } catch (err) { showError(err, 'Could not create the pull request'); e.target.disabled = false; }
        }, { cls: 'primary', iconName: 'pr' })),
      pre.commits.length ? h('div', { style: { marginTop: '18px' } }, h('h3', null, 'Commits'), h('div', { class: 'panel' }, pre.commits.map((c) => h('div', { class: 'list-row' }, h('span', { class: 'mono muted' }, c.hash.slice(0, 8)), h('span', { class: 'grow ellipsis' }, c.subject), h('span', { class: 'faint' }, ago(c.commitTime)))))) : null);
    title.focus();
  })();
  return null;
}

export { switchTo, fmtDate, menuAt, store };
