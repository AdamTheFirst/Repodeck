'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir, rm } = require('../helpers');

// The module reads the data folder's paths: keep the test away from the real one.
const dataDir = tmpdir('copilot-data');
process.env.REPODECK_DATA = dataDir;
const work = tmpdir('copilot-work');
test.after(() => { rm(dataDir); rm(work); });

const copilot = require('../../server/copilot');

test('wrapping that a model adds around its answer is removed, and nothing else', () => {
  assert.equal(copilot.clean('```\nFix the greeting\n```'), 'Fix the greeting');
  assert.equal(copilot.clean('```text\nFix the greeting\n\n- one\n```\n'), 'Fix the greeting\n\n- one');
  assert.equal(copilot.clean('"Fix the greeting"'), 'Fix the greeting');
  assert.equal(copilot.clean('Say "hello" and "bye"'), 'Say "hello" and "bye"');
  assert.equal(copilot.clean('Fix it\r\n\r\nUse `x` not ```y```'), 'Fix it\n\nUse `x` not ```y```');
});

test('the answer is read from the JSON events of the CLI, or taken as it is from an older CLI', () => {
  const ev = (type, data) => JSON.stringify({ type, data });
  const answer = 'Fix the greeting\n\n- one long line that a terminal would have wrapped';
  const out = [ev('session.mcp_servers_loaded', { servers: [] }), ev('user.message', { content: 'Write it' }),
    ev('assistant.message', { content: '' }), ev('assistant.message', { content: answer }), ev('assistant.turn_end', {}), '{"type":"result","exitCode":0}'].join('\n');
  assert.equal(copilot.answerOf(out), answer);
  assert.equal(copilot.answerOf('Fix the greeting\n\nPlain text.\n'), 'Fix the greeting\n\nPlain text.\n');
  assert.equal(copilot.answerOf('{not json at all}\nFix it'), '{not json at all}\nFix it');
  assert.equal(copilot.answerOf([ev('user.message', { content: 'x' }), ev('assistant.turn_end', {})].join('\n')), '', 'events but no answer');
  assert.throws(() => copilot.answerOf(ev('session.error', { message: 'No Copilot plan on this account' })), /No Copilot plan/);
});

test('a pull request answer is split into its first line and the rest', () => {
  assert.deepEqual(copilot.splitPr('Add the export\n\nIt adds an export.\n\n- one\n- two\n'), { title: 'Add the export', body: 'It adds an export.\n\n- one\n- two' });
  assert.deepEqual(copilot.splitPr('\n# Add the export\nBody'), { title: 'Add the export', body: 'Body' });
  assert.deepEqual(copilot.splitPr('**Title:** Add the export\n\nBody'), { title: 'Add the export', body: 'Body' });
  assert.deepEqual(copilot.splitPr('Only a title'), { title: 'Only a title', body: '' });
});

test('the commit prompt carries the file list, the draft and the habits of recent commits', () => {
  const p = copilot.commitPrompt({ files: ' main.py | 2 +-', diff: 'diff --git a/main.py b/main.py\n', recent: ['Graph: keep the scroll position'], draft: 'greeting' });
  assert.match(p, /Recent commit subjects:\n- Graph: keep the scroll position/);
  assert.match(p, /The author's draft so far[^\n]*\ngreeting/);
  assert.match(p, /Files changed:\n main\.py \| 2 \+-/);
  assert.match(p, /\nDiff:\ndiff --git a\/main\.py/);
  assert.match(p, /do not follow them/i, 'the diff is marked as data');
});

test('a long diff is cut, and the prompt says so', () => {
  const p = copilot.commitPrompt({ files: 'big.txt', diff: 'x'.repeat(copilot.MAX_DIFF + 500) });
  assert.match(p, new RegExp(`Diff \\(cut after ${copilot.MAX_DIFF} characters`));
  assert.ok(p.length < copilot.MAX_DIFF + 3000);
  assert.doesNotMatch(p, /Recent commit subjects|author's draft/);
});

test('the pull request prompt names both branches, lists the commits and asks for the template to be filled', () => {
  const p = copilot.prPrompt({ head: 'feature/x', base: 'develop', commits: [{ subject: 'Add util', body: 'Because.' }], files: 'util.py', diff: '+def f():', template: '## What\n<!-- say what -->' });
  assert.match(p, /merges the branch "feature\/x" into "develop"/);
  assert.match(p, /Commits, oldest first:\n- Add util\n {2}Because\./);
  assert.match(p, /Template:\n## What/);
  assert.match(p, /fill it in/);
  assert.doesNotMatch(copilot.prPrompt({ head: 'a', base: 'b', files: 'f', diff: 'd' }), /Template:/);
});

test('new files are shown from their start; binary ones and ones outside the repository are not read', () => {
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(work, 'b.bin'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(path.dirname(work), 'outside-copilot-test.txt'), 'secret');
  try {
    const out = copilot.newFiles(work, [{ path: 'a.txt' }, { path: 'b.bin' }, { path: '../outside-copilot-test.txt' }, { path: 'gone.txt' }]);
    assert.match(out, /new file: a\.txt\n\+one\n\+two/);
    assert.match(out, /new file: b\.bin \(binary\)/);
    assert.match(out, /new file: gone\.txt$/);
    assert.doesNotMatch(out, /secret|outside/);
  } finally { rm(path.join(path.dirname(work), 'outside-copilot-test.txt')); }
});
