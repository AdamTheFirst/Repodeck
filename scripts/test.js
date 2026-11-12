// Runs every test file. Listing the files here keeps it working on Node 20, where
// "node --test" does not expand wildcards on Windows.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', 'test');
const files = ['unit', 'integration'].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(root, dir, f)));
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status == null ? 1 : res.status);
