// GitHub operations through the GitHub CLI. Every call passes -R owner/repo explicitly
// (remote URLs may use ssh host aliases gh cannot resolve) and runs from a neutral folder
// so gh never infers a repository or touches a working tree.
'use strict';
const { run, ProcError } = require('./proc');
const { paths } = require('./paths');
const config = require('./config');
const log = require('./log');

const HOST = 'github.com';
const metaCache = new Map();
const tokenCache = new Map(); // login -> { token, at }  (memory only, never logged or persisted)
let accountsCache = null;

async function accounts(force = false) {
  if (accountsCache && !force && Date.now() - accountsCache.at < 60_000) return accountsCache.list;
  let list = [];
  try {
    const r = await run('gh', ['auth', 'status', '--json', 'hosts', '--jq',
      '.hosts | to_entries[] | .key as $h | .value[] | {host:$h, login, active, state, scopes}'],
    { cwd: paths.neutral, quiet: true, timeout: 20_000, okCodes: [0, 1] });
    list = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (/not installed/.test(e.message)) throw e;
    list = [];
  }
  accountsCache = { at: Date.now(), list };
  return list;
}

async function tokenFor(login) {
  const c = tokenCache.get(login);
  if (c && Date.now() - c.at < 10 * 60_000) return c.token;
  const r = await run('gh', ['auth', 'token', '--hostname', HOST, '--user', login], { cwd: paths.neutral, quiet: true, timeout: 15_000 });
  const token = r.stdout.trim();
  tokenCache.set(login, { token, at: Date.now() });
  return token;
}

/** Environment for running gh as a specific account. Active account needs nothing. */
async function envFor(login) {
  if (!login) return {};
  const accs = await accounts();
  const a = accs.find((x) => x.login === login && x.host === HOST);
  if (!a) throw ghError(`The GitHub account "${login}" is not signed in to gh. Run "gh auth login" or change the account for this owner in Settings.`, 'auth');
  if (a.active) return {};
  return { GH_TOKEN: await tokenFor(login), GH_HOST: HOST };
}

function ghError(message, kind) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

function classify(e) {
  const s = `${e.stderr || ''} ${e.message || ''}`;
  if (/not installed/.test(s)) return 'missing';
  if (/Could not resolve to a Repository|HTTP 404|Not Found/i.test(s)) return 'no-access';
  if (/rate limit/i.test(s)) return 'rate-limit';
  if (/gh auth login|authentication|HTTP 401|Bad credentials/i.test(s)) return 'auth';
  if (/timed out|ETIMEDOUT|ENOTFOUND|connect|network/i.test(s)) return 'network';
  return 'error';
}

let rateLimitedUntil = 0;

/** Low-level gh runner. owner selects the account mapped to that owner. */
async function gh(args, { owner, sampleRepo, login, input, timeout = 60_000, repoLabel, quiet = false, okCodes } = {}) {
  if (Date.now() < rateLimitedUntil) throw ghError(`GitHub rate limit reached; waiting until ${new Date(rateLimitedUntil).toLocaleTimeString()}.`, 'rate-limit');
  const acct = login || accountForOwner();
  const env = await envFor(acct);
  try {
    return await run('gh', args, { cwd: paths.neutral, env, input, timeout, repo: repoLabel, quiet, okCodes, redact: env.GH_TOKEN ? [env.GH_TOKEN] : undefined });
  } catch (e) {
    // gh api prints GitHub's error body on stdout; surface its explanation instead of just "HTTP 422".
    try {
      const body = JSON.parse(String(e.stdout || '').trim() || 'null');
      if (body && (body.message || body.errors)) {
        const details = (body.errors || []).map((x) => (typeof x === 'string' ? x : x.message || [x.resource, x.field, x.code].filter(Boolean).join(' '))).filter(Boolean);
        e.message = `${e.message}\nGitHub says: ${[body.message, ...details].filter(Boolean).join('; ')}`;
      }
    } catch {}
    const kind = classify(e);
    if (kind === 'rate-limit') rateLimitedUntil = Date.now() + 5 * 60_000;
    e.kind = kind;
    if (kind === 'no-access' && owner) e.message = `${e.message}\nThe GitHub account "${acct || (await activeLogin()) || 'unknown'}" may not have access to ${owner}. Choose another account for this owner in Settings, or sign in with "gh auth login".`;
    throw e;
  }
}

