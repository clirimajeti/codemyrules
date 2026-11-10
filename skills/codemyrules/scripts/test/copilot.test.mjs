import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toEdit, toolArgs } from '../copilot.mjs';

const CLI = path.join(import.meta.dirname, '..', 'cli.mjs');
const fixture = path.join(import.meta.dirname, 'fixtures', 'fake-eslint.mjs');
const content = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// a repo with the loop (fake linter: an error on line 2 of every file); hooks run as the Copilot hooks file runs them
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-copilot-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), JSON.stringify({
    linters: [{ name: 'fake', extensions: ['.ts'], format: 'eslint', tier: 'fast', command: ['node', fixture, '{files}'] }],
    protect: ['eslint.config.js'],
  }));
  fs.writeFileSync(path.join(dir, 'src/a.ts'), content(6));
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  // toolArgs as a JSON string, as the GitHub docs show it
  const hook = (event, payload) => {
    const r = spawnSync('node', [CLI, 'hook', 'copilot', event], {
      cwd: dir, encoding: 'utf8',
      input: JSON.stringify({ sessionId: 's1', timestamp: 1, cwd: dir, ...payload, ...(payload.toolArgs && { toolArgs: JSON.stringify(payload.toolArgs) }) }),
    });
    return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  // an edit as Copilot runs it: preToolUse, the change on disk, postToolUse
  const edit = (file, line) => {
    const toolArgs = { path: path.join(dir, file), old_str: `line ${line}\n`, new_str: 'changed\n' };
    const pre = hook('preToolUse', { toolName: 'edit', toolArgs });
    if (pre.json) return { pre };
    const p = path.join(dir, file);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`line ${line}\n`, 'changed\n'));
    return { pre, post: hook('postToolUse', { toolName: 'edit', toolArgs, toolResult: { resultType: 'success', textResultForLlm: 'ok' } }) };
  };
  return { dir, hook, edit };
}

test('toolArgs takes an object or a JSON string; toEdit maps edit and create', () => {
  assert.deepEqual(toolArgs({ toolArgs: '{"path":"a"}' }), { path: 'a' });
  assert.deepEqual(toolArgs({ toolArgs: { path: 'a' } }), { path: 'a' });
  assert.deepEqual(toolArgs({ toolArgs: 'not json' }), {});
  assert.deepEqual(toEdit('create', { path: 'a.ts', file_text: 'x' }), { file: 'a.ts', content: 'x' });
  assert.deepEqual(toEdit('edit', { path: 'a.ts', old_str: 'a', new_str: 'b' }), { file: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] });
  assert.equal(toEdit('view', { path: 'a.ts' }), null);
});

test('an edit on a flagged line gets the findings as additionalContext; a clean line gets nothing', (t) => {
  const { edit } = setup(t);
  const { pre, post } = edit('src/a.ts', 2);
  assert.equal(pre.stdout, '');
  assert.equal(post.status, 0, post.stderr);
  assert.match(post.json.additionalContext, /src\/a\.ts:2 fake\/rule/);
  assert.equal(setup(t).edit('src/a.ts', 5).post.json, null);
});

test('a protected file or an added suppression asks the user', (t) => {
  const { dir, hook, edit } = setup(t);
  const { pre } = edit('eslint.config.js', 1);
  assert.equal(pre.json.permissionDecision, 'ask');
  assert.match(pre.json.permissionDecisionReason, /^codemyrules: eslint\.config\.js is protected/);
  const create = hook('preToolUse', { toolName: 'create', toolArgs: { path: path.join(dir, 'src/b.ts'), file_text: 'x(); // eslint-disable-line\n' } });
  assert.match(create.json.permissionDecisionReason, /lint suppression/);
  const setupFile = hook('preToolUse', { toolName: 'edit', toolArgs: { path: '.github/hooks/codemyrules.json', old_str: 'a', new_str: 'b' } });
  assert.match(setupFile.json.permissionDecisionReason, /part of the codemyrules setup/);
});

test('a shell command that adds a suppression tells the agent to undo it', (t) => {
  const { dir, hook } = setup(t);
  const toolArgs = { command: 'sed -i x src/a.ts' };
  assert.equal(hook('preToolUse', { toolName: 'bash', toolArgs }).status, 0);
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'x(); // eslint-disable-line\n');
  const post = hook('postToolUse', { toolName: 'bash', toolArgs, toolResult: { resultType: 'success', textResultForLlm: '' } });
  assert.match(post.json.additionalContext, /lint suppression in src\/a\.ts[\s\S]*Undo them now/);
  assert.match(post.stderr, /told to undo changes made through bash/);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude/codemyrules')).filter((f) => f.startsWith('shell-')), []);
});

test('agentStop blocks once with the turn findings, then reports to the user', (t) => {
  const { hook, edit } = setup(t);
  edit('src/a.ts', 2);
  const first = hook('agentStop', { stopReason: 'end_turn', stop_hook_active: false });
  assert.equal(first.json.decision, 'block');
  assert.match(first.json.reason, /src\/a\.ts:2 fake\/rule/);
  const retry = hook('agentStop', { stopReason: 'end_turn', stop_hook_active: true });
  assert.equal(retry.status, 2);
  assert.equal(retry.stdout, '');
  assert.match(retry.stderr, /still failing after one retry/);
  assert.equal(hook('agentStop', { stopReason: 'end_turn', stop_hook_active: false }).json, null);
});
