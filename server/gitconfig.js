// The user's global git configuration: a fixed list of well-understood settings can be changed,
// everything else is shown read-only.
'use strict';
const { run } = require('./proc');

// key -> allowed values (array), or a validator function for free text
const text = (max = 200) => (v) => typeof v === 'string' && v.length <= max && !/[\r\n]/.test(v);
const EDITABLE = {
  'user.name': text(), 'user.email': (v) => text()(v) && (v === '' || /^[^\s@]+@[^\s@]+$/.test(v)),
  'init.defaultbranch': (v) => v === '' || /^[A-Za-z0-9._/-]{1,100}$/.test(v),
  'pull.rebase': ['', 'false', 'true'], 'pull.ff': ['', 'only', 'true', 'false'],
  'push.autosetupremote': ['', 'true', 'false'], 'push.default': ['', 'simple', 'current', 'upstream'],
  'fetch.prune': ['', 'true', 'false'],
  'core.autocrlf': ['', 'true', 'input', 'false'], 'core.longpaths': ['', 'true', 'false'], 'core.editor': text(300),
  'rerere.enabled': ['', 'true', 'false'], 'merge.conflictstyle': ['', 'merge', 'diff3', 'zdiff3'],
  'credential.helper': text(200),
};

const g = (args, opts = {}) => run('git', ['config', '--global', ...args], { timeout: 15_000, ...opts });

async function get() {
  let all = [];
  try {
    const r = await g(['--list', '-z'], { quiet: true, okCodes: [0, 1, 128] });
    all = r.stdout.split('\0').filter(Boolean).map((e) => { const i = e.indexOf('\n'); return i < 0 ? { key: e, value: '' } : { key: e.slice(0, i), value: e.slice(i + 1) }; });
  } catch {}
  const values = {};
  for (const k of Object.keys(EDITABLE)) { const hit = all.filter((x) => x.key.toLowerCase() === k).pop(); values[k] = hit ? hit.value : ''; }
  let file = null;
  try { file = (await g(['--list', '--show-origin', '-z'], { quiet: true, okCodes: [0, 1, 128] })).stdout.split('\0')[0].replace(/^file:/, '') || null; } catch {}
  let version = '';
  try { version = (await run('git', ['--version'], { quiet: true, timeout: 10_000 })).stdout.trim(); } catch {}
  // never show values that may hold secrets
  const shown = all.map((x) => (/(token|password|secret|extraheader)/i.test(x.key) || /:\/\/[^/\s]*:[^@\s]+@/.test(x.value) ? { key: x.key, value: '(hidden)' } : x));
  return { values, all: shown, file, version };
}

async function set({ key, value }) {
  const k = String(key || '').toLowerCase();
  const rule = EDITABLE[k];
  if (!rule) throw new Error(`"${key}" cannot be changed here. Edit your .gitconfig for other settings.`);
  const v = String(value ?? '');
  if (Array.isArray(rule) ? !rule.includes(v) : !rule(v)) throw new Error(`"${v}" is not a valid value for ${key}.`);
  if (v === '') await g(['--unset-all', k], { okCodes: [0, 5] });
  else await g([k, v]);
  return get();
}

module.exports = { get, set, EDITABLE };
