'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../server/parse');

test('parseStatusV2: branch headers, all entry kinds, paths with spaces', () => {
  const text = [
    '# branch.oid 1234567890abcdef1234567890abcdef12345678',
    '# branch.head feature/x',
    '# branch.upstream origin/feature/x',
    '# branch.ab +2 -3',
    '# stash 4',
    '1 M. N... 100644 100644 100644 aaa bbb staged only.txt',
    '1 .M N... 100644 100644 100644 aaa bbb dir/changed file.js',
    '1 MM N... 100644 100644 100644 aaa bbb both.txt',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt', 'old name.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt',
    '? untracked file.md',
    '',
  ].join('\0');
  const s = P.parseStatusV2(text);
  assert.equal(s.head, 'feature/x');
  assert.equal(s.upstream, 'origin/feature/x');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 3);
  assert.equal(s.stash, 4);
  assert.deepEqual(s.staged.map((f) => f.path), ['staged only.txt', 'both.txt', 'new name.txt']);
  assert.equal(s.staged[2].orig, 'old name.txt');
  assert.deepEqual(s.unstaged.map((f) => f.path), ['dir/changed file.js', 'both.txt']);
  assert.deepEqual(s.conflicted.map((f) => [f.path, f.conflict]), [['conflict.txt', 'both modified']]);
  assert.deepEqual(s.untracked.map((f) => f.path), ['untracked file.md']);
});

test('parseStatusV2: detached and initial', () => {
  const s = P.parseStatusV2('# branch.oid (initial)\0# branch.head (detached)\0');
  assert.equal(s.oid, null);
  assert.equal(s.detached, true);
  assert.equal(s.head, null);
});

test('parseRemoteUrl: https, scp-like with ssh host alias, ssh://, no .git', () => {
  assert.deepEqual(P.parseRemoteUrl('https://github.com/acme/api-service.git'), { host: 'github.com', owner: 'acme', repo: 'api-service', slug: 'acme/api-service' });
  assert.deepEqual(P.parseRemoteUrl('git@github.com-work:acme/api_service.git'), { host: 'github.com-work', owner: 'acme', repo: 'api_service', slug: 'acme/api_service' });
  assert.deepEqual(P.parseRemoteUrl('ssh://git@ssh.github.com:443/acme/web'), { host: 'ssh.github.com', owner: 'acme', repo: 'web', slug: 'acme/web' });
  assert.deepEqual(P.parseRemoteUrl('https://user:pw@github.com/acme/web/'), { host: 'github.com', owner: 'acme', repo: 'web', slug: 'acme/web' });
  assert.equal(P.parseRemoteUrl('C:\\repos\\thing.git'), null);
  assert.equal(P.parseRemoteUrl(''), null);
  assert.ok(P.looksLikeGitHub('github.com-work'));
  assert.ok(P.looksLikeGitHub('github.com'));
  assert.ok(!P.looksLikeGitHub('gitlab.com'));
});

test('parseLog and decorations', () => {
  const rec = ['a1', 'p1 p2', 'Ann', 'a@x', '100', 'Cid', 'c@x', '200', 'HEAD -> main, origin/main, tag: v1.0', 'Merge x | y'].join('\x1f') + '\x1e\n';
  const [c] = P.parseLog(rec);
  assert.equal(c.hash, 'a1');
  assert.deepEqual(c.parents, ['p1', 'p2']);
  assert.equal(c.subject, 'Merge x | y');
  assert.deepEqual(c.refs.map((r) => r.type), ['head', 'branch', 'ref', 'tag']);
  assert.equal(c.refs[1].current, true);
});

const DIFF = [
  'diff --git a/f.txt b/f.txt',
  'index 111..222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,4 +1,4 @@ ctx',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '-four',
  '+FOUR',
  '@@ -10,3 +10,4 @@',
  ' ten',
  '+ten-and-a-half',
  ' eleven',
  ' twelve',
  '',
].join('\n');

