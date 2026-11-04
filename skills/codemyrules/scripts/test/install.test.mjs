import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOKS, findExecutable, mergeSettings, validateLoopConfig } from '../install.mjs';

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const cfg = path.join(dir, '..', path.basename(dir) + '-loop.json');
  fs.writeFileSync(cfg, JSON.stringify({ linters: [], protect: [] }));
  t.after(() => fs.rmSync(cfg, { force: true }));
  return { dir, cfg, git };
}

const run = (dir, cfg, ...extra) =>
  spawnSync('node', [INSTALL, dir, '--config', cfg, ...extra], { encoding: 'utf8' });

test('mergeSettings keeps existing keys, adds hooks, is idempotent', () => {
  const existing = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
  };
  const once = mergeSettings(existing);
  assert.deepEqual(once.permissions, existing.permissions);
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.hooks.PreToolUse.length, 1);
  assert.equal(once.hooks.PostToolUse.length, 1);
  assert.deepEqual(mergeSettings(once), once);
  assert.equal(HOOKS.Stop[0].matcher, undefined);
});

test('each hook entry has an explicit timeout in seconds', () => {
  const t = (e) => HOOKS[e][0].hooks[0].timeout;
  assert.deepEqual([t('PreToolUse'), t('PostToolUse'), t('Stop')], [10, 30, 120]);
});

test('dry run writes nothing', (t) => {
  const { dir, cfg } = tempRepo(t);
  const r = run(dir, cfg);
  assert.equal(r.status, 0);
  assert.throws(() => fs.readdirSync(path.join(dir, '.claude')), { code: 'ENOENT' });
});

test('--apply installs files, is idempotent, and leaves git clean', (t) => {
  const { dir, cfg, git } = tempRepo(t);
  assert.equal(run(dir, cfg, '--apply').status, 0);
  assert.equal(run(dir, cfg, '--apply').status, 0);
  for (const f of ['lib', 'lint-turn', 'lint-edited', 'guard'])
    assert.ok(fs.existsSync(path.join(dir, '.claude/codemyrules', f + '.mjs')));
  assert.ok(fs.existsSync(path.join(dir, '.claude/codemyrules/loop.json')));
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
  assert.equal(s.hooks.Stop.length, 1);
  const ex = fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8');
  assert.equal(ex.split('\n').filter((l) => l === '.claude/codemyrules/').length, 1);
  assert.equal(ex.split('\n').filter((l) => l === '.claude/settings.local.json').length, 1);
  assert.equal(git('status', '--porcelain').stdout, '');
});

test('non-repo dir exits 1', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = run(dir, path.join(dir, 'x.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`codemyrules: ${dir.replace(/[/.]/g, '\\$&')} is not a git repository`));
});

const goodLinter = { name: 'eslint', format: 'eslint', command: ['node', 'node_modules/eslint/bin/eslint.js', '--format', 'json', '{files}'], extensions: ['.ts'], tier: 'full' };

test('validateLoopConfig accepts a valid config and an empty one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    assert.deepEqual(validateLoopConfig({ linters: [goodLinter], protect: ['eslint.config.*'] }, dir), []);
    assert.deepEqual(validateLoopConfig({ linters: [], protect: [] }, dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validateLoopConfig names every broken field', () => {
  const dir = os.tmpdir();
  const errs = validateLoopConfig({
    linters: [{ name: '', format: 'bogus', command: 'eslint {files}', extensions: ['ts'], tier: 'medium' }, { ...goodLinter, command: ['eslint'] }],
    protect: 'eslint.config.ts',
    linter: [],
  }, dir).join('\n');
  for (const want of [/linters\[0\]\.name/, /linters\[0\]\.format.*bogus/, /linters\[0\]\.command/, /linters\[0\]\.extensions/, /linters\[0\]\.tier.*medium/, /linters\[1\]\.command.*\{files\}/, /protect/, /unknown key.*linter/]) {
    assert.match(errs, want);
  }
});

test('validateLoopConfig refuses ast-grep without an sgconfig the command can find', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    const sg = { name: 'ast-grep', format: 'ast-grep', command: ['npx', 'ast-grep', 'scan', '--json=compact', '{files}'], extensions: ['.java'], tier: 'fast' };
    assert.match(validateLoopConfig({ linters: [sg], protect: [] }, dir).join('\n'), /linters\[0\].*sgconfig\.yml/);
    const viaC = { ...sg, command: ['npx', 'ast-grep', 'scan', '-c', 'sgconfig.suggestions.yml', '{files}'] };
    assert.match(validateLoopConfig({ linters: [viaC], protect: [] }, dir).join('\n'), /linters\[0\].*sgconfig\.suggestions\.yml.*does not exist/);
    fs.writeFileSync(path.join(dir, 'sgconfig.suggestions.yml'), 'ruleDirs: [rules, suggestions]\n');
    assert.deepEqual(validateLoopConfig({ linters: [viaC], protect: [] }, dir), []);
    fs.writeFileSync(path.join(dir, 'sgconfig.yml'), 'ruleDirs: [rules]\n');
    assert.deepEqual(validateLoopConfig({ linters: [sg], protect: [] }, dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validateLoopConfig refuses a -c or --config path that does not exist, for any linter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    const es = { name: 'eslint', format: 'eslint', command: ['node', 'node_modules/eslint/bin/eslint.js', '--config', 'eslint.config.suggestions.mjs', '--format', 'json', '{files}'], extensions: ['.ts'], tier: 'full' };
    assert.match(validateLoopConfig({ linters: [es], protect: [] }, dir).join('\n'), /linters\[0\].*eslint\.config\.suggestions\.mjs.*does not exist/);
    fs.writeFileSync(path.join(dir, 'eslint.config.suggestions.mjs'), 'export default [];\n');
    assert.deepEqual(validateLoopConfig({ linters: [es], protect: [] }, dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an invalid or unreadable config exits 1 and writes nothing, even with --apply', (t) => {
  const { dir, cfg } = tempRepo(t);
  fs.writeFileSync(cfg, JSON.stringify({ linters: [{ ...goodLinter, tier: 'medium' }], protect: [] }));
  let r = run(dir, cfg, '--apply');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codemyrules: invalid loop config/);
  assert.match(r.stderr, /tier/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  fs.writeFileSync(cfg, '{ not json');
  r = run(dir, cfg, '--apply');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codemyrules: could not read loop config/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

test('validateLoopConfig refuses a command whose tool is not installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    const ruff = { name: 'ruff', format: 'ruff', command: ['cmr-no-such-tool', 'run', 'ruff', 'check', '{files}'], extensions: ['.py'], tier: 'full' };
    assert.match(validateLoopConfig({ linters: [ruff], protect: [] }, dir).join('\n'), /linters\[0\].*"cmr-no-such-tool" is not installed/);
    const local = { ...goodLinter, command: ['node_modules/.bin/eslint', '{files}'] };
    assert.match(validateLoopConfig({ linters: [local], protect: [] }, dir).join('\n'), /"node_modules\/\.bin\/eslint" is not installed/);
    fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/.bin/eslint'), '');
    assert.deepEqual(validateLoopConfig({ linters: [local], protect: [] }, dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findExecutable looks a bare name up on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    fs.writeFileSync(path.join(dir, 'mytool'), '');
    assert.equal(findExecutable('mytool', os.tmpdir(), { PATH: dir }), true);
    assert.equal(findExecutable('mytool', os.tmpdir(), { PATH: os.tmpdir() }), false);
    assert.equal(findExecutable('node', dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
