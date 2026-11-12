#!/usr/bin/env node
// Entry point. Starts (or reuses) the local server and opens the app window.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { paths, writeJsonAtomic, readJson } = require('./paths');
const log = require('./log');

log.init(paths.logs);
const config = require('./config');

const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');

function ping(port, token) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/rpc', method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'X-Token': token, Host: `127.0.0.1:${port}` } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(res.statusCode === 200 && b.includes('"ok":true')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(JSON.stringify({ method: 'app.ping' }));
  });
}

function findEdge() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

function openWindow(url) {
  const edge = process.platform === 'win32' ? findEdge() : null;
  if (edge) {
    spawn(edge, [`--app=${url}`, `--user-data-dir=${path.join(paths.data, 'edge-profile')}`, '--no-first-run', '--no-default-browser-check',
      '--window-size=1440,900', '--disable-features=Translate'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const inst = readJson(paths.instance, null);
  if (inst && inst.port && inst.token && await ping(inst.port, inst.token)) {
    if (!noOpen) openWindow(`http://127.0.0.1:${inst.port}/`);
    return; // reuse the running instance
  }

  const cfg = config.load();
  const token = crypto.randomBytes(24).toString('hex');
  const state = require('./state');
  const { createServer } = require('./http');

  let idleTimer = null;
  let everConnected = false;
  const { listen } = createServer({
    token,
    onClients(n) {
      if (n > 0) { everConnected = true; clearTimeout(idleTimer); idleTimer = null; return; }
      if (!everConnected || config.get().keepRunningWhenClosed) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { log.info('Window closed; shutting down'); shutdown(0); }, 20_000);
    },
  });
  const port = await listen(cfg.port);
  writeJsonAtomic(paths.instance, { pid: process.pid, port, token, started: Date.now() });
  log.info(`git-helper listening on 127.0.0.1:${port}`);
  state.start();

  // If nobody connects within two minutes (window failed to open), stop rather than linger.
  setTimeout(() => { if (!everConnected && !config.get().keepRunningWhenClosed && !noOpen) shutdown(0); }, 120_000);

  if (!noOpen) openWindow(`http://127.0.0.1:${port}/`);
  if (process.env.GIT_HELPER_PRINT_URL) process.stdout.write(`http://127.0.0.1:${port}/\n`);

  function shutdown(code) {
    try { const cur = readJson(paths.instance, null); if (cur && cur.pid === process.pid) fs.unlinkSync(paths.instance); } catch {}
    state.stop();
    process.exit(code);
  }
  process.on('exit', () => { try { const cur = readJson(paths.instance, null); if (cur && cur.pid === process.pid) fs.unlinkSync(paths.instance); } catch {} });
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (e) => { log.error('Uncaught exception', { error: e.stack }); });
  process.on('unhandledRejection', (e) => { log.error('Unhandled rejection', { error: e && e.stack ? e.stack : String(e) }); });
}

main().catch((e) => { log.error('Startup failed', { error: e.stack }); console.error(e.message); process.exit(1); });
