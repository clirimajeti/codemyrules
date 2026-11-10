// The guard gaps from the 2026-11-09 review, each reproduced the way a user meets it: through the hook scripts
// or the installed hook commands, in a real git repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import codemyrules from '../pi.mjs';

const SCRIPTS = path.join(import.meta.dirname, '..');
const CLI = path.join(SCRIPTS, 'cli.mjs');
const fixture = path.join(import.meta.dirname, 'fixtures', 'fake-eslint.mjs');
const content = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
// Claude Code runs hook commands through bash, also on Windows (Git Bash)
const BASH = process.platform === 'win32' ? 'bash' : '/bin/sh';

// a repo with the loop (fake linter: an error on line 2 of every .ts file), src/a.ts and src/b.ts committed
function repo(t, loop = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-gap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => { const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), JSON.stringify({
    linters: [{ name: 'fake', extensions: ['.ts'], format: 'eslint', tier: 'fast', command: ['node', fixture, '{files}'] }],
    protect: ['eslint.config.js'],
    ...loop,
  }));
  fs.writeFileSync(path.join(dir, 'src/a.ts'), content(6));
  fs.writeFileSync(path.join(dir, 'src/b.ts'), content(6));
  fs.writeFileSync(path.join(dir, 'eslint.config.js'), 'export default [];\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

const hook = (dir, script, input) => {
  const r = spawnSync('node', [path.join(SCRIPTS, script)], {
    input: JSON.stringify({ session_id: 's1', ...input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return { ...r, json: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
};
const shell = (dir, event, command) => hook(dir, 'shell-guard.mjs', { hook_event_name: event, tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command } });
// a shell command as Claude Code runs it: PreToolUse, the change, PostToolUse
const around = (dir, command, change) => {
  const pre = shell(dir, 'PreToolUse', command);
  assert.equal(pre.status, 0, pre.stderr);
  change();
  return shell(dir, 'PostToolUse', command).json;
};
const write = (dir, f, s) => fs.writeFileSync(path.join(dir, f), s);
const replaceLine = (dir, f, n, s) => {
  const p = path.join(dir, f);
  const l = fs.readFileSync(p, 'utf8').split('\n');
  l[n - 1] = s;
  fs.writeFileSync(p, l.join('\n'));
};

test('gap 1: widening an existing suppression by editing only its rule list asks', (t) => {
  const { dir } = repo(t);
  write(dir, 'src/c.ts', 'a();\n// eslint-disable-next-line no-console\nconsole.log(1);\n');
  const r = hook(dir, 'guard.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/c.ts'), old_string: 'no-console', new_string: 'no-console, no-eval' } });
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'ask', r.stdout);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /lint suppression in src\/c\.ts/);
  // editing code next to a suppression, without touching it, still passes
  const ok = hook(dir, 'guard.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/c.ts'), old_string: 'a();', new_string: 'b();' } });
  assert.equal(ok.stdout, '');
  // MultiEdit and replace_all are judged by whole lines too
  const multi = hook(dir, 'guard.mjs', { tool_name: 'MultiEdit', tool_input: { file_path: path.join(dir, 'src/c.ts'), edits: [
    { old_string: 'a();', new_string: 'b();' }, { old_string: 'console', new_string: 'console, no-eval', replace_all: false }] } });
  assert.equal(multi.json?.hookSpecificOutput?.permissionDecision, 'ask', multi.stdout);
});

test('gap 2: a turn sent back by another Stop hook is still blocked once by codemyrules', (t) => {
  const { dir } = repo(t);
  replaceLine(dir, 'src/a.ts', 2, 'changed');
  assert.equal(hook(dir, 'lint-edited.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.ts') } }).status, 2);
  // another Stop hook blocked first, so Claude Code sends stop_hook_active: true on codemyrules' first look
  const first = hook(dir, 'lint-turn.mjs', { stop_hook_active: true });
  assert.equal(first.status, 2, first.stdout);
  assert.match(first.stderr, /src\/a\.ts:2/);
  // the retry after codemyrules' own block is let through with a message to the user
  const retry = hook(dir, 'lint-turn.mjs', { stop_hook_active: true });
  assert.equal(retry.status, 0);
  assert.match(retry.json.systemMessage, /still failing after one retry/);
});

test('gap 2: a block whose retry never came does not turn the next turn into a report', (t) => {
  const { dir } = repo(t);
  replaceLine(dir, 'src/a.ts', 2, 'changed');
  hook(dir, 'lint-edited.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.ts') } });
  assert.equal(hook(dir, 'lint-turn.mjs', { stop_hook_active: false }).status, 2);
  // the user interrupted and wrote a new prompt: the next stop has stop_hook_active false, so it is no retry
  assert.equal(hook(dir, 'lint-turn.mjs', { stop_hook_active: false }).status, 2);
});

test('gap 3: a commit inside the turn does not hide the edits from the end-of-turn check', (t) => {
  const { dir, git } = repo(t);
  replaceLine(dir, 'src/a.ts', 2, 'changed');
  hook(dir, 'lint-edited.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.ts') } });
  git('commit', '-q', '-am', 'agent commits its work');
  const r = hook(dir, 'lint-turn.mjs', { stop_hook_active: false });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /src\/a\.ts:2/);
});

test('gap 3: a suppression added and committed in one command is caught', (t) => {
  const { dir, git } = repo(t);
  const out = around(dir, 'sed -i x src/b.ts && git commit -am x', () => {
    write(dir, 'src/b.ts', 'x(); // eslint-disable-line\n');
    git('commit', '-q', '-am', 'x');
  });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /lint suppression in src\/b\.ts/);
});

