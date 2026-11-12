// Windows toast notifications through Windows PowerShell (no extra dependencies).
'use strict';
const { run } = require('./proc');
const log = require('./log');

// PowerShell's own AppUserModelID is registered on every Windows install, so toasts
// show up without registering a shortcut. The XML arrives on stdin, never on the command line.
const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$x.LoadXml([Console]::In.ReadToEnd())',
  '$t = New-Object Windows.UI.Notifications.ToastNotification $x',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').Show($t)`,
].join('; ');

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

function toast({ title, body, url, sound = false }) {
  if (process.platform !== 'win32') return Promise.resolve();
  const launch = url && /^https?:\/\//.test(url) ? ` activationType="protocol" launch="${esc(url)}"` : '';
  const xml = `<toast${launch}><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual>${sound ? '' : '<audio silent="true"/>'}</toast>`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { input: xml, quiet: true, timeout: 20_000 })
    .catch((e) => log.warn('Toast failed', { error: e.message }));
}

module.exports = { toast };
