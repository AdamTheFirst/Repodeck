'use strict';
// GitHub layer against a stubbed gh: argument shapes (always -R owner/repo, neutral cwd),
// account selection per owner, board batching and PR merge safety. Fixtures are hand-written.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.GIT_HELPER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-data-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let handler = () => ({ stdout: '' });
const procPath = require.resolve('../../server/proc');
require.cache[procPath] = {
  id: procPath, filename: procPath, loaded: true,
  exports: {
    ProcError: class extends Error {},
    cancel: () => false,
    run: async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, opts });
      const res = handler(args, opts);
      if (res instanceof Error) throw res;
      return { stdout: res.stdout || '', stderr: '', code: 0 };
    },
  },
};

const config = require('../../server/config');
const gh = require('../../server/gh');
const { paths } = require('../../server/paths');

const ACCOUNTS = [
  '{"active":true,"host":"github.com","login":"personal","scopes":"repo","state":"success"}',
  '{"active":false,"host":"github.com","login":"work","scopes":"repo","state":"success"}',
].join('\n');

function notFound() { const e = new Error('HTTP 404: Not Found'); e.stderr = 'HTTP 404: Not Found'; return e; }

test('owner is mapped to the first account that can see it; tokens never appear in logged commands', async () => {
  config.load();
  calls.length = 0;
  handler = (args, opts) => {
    if (args[0] === 'auth' && args[1] === 'status') return { stdout: ACCOUNTS };
    if (args[0] === 'auth' && args[1] === 'token') return { stdout: 'gho_secret_work_token\n' };
    if (args[0] === 'api' && args[1] === 'repos/acme-corp/api-service') return opts.env && opts.env.GH_TOKEN === 'gho_secret_work_token' ? { stdout: 'acme-corp/api-service' } : notFound();
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]' };
    return { stdout: '' };
  };
  const login = await gh.accountForOwner('acme-corp', 'api-service');
  assert.equal(login, 'work');
  assert.equal(config.get().accountForOwner['acme-corp'], 'work', 'saved for next time');
  await gh.prList({ owner: 'acme-corp', repo: 'api-service' }, { filter: 'mine' });
  const list = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'list');
  assert.deepEqual(list.args.slice(2, 4), ['-R', 'acme-corp/api-service']);
  assert.equal(list.opts.cwd, paths.neutral, 'gh never runs inside a repository');
  assert.equal(list.opts.env.GH_TOKEN, 'gho_secret_work_token');
  assert.deepEqual(list.opts.redact, ['gho_secret_work_token'], 'token is redacted from the activity log');
  assert.ok(list.args.includes('--author') && list.args.includes('@me'));
});

test('with auto-detection off only the active account is tried', async () => {
  config.update({ accountForOwner: {}, autoDetectAccounts: false });
  gh.forgetAccounts();
  calls.length = 0;
  handler = (args) => (args[0] === 'auth' && args[1] === 'status' ? { stdout: ACCOUNTS } : args[0] === 'api' ? notFound() : { stdout: '' });
  const login = await gh.accountForOwner('other-org', 'thing');
  assert.equal(login, null, 'active account cannot see it, and the other account is not tried');
  assert.equal(calls.filter((c) => c.args[0] === 'auth' && c.args[1] === 'token').length, 0, 'no token requested for the inactive account');
  config.update({ autoDetectAccounts: true });
});

test('board batch: one GraphQL call for many repos, runs mapped, missing repos reported', async () => {
  config.update({ accountForOwner: { acme: 'personal' } });
  calls.length = 0;
  handler = (args) => {
    if (args[0] === 'auth' && args[1] === 'status') return { stdout: ACCOUNTS };
    if (args[0] === 'api' && args[1] === 'graphql') {
      return { stdout: JSON.stringify({
        data: {
          r0: { nameWithOwner: 'acme/a', defaultBranchRef: { name: 'main', target: { oid: 'abc', messageHeadline: 'Fix', committedDate: '2026-01-01T00:00:00Z', url: 'u', author: { name: 'A', user: { login: 'a' } }, statusCheckRollup: { state: 'FAILURE' },
            checkSuites: { nodes: [
              { status: 'COMPLETED', conclusion: 'FAILURE', createdAt: 'x', updatedAt: 'y', app: { slug: 'github-actions' }, workflowRun: { databaseId: 11, runNumber: 5, url: 'https://github.com/acme/a/actions/runs/11', createdAt: 'x', updatedAt: 'y', event: 'push', workflow: { name: 'CI' } } },
              { status: 'QUEUED', conclusion: null, createdAt: 'x', updatedAt: 'y', app: { slug: 'some-app' }, workflowRun: null },
            ] } } } },
          r1: null,
        },
        errors: [{ path: ['r1'], message: "Could not resolve to a Repository with the name 'acme/b'." }],
      }) };
    }
    return { stdout: '' };
  };
  const out = await gh.boardBatch([{ owner: 'acme', repo: 'a' }, { owner: 'acme', repo: 'b' }], 'personal');
  assert.equal(calls.filter((c) => c.args[1] === 'graphql').length, 1);
  assert.equal(out['acme/a'].branch, 'main');
  assert.deepEqual(out['acme/a'].runs.map((r) => [r.id, r.workflow, r.conclusion]), [[11, 'CI', 'failure']], 'non-Actions check suites ignored');
  assert.equal(out['acme/b'].kind, 'no-access');
});

