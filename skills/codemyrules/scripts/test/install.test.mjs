import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findExecutable, hookEntries, mergeSettings, validateLoopConfig } from '../install.mjs';

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
const CLI = path.join(path.dirname(INSTALL), 'cli.mjs');
const HOOKS = hookEntries('/pkg/cli.mjs');

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

// --cli points the hooks at this checkout; without it the installer looks for the global npm package
const run = (dir, cfg, ...extra) =>
  spawnSync('node', [INSTALL, dir, '--config', cfg, '--cli', CLI, ...extra], { encoding: 'utf8' });

test('mergeSettings keeps existing keys, adds hooks, is idempotent', () => {
  const existing = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
  };
  const once = mergeSettings(existing, HOOKS);
  assert.deepEqual(once.permissions, existing.permissions);
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.hooks.PreToolUse.length, 2);
  assert.equal(once.hooks.PostToolUse.length, 2);
  assert.deepEqual(mergeSettings(once, HOOKS), once);
  assert.equal(HOOKS.Stop[0].matcher, undefined);
});

test('each hook entry has an explicit timeout in seconds', () => {
  const t = (e) => HOOKS[e][0].hooks[0].timeout;
  assert.deepEqual([t('PreToolUse'), t('PostToolUse'), t('Stop')], [10, 30, 120]);
});