test('parseDiff: hunks, line kinds, counts', () => {
  const [f] = P.parseDiff(DIFF);
  assert.equal(f.path, 'f.txt');
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[0].oldStart, 1);
  assert.equal(f.hunks[0].context, ' ctx');
  assert.deepEqual(f.hunks[0].lines.map((l) => l.t).join(''), ' -+ -+');
});

test('buildPatch forward: only selected lines, unselected removals become context', () => {
  const [f] = P.parseDiff(DIFF);
  const sel = new Map([[0, new Set([2])]]); // only "+TWO" of hunk 0
  const patch = P.buildPatch(f, sel, 'forward');
  assert.match(patch, /@@ -1,4 \+1,5 @@/);
  assert.ok(patch.includes('\n two\n+TWO\n'));
  assert.ok(patch.includes('\n four\n'));
  assert.ok(!patch.includes('+FOUR'));
  assert.ok(!patch.includes('ten-and-a-half'));
});

test('buildPatch reverse: unselected additions become context, unselected removals dropped', () => {
  const [f] = P.parseDiff(DIFF);
  const sel = new Map([[0, new Set([5])], [1, 'all']]); // "+FOUR" and the whole second hunk
  const patch = P.buildPatch(f, sel, 'reverse');
  assert.ok(patch.includes('\n TWO\n'));
  assert.ok(!patch.includes('-two'));
  assert.ok(patch.includes('\n three\n+FOUR\n'));
  assert.ok(!patch.includes('-four'));
  assert.ok(patch.includes('+ten-and-a-half'));
});

test('buildPatch: nothing selected returns null', () => {
  const [f] = P.parseDiff(DIFF);
  assert.equal(P.buildPatch(f, new Map(), 'forward'), null);
});

test('conflict parsing and resolution keep surrounding text and line endings', () => {
  const text = 'a\r\n<<<<<<< HEAD\r\nours\r\n||||||| base\r\norig\r\n=======\r\ntheirs\r\n>>>>>>> topic\r\nz\r\n';
  const p = P.parseConflicts(text);
  assert.equal(p.eol, '\r\n');
  const c = p.segs.find((s) => s.type === 'conflict');
  assert.deepEqual(c.ours, ['ours']);
  assert.deepEqual(c.base, ['orig']);
  assert.deepEqual(c.theirs, ['theirs']);
  assert.equal(c.theirsLabel, 'topic');
  assert.equal(P.resolveConflicts(p, ['theirs']), 'a\r\ntheirs\r\nz\r\n');
  assert.equal(P.resolveConflicts(p, ['both']), 'a\r\nours\r\ntheirs\r\nz\r\n');
  assert.equal(P.resolveConflicts(p, [null]).includes('<<<<<<< HEAD'), true);
});

test('malformed conflict markers are kept as text', () => {
  const p = P.parseConflicts('x\n<<<<<<< HEAD\nonly ours\n');
  assert.equal(p.segs.some((s) => s.type === 'conflict'), false);
  assert.equal(P.resolveConflicts(p, []), 'x\n<<<<<<< HEAD\nonly ours\n');
});

test('parseDispatchInputs: inputs with types, options and defaults', () => {
  const y = `name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: "Where to deploy"
        required: true
        type: choice
        options:
          - staging
          - production
        default: staging
      dry_run:
        type: boolean
        default: 'true'
      note:
        description: Free text # trailing comment
jobs:
  a:
    runs-on: ubuntu-latest
`;
  const r = P.parseDispatchInputs(y);
  assert.equal(r.hasDispatch, true);
  assert.deepEqual(r.inputs.map((i) => i.name), ['environment', 'dry_run', 'note']);
  assert.deepEqual(r.inputs[0].options, ['staging', 'production']);
  assert.equal(r.inputs[0].required, true);
  assert.equal(r.inputs[0].default, 'staging');
  assert.equal(r.inputs[1].type, 'boolean');
  assert.equal(r.inputs[2].description, 'Free text');
  assert.equal(P.parseDispatchInputs('on: [push, workflow_dispatch]\n').hasDispatch, true);
  assert.equal(P.parseDispatchInputs('on:\n  push:\n').hasDispatch, false);
});