async function activeLogin() {
  const a = (await accounts()).find((x) => x.active && x.host === HOST);
  return a ? a.login : null;
}

const json = async (args, opts) => {
  const r = await gh(args, opts);
  const t = r.stdout.trim();
  return t ? JSON.parse(t) : null;
};

// ---------------- account isolation ----------------
// Every GitHub call is made as the account whose workspace is open. Other signed-in accounts are never used.
function accountForOwner() { return config.get().currentAccount || null; }
function forgetAccounts() { accountsCache = null; tokenCache.clear(); metaCache.clear(); }

/** Check access for a repo slug: returns { ok, login, kind, message }. */
async function checkAccess(slug) {
  const login = slug.account || accountForOwner();
  try {
    const env = await envFor(login);
    await run('gh', ['api', `repos/${slug.owner}/${slug.repo}`, '--jq', '.full_name'], { cwd: paths.neutral, env, quiet: true, timeout: 20_000 });
    return { ok: true, login: login || (await activeLogin()) };
  } catch (e) {
    return { ok: false, login: login || (await activeLogin()), kind: classify(e), message: (e.stderr || e.message || '').trim().split('\n')[0] };
  }
}

const R = (s) => ['-R', `${s.owner}/${s.repo}`];
const O = (s) => ({ owner: s.owner, login: s.account || undefined, repoLabel: s.label || s.repo });

// ---------------- repository metadata ----------------

async function repoMeta(s, force = false) {
  const key = `${s.owner}/${s.repo}`.toLowerCase();
  const c = metaCache.get(key);
  if (c && !force && Date.now() - c.at < 10 * 60_000) return c.v;
  const v = await json(['api', `repos/${s.owner}/${s.repo}`, '--jq',
    '{default_branch, allow_merge_commit, allow_squash_merge, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge, html_url, private, permissions, node_id}'], { ...O(s), quiet: true });
  metaCache.set(key, { at: Date.now(), v });
  return v;
}

// ---------------- pull requests ----------------

const PR_LIST_FIELDS = 'number,title,author,headRefName,baseRefName,isDraft,state,reviewDecision,updatedAt,createdAt,url,labels,isCrossRepository,headRepositoryOwner,statusCheckRollup,mergedAt,additions,deletions';

async function prList(s, { filter = 'all', search = '', label, author, base, limit = 50 } = {}) {
  const args = ['pr', 'list', ...R(s), '--json', PR_LIST_FIELDS, '-L', String(limit)];
  let q = search || '';
  if (filter === 'mine') args.push('--author', '@me');
  else if (filter === 'assigned') args.push('--assignee', '@me');
  else if (filter === 'review') q = `${q} review-requested:@me`.trim();
  else if (filter === 'merged') args.push('--state', 'merged');
  else if (filter === 'closed') args.push('--state', 'closed');
  else if (filter === 'recent') args.push('--state', 'all');
  if (label) args.push('--label', label);
  if (author && filter !== 'mine') args.push('--author', author);
  if (base) args.push('--base', base);
  if (q) args.push('--search', q);
  const list = await json(args, O(s));
  return (list || []).map(slimPr);
}

function rollupState(rollup) {
  if (!rollup || !rollup.length) return null;
  let pending = 0; let failed = 0; let ok = 0;
  for (const c of rollup) {
    const st = (c.status || c.state || '').toUpperCase();
    const concl = (c.conclusion || c.state || '').toUpperCase();
    if (['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(st) && !c.conclusion) pending++;
    else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(concl)) failed++;
    else ok++;
  }
  return failed ? 'failure' : pending ? 'pending' : 'success';
}

function slimPr(p) {
  return { ...p, checks: rollupState(p.statusCheckRollup), statusCheckRollup: undefined };
}

const PR_VIEW_FIELDS = 'id,number,title,body,state,isDraft,author,headRefName,headRefOid,baseRefName,headRepositoryOwner,headRepository,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,reviews,reviewRequests,assignees,labels,milestone,closingIssuesReferences,commits,files,comments,statusCheckRollup,url,createdAt,updatedAt,mergedAt,mergedBy,mergeCommit,additions,deletions,autoMergeRequest,maintainerCanModify,latestReviews';

async function prView(s, n) {
  const p = await json(['pr', 'view', String(+n), ...R(s), '--json', PR_VIEW_FIELDS], O(s));
  p.checks = (p.statusCheckRollup || []).map(normalizeCheck);
  p.checksState = rollupState(p.statusCheckRollup);
  delete p.statusCheckRollup;
  return p;
}

function normalizeCheck(c) {
  const url = c.detailsUrl || c.targetUrl || '';
  const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url);
  return {
    name: c.name || c.context, workflow: c.workflowName || '', status: (c.status || c.state || '').toLowerCase(),
    conclusion: (c.conclusion || (c.state && c.state !== 'PENDING' ? c.state : '') || '').toLowerCase(),
    url, runId: m ? m[1] : null, jobId: m ? m[2] : null, startedAt: c.startedAt, completedAt: c.completedAt,
  };
}

