// The app window of this process: open it, or bring the existing one to the front.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('./proc');
const { paths } = require('./paths');
const config = require('./config');
const log = require('./log');

const ctx = { url: null, clients: 0, broadcast: null };

// Repodeck.exe is both the launcher and the window (installer/src/Window.cs). An installed copy has it
// next to the server; a source checkout has it in dist\ after scripts\build.ps1.
function hostExe() {
  const root = path.join(__dirname, '..');
  return [path.join(root, 'Repodeck.exe'), path.join(root, 'dist', 'Repodeck.exe')]
    .find((f) => fs.existsSync(f) && fs.existsSync(path.join(path.dirname(f), 'Microsoft.Web.WebView2.Core.dll'))) || null;
}

function open() {
  const url = ctx.url;
  if (!url) return;
  if (process.platform !== 'win32') { spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref(); return; }
  const exe = process.env.REPODECK_WINDOW === 'edge' ? null : hostExe();
  if (!exe) { openInEdge(url); return; }
  const account = config.get().currentAccount;
  const started = Date.now();
  let fellBack = false;
  const fallback = (why) => { if (fellBack) return; fellBack = true; log.info(`Own window not available (${why}); using an Edge app window`); openInEdge(url); };
  try {
    const child = spawn(exe, ['--window', url, ...(account ? ['--account', account] : [])], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => fallback(e.message));
    // 3 = WebView2 is missing on this computer. A quick abnormal exit is treated the same way.
    child.on('exit', (code) => { if (code === 3 || (code !== 0 && Date.now() - started < 8000)) fallback(`exit code ${code}`); });
    child.unref();
    // Browser profiles made for the app window by earlier versions are no longer used.
    for (const old of ['edge-profile', 'window-profile']) fs.rm(path.join(paths.data, old), { recursive: true, force: true }, () => {});
  } catch (e) { fallback(e.message); }
}

function findEdge() {
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

/** Fallback for computers without WebView2: an Edge window in app mode, or the default browser. */
function openInEdge(url) {
  const edge = findEdge();
  if (!edge) { spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref(); return; }
  // The window uses its own Edge profile. Left alone, Edge signs that profile in with the Windows
  // account, turns on sync and installs the user's synced extensions, which then open their own
  // welcome tabs. The app window must be just a window: no sign-in, no sync, no extensions.
  spawn(edge, [`--app=${url}`, `--user-data-dir=${path.join(paths.data, 'window-profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-component-extensions-with-background-pages',
    '--disable-features=msImplicitSignin,msEdgeSyncConsent,msEdgeWelcomePage,Translate', '--disable-background-networking',
    '--window-size=1440,900'], { detached: true, stdio: 'ignore' }).unref();
  // Windows would call that window "Microsoft Edge" on the taskbar: give it Repodeck's name.
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
  if (ctx.broadcast) ctx.broadcast('focus', {}); // the app's own window restores and raises itself
  if (process.platform === 'win32') {
    // The title arrives on stdin, never on the command line.
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$t = [Console]::In.ReadToEnd(); [void](New-Object -ComObject WScript.Shell).AppActivate($t)'],
      { input: title(), quiet: true, timeout: 15_000 }).catch(() => {});
  }
  return { focused: true };
}

module.exports = { ctx, open, focusOrOpen, title };