test('gap 4: deleting the setup folder in the same command does not hide the change', (t) => {
  const { dir } = repo(t);
  const out = around(dir, 'rm -rf .claude/codemyrules; sed -i x src/a.ts', () => {
    fs.rmSync(path.join(dir, '.claude/codemyrules'), { recursive: true, force: true });
    write(dir, 'src/a.ts', 'x(); // eslint-disable-line\n');
  });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /lint suppression in src\/a\.ts/);
  assert.match(out.reason, /loop\.json is part of the codemyrules setup/);
});

test('gap 4: in pi, deleting loop.json through bash does not switch the extension off', async (t) => {
  const { dir } = repo(t);
  const handlers = {};
  codemyrules({ on: (event, fn) => { handlers[event] = fn; } });
  const ctx = { cwd: dir, hasUI: true, sessionManager: { getSessionId: () => 's1' }, ui: { confirm: async () => false, notify: () => {} } };
  const input = { command: 'rm .claude/codemyrules/loop.json; sed -i x src/a.ts' };
  await handlers.tool_call({ toolName: 'bash', toolCallId: 'c1', input }, ctx);
  fs.rmSync(path.join(dir, '.claude/codemyrules/loop.json'));
  write(dir, 'src/a.ts', 'x(); // eslint-disable-line\n');
  const r = await handlers.tool_result({ toolName: 'bash', toolCallId: 'c1', input, content: [], isError: false }, ctx);
  assert.match(r?.content?.at(-1)?.text ?? '', /Undo them now/);
  // and the next edit to a file the guard would ask about still asks
  const call = await handlers.tool_call({ toolName: 'edit', toolCallId: 'c2', input: { path: 'src/b.ts', edits: [{ oldText: 'line 1', newText: 'x // eslint-disable-line' }] } }, ctx);
  assert.equal(call?.block, true);
});

test('gap 4 and 8: hook commands survive a moved project, and fail closed when the pinned copy is gone', (t) => {
  const { dir } = repo(t);
  const cfg = path.join(dir, '..', `${path.basename(dir)}-loop.json`);
  fs.writeFileSync(cfg, JSON.stringify({ linters: [], protect: ['eslint.config.js'] }));
  t.after(() => fs.rmSync(cfg, { force: true }));
  const inst = spawnSync('node', [CLI, 'install', dir, '--config', cfg, '--cli', CLI, '--harness', 'claude', '--apply'], { encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  const moved = `${dir}-moved`;
  fs.renameSync(dir, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  const hooks = JSON.parse(fs.readFileSync(path.join(moved, '.claude/settings.local.json'), 'utf8')).hooks;
  const cmd = (event, name) => hooks[event].flatMap((e) => e.hooks).find((h) => h.command.includes(` hook ${name}`)).command;
  const exec = (command, input) => spawnSync(BASH, ['-c', command], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: moved } });
  const guardInput = { tool_name: 'Edit', tool_input: { file_path: path.join(moved, 'eslint.config.js'), old_string: 'export', new_string: 'export' } };
  const ask = exec(cmd('PreToolUse', 'guard'), guardInput);
  assert.equal(ask.status, 0, ask.stderr);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'ask');
  // the pinned copy deleted (rm -rf by the agent, a broken checkout): the edit guard and the shell guard deny, with a reason
  fs.rmSync(path.join(moved, '.claude/codemyrules/pkg'), { recursive: true, force: true });
  const denied = exec(cmd('PreToolUse', 'guard'), guardInput);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /codemyrules: the hook could not run.*codemyrules install/s);
  assert.equal(exec(cmd('PostToolUse', 'shell'), { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x' }).status, 2);
  // the Stop hook does not, since nothing the agent can do ends that loop
  assert.notEqual(exec(cmd('Stop', 'turn'), {}).status, 2);
});

test('gap 5: a script named install.mjs inside the project is not the codemyrules installer', (t) => {
  const { dir } = repo(t);
  fs.mkdirSync(path.join(dir, 'tmp'));
  write(dir, 'tmp/install.mjs', '// fake');
  const out = around(dir, 'node tmp/install.mjs', () => {
    write(dir, '.claude/codemyrules/loop.json', JSON.stringify({ linters: [], protect: [] }));
  });
  assert.equal(out?.decision, 'block', JSON.stringify(out));
  assert.match(out.reason, /loop\.json is part of the codemyrules setup/);
});

test('gap 6: a protected file named in other letter case asks on a case-insensitive file system', (t) => {
  const { dir } = repo(t);
  if (!fs.existsSync(path.join(dir, 'ESLINT.CONFIG.JS'))) return t.skip('case-sensitive file system');
  const r = hook(dir, 'guard.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'ESLint.Config.js'), old_string: 'export', new_string: 'export' } });
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, 'ask', r.stdout);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /eslint\.config\.js is protected/);
});

test('gap 7: a git-ignored protected file changed through the shell is caught', (t) => {
  const { dir, git } = repo(t, { protect: ['eslint.local.js', 'rules/*.js'] });
  write(dir, '.gitignore', '.claude/\neslint.local.js\nrules/\n');
  write(dir, 'eslint.local.js', 'a\n');
  fs.mkdirSync(path.join(dir, 'rules'));
  write(dir, 'rules/r.js', 'a\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'ignore');
  const out = around(dir, 'sed -i x eslint.local.js rules/r.js', () => {
    write(dir, 'eslint.local.js', 'b\n');
    write(dir, 'rules/r.js', 'b\n');
  });
  assert.equal(out?.decision, 'block', JSON.stringify(out));
  assert.match(out.reason, /eslint\.local\.js is protected/);
  assert.match(out.reason, /rules\/r\.js is protected/);
});
