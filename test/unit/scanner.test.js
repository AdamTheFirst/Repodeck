'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir, rm } = require('../helpers');
const { scanRoot } = require('../../server/scanner');

test('scanner finds nested repositories and skips ignored folders', async () => {
  const root = tmpdir();
  try {
    const mk = (p, file = false) => { const d = path.join(root, p); fs.mkdirSync(file ? path.dirname(d) : d, { recursive: true }); if (file) fs.writeFileSync(d, 'gitdir: x'); };
    mk('platform/.git');
    mk('platform/services/api/.git');
    mk('platform/services/ai/translator/.git');
    mk('platform/node_modules/pkg/.git');
    mk('other/.git');
    mk('linked/.git', true); // worktree / submodule style
    const found = await scanRoot(root, { ignore: ['node_modules'], depth: 6 });
    const rel = found.map((f) => path.relative(root, f.path).replace(/\\/g, '/')).sort();
    assert.deepEqual(rel, ['linked', 'other', 'platform', 'platform/services/ai/translator', 'platform/services/api']);
    const api = found.find((f) => f.path.endsWith('api'));
    const platform = found.find((f) => f.path.endsWith('platform'));
    assert.equal(api.parent, platform.id);
    assert.equal(found.find((f) => f.path.endsWith('linked')).kind, 'linked');
  } finally { rm(root); }
});
