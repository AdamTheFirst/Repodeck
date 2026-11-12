// Is there a newer release? One request to GitHub's public API for the latest release of this project.
// Nothing about the user or the computer is sent. Nothing is downloaded or installed here: the app
// only says that a newer version exists and where to get it.
'use strict';
const https = require('node:https');
const path = require('node:path');
const config = require('./config');
const log = require('./log');

const REPO = 'AdamTheFirst/Repodeck';
const RELEASES = `https://github.com/${REPO}/releases`;
const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Pure: is version a (such as "1.2.0" or "v1.2.0") newer than b? */
function newer(a, b) {
  const parts = (v) => String(v || '').replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}

function latestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'Repodeck', Accept: 'application/vnd.github+json' }, timeout: 15_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 2_000_000) body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`GitHub answered ${res.statusCode}`)); return; }
        try { const j = JSON.parse(body); resolve({ tag: String(j.tag_name || ''), url: String(j.html_url || '') }); } catch { reject(new Error('The answer from GitHub could not be read')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time')));
    req.on('error', reject);
  });
}

// A copy from the Microsoft Store is updated by the Store.
const fromStore = () => path.resolve(__dirname).toLowerCase().includes('\\windowsapps\\');

let last = null; // { at, result }
async function check({ force = false } = {}) {
  const current = require('../package.json').version;
  if (fromStore()) return { current, managed: 'store' };
  if (!force && config.get().checkForUpdates === false) return { current, disabled: true };
  if (!force && last && Date.now() - last.at < SIX_HOURS) return last.result;
  let result;
  try {
    const r = await latestRelease();
    const latest = r.tag.replace(/^v/i, '');
    result = {
      current, latest, available: newer(latest, current), checkedAt: Date.now(),
      notes: r.url.startsWith(`${RELEASES}/`) ? r.url : RELEASES,
      download: `${RELEASES}/latest/download/RepodeckSetup.exe`,
    };
  } catch (e) {
    log.warn('Update check failed', { error: e.message });
    result = { current, error: e.message, checkedAt: Date.now() };
    if (!force) return result; // do not remember a failure: try again next time
  }
  last = { at: Date.now(), result };
  return result;
}

module.exports = { check, newer };
