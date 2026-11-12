'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir, rm } = require('../helpers');

// Backups of the ssh config go to the data folder: keep the test away from the real one.
const dataDir = tmpdir();
process.env.REPODECK_DATA = dataDir;
test.after(() => rm(dataDir));

const SAMPLE = [
  '# my settings',
  'Host *',
  '    ServerAliveInterval 60',
  '',
  '# work account',
  'Host github-work gh-work',
  '    HostName github.com',
  '    User git',
  '    IdentityFile "~/.ssh/id_work"',
  '',
  'Host build',
  '  HostName=10.0.0.5',
  '  Port 2222',
  '',
  'Match host *.internal',
  '    User deploy',
  '',
].join('\n');

test('ssh config: host blocks are parsed, wildcards and Match kept apart', () => {
  const { parseConfig } = require('../../server/ssh');
  const { blocks } = parseConfig(SAMPLE);
  assert.deepEqual(blocks.map((b) => b.hosts), [['*'], ['github-work', 'gh-work'], ['build']]);
  assert.equal(blocks[1].options.hostname, 'github.com');
  assert.equal(blocks[1].options.identityfile, '~/.ssh/id_work');
  assert.equal(blocks[2].options.hostname, '10.0.0.5');
  assert.equal(blocks[2].options.port, '2222');
  assert.equal(blocks[2].options.user, undefined, 'options of the Match block do not leak into the previous host');
});

