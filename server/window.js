// The app window of this process: open it, or bring the existing one to the front.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('./proc');
const { paths } = require('./paths');
const config = require('./config');

const ctx = { url: null, clients: 0, broadcast: null };

function findEdge() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

function open() {
  const url = ctx.url;
  if (!url) return;
  const edge = process.platform === 'win32' ? findEdge() : null;
  if (edge) {
    spawn(edge, [`--app=${url}`, `--user-data-dir=${path.join(paths.data, 'edge-profile')}`, '--no-first-run', '--no-default-browser-check',
      '--window-size=1440,900', '--disable-features=Translate'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

/** The title the page sets, so the window can be found again. */
function title() {
  const a = config.get().currentAccount;
  return a ? `git-helper · ${a}` : 'git-helper';
}

/** Bring this process's window forward; open one if it has none. Never opens a second. */
async function focusOrOpen() {
  if (ctx.clients <= 0) { open(); return { opened: true }; }
  if (ctx.broadcast) ctx.broadcast('focus', {});
  if (process.platform === 'win32') {
    // The title arrives on stdin, never on the command line.
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$t = [Console]::In.ReadToEnd(); [void](New-Object -ComObject WScript.Shell).AppActivate($t)'],
      { input: title(), quiet: true, timeout: 15_000 }).catch(() => {});
  }
  return { focused: true };
}

module.exports = { ctx, open, focusOrOpen, title };
