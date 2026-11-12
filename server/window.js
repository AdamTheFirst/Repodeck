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
    // The window uses its own Edge profile. Left alone, Edge signs that profile in with the Windows
    // account, turns on sync and installs the user's synced extensions, which then open their own
    // welcome tabs. The app window must be just a window: no sign-in, no sync, no extensions.
    const old = path.join(paths.data, 'edge-profile'); // profile from earlier versions, already synced
    fs.rm(old, { recursive: true, force: true }, () => {});
    spawn(edge, [`--app=${url}`, `--user-data-dir=${path.join(paths.data, 'window-profile')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-component-extensions-with-background-pages',
      '--disable-features=msImplicitSignin,msEdgeSyncConsent,msEdgeWelcomePage,Translate', '--disable-background-networking',
      '--window-size=1440,900'], { detached: true, stdio: 'ignore' }).unref();
    brand();
    return;
  }
  if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

// Edge draws the window, so Windows would call it "Microsoft Edge" on the taskbar. The launcher gives it
// Repodeck's own name and makes "Pin to taskbar" pin Repodeck. Only available in an installed copy.
function brand() {
  const exe = path.join(__dirname, '..', 'Repodeck.exe');
  if (fs.existsSync(exe)) spawn(exe, ['--brand'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** The title the page sets, so the window can be found again. */
function title() {
  const a = config.get().currentAccount;
  return a ? `Repodeck · ${a}` : 'Repodeck';
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
