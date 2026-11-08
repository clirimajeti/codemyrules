import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import codemyrules, { toEdit } from '../pi.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-eslint.mjs');
const content = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// a repo with the loop (fake linter: an error on line 2 of every file) and the extension loaded into a fake pi
function setup(t, { hasUI = true, confirm = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-pi-')));
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
  const handlers = {};
  codemyrules({ on: (event, fn) => { handlers[event] = fn; } });
  const asked = [];
  const told = [];
  const ctx = {
    cwd: dir, hasUI,
    sessionManager: { getSessionId: () => 's1' },
    ui: { confirm: async (title, msg) => { asked.push(msg); return confirm; }, notify: (msg) => told.push(msg) },
  };
  const on = (event, e) => handlers[event](e, ctx);
  // an edit as pi runs it: tool_call, the change on disk, tool_result
  const edit = async (file, line) => {
    const input = { path: file, edits: [{ oldText: `line ${line}\n`, newText: 'changed\n' }] };
    const call = await on('tool_call', { toolName: 'edit', toolCallId: 'c1', input });
    if (call?.block) return { call };
    const p = path.join(dir, file);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`line ${line}\n`, 'changed\n'));
    return { call, result: await on('tool_result', { toolName: 'edit', toolCallId: 'c1', input, content: [{ type: 'text', text: 'ok' }], isError: false }) };
  };
  return { dir, on, edit, asked, told };
}

test('toEdit maps pi edit and write input, including the older top-level oldText', () => {
  assert.deepEqual(toEdit('write', { path: 'a.ts', content: 'x' }), { file: 'a.ts', content: 'x' });
  assert.deepEqual(toEdit('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }), { file: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] });
  assert.deepEqual(toEdit('edit', { path: 'a.ts', oldText: 'a', newText: 'b' }), { file: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] });
  assert.equal(toEdit('read', { path: 'a.ts' }), null);
});

test('an edit on a flagged line gets the findings in its tool result', async (t) => {
  const { edit } = setup(t);
  const { result } = await edit('src/a.ts', 2);
  assert.match(result.content.at(-1).text, /src\/a\.ts:2 fake\/rule/);
  assert.equal(result.content[0].text, 'ok');
});

test('an edit on a clean line leaves the tool result alone', async (t) => {
  const { edit } = setup(t);
  assert.equal((await edit('src/a.ts', 5)).result, undefined);
});

test('a protected file asks the user; a no blocks the edit, a yes lets it through', async (t) => {
  const no = setup(t, { confirm: false });
  const { call } = await no.edit('eslint.config.js', 1);
  assert.equal(call.block, true);
  assert.match(call.reason, /protected.*declined/);
  assert.match(no.asked[0], /eslint\.config\.js/);
  const yes = setup(t, { confirm: true });
  fs.writeFileSync(path.join(yes.dir, 'eslint.config.js'), content(3));
  assert.equal((await yes.edit('eslint.config.js', 1)).call, undefined);
});

test('without a UI a flagged edit is refused, since nobody can be asked', async (t) => {
  const { on } = setup(t, { hasUI: false });
  const r = await on('tool_call', { toolName: 'edit', input: { path: '.pi/extensions/codemyrules.js', edits: [{ oldText: '', newText: 'x' }] } });
  assert.equal(r.block, true);
  assert.match(r.reason, /codemyrules setup.*nobody can be asked/);
});

test('the turn end sends the agent back once with the findings, then lets it settle', async (t) => {
  const { on, edit, told } = setup(t);
  await edit('src/a.ts', 2);
  const first = await on('agent_before_settle', { entries: [] });
  assert.equal(first.continue, true);
  assert.match(first.entries[0].content, /src\/a\.ts:2/);
  assert.equal((await on('agent_before_settle', { entries: [] })), undefined);
  assert.match(told.at(-1), /still failing after one retry/);
});

test('a bash command that adds an ignore comment is sent back to be undone', async (t) => {
  const { dir, on } = setup(t);
  const input = { command: 'echo "// eslint-disable-next-line" >> src/a.ts' };
  await on('tool_call', { toolName: 'bash', toolCallId: 'b1', input });
  fs.appendFileSync(path.join(dir, 'src/a.ts'), '// eslint-disable-next-line\n');
  const r = await on('tool_result', { toolName: 'bash', toolCallId: 'b1', input, content: [], isError: true });
  assert.match(r.content.at(-1).text, /lint suppression.*\n.*Undo them now/s);
});

test('without loop.json the extension does nothing', async (t) => {
  const { dir, edit } = setup(t);
  fs.rmSync(path.join(dir, '.claude/codemyrules/loop.json'));
  assert.deepEqual(await edit('src/a.ts', 2), { call: undefined, result: undefined });
});
