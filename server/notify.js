// Windows toast notifications through Windows PowerShell (no extra dependencies).
'use strict';
const { run } = require('./proc');
const log = require('./log');

// Setup registers "Repodeck.App" so notifications show the app's own name and icon. When running
// from source without Setup, fall back to PowerShell's identity, which exists on every Windows.
const OWN_AUMID = 'Repodeck.App';
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
let aumid = null;
async function appId() {
  if (aumid) return aumid;
  try {
    await run('reg.exe', ['query', `HKCU\\Software\\Classes\\AppUserModelId\\${OWN_AUMID}`, '/v', 'DisplayName'], { quiet: true, timeout: 10_000 });
    aumid = OWN_AUMID;
  } catch { aumid = PS_AUMID; }
  return aumid;
}
const script = (id) => [
  '$ErrorActionPreference = "Stop"',
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$x.LoadXml([Console]::In.ReadToEnd())',
  '$t = New-Object Windows.UI.Notifications.ToastNotification $x',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${id}').Show($t)`,
].join('; ');

// The XML travels over stdin, which PowerShell reads in the console code page: keep it pure ASCII
// by writing every other character as a numeric reference, so names and symbols arrive intact.
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])
  .replace(/[^\x20-\x7e]/gu, (c) => (c === '\n' ? '&#10;' : `&#x${c.codePointAt(0).toString(16)};`));

async function toast({ title, body, url, sound = false }) {
  if (process.platform !== 'win32') return;
  const launch = url && /^https?:\/\//.test(url) ? ` activationType="protocol" launch="${esc(url)}"` : '';
  const xml = `<toast${launch}><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual>${sound ? '' : '<audio silent="true"/>'}</toast>`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script(await appId())], { input: xml, quiet: true, timeout: 20_000 })
    .catch((e) => log.warn('Toast failed', { error: e.message }));
}

module.exports = { toast };
