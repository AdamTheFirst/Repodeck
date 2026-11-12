// Running git-helper windows. One process per account at most; each records itself in
// instance-<account>.json so a second launch can find it instead of starting a duplicate.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { paths, writeJsonAtomic, readJson } = require('./paths');

const key = (login) => (login ? String(login).toLowerCase().replace(/[^a-z0-9-]/g, '') : '_none');
const fileFor = (login) => path.join(paths.data, `instance-${key(login)}.json`);

function rpc(inst, method, params, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: inst.port, path: '/api/rpc', method: 'POST', timeout,
      headers: { 'Content-Type': 'application/json', 'X-Token': inst.token, Host: `127.0.0.1:${inst.port}` } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { const j = JSON.parse(b); resolve(res.statusCode === 200 && !j.error ? j.result : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(JSON.stringify({ method, params: params || {} }));
  });
}

/** The live instance showing this account, or null. Stale files are removed. */
async function find(login) {
  const f = fileFor(login);
  const inst = readJson(f, null);
  if (!inst || !inst.port || !inst.token) return null;
  if (inst.pid === process.pid) return null;
  const ok = await rpc(inst, 'app.ping');
  if (ok && ok.ok) return inst;
  try { fs.unlinkSync(f); } catch {}
  return null;
}

/** Every live instance other than this process: [{ account, port, token, pid }]. */
async function others() {
  let names = [];
  try { names = fs.readdirSync(paths.data).filter((n) => /^instance-.*\.json$/.test(n)); } catch {}
  const out = [];
  for (const n of names) {
    const inst = readJson(path.join(paths.data, n), null);
    if (!inst || inst.pid === process.pid) continue;
    const ok = await rpc(inst, 'app.ping');
    if (ok && ok.ok) out.push(inst); else { try { fs.unlinkSync(path.join(paths.data, n)); } catch {} }
  }
  return out;
}

let mine = null; // { file, account }
function register(login, port, token) {
  unregister();
  const file = fileFor(login);
  writeJsonAtomic(file, { pid: process.pid, port, token, account: login || '', started: Date.now() });
  mine = { file, account: login || '', port, token };
}
function unregister() {
  if (!mine) return;
  try { const cur = readJson(mine.file, null); if (cur && cur.pid === process.pid) fs.unlinkSync(mine.file); } catch {}
  mine = null;
}
/** The open account changed in this process: move the registration. */
function rename(login) { if (mine) register(login, mine.port, mine.token); }

module.exports = { find, others, register, unregister, rename, rpc, fileFor, key };
