import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toEdit } from '../gemini.mjs';

const CLI = path.join(import.meta.dirname, '..', 'cli.mjs');
const fixture = path.join(import.meta.dirname, 'fixtures', 'fake-eslint.mjs');
const content = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// a repo with the loop (fake linter: an error on line 2 of every file); hooks run as Gemini runs them: cwd = project root
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-gemini-')));
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
  const hook = (payload) => {
    const r = spawnSync('node', [CLI, 'hook', 'gemini'], {
      cwd: dir, encoding: 'utf8',
      input: JSON.stringify({ session_id: 's1', cwd: dir, timestamp: '2026-11-23T00:00:00Z', ...payload }),
    });
    return { ...r, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  const replace = (file, line) => ({ tool_name: 'replace', tool_input: { file_path: path.join(dir, file), old_string: `line ${line}\n`, new_string: 'changed\n' } });
  // an edit as Gemini runs it: BeforeTool, the change on disk, AfterTool
  const edit = (file, line) => {
    const call = replace(file, line);
    const pre = hook({ hook_event_name: 'BeforeTool', ...call });
    if (pre.json) return { pre };
    const p = path.join(dir, file);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`line ${line}\n`, 'changed\n'));
    return { pre, post: hook({ hook_event_name: 'AfterTool', ...call, tool_response: { llmContent: 'ok' } }) };
  };
  return { dir, hook, edit, replace };
}

test('toEdit maps write_file and replace', () => {
  assert.deepEqual(toEdit('write_file', { file_path: '/p/a.ts', content: 'x' }), { file: '/p/a.ts', content: 'x' });
  assert.deepEqual(toEdit('replace', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b', allow_multiple: true }),
    { file: '/p/a.ts', edits: [{ oldText: 'a', newText: 'b', replaceAll: true }] });
  assert.equal(toEdit('read_file', { file_path: '/p/a.ts' }), null);
  assert.equal(toEdit('replace', {}), null);
});

test('BeforeTool asks for a flagged edit, with the reason as systemMessage', (t) => {
  const { dir, hook } = setup(t);
  const r = hook({ hook_event_name: 'BeforeTool', tool_name: 'replace',
    tool_input: { file_path: path.join(dir, 'src/a.ts'), old_string: 'line 1', new_string: 'line 1 // eslint-disable-line' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'ask');
  assert.match(r.json.systemMessage, /^codemyrules: .*Only the user can approve this\.$/s);
  assert.match(r.json.systemMessage, /lint suppression/);
});

test('BeforeTool asks for a write to a protected path and to .gemini/settings.json', (t) => {
  const { dir, hook } = setup(t);
  for (const f of ['eslint.config.js', '.gemini/settings.json']) {
    const r = hook({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: path.join(dir, f), content: 'x' } });
    assert.equal(r.json.decision, 'ask', f);
  }
});

test('BeforeTool says nothing for a clean edit', (t) => {
  const { edit } = setup(t);
  const { pre } = edit('src/a.ts', 5);
  assert.equal(pre.status, 0);
  assert.equal(pre.stdout, '');
});

test('AfterTool on an edit returns the findings as additionalContext', (t) => {
  const { edit } = setup(t);
  const { post } = edit('src/a.ts', 2);
  assert.equal(post.status, 0, post.stderr);
  assert.match(post.json.hookSpecificOutput.additionalContext, /src\/a\.ts:2 fake\/rule/);
});

test('AfterTool skips a failed edit', (t) => {
  const { hook, replace } = setup(t);
  const r = hook({ hook_event_name: 'AfterTool', ...replace('src/a.ts', 2), tool_response: { error: { message: 'x' } } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('a shell command that changes a protected file is reported to the agent', (t) => {
  const { dir, hook } = setup(t);
  const call = { tool_name: 'run_shell_command', tool_input: { command: 'echo x > eslint.config.js' } };
  assert.equal(hook({ hook_event_name: 'BeforeTool', ...call }).stdout, '');
  fs.writeFileSync(path.join(dir, 'eslint.config.js'), 'x\n');
  const post = hook({ hook_event_name: 'AfterTool', ...call, tool_response: { llmContent: '' } });
  assert.equal(post.status, 0, post.stderr);
  assert.match(post.json.hookSpecificOutput.additionalContext, /eslint\.config\.js/);
  assert.ok(post.json.systemMessage);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude/codemyrules')).filter((f) => f.startsWith('shell-')), []);
});

test('AfterAgent sends the agent back once, then reports', (t) => {
  const { hook, edit } = setup(t);
  edit('src/a.ts', 2);
  const first = hook({ hook_event_name: 'AfterAgent', stop_hook_active: false });
  assert.equal(first.json.decision, 'deny');
  assert.match(first.json.reason, /src\/a\.ts:2 fake\/rule/);
  const retry = hook({ hook_event_name: 'AfterAgent', stop_hook_active: true });
  assert.equal(retry.status, 0);
  assert.equal(retry.json.decision, undefined);
  assert.match(retry.json.systemMessage, /still failing after one retry/);
});

test('other tools and empty payloads are left alone', (t) => {
  const { hook } = setup(t);
  for (const hook_event_name of ['BeforeTool', 'AfterTool']) {
    for (const tool_name of ['read_file', 'mcp_x_write', 'replace']) {
      const r = hook({ hook_event_name, tool_name, ...(tool_name !== 'replace' && { tool_input: { file_path: 'src/a.ts' } }) });
      assert.equal(r.status, 0, `${hook_event_name} ${tool_name}`);
      assert.equal(r.stdout, '', `${hook_event_name} ${tool_name}`);
    }
  }
});

test('an unreadable loop.json does not switch the guard off', (t) => {
  const { dir, edit } = setup(t);
  // a missing file reads as an empty config in core, so "unreadable" is a malformed one
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), '{ nope');
  const { pre } = edit('src/a.ts', 5);
  assert.equal(pre.json.decision, 'ask');
  assert.match(pre.json.systemMessage, /loop\.json could not be read/);
});
