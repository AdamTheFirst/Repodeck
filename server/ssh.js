// SSH connections: host aliases in ~/.ssh/config and the keys they use.
// Reads are harmless. Every write to the config file is preceded by a timestamped backup,
// only touches the one Host block concerned, and private keys are never read or sent anywhere.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./proc');
const { paths } = require('./paths');

const sshDir = () => process.env.REPODECK_SSH_DIR || path.join(os.homedir(), '.ssh');
const configFile = () => path.join(sshDir(), 'config');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

// ---------------- pure helpers (unit tested) ----------------

/** Split an ssh config into Host blocks. Lines before the first Host and Match blocks are kept as-is by the writers. */
function parseConfig(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  lines.forEach((line, i) => {
    const m = /^\s*(Host|Match)\s+(.+?)\s*$/i.exec(line);
    if (m) {
      if (cur) cur.end = i - 1;
      cur = m[1].toLowerCase() === 'host' ? { start: i, end: i, hosts: m[2].split(/\s+/), options: {} } : null;
      if (cur) blocks.push(cur);
      return;
    }
    if (!cur) return;
    const o = /^\s*([A-Za-z]+)[\s=]+(.+?)\s*$/.exec(line);
    if (o && !line.trim().startsWith('#')) cur.options[o[1].toLowerCase()] = o[2].replace(/^"(.*)"$/, '$1');
    cur.end = i;
  });
  // a block ends before trailing blank lines and before comments that introduce the next block
  for (const b of blocks) {
    while (b.end > b.start && (!lines[b.end].trim() || lines[b.end].trim().startsWith('#'))) b.end--;
  }
  return { lines, blocks };
}

function hostBlock({ alias, hostName, user, identityFile }) {
  return [
    `Host ${alias}`,
    `    HostName ${hostName}`,
    `    User ${user}`,
    `    IdentityFile ${identityFile}`,
    '    IdentitiesOnly yes',
  ];
}

/** Text with a new Host block appended. */
function addHostText(text, spec) {
  const { blocks } = parseConfig(text);
  if (blocks.some((b) => b.hosts.includes(spec.alias))) throw new Error(`A connection named "${spec.alias}" already exists.`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text.replace(/\s+$/, '');
  return `${body}${body ? eol + eol : ''}# Added by Repodeck${eol}${hostBlock(spec).join(eol)}${eol}`;
}

/** Text with one alias removed: the whole block when it is the only name on the Host line, else just that name. */
function removeHostText(text, alias) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const { lines, blocks } = parseConfig(text);
  const b = blocks.find((x) => x.hosts.includes(alias));
  if (!b) throw new Error(`No connection named "${alias}" was found.`);
  if (b.hosts.length > 1) {
    lines[b.start] = lines[b.start].replace(/^(\s*Host\s+)(.+?)\s*$/i, (_, pre) => pre + b.hosts.filter((h) => h !== alias).join(' '));
    return lines.join(eol);
  }
  let start = b.start;
  if (start > 0 && lines[start - 1].trim() === '# Added by Repodeck') start--;
  let end = b.end;
  while (end + 1 < lines.length && !lines[end + 1].trim()) end++; // swallow the blank lines that followed it
  lines.splice(start, end - start + 1);
  return lines.join(eol).replace(/(\r?\n){3,}/g, eol + eol);
}

// ---------------- file access ----------------

function readConfig() { try { return fs.readFileSync(configFile(), 'utf8'); } catch { return ''; } }

