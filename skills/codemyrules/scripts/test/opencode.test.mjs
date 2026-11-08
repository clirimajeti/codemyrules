import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin, { patchEdit, toEdit } from '../opencode.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-eslint.mjs');
const content = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// a repo with the loop (fake linter: an error on line 2 of every file) and the plugin set up in a fake opencode
async function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-oc-')));
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
  const hooks = {};
  const sent = [];
  const hook = (domain) => async (name, fn) => { hooks[`${domain}.${name}`] = fn; };
  await plugin.setup({
    location: { directory: dir },
    tool: { hook: hook('tool') },
    permission: { hook: hook('permission') },
    session: { hook: hook('session'), synthetic: async (m) => { sent.push(m); } },
  });
  const on = async (name, e) => { await hooks[name](e); return e; };
  // a tool call as opencode runs it: execute.before, the edit permission, the change on disk, execute.after
  const call = async (tool, input, { files = [], apply = () => {} } = {}) => {
    const id = `c${Math.random()}`;
    const base = { tool, sessionID: 's1', id, input };
    await on('tool.execute.before', { ...base });
    const ask = files.length ? await on('permission.evaluate', { sessionID: 's1', action: 'edit', resources: files, source: { type: 'tool', id }, effect: 'allow' }) : null;
    if (ask?.effect === 'ask') return { ask };
    apply();
    const after = await on('tool.execute.after', { ...base, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } });
    return { ask, after };
  };
  const edit = (file, line) => call('edit', { path: path.join(dir, file), oldString: `line ${line}\n`, newString: 'changed\n' }, {
    files: [file],
    apply: () => { const p = path.join(dir, file); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`line ${line}\n`, 'changed\n')); },
  });
  return { dir, on, call, edit, sent };
}

test('toEdit maps opencode edit and write input', () => {
  assert.deepEqual(toEdit('write', { path: 'a.ts', content: 'x' }), { file: 'a.ts', content: 'x' });
  assert.deepEqual(toEdit('edit', { path: 'a.ts', oldString: 'a', newString: 'b' }), { file: 'a.ts', edits: [{ oldText: 'a', newText: 'b', replaceAll: false }] });
  assert.equal(toEdit('read', { path: 'a.ts' }), null);
});

test('patchEdit turns each hunk of a unified diff into its old and new side', () => {
  const patch = 'Index: a.ts\n===\n--- a.ts\n+++ a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+// eslint-disable-next-line\n\\ No newline at end of file\n@@ -9 +9 @@\n-x\n+y\n';
  assert.deepEqual(patchEdit('a.ts', patch), { file: 'a.ts', edits: [
    { oldText: 'keep\nold', newText: 'keep\n// eslint-disable-next-line' },
    { oldText: 'x', newText: 'y' },
  ] });
});

test('an edit on a flagged line gets the findings in its tool result', async (t) => {
  const { edit } = await setup(t);
  const { ask, after } = await edit('src/a.ts', 2);
  assert.equal(ask.effect, 'allow');
  assert.equal(after.result.content[0].text, 'ok');
  assert.match(after.result.content.at(-1).text, /src\/a\.ts:2 fake\/rule/);
});

test('an edit on a clean line leaves the tool result alone', async (t) => {
  const { edit } = await setup(t);
  assert.equal((await edit('src/a.ts', 5)).after.result.content.length, 1);
});

test('a protected file or an added suppression turns the edit permission into a question with the reason', async (t) => {
  const { call } = await setup(t);
  const cfg = await call('write', { path: 'eslint.config.js', content: 'x' }, { files: ['eslint.config.js'] });
  assert.equal(cfg.ask.effect, 'ask');
  assert.match(cfg.ask.message, /^codemyrules: eslint\.config\.js is protected.*approve/);
  const sup = await call('edit', { path: 'src/a.ts', oldString: 'line 3\n', newString: '// eslint-disable-next-line\nline 3\n' }, { files: ['src/a.ts'] });
  assert.match(sup.ask.message, /adds or changes a lint suppression in src\/a\.ts/);
  const setupFile = await call('write', { path: '.opencode/plugins/codemyrules.js', content: '' }, { files: ['.opencode/plugins/codemyrules.js'] });
  assert.match(setupFile.ask.message, /part of the codemyrules setup/);
});

test('apply_patch is checked from the diffs on the permission request', async (t) => {
  const { on } = await setup(t);
  const patch = '--- src/a.ts\n+++ src/a.ts\n@@ -3,1 +3,2 @@\n+// @ts-ignore\n line 3\n';
  const e = await on('permission.evaluate', { sessionID: 's1', action: 'edit', resources: ['src/a.ts'], metadata: { files: [{ file: 'src/a.ts', patch }] }, source: { type: 'tool', id: 'p1' }, effect: 'allow' });
  assert.equal(e.effect, 'ask');
  assert.match(e.message, /lint suppression/);
});

test('a shell command that adds an ignore comment is told to undo it', async (t) => {
  const { dir, call } = await setup(t);
  const { after } = await call('shell', { command: 'echo' }, { apply: () => fs.appendFileSync(path.join(dir, 'src/a.ts'), '// eslint-disable-next-line\n') });
  assert.match(after.result.content.at(-1).text, /lint suppression.*\n.*Undo them now/s);
});

test('going idle sends the findings back once, then lets the agent stop', async (t) => {
  const { on, edit, sent } = await setup(t);
  await edit('src/a.ts', 2);
  await on('session.experimental.idle', { sessionID: 's1', background: [] });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /src\/a\.ts:2/);
  await on('session.experimental.idle', { sessionID: 's1', background: [] });
  assert.equal(sent.length, 1);
});

test('without loop.json the plugin does nothing', async (t) => {
  const { dir, edit, on, sent } = await setup(t);
  fs.rmSync(path.join(dir, '.claude/codemyrules/loop.json'));
  const { after } = await edit('src/a.ts', 2);
  assert.equal(after.result.content.length, 1);
  await on('session.experimental.idle', { sessionID: 's1', background: [] });
  assert.equal(sent.length, 0);
});
