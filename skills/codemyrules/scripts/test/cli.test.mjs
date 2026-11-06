import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(import.meta.dirname, '..', 'cli.mjs');
const ROOT = path.join(import.meta.dirname, '../../../..');
const json = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const cli = (args, opts = {}) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });

test('--version prints the package version', () => {
  const r = cli(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), json('package.json').version);
});

test('package.json, plugin.json and SKILL.md carry the same version', () => {
  const skill = /^version:\s*"?([^"\n]+)"?$/m.exec(fs.readFileSync(path.join(ROOT, 'skills/codemyrules/SKILL.md'), 'utf8'))?.[1];
  assert.equal(json('.claude-plugin/plugin.json').version, json('package.json').version);
  assert.equal(skill, json('package.json').version);
});

test('hook guard behaves like the guard script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    const input = { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.ts'), old_string: 'x', new_string: 'x // @ts-ignore' } };
    const r = cli(['hook', 'guard'], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hook turn passes the exit code through', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    const r = cli(['hook', 'turn'], { input: '{}', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install and measure pass their arguments on', () => {
  assert.equal(cli(['install']).status, 2);
  assert.match(cli(['install']).stderr, /usage: .*install/);
  assert.equal(cli(['measure']).status, 2);
  assert.match(cli(['measure']).stderr, /usage: .*measure/);
});

test('an unknown command prints the usage and exits 2', () => {
  for (const args of [[], ['nope'], ['hook', 'nope']]) {
    const r = cli(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: codemyrules/);
  }
});

test('the package ships the scripts and nothing else of the repo', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path.split(path.sep).join('/'));
  for (const f of ['package.json', 'LICENSE', 'README.md', 'skills/codemyrules/scripts/cli.mjs', 'skills/codemyrules/scripts/install.mjs',
    'skills/codemyrules/scripts/guard.mjs', 'skills/codemyrules/scripts/core/lib.mjs', 'skills/codemyrules/scripts/core/secret-patterns.json']) {
    assert.ok(files.includes(f), `missing ${f}`);
  }
  for (const f of files) assert.doesNotMatch(f, /(^|\/)(test|notes|blog|\.github)\//, f);
  const bin = json('package.json').bin.codemyrules;
  assert.match(fs.readFileSync(path.join(ROOT, bin), 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

function installedRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const cfg = path.join(dir, '..', `${path.basename(dir)}-loop.json`);
  t.after(() => fs.rmSync(cfg, { force: true }));
  fs.writeFileSync(cfg, JSON.stringify({ linters: [{ name: 'eslint', format: 'eslint', tier: 'full', extensions: ['.ts'], cwd: '.', command: ['node', 'x.js', '{files}'] }], protect: ['**/eslint.config.*'] }));
  const sp = path.join(dir, '.claude/settings.local.json');
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  const r = cli(['install', dir, '--config', cfg, '--cli', CLI, '--apply']);
  assert.equal(r.status, 0, r.stderr);
  return { dir, sp };
}

test('uninstall is a dry run by default, then removes the setup and only codemyrules hook entries', (t) => {
  const { dir, sp } = installedRepo(t);
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/failures.log'), '{"ruleId":"r"}\n');
  const dry = cli(['uninstall', dir]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /delete .*\.claude[/\\]codemyrules/);
  assert.match(dry.stdout, /failures\.log/);
  assert.ok(fs.existsSync(path.join(dir, '.claude/codemyrules/loop.json')));
  assert.equal(cli(['uninstall', dir, '--apply']).status, 0);
  assert.equal(fs.existsSync(path.join(dir, '.claude/codemyrules')), false);
  const commands = Object.values(JSON.parse(fs.readFileSync(sp, 'utf8')).hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));
  assert.deepEqual(commands, ['echo mine']);
  assert.match(cli(['uninstall', dir]).stdout, /nothing to change/);
});

test('status shows the package, the hooks, the config and recent failures', (t) => {
  const { dir } = installedRepo(t);
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/failures.log'), [
    { ts: now, event: 'edit', ruleId: 'no-raw-fetch' }, { ts: now, event: 'turn', ruleId: 'no-raw-fetch' },
    { ts: '2020-01-01T00:00:00.000Z', event: 'edit', ruleId: 'old-rule' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = cli(['status', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`codemyrules ${json('package.json').version.replace(/\./g, '\\.')}`));
  assert.match(r.stdout, /hooks: 6 entries, all run .*cli\.mjs/);
  assert.match(r.stdout, /eslint \(full, \.ts, cwd \.\)/);
  assert.match(r.stdout, /\*\*\/eslint\.config\.\*/);
  assert.match(r.stdout, /no-raw-fetch: 2/);
  assert.doesNotMatch(r.stdout, /old-rule/);
});

test('status names broken hooks, copies from 0.4 and a missing install', (t) => {
  const { dir, sp } = installedRepo(t);
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: 'node "/gone/cli.mjs" hook turn' }] });
  fs.writeFileSync(sp, JSON.stringify(s));
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/guard.mjs'), 'old');
  const r = cli(['status', dir]);
  assert.match(r.stdout, /missing: \/gone\/cli\.mjs/);
  assert.match(r.stdout, /copies from before the npm package: guard\.mjs/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.match(cli(['status', empty]).stdout, /not installed/);
});