function writeConfig(text) {
  fs.mkdirSync(sshDir(), { recursive: true });
  const f = configFile();
  let backup = null;
  if (fs.existsSync(f)) {
    backup = path.join(paths.backups, `ssh-config-${Date.now()}.bak`);
    fs.copyFileSync(f, backup);
  }
  const tmp = `${f}.repodeck-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
  return backup;
}

const expand = (p) => (p || '').replace(/^~(?=$|[\\/])/, os.homedir()).replace(/%d/g, os.homedir());
const collapse = (p) => { const h = os.homedir(); return p.toLowerCase().startsWith(h.toLowerCase()) ? `~${p.slice(h.length).replace(/\\/g, '/')}` : p.replace(/\\/g, '/'); };

async function keyInfo(file) {
  const priv = expand(file);
  const pub = `${priv}.pub`;
  const info = { file, exists: fs.existsSync(priv), hasPublic: fs.existsSync(pub), type: null, fingerprint: null, comment: null };
  if (!info.hasPublic) return info;
  try {
    const r = await run('ssh-keygen', ['-l', '-f', pub], { quiet: true, timeout: 10_000 });
    const m = /^(\d+)\s+(\S+)\s+(.*?)\s+\((\w+)\)\s*$/.exec(r.stdout.trim());
    if (m) { info.fingerprint = m[2]; info.comment = m[3]; info.type = m[4].toLowerCase(); }
  } catch {}
  return info;
}

/** Connections and keys. `github` marks hosts that lead to GitHub. */
async function list() {
  const text = readConfig();
  const { blocks } = parseConfig(text);
  const connections = [];
  for (const b of blocks) {
    for (const alias of b.hosts) {
      if (/[*?!]/.test(alias)) continue;
      const hostName = b.options.hostname || alias;
      connections.push({
        alias, hostName, user: b.options.user || '', identityFile: b.options.identityfile || '', port: b.options.port || '',
        github: /(^|\.)github\.com$/i.test(hostName), shared: b.hosts.length > 1 ? b.hosts.filter((h) => h !== alias) : [],
        key: b.options.identityfile ? await keyInfo(b.options.identityfile) : null,
      });
    }
  }
  let files = [];
  try { files = fs.readdirSync(sshDir()).filter((n) => n.endsWith('.pub')); } catch {}
  const keys = [];
  for (const n of files) keys.push(await keyInfo(collapse(path.join(sshDir(), n.slice(0, -4)))));
  let version = null;
  try { version = (await run('ssh', ['-V'], { quiet: true, timeout: 10_000 })).stderr.trim().split(',')[0]; } catch {}
  return { configFile: configFile(), exists: !!text, connections, keys, ssh: version };
}

async function publicKey(file) {
  const pub = `${expand(file)}.pub`;
  if (path.dirname(path.resolve(pub)).toLowerCase() !== path.resolve(sshDir()).toLowerCase()) throw new Error('Only keys in your .ssh folder can be read.');
  return fs.readFileSync(pub, 'utf8').trim();
}

/** New ed25519 key pair in ~/.ssh. Never overwrites. No passphrase: the app cannot type one for git later. */
async function generateKey({ name, comment }) {
  if (!NAME.test(name || '')) throw new Error('Use letters, digits, dots, dashes or underscores for the key name.');
  const file = path.join(sshDir(), name);
  if (fs.existsSync(file) || fs.existsSync(`${file}.pub`)) throw new Error(`A key named "${name}" already exists.`);
  fs.mkdirSync(sshDir(), { recursive: true });
  await run('ssh-keygen', ['-t', 'ed25519', '-f', file, '-N', '', '-C', String(comment || name).replace(/[\r\n]/g, ' ').slice(0, 120), '-q'], { timeout: 30_000, quiet: true });
  return keyInfo(collapse(file));
}

async function addHost({ alias, hostName = 'github.com', user = 'git', identityFile }) {
  if (!NAME.test(alias || '')) throw new Error('A connection name can only contain letters, digits, dots, dashes and underscores.');
  if (!/^[A-Za-z0-9.-]+$/.test(hostName)) throw new Error('Invalid host name.');
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error('Invalid user name.');
  if (!identityFile || /[\r\n"]/.test(identityFile)) throw new Error('Choose a key.');
  if (!fs.existsSync(expand(identityFile))) throw new Error(`The key file ${identityFile} does not exist.`);
  const backup = writeConfig(addHostText(readConfig(), { alias, hostName, user, identityFile: collapse(expand(identityFile)) }));
  return { backup };
}

async function removeHost({ alias }) {
  const backup = writeConfig(removeHostText(readConfig(), alias));
  return { backup };
}

/** Try to authenticate. GitHub answers "Hi <login>!" and exit code 1 on success. */
async function test({ alias }) {
  if (!NAME.test(alias || '')) throw new Error('Invalid connection name');
  let out = '';
  let code = 0;
  try {
    const own = process.env.REPODECK_SSH_DIR ? ['-F', configFile()] : []; // tests and development use their own folder
    const r = await run('ssh', [...own, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', `git@${alias}`], { quiet: true, timeout: 25_000, okCodes: [0, 1, 255] });
    out = `${r.stdout}${r.stderr}`.trim(); code = r.code;
  } catch (e) { out = `${e.stdout || ''}${e.stderr || e.message}`.trim(); code = e.code; }
  const hi = /Hi ([^!]+)!/.exec(out);
  let hint = null;
  if (!hi) {
    hint = /Permission denied \(publickey\)/i.test(out) ? 'GitHub does not know this key. Add the public key to the GitHub account, then test again.'
      : /Could not resolve hostname/i.test(out) ? 'The host name could not be found. Check the connection’s host name.'
        : /Connection timed out|Network is unreachable/i.test(out) ? 'GitHub could not be reached on port 22. Some networks block it; use HTTPS, or the host ssh.github.com on port 443.'
          : /passphrase|sign_and_send_pubkey|agent refused/i.test(out) ? 'The key has a passphrase and no agent is offering it. Start ssh-agent and add the key with ssh-add.'
            : /No such file|not accessible/i.test(out) ? 'The key file named in the connection is missing.' : null;
  }
  return { ok: !!hi, login: hi ? hi[1] : null, output: out.split('\n').slice(-6).join('\n'), code, hint };
}

module.exports = { list, publicKey, generateKey, addHost, removeHost, test, parseConfig, addHostText, removeHostText, configFile, collapse, expand };
