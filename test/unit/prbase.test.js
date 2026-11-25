'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir, rm } = require('../helpers');

// Settings are saved in the data folder: keep the test away from the real one.
const dataDir = tmpdir('prbase-data');
process.env.REPODECK_DATA = dataDir;
test.after(() => rm(dataDir));

const prbase = require('../../server/prbase');
const config = require('../../server/config');

const slug = { owner: 'Acme', repo: 'Shop' };
const has = (...names) => async (b) => names.includes(b);
const choose = (cfg, head, exists) => prbase.choose({ cfg, slug, head, fallback: 'main', exists });

test('with nothing set, a pull request opens into the default branch', async () => {
  assert.deepEqual(await choose({ prBase: '', prBaseByRepo: {} }, 'feature/x', has('develop')), { base: 'main', from: 'default', missing: [] });
});

test('the general base branch is used where the repository has it', async () => {
  assert.deepEqual(await choose({ prBase: 'develop' }, 'feature/x', has('develop')), { base: 'develop', from: 'all', missing: [] });
});

test('a repository without the general base branch falls back to its default branch, and says which was missing', async () => {
  assert.deepEqual(await choose({ prBase: 'develop' }, 'feature/x', has()), { base: 'main', from: 'default', missing: ['develop'] });
});

test('the branch set for one repository wins over the general one, whatever the case of owner and name', async () => {
  const cfg = { prBase: 'develop', prBaseByRepo: { 'acme/shop': 'release' } };
  assert.deepEqual(await choose(cfg, 'feature/x', has('develop', 'release')), { base: 'release', from: 'repo', missing: [] });
  assert.equal((await prbase.choose({ cfg, slug: { owner: 'acme', repo: 'other' }, head: 'feature/x', fallback: 'main', exists: has('develop', 'release') })).base, 'develop');
});

test('a repository can be set back to its default branch while the others use the general one', async () => {
  const never = async () => { throw new Error('the default branch needs no lookup'); };
  assert.deepEqual(await choose({ prBase: 'develop', prBaseByRepo: { 'acme/shop': 'main' } }, 'feature/x', never), { base: 'main', from: 'repo', missing: [] });
});

test('when the repository branch is gone, the general one is tried next', async () => {
  const cfg = { prBase: 'develop', prBaseByRepo: { 'acme/shop': 'release' } };
  assert.deepEqual(await choose(cfg, 'feature/x', has('develop')), { base: 'develop', from: 'all', missing: ['release'] });
});

test('a branch is never its own base: from develop, the pull request goes to the default branch', async () => {
  assert.deepEqual(await choose({ prBase: 'develop' }, 'develop', has('develop')), { base: 'main', from: 'default', missing: [] });
});

test('setting and forgetting the branch of one repository leaves the others alone', () => {
  const one = prbase.withRepo({ 'x/y': 'dev' }, slug, 'develop');
  assert.deepEqual(one, { 'x/y': 'dev', 'acme/shop': 'develop' });
  assert.deepEqual(prbase.withRepo(one, slug, ''), { 'x/y': 'dev' });
});

test('branch names that git would refuse are not accepted', () => {
  for (const ok of ['', 'develop', 'release/2026.1', 'feature/a-b_c']) assert.ok(prbase.validName(ok), ok);
  for (const bad of ['two words', '-x', 'a..b', 'a~1', 'a:b', '/a', 'a/', 'a.lock', 'a@{1}', 42, null]) assert.ok(!prbase.validName(bad), String(bad));
});

test('the settings keep valid base branches and refuse the rest', () => {
  const cfg = config.update({ prBase: 'develop', prBaseByRepo: { 'acme/shop': 'release' } });
  assert.equal(cfg.prBase, 'develop');
  assert.deepEqual(cfg.prBaseByRepo, { 'acme/shop': 'release' });
  assert.throws(() => config.update({ prBase: 'not a branch' }), /Invalid value/);
  assert.throws(() => config.update({ prBaseByRepo: { 'no-slash': 'develop' } }), /Invalid value/);
  assert.throws(() => config.update({ prBaseByRepo: ['develop'] }), /Invalid value/);
  assert.equal(config.update({ prBase: '' }).prBase, '');
});
