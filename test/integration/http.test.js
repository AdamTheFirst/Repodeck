'use strict';
// Localhost security: Host and Origin checks, session token, static path traversal.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.REPODECK_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-data-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../../server/http');

function req(port, { method = 'GET', p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.end(body); else r.end();
  });
}

test('server rejects foreign hosts, foreign origins, missing tokens and traversal', async (t) => {
  const token = 'a'.repeat(48);
  const { server, listen } = createServer({ token, onClients() {} });
  const port = await listen(48700 + Math.floor(Math.random() * 200));
  t.after(() => server.close());

  const ok = await req(port, { p: '/' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.includes(token), 'token injected into the page');
  assert.match(ok.headers['content-security-policy'], /script-src 'self'/);

  assert.equal((await req(port, { p: '/', headers: { Host: 'evil.example:80' } })).status, 421, 'DNS rebinding blocked');
  const rpc = (headers) => req(port, { method: 'POST', p: '/api/rpc', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ method: 'app.ping' }) });
  assert.equal((await rpc({})).status, 401, 'token required');
  assert.equal((await rpc({ 'X-Token': 'b'.repeat(48) })).status, 401, 'wrong token');
  assert.equal((await rpc({ 'X-Token': token, Origin: 'https://evil.example' })).status, 403, 'foreign origin');
  const good = await rpc({ 'X-Token': token, Origin: `http://127.0.0.1:${port}` });
  assert.equal(good.status, 200);
  assert.deepEqual(JSON.parse(good.body), { result: { ok: true } });
  const unknown = await req(port, { method: 'POST', p: '/api/rpc', headers: { 'Content-Type': 'application/json', 'X-Token': token }, body: JSON.stringify({ method: 'constructor' }) });
  assert.equal(unknown.status, 404, 'only whitelisted methods');
  const repoless = await req(port, { method: 'POST', p: '/api/rpc', headers: { 'Content-Type': 'application/json', 'X-Token': token }, body: JSON.stringify({ method: 'repo.changes', params: { id: 'nope' } }) });
  assert.equal(repoless.status, 404, 'unknown repository ids are refused');
  assert.ok([403, 404].includes((await req(port, { p: '/..%2f..%2fpackage.json' })).status));
  assert.equal((await req(port, { p: '/api/events' })).status, 401);
  assert.equal((await req(port, { method: 'POST', p: '/api/rpc', headers: { 'X-Token': token, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415, 'simple cross-site POSTs refused');
});
