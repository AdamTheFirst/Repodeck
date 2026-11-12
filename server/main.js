#!/usr/bin/env node
// Entry point. One process per GitHub account at most: a second launch for the same account
// brings the existing window forward instead of starting a duplicate.
//   node server/main.js [--account <login>] [--no-open]
'use strict';
const crypto = require('node:crypto');
const { paths } = require('./paths');
const log = require('./log');

log.init(paths.logs);
const config = require('./config');
const instances = require('./instances');
const win = require('./window');

const args = process.argv.slice(2);
const noOpen = args.includes('--no-open');
const ai = args.indexOf('--account');
const accountArg = ai >= 0 && args[ai + 1] && /^[A-Za-z0-9-]+$/.test(args[ai + 1]) ? args[ai + 1] : null;

async function handOver(inst) {
  if (!noOpen) await instances.rpc(inst, 'app.focusWindow', {}, 20_000);
}

async function main() {
  const cfg = config.load();
  if (accountArg) config.setSessionAccount(accountArg);
  const wanted = config.get().currentAccount;
  const running = await instances.find(wanted);
  if (running) { await handOver(running); return; }

  const token = crypto.randomBytes(24).toString('hex');
  const state = require('./state');
  const { createServer } = require('./http');

  let idleTimer = null;
  let everConnected = false;
  const { listen, broadcast } = createServer({
    token,
    onClients(n) {
      win.ctx.clients = n;
      if (n > 0) { everConnected = true; clearTimeout(idleTimer); idleTimer = null; return; }
      if (!everConnected || config.get().keepRunningWhenClosed) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { log.info('Window closed; shutting down'); shutdown(0); }, 20_000);
    },
  });
  const port = await listen(cfg.port);
  win.ctx.url = `http://127.0.0.1:${port}/`;
  win.ctx.broadcast = broadcast;

  // The account may differ from the one we asked for (signed out meanwhile, or first run).
  const account = await state.ensureAccount();
  if (account !== wanted) {
    const other = await instances.find(account);
    if (other) { await handOver(other); process.exit(0); }
  }
  instances.register(account, port, token);
  log.info(`git-helper listening on 127.0.0.1:${port} for ${account || 'no account'}`);
  state.start();

  // If nobody connects within two minutes (window failed to open), stop rather than linger.
  setTimeout(() => { if (!everConnected && !config.get().keepRunningWhenClosed && !noOpen) shutdown(0); }, 120_000);

  if (!noOpen) win.open();
  if (process.env.GIT_HELPER_PRINT_URL) process.stdout.write(`${win.ctx.url}\n`);

  function shutdown(code) {
    instances.unregister();
    state.stop();
    process.exit(code);
  }
  process.on('exit', () => instances.unregister());
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (e) => { log.error('Uncaught exception', { error: e.stack }); });
  process.on('unhandledRejection', (e) => { log.error('Unhandled rejection', { error: e && e.stack ? e.stack : String(e) }); });
}

main().catch((e) => { log.error('Startup failed', { error: e.stack }); console.error(e.message); process.exit(1); });
