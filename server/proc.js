// Safe process runner: argument arrays only, never a shell.
'use strict';
const { spawn } = require('node:child_process');
const log = require('./log');

const BASE_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',   // never block waiting for a terminal prompt
  GCM_INTERACTIVE: 'auto',    // Git Credential Manager may still show its GUI
  GIT_OPTIONAL_LOCKS: '0',    // read-only commands must not take index.lock
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  CLICOLOR: '0',
  GH_PAGER: '',
  GIT_PAGER: '',
  PAGER: '',
};

class ProcError extends Error {
  constructor(res) {
    const first = (res.stderr || res.stdout || '').trim().split('\n').slice(-6).join('\n');
    super(first || `${res.cmd} exited with code ${res.code}`);
    this.name = 'ProcError';
    this.code = res.code;
    this.stderr = res.stderr;
    this.stdout = res.stdout;
    this.command = res.display;
    this.timedOut = res.timedOut;
    this.cancelled = res.cancelled;
  }
}

const running = new Map(); // opId -> child
let opCounter = 0;

function quoteForDisplay(a) {
  return /[\s"'`$]/.test(a) || a === '' ? JSON.stringify(a) : a;
}

/**
 * Run a program.
 * opts: cwd, input (string|Buffer), timeout (ms), env (extra), okCodes ([0]),
 *       binary (return Buffer stdout), repo (for activity log), opId, quiet,
 *       redact (array of strings to hide in the logged command)
 */
function run(cmd, args, opts = {}) {
  const timeout = opts.timeout ?? 60_000;
  const okCodes = opts.okCodes || [0];
  const opId = opts.opId || `op${++opCounter}`;
  const display = [cmd, ...(opts.displayArgs || args).map(quoteForDisplay)].join(' ');
  const started = Date.now();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...BASE_ENV, ...(opts.env || {}) },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(new ProcError({ cmd, display, code: -1, stderr: e.message, stdout: '' }));
    }
    running.set(opId, child);
    const out = [];
    const err = [];
    let outLen = 0;
    const maxOut = opts.maxBuffer ?? 64 * 1024 * 1024;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    child.stdout.on('data', (d) => {
      if (outLen + d.length > maxOut) { truncated = true; return; }
      outLen += d.length; out.push(d);
    });
    child.stderr.on('data', (d) => { if (err.length < 2000) err.push(d); });
    child.stdin.on('error', () => {});
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();

    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout) : null;

    child.on('cancel', () => { cancelled = true; killTree(child); });

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      running.delete(opId);
      const res = { cmd, display, code: -1, stdout: '', stderr: e.code === 'ENOENT' ? `${cmd} is not installed or not on PATH` : e.message };
      log.activity({ repo: opts.repo, command: opts.quiet ? null : redact(display, opts.redact), ms: Date.now() - started, ok: false, error: res.stderr });
      reject(new ProcError(res));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      running.delete(opId);
      const stdoutBuf = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      const res = {
        cmd, display, code,
        stdout: opts.binary ? stdoutBuf : stdoutBuf.toString('utf8'),
        stderr, truncated, timedOut, cancelled,
        ms: Date.now() - started,
      };
      const ok = !timedOut && !cancelled && okCodes.includes(code);
      if (!opts.quiet) {
        log.activity({
          repo: opts.repo, command: redact(display, opts.redact), ms: res.ms, ok, code,
          error: ok ? undefined : (timedOut ? `Timed out after ${Math.round(timeout / 1000)} s` : cancelled ? 'Cancelled' : stderr.trim().slice(0, 4000)),
          output: opts.logOutput ? (stderr + (typeof res.stdout === 'string' ? res.stdout : '')).slice(0, 4000) : undefined,
        });
      }
      if (ok) return resolve(res);
      if (timedOut) res.stderr = `Timed out after ${Math.round(timeout / 1000)} s. ` +
        'If this needed a password or passphrase, the app cannot answer prompts: set up a credential helper or ssh-agent.\n' + stderr;
      if (cancelled) res.stderr = 'Cancelled by user.\n' + stderr;
      reject(new ProcError(res));
    });
  });
}

function redact(s, list) {
  if (!list) return s;
  for (const r of list) if (r) s = s.split(r).join('***');
  return s;
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { child.kill(); }
  } else child.kill('SIGTERM');
}

function cancel(opId) {
  const c = running.get(opId);
  if (!c) return false;
  c.emit('cancel');
  return true;
}

module.exports = { run, cancel, ProcError };