test('merge uses --match-head-commit, deletes the branch via the API (never a local checkout)', async () => {
  calls.length = 0;
  handler = (args) => (args[0] === 'auth' ? { stdout: ACCOUNTS } : { stdout: '' });
  const res = await gh.prMerge({ owner: 'acme', repo: 'a' }, 7, { method: 'squash', subject: 'S', body: 'B', headOid: 'deadbeef', deleteBranch: true, headRef: 'feature/x' });
  const merge = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(merge.args.includes('--squash'));
  assert.deepEqual(merge.args.slice(merge.args.indexOf('--match-head-commit'), merge.args.indexOf('--match-head-commit') + 2), ['--match-head-commit', 'deadbeef']);
  assert.ok(!merge.args.includes('--delete-branch'));
  assert.equal(merge.opts.input, 'B');
  const del = calls.find((c) => c.args[0] === 'api' && c.args[2] === 'DELETE');
  assert.equal(del.args[3], 'repos/acme/a/git/refs/heads/feature/x');
  assert.equal(res.branchDeleted, true);
  await assert.rejects(gh.prMerge({ owner: 'acme', repo: 'a' }, 7, { method: 'force' }), /Invalid merge method/);
});

test('review submission carries inline comments with sides and ranges', async () => {
  calls.length = 0;
  handler = (args) => (args[0] === 'auth' ? { stdout: ACCOUNTS } : { stdout: '{}' });
  await gh.submitReview({ owner: 'acme', repo: 'a' }, 3, { event: 'REQUEST_CHANGES', body: 'see notes', commitId: 'c0ffee', comments: [
    { path: 'src/x.js', line: 12, side: 'RIGHT', body: 'nit' }, { path: 'src/y.js', line: 9, startLine: 5, side: 'LEFT', body: 'range' }] });
  const c = calls.find((x) => x.args[0] === 'api' && x.args[3] === 'repos/acme/a/pulls/3/reviews');
  const payload = JSON.parse(c.opts.input);
  assert.equal(payload.event, 'REQUEST_CHANGES');
  assert.equal(payload.commit_id, 'c0ffee');
  assert.deepEqual(payload.comments[1], { path: 'src/y.js', body: 'range', line: 9, side: 'LEFT', start_line: 5, start_side: 'LEFT' });
  await assert.rejects(gh.submitReview({ owner: 'acme', repo: 'a' }, 3, { event: 'DISMISS' }), /Invalid review/);
});

test('GitHub error bodies are surfaced instead of a bare HTTP status', async () => {
  handler = (args) => {
    if (args[0] === 'auth') return { stdout: ACCOUNTS };
    const e = new Error('gh: Unprocessable Entity (HTTP 422)');
    e.stderr = 'gh: Unprocessable Entity (HTTP 422)';
    e.stdout = JSON.stringify({ message: 'Unprocessable Entity', errors: ['Review Can not approve your own pull request'], status: '422' });
    return e;
  };
  await assert.rejects(gh.submitReview({ owner: 'acme', repo: 'a' }, 3, { event: 'APPROVE' }), /GitHub says: Unprocessable Entity; Review Can not approve your own pull request/);
});

test('check rollup and check normalisation', () => {
  assert.equal(gh.rollupState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(gh.rollupState([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), 'failure');
  assert.equal(gh.rollupState([{ state: 'SUCCESS' }]), 'success');
  assert.equal(gh.rollupState([]), null);
  const c = gh.normalizeCheck({ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/a/actions/runs/42/job/99' });
  assert.deepEqual([c.runId, c.jobId, c.conclusion], ['42', '99', 'failure']);
});