async function prDiff(s, n) {
  const r = await gh(['pr', 'diff', String(+n), ...R(s), '--color', 'never'], { ...O(s), quiet: true, timeout: 120_000 });
  return r.stdout;
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  id
  reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine startLine diffSide startDiffSide
    comments(first:50){nodes{id databaseId body author{login} createdAt url viewerCanUpdate viewerCanDelete diffHunk replyTo{databaseId}}}}}
  files(first:100){nodes{path viewerViewedState}}
}}}`;

async function prThreads(s, n) {
  const d = await json(['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-F', `owner=${s.owner}`, '-F', `name=${s.repo}`, '-F', `number=${+n}`], { ...O(s), quiet: true });
  const pr = d.data.repository.pullRequest;
  return { id: pr.id, threads: pr.reviewThreads.nodes, viewed: Object.fromEntries(pr.files.nodes.map((f) => [f.path, f.viewerViewedState])) };
}

async function gql(s, query, vars) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars || {})) args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  return json(args, O(s));
}

async function restJson(s, method, endpoint, body) {
  const args = ['api', '-X', method, endpoint];
  if (body) args.push('--input', '-');
  return json(args, { ...O(s), input: body ? JSON.stringify(body) : undefined });
}

async function prCreate(s, { head, base, title, body, draft, reviewers = [], assignees = [], labels = [] }) {
  const args = ['pr', 'create', ...R(s), '--head', head, '--base', base, '--title', title, '--body-file', '-'];
  if (draft) args.push('--draft');
  if (reviewers.length) args.push('--reviewer', reviewers.join(','));
  if (assignees.length) args.push('--assignee', assignees.join(','));
  if (labels.length) args.push('--label', labels.join(','));
  const r = await gh(args, { ...O(s), input: body || '' , timeout: 120_000 });
  const url = r.stdout.trim().split('\n').pop();
  const m = /\/pull\/(\d+)/.exec(url);
  return { url, number: m ? +m[1] : null };
}

async function prComment(s, n, body) { await gh(['pr', 'comment', String(+n), ...R(s), '--body-file', '-'], { ...O(s), input: body }); }
async function editIssueComment(s, id, body) { return restJson(s, 'PATCH', `repos/${s.owner}/${s.repo}/issues/comments/${+id}`, { body }); }
async function deleteIssueComment(s, id) { await gh(['api', '-X', 'DELETE', `repos/${s.owner}/${s.repo}/issues/comments/${+id}`], O(s)); }
async function editReviewComment(s, id, body) { return restJson(s, 'PATCH', `repos/${s.owner}/${s.repo}/pulls/comments/${+id}`, { body }); }
async function deleteReviewComment(s, id) { await gh(['api', '-X', 'DELETE', `repos/${s.owner}/${s.repo}/pulls/comments/${+id}`], O(s)); }
async function replyReviewComment(s, n, id, body) { return restJson(s, 'POST', `repos/${s.owner}/${s.repo}/pulls/${+n}/comments/${+id}/replies`, { body }); }

async function setThreadResolved(s, threadId, resolved) {
  const m = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  return gql(s, `mutation($id:ID!){${m}(input:{threadId:$id}){thread{id isResolved}}}`, { id: threadId });
}

async function setFileViewed(s, prId, path, viewed) {
  const m = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed';
  return gql(s, `mutation($id:ID!,$path:String!){${m}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`, { id: prId, path });
}

/** comments: [{ path, line, side, startLine?, startSide?, body }] */
async function submitReview(s, n, { event, body, comments = [], commitId }) {
  if (!['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(event)) throw new Error('Invalid review type');
  const payload = { event, body: body || '' };
  if (commitId) payload.commit_id = commitId;
  if (comments.length) {
    payload.comments = comments.map((c) => {
      const o = { path: c.path, body: c.body, line: +c.line, side: c.side || 'RIGHT' };
      if (c.startLine && +c.startLine !== +c.line) { o.start_line = +c.startLine; o.start_side = c.startSide || o.side; }
      return o;
    });
  }
  return restJson(s, 'POST', `repos/${s.owner}/${s.repo}/pulls/${+n}/reviews`, payload);
}

async function prEdit(s, n, { title, body, base, addReviewers = [], removeReviewers = [], addAssignees = [], removeAssignees = [], addLabels = [], removeLabels = [], milestone }) {
  const args = ['pr', 'edit', String(+n), ...R(s)];
  if (title != null) args.push('--title', title);
  if (body != null) args.push('--body-file', '-');
  if (base) args.push('--base', base);
  if (addReviewers.length) args.push('--add-reviewer', addReviewers.join(','));
  if (removeReviewers.length) args.push('--remove-reviewer', removeReviewers.join(','));
  if (addAssignees.length) args.push('--add-assignee', addAssignees.join(','));
  if (removeAssignees.length) args.push('--remove-assignee', removeAssignees.join(','));
  if (addLabels.length) args.push('--add-label', addLabels.join(','));
  if (removeLabels.length) args.push('--remove-label', removeLabels.join(','));
  if (milestone !== undefined) { if (milestone) args.push('--milestone', milestone); else args.push('--remove-milestone'); }
  if (args.length === 4) return;
  await gh(args, { ...O(s), input: body != null ? body : undefined });
}

async function prReady(s, n, ready) { await gh(['pr', 'ready', String(+n), ...R(s), ...(ready ? [] : ['--undo'])], O(s)); }
async function prClose(s, n) { await gh(['pr', 'close', String(+n), ...R(s)], O(s)); }
async function prReopen(s, n) { await gh(['pr', 'reopen', String(+n), ...R(s)], O(s)); }

/** Merge. Uses --match-head-commit so we never merge commits the user has not seen. */
async function prMerge(s, n, { method, subject, body, auto, headOid, deleteBranch, headRef, crossRepo }) {
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error('Invalid merge method');
  const args = ['pr', 'merge', String(+n), ...R(s), `--${method}`];
  if (auto) args.push('--auto');
  if (headOid) args.push('--match-head-commit', headOid);
  if (subject && method !== 'rebase') args.push('--subject', subject);
  if (body != null && method !== 'rebase') args.push('--body-file', '-');
  await gh(args, { ...O(s), input: body != null && method !== 'rebase' ? body : undefined, timeout: 120_000 });
  let branchDeleted = false;
  let deleteError = null;
  if (deleteBranch && !auto && !crossRepo && headRef) {
    try {
      await gh(['api', '-X', 'DELETE', `repos/${s.owner}/${s.repo}/git/refs/heads/${encodeURI(headRef)}`], O(s));
      branchDeleted = true;
    } catch (e) { deleteError = e.message; }
  }
  return { branchDeleted, deleteError };
}

async function prDisableAuto(s, n) { await gh(['pr', 'merge', String(+n), ...R(s), '--disable-auto'], O(s)); }
async function prUpdateBranch(s, n) { await gh(['api', '-X', 'PUT', `repos/${s.owner}/${s.repo}/pulls/${+n}/update-branch`], O(s)); }
async function prMergeCommit(s, n) {
  const p = await json(['pr', 'view', String(+n), ...R(s), '--json', 'state,mergeCommit,mergedAt,baseRefName'], { ...O(s), quiet: true });
  return p;
}

async function prTemplate(s, base) {
  for (const p of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md']) {
    try {
      const r = await gh(['api', `repos/${s.owner}/${s.repo}/contents/${p}${base ? `?ref=${encodeURIComponent(base)}` : ''}`, '-H', 'Accept: application/vnd.github.raw'], { ...O(s), quiet: true });
      if (r.stdout) return r.stdout;
    } catch {}
  }
  return '';
}

async function collaborators(s) {
  try {
    return await json(['api', `repos/${s.owner}/${s.repo}/collaborators?per_page=100`, '--jq', '[.[].login]'], { ...O(s), quiet: true });
  } catch { return []; }
}
async function labels(s) {
  try { return await json(['label', 'list', ...R(s), '--json', 'name,color', '-L', '200'], { ...O(s), quiet: true }); } catch { return []; }
}
async function milestones(s) {
  try { return await json(['api', `repos/${s.owner}/${s.repo}/milestones?state=open&per_page=100`, '--jq', '[.[] | {title, number}]'], { ...O(s), quiet: true }); } catch { return []; }
}

// ---------------- issues ----------------

async function issueList(s, { filter = 'all', search = '', state = 'open', limit = 50 } = {}) {
  const args = ['issue', 'list', ...R(s), '--json', 'number,title,author,state,labels,assignees,updatedAt,url,comments', '-L', String(limit), '--state', state];
  if (filter === 'mine') args.push('--author', '@me');
  else if (filter === 'assigned') args.push('--assignee', '@me');
  if (search) args.push('--search', search);
  const l = await json(args, O(s));
  return (l || []).map((i) => ({ ...i, comments: (i.comments || []).length }));
}
async function issueView(s, n) {
  return json(['issue', 'view', String(+n), ...R(s), '--json', 'number,title,body,state,author,labels,assignees,milestone,comments,url,createdAt,updatedAt,closedAt'], O(s));
}
async function issueCreate(s, { title, body, labels: lb = [], assignees = [] }) {
  const args = ['issue', 'create', ...R(s), '--title', title, '--body-file', '-'];
  if (lb.length) args.push('--label', lb.join(','));
  if (assignees.length) args.push('--assignee', assignees.join(','));
  const r = await gh(args, { ...O(s), input: body || '' });
  return { url: r.stdout.trim().split('\n').pop() };
}
async function issueComment(s, n, body) { await gh(['issue', 'comment', String(+n), ...R(s), '--body-file', '-'], { ...O(s), input: body }); }
async function issueClose(s, n, reason) { await gh(['issue', 'close', String(+n), ...R(s), ...(reason ? ['--reason', reason] : [])], O(s)); }
async function issueReopen(s, n) { await gh(['issue', 'reopen', String(+n), ...R(s)], O(s)); }
async function issueEdit(s, n, { addLabels = [], removeLabels = [], addAssignees = [], removeAssignees = [], title, body }) {
  const args = ['issue', 'edit', String(+n), ...R(s)];
  if (title != null) args.push('--title', title);
  if (body != null) args.push('--body-file', '-');
  if (addLabels.length) args.push('--add-label', addLabels.join(','));
  if (removeLabels.length) args.push('--remove-label', removeLabels.join(','));
  if (addAssignees.length) args.push('--add-assignee', addAssignees.join(','));
  if (removeAssignees.length) args.push('--remove-assignee', removeAssignees.join(','));
  if (args.length === 4) return;
  await gh(args, { ...O(s), input: body != null ? body : undefined });
}

// ---------------- actions ----------------

const RUN_FIELDS = 'databaseId,number,name,displayTitle,workflowName,workflowDatabaseId,headBranch,headSha,event,status,conclusion,createdAt,updatedAt,startedAt,url,attempt';

async function runList(s, { branch, workflow, status, commit, limit = 30, event } = {}) {
  const args = ['run', 'list', ...R(s), '--json', RUN_FIELDS, '-L', String(limit)];
  if (branch) args.push('--branch', branch);
  if (workflow) args.push('--workflow', String(workflow));
  if (status) args.push('--status', status);
  if (commit) args.push('--commit', commit);
  if (event) args.push('--event', event);
  return (await json(args, { ...O(s), quiet: true })) || [];
}

async function runView(s, id) {
  return json(['run', 'view', String(+id), ...R(s), '--json', `${RUN_FIELDS},jobs`], { ...O(s), quiet: true });
}

async function runLog(s, id, { jobId, failedOnly } = {}) {
  const args = ['run', 'view', ...(jobId ? ['--job', String(+jobId)] : [String(+id)]), ...R(s), failedOnly ? '--log-failed' : '--log'];
  const r = await gh(args, { ...O(s), quiet: true, timeout: 180_000 });
  return r.stdout;
}

async function runRerun(s, id, { failed, jobId } = {}) {
  const args = ['run', 'rerun', ...(jobId ? ['--job', String(+jobId)] : [String(+id)]), ...R(s)];
  if (failed && !jobId) args.push('--failed');
  await gh(args, O(s));
}
async function runCancel(s, id) { await gh(['run', 'cancel', String(+id), ...R(s)], O(s)); }

async function workflows(s) {
  return (await json(['workflow', 'list', ...R(s), '--all', '--json', 'id,name,path,state'], { ...O(s), quiet: true })) || [];
}
async function workflowYaml(s, id, ref) {
  const r = await gh(['workflow', 'view', String(id), ...R(s), '--yaml', ...(ref ? ['--ref', ref] : [])], { ...O(s), quiet: true });
  return r.stdout;
}
async function workflowDispatch(s, id, ref, inputs) {
  await gh(['workflow', 'run', String(id), ...R(s), '--ref', ref, '--json'], { ...O(s), input: JSON.stringify(inputs || {}) });
}

const DEPLOY_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
  environments(first:20){nodes{name}}
  deployments(last:20, orderBy:{field:CREATED_AT, direction:ASC}){nodes{environment state createdAt commitOid ref{name}
    latestStatus{state createdAt environmentUrl logUrl description}}}}}`;
async function deployments(s) {
  const d = await json(['api', 'graphql', '-f', `query=${DEPLOY_QUERY}`, '-F', `owner=${s.owner}`, '-F', `name=${s.repo}`], { ...O(s), quiet: true });
  const repo = d.data.repository;
  const latest = {};
  for (const dep of repo.deployments.nodes) latest[dep.environment] = dep; // ascending, so last wins
  return { environments: repo.environments.nodes.map((e) => e.name), latest: Object.values(latest).reverse() };
}

// ---------------- batched board query ----------------

function boardQuery(slugs) {
  const parts = slugs.map((s, i) => `r${i}: repository(owner:${JSON.stringify(s.owner)}, name:${JSON.stringify(s.repo)}) {
    nameWithOwner defaultBranchRef { name target { ... on Commit { oid messageHeadline committedDate url author { name user { login } }
      statusCheckRollup { state }
      checkSuites(last: 30) { nodes { status conclusion createdAt updatedAt app { slug }
        workflowRun { databaseId runNumber url createdAt updatedAt event workflow { name } } } } } } } }`);
  return `query { ${parts.join('\n')} rateLimit { remaining resetAt } }`;
}

/** One GraphQL call for many repos of the same account. Returns map slug -> summary | { error }. */
async function boardBatch(slugs, login) {
  const out = {};
  for (let i = 0; i < slugs.length; i += 25) {
    const chunk = slugs.slice(i, i + 25);
    let d;
    try {
      const r = await gh(['api', 'graphql', '-f', `query=${boardQuery(chunk)}`], { login, quiet: true, timeout: 60_000, okCodes: [0, 1] });
      d = JSON.parse(r.stdout || '{}');
    } catch (e) {
      for (const s of chunk) out[`${s.owner}/${s.repo}`.toLowerCase()] = { error: e.message, kind: e.kind };
      continue;
    }
    chunk.forEach((s, k) => {
      const key = `${s.owner}/${s.repo}`.toLowerCase();
      const repo = d.data && d.data[`r${k}`];
      if (!repo) {
        const err = (d.errors || []).find((x) => (x.path || [])[0] === `r${k}`);
        out[key] = { error: err ? err.message : 'No access', kind: 'no-access' };
        return;
      }
      const ref = repo.defaultBranchRef;
      if (!ref || !ref.target) { out[key] = { branch: ref ? ref.name : null, runs: [] }; return; }
      const t = ref.target;
      const runs = (t.checkSuites ? t.checkSuites.nodes : []).filter((n) => n.workflowRun).map((n) => ({
        id: n.workflowRun.databaseId, number: n.workflowRun.runNumber, url: n.workflowRun.url,
        workflow: n.workflowRun.workflow ? n.workflowRun.workflow.name : '?', event: n.workflowRun.event,
        status: (n.status || '').toLowerCase(), conclusion: (n.conclusion || '').toLowerCase(),
        createdAt: n.workflowRun.createdAt, updatedAt: n.workflowRun.updatedAt,
      }));
      out[key] = {
        branch: ref.name, oid: t.oid, headline: t.messageHeadline, committedDate: t.committedDate, commitUrl: t.url,
        author: t.author ? (t.author.user ? t.author.user.login : t.author.name) : '',
        rollup: t.statusCheckRollup ? t.statusCheckRollup.state.toLowerCase() : null, runs,
      };
    });
  }
  return out;
}

// ---------------- notifications source ----------------

const MY_PRS_QUERY = `query { viewer { login }
  mine: search(query:"is:pr is:open author:@me archived:false", type:ISSUE, first:50) { nodes { ... on PullRequest { number title url headRefOid repository { nameWithOwner }
    commits(last:1){ nodes { commit { statusCheckRollup { state } } } } } } }
  review: search(query:"is:pr is:open review-requested:@me archived:false", type:ISSUE, first:50) { nodes { ... on PullRequest { number title url repository { nameWithOwner } author { login } } } } }`;

async function myPrs(login) {
  const d = await json(['api', 'graphql', '-f', `query=${MY_PRS_QUERY}`], { login, quiet: true });
  const data = d.data;
  return {
    login: data.viewer.login,
    mine: data.mine.nodes.filter((n) => n.number).map((n) => ({
      repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, head: n.headRefOid,
      checks: n.commits.nodes[0] && n.commits.nodes[0].commit.statusCheckRollup ? n.commits.nodes[0].commit.statusCheckRollup.state.toLowerCase() : null,
    })),
    review: data.review.nodes.filter((n) => n.number).map((n) => ({ repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, author: n.author ? n.author.login : '' })),
  };
}

async function repoList(owner, login) {
  const args = ['repo', 'list', ...(owner ? [owner] : []), '--json', 'nameWithOwner,url,sshUrl,description,isPrivate,updatedAt', '-L', '300'];
  return (await json(args, { login, owner, quiet: true })) || [];
}

/** Every repository the current account can see: its own plus each of its organisations'. */
async function repoListAll() {
  const login = accountForOwner();
  if (!login) throw ghError('Sign in to GitHub first.', 'auth');
  let orgs = [];
  try { orgs = (await json(['api', 'user/orgs', '--jq', '[.[].login]'], { quiet: true })) || []; } catch {}
  const out = [];
  const seen = new Set();
  for (const owner of [login, ...orgs]) {
    let list = [];
    try { list = await json(['repo', 'list', owner, '--json', 'nameWithOwner,url,sshUrl,description,isPrivate,isArchived,isFork,updatedAt,primaryLanguage,defaultBranchRef', '-L', '1000'], { quiet: true }); } catch { continue; }
    for (const r of list || []) {
      if (seen.has(r.nameWithOwner.toLowerCase())) continue;
      seen.add(r.nameWithOwner.toLowerCase());
      out.push({ ...r, owner, language: r.primaryLanguage ? r.primaryLanguage.name : '', defaultBranch: r.defaultBranchRef ? r.defaultBranchRef.name : '', primaryLanguage: undefined, defaultBranchRef: undefined });
    }
  }
  return out.sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || ''));
}

async function version() {
  const r = await run('gh', ['--version'], { cwd: paths.neutral, quiet: true, timeout: 10_000 });
  return r.stdout.split('\n')[0].trim();
}

module.exports = {
  accounts, activeLogin, accountForOwner, forgetAccounts, checkAccess, classify, repoMeta,
  prList, prView, prDiff, prThreads, prCreate, prComment, editIssueComment, deleteIssueComment, editReviewComment, deleteReviewComment,
  replyReviewComment, setThreadResolved, setFileViewed, submitReview, prEdit, prReady, prClose, prReopen, prMerge, prDisableAuto,
  prUpdateBranch, prMergeCommit, prTemplate, collaborators, labels, milestones,
  issueList, issueView, issueCreate, issueComment, issueClose, issueReopen, issueEdit,
  runList, runView, runLog, runRerun, runCancel, workflows, workflowYaml, workflowDispatch, deployments,
  boardBatch, myPrs, repoList, repoListAll, version, rollupState, normalizeCheck, ProcError,
};