test('ssh config: adding a host appends one block and keeps everything else', () => {
  const { addHostText, parseConfig } = require('../../server/ssh');
  const out = addHostText(SAMPLE, { alias: 'github-home', hostName: 'github.com', user: 'git', identityFile: '~/.ssh/id_home' });
  assert.ok(out.startsWith(SAMPLE.trimEnd()));
  const b = parseConfig(out).blocks.find((x) => x.hosts.includes('github-home'));
  assert.equal(b.options.identityfile, '~/.ssh/id_home');
  assert.equal(b.options.identitiesonly, 'yes');
  assert.throws(() => addHostText(out, { alias: 'github-home', hostName: 'github.com', user: 'git', identityFile: 'x' }), /already exists/);
  assert.match(addHostText('', { alias: 'a', hostName: 'github.com', user: 'git', identityFile: 'k' }), /^# Added by Repodeck\nHost a\n/);
  assert.ok(addHostText('Host x\r\n  User y\r\n', { alias: 'a', hostName: 'h', user: 'git', identityFile: 'k' }).includes('\r\nHost a\r\n'), 'keeps CRLF files CRLF');
});

test('ssh config: removing a host touches only that host', () => {
  const { addHostText, removeHostText, parseConfig } = require('../../server/ssh');
  const added = addHostText(SAMPLE, { alias: 'github-home', hostName: 'github.com', user: 'git', identityFile: '~/.ssh/id_home' });
  const back = removeHostText(added, 'github-home');
  assert.equal(back.trimEnd(), SAMPLE.trimEnd(), 'add then remove gives the original file');
  // one of two names on a shared Host line: only the name goes
  const shared = removeHostText(SAMPLE, 'gh-work');
  assert.ok(shared.includes('\nHost github-work\n'));
  assert.ok(shared.includes('IdentityFile "~/.ssh/id_work"'));
  // a whole block: neighbours, comments of other blocks and the Match block stay
  const gone = removeHostText(SAMPLE, 'build');
  assert.deepEqual(parseConfig(gone).blocks.map((b) => b.hosts), [['*'], ['github-work', 'gh-work']]);
  assert.ok(gone.includes('Match host *.internal\n    User deploy'));
  assert.ok(gone.includes('# work account'));
  assert.ok(!gone.includes('10.0.0.5'));
  assert.throws(() => removeHostText(SAMPLE, 'nope'), /No connection/);
});

test('ssh: add and remove write the file with a backup, keys are never overwritten', async () => {
  const dir = tmpdir();
  process.env.REPODECK_SSH_DIR = dir;
  try {
    const ssh = require('../../server/ssh');
    fs.writeFileSync(path.join(dir, 'config'), SAMPLE);
    fs.writeFileSync(path.join(dir, 'id_home'), 'not a real key');
    await assert.rejects(ssh.addHost({ alias: 'bad name', identityFile: path.join(dir, 'id_home') }), /can only contain/);
    await assert.rejects(ssh.addHost({ alias: 'ok', identityFile: path.join(dir, 'missing') }), /does not exist/);
    const r = await ssh.addHost({ alias: 'github-home', identityFile: path.join(dir, 'id_home') });
    assert.equal(fs.readFileSync(r.backup, 'utf8'), SAMPLE, 'the previous file is kept as a backup');
    const l = await ssh.list();
    assert.deepEqual(l.connections.map((c) => c.alias), ['github-work', 'gh-work', 'build', 'github-home']);
    assert.equal(l.connections[3].github, true);
    assert.equal(l.connections[2].github, false);
    await assert.rejects(ssh.generateKey({ name: 'id_home' }), /already exists/);
    await assert.rejects(ssh.generateKey({ name: '../evil' }), /letters, digits/);
    await assert.rejects(ssh.publicKey(path.join(dir, '..', 'elsewhere')), /Only keys in your \.ssh folder|ENOENT/);
    await ssh.removeHost({ alias: 'github-home' });
    assert.equal(fs.readFileSync(path.join(dir, 'config'), 'utf8').trimEnd(), SAMPLE.trimEnd());
  } finally { delete process.env.REPODECK_SSH_DIR; rm(dir); }
});

test('git config: only known keys and valid values are accepted', async () => {
  const dir = tmpdir();
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path.join(dir, 'gitconfig');
  try {
    const gc = require('../../server/gitconfig');
    await assert.rejects(gc.set({ key: 'core.sshCommand', value: 'calc.exe' }), /cannot be changed here/);
    await assert.rejects(gc.set({ key: 'alias.x', value: '!calc' }), /cannot be changed here/);
    await assert.rejects(gc.set({ key: 'pull.rebase', value: 'maybe' }), /not a valid value/);
    await assert.rejects(gc.set({ key: 'user.email', value: 'nope' }), /not a valid value/);
    let g = await gc.set({ key: 'pull.rebase', value: 'true' });
    assert.equal(g.values['pull.rebase'], 'true');
    g = await gc.set({ key: 'init.defaultBranch', value: 'main' });
    assert.equal(g.values['init.defaultbranch'], 'main');
    g = await gc.set({ key: 'pull.rebase', value: '' });
    assert.equal(g.values['pull.rebase'], '', 'an empty value removes the setting');
    g = await gc.set({ key: 'pull.rebase', value: '' });
    assert.equal(g.values['pull.rebase'], '', 'clearing twice is fine');
    assert.ok(g.all.some((x) => x.key === 'init.defaultbranch'));
  } finally { if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prev; rm(dir); }
});

test('an account set to SSH rewrites https GitHub addresses for one command', () => {
  const { transportArgs } = require('../../server/git');
  assert.deepEqual(transportArgs(undefined), []);
  assert.deepEqual(transportArgs({ protocol: 'https', host: 'github.com-work' }), []);
  assert.deepEqual(transportArgs({ protocol: 'ssh', host: '' }), ['-c', 'url.git@github.com:.insteadOf=https://github.com/']);
  assert.deepEqual(transportArgs({ protocol: 'ssh', host: 'github.com-work' }), ['-c', 'url.git@github.com-work:.insteadOf=https://github.com/']);
  assert.deepEqual(transportArgs({ protocol: 'ssh', host: 'bad host -oProxyCommand=x' }), ['-c', 'url.git@github.com:.insteadOf=https://github.com/']);
});