test('the shell guard runs before and after Bash and NotebookEdit', () => {
  for (const e of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    const shell = HOOKS[e].find((x) => x.hooks[0].command.endsWith(' hook shell'));
    assert.equal(shell.matcher, 'Bash|NotebookEdit', e);
  }
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
  // no copies: the hooks run the npm package, the project keeps only its config
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude/codemyrules')), ['loop.json']);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
  assert.equal(s.hooks.Stop.length, 1);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, `node "${CLI}" hook guard`);
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
  assert.ok(r.stderr.includes(`codemyrules: ${dir} is not a git repository`), r.stderr);
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
    const sg = { name: 'ast-grep', format: 'ast-grep', command: ['npx', 'ast-grep', 'scan', '--json=compact', '{files}'], extensions: ['.java'], tier: 'full' };
    assert.match(validateLoopConfig({ linters: [sg], protect: [] }, dir).join('\n'), /linters\[0\].*sgconfig\.yml/);
    const viaC = { ...sg, command: ['npx', 'ast-grep', 'scan', '-c', 'sgconfig.suggestions.yml', '{files}'] };
    assert.match(validateLoopConfig({ linters: [viaC], protect: [] }, dir).join('\n'), /linters\[0\].*sgconfig\.suggestions\.yml.*does not exist/);
    fs.writeFileSync(path.join(dir, 'sgconfig.suggestions.yml'), 'ruleDirs: [rules, suggestions]\n');
    assert.deepEqual(validateLoopConfig({ linters: [viaC], protect: [] }, dir), []);
    fs.writeFileSync(path.join(dir, 'sgconfig.yml'), 'ruleDirs: [rules]\n');
    assert.deepEqual(validateLoopConfig({ linters: [sg], protect: [] }, dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validateLoopConfig refuses a package runner in the fast tier, where it would resolve the package on every edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    fs.writeFileSync(path.join(dir, 'sgconfig.yml'), 'ruleDirs: [rules]\n');
    const sg = (command, tier = 'fast') => ({ linters: [{ name: 'ast-grep', format: 'ast-grep', command, extensions: ['.kt'], tier }], protect: [] });
    for (const runner of [['npx', '-y', '-p', '@ast-grep/cli@0.39.0', 'ast-grep'], ['npm', 'exec', '--', 'ast-grep'], ['pnpm', 'dlx', '@ast-grep/cli'], ['yarn', 'dlx', '@ast-grep/cli'], ['bunx', '@ast-grep/cli']]) {
      const errs = validateLoopConfig(sg([...runner, 'scan', '--json=compact', '{files}']), dir).filter((e) => !/is not installed/.test(e));
      assert.match(errs.join('\n'), /linters\[0\].*runs through .* on every edit.*full tier/, runner.join(' '));
      assert.deepEqual(validateLoopConfig(sg([...runner, 'scan', '--json=compact', '{files}'], 'full'), dir).filter((e) => !/is not installed/.test(e)), [], runner.join(' '));
    }
    fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/.bin/ast-grep'), '');
    assert.deepEqual(validateLoopConfig(sg(['node_modules/.bin/ast-grep', 'scan', '--json=compact', '{files}']), dir), []);
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

test('without --config and without an installed loop.json, the installer explains its usage', (t) => {
  const { dir } = tempRepo(t);
  const r = spawnSync('node', [INSTALL, dir], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('SKILL.md and plugin.json carry the same version', () => {
  const root = path.join(path.dirname(INSTALL), '../../..');
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8')).version;
  const skill = /^version:\s*"?([^"\n]+)"?$/m.exec(fs.readFileSync(path.join(root, 'skills/codemyrules/SKILL.md'), 'utf8'))?.[1];
  assert.equal(skill, plugin);
});

test('every hook command the installer writes runs as written', (t) => {
  const { dir, cfg } = tempRepo(t);
  assert.equal(run(dir, cfg, '--apply').status, 0);
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8')).hooks;
  const cmd = (event, name) => hooks[event].flatMap((e) => e.hooks).find((h) => h.command.endsWith(` hook ${name}`)).command;
  const exec = (command, input) => spawnSync(command, { shell: true, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  const ask = exec(cmd('PreToolUse', 'guard'), { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.ts'), old_string: 'x', new_string: 'x // eslint-disable-line' } });
  assert.equal(ask.status, 0, ask.stderr);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'ask');
  for (const [event, name, input] of [
    ['PostToolUse', 'edited', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.txt') } }],
    ['Stop', 'turn', {}],
    ['PreToolUse', 'shell', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'i' }],
    ['PostToolUse', 'shell', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'i' }],
  ]) {
    const r = exec(cmd(event, name), input);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout, '', name);
  }
});

test('installing over a copy-based install removes the copies and their hook entries, keeps the user\'s own hooks', (t) => {
  const { dir, cfg } = tempRepo(t);
  const state = path.join(dir, '.claude/codemyrules');
  fs.mkdirSync(path.join(state, 'core'), { recursive: true });
  for (const f of ['lib.mjs', 'secret-patterns.json', 'guard.mjs', 'shell-guard.mjs', 'lint-edited.mjs', 'lint-turn.mjs', 'core/lib.mjs', 'core/checks.mjs']) fs.writeFileSync(path.join(state, f), 'old');
  fs.writeFileSync(path.join(state, 'failures.log'), '{"ruleId":"r"}\n');
  const old = (script) => ({ hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/.claude/codemyrules/${script}"`, timeout: 10 }] });
  fs.writeFileSync(path.join(dir, '.claude/settings.local.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', ...old('guard.mjs') }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', ...old('lint-edited.mjs') }],
    Stop: [old('lint-turn.mjs')],
  } }));
  const dry = run(dir, cfg);
  assert.match(dry.stdout, /^delete .*guard\.mjs$/m);
  assert.ok(fs.existsSync(path.join(state, 'guard.mjs')));
  assert.equal(run(dir, cfg, '--apply').status, 0);
  assert.deepEqual(fs.readdirSync(state).sort(), ['failures.log', 'loop.json']);
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8')).hooks;
  const commands = Object.values(hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(commands.includes('echo mine'));
  assert.ok(!commands.some((c) => c.includes('.claude/codemyrules/')), commands.join('\n'));
  assert.equal(commands.filter((c) => c.endsWith(' hook guard')).length, 1);
});

// a throwaway global npm prefix laid out the way `npm install -g` does it, on PATH ahead of nothing else
function npmPrefix(t) {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-npm-')));
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));
  const win = process.platform === 'win32';
  const bin = win ? prefix : path.join(prefix, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(prefix, win ? 'node_modules' : 'lib/node_modules', 'codemyrules/skills/codemyrules/scripts/cli.mjs');
  // the real PATH minus any directory with a real codemyrules on it
  const rest = (process.env.PATH ?? '').split(path.delimiter).filter((d) => !['codemyrules', 'codemyrules.cmd'].some((f) => fs.existsSync(path.join(d, f))));
  const env = { ...process.env, PATH: [bin, ...rest].join(path.delimiter) };
  const install = () => {
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '');
    if (win) fs.writeFileSync(path.join(bin, 'codemyrules.cmd'), '');
    else fs.symlinkSync(cli, path.join(bin, 'codemyrules'));
  };
  return { env, cli, install };
}

test('without --cli the hooks point at the global npm package, and without one the installer says how to get it', (t) => {
  const { dir, cfg } = tempRepo(t);
  const { env, cli, install } = npmPrefix(t);
  const r = spawnSync(process.execPath, [INSTALL, dir, '--config', cfg, '--apply'], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm install -g codemyrules/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  install();
  const ok = spawnSync(process.execPath, [INSTALL, dir, '--config', cfg, '--apply'], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8'));
  assert.equal(s.hooks.Stop[0].hooks[0].command, `node "${cli}" hook turn`);
});

test('validateLoopConfig checks a linter cwd and resolves its command and config from there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    fs.mkdirSync(path.join(dir, 'apps/web/node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps/web/node_modules/.bin/eslint'), '');
    fs.writeFileSync(path.join(dir, 'apps/web/eslint.config.mjs'), '');
    const web = { ...goodLinter, cwd: 'apps/web', command: ['node_modules/.bin/eslint', '-c', 'eslint.config.mjs', '--format', 'json', '{files}'] };
    assert.deepEqual(validateLoopConfig({ linters: [web], protect: [] }, dir), []);
    const errs = (l) => validateLoopConfig({ linters: [{ ...web, ...l }], protect: [] }, dir).join('\n');
    assert.match(errs({ cwd: 'apps/nope' }), /linters\[0\]\.cwd "apps\/nope" is not a folder in the project/);
    assert.match(errs({ cwd: '../elsewhere' }), /linters\[0\]\.cwd .* in the project/);
    assert.match(errs({ cwd: 3 }), /linters\[0\]\.cwd must be a path/);
    // without the cwd, the same command and config are looked up from the root, where they do not exist
    const { cwd, ...rootLinter } = web;
    assert.match(validateLoopConfig({ linters: [rootLinter], protect: [] }, dir).join('\n'), /is not installed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
