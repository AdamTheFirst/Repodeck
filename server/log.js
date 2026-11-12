// Rotating file log + in-memory activity ring buffer (shown in the UI).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const MAX_FILE = 2 * 1024 * 1024;
const KEEP = 5;
const RING = 2000;

const events = new EventEmitter();
const ring = [];
let seq = 0;
let logDir = null;

function init(dir) {
  logDir = dir;
}

function file() { return logDir && path.join(logDir, 'repodeck.log'); }

function rotate() {
  const f = file();
  try {
    if (fs.statSync(f).size < MAX_FILE) return;
  } catch { return; }
  for (let i = KEEP - 1; i >= 1; i--) {
    try { fs.renameSync(`${f}.${i}`, `${f}.${i + 1}`); } catch {}
  }
  try { fs.renameSync(f, `${f}.1`); } catch {}
}

function write(level, msg, extra) {
  const line = `${new Date().toISOString()} ${level} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
  if (process.env.REPODECK_DEBUG) process.stderr.write(line);
  if (!logDir) return;
  try { rotate(); fs.appendFileSync(file(), line); } catch {}
}

function activity(entry) {
  const e = { id: ++seq, time: Date.now(), ...entry };
  if (!e.command) return e; // quiet entries are not recorded
  ring.push(e);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  write(e.ok ? 'CMD' : 'ERR', `${e.repo ? '[' + e.repo + '] ' : ''}${e.command} (${e.ms} ms${e.ok ? '' : ', failed'})`,
    e.ok ? undefined : { error: (e.error || '').slice(0, 1000) });
  events.emit('activity', e);
  return e;
}

function list(repo, limit = 500) {
  const r = repo ? ring.filter((e) => e.repo === repo) : ring;
  return r.slice(-limit);
}

module.exports = {
  init, activity, list, events,
  info: (m, x) => write('INF', m, x),
  warn: (m, x) => write('WRN', m, x),
  error: (m, x) => write('ERR', m, x),
};
