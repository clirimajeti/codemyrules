import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'lint-turn.mjs');
const fixture = path.join(here, 'fixtures', 'fake-eslint.mjs');
const content = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function setup(command = ['node', fixture, '{files}']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  const sh = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  sh('init', '-q');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'),
    JSON.stringify({ linters: [{ name: 'fake', extensions: ['.ts'], format: 'eslint', command }] }));
  for (const f of ['a.ts', 'b.ts', 'my file.ts']) fs.writeFileSync(path.join(dir, 'src', f), content(6));
  sh('add', '-A');
  sh('commit', '-q', '-m', 'init');
  return dir;
}

const turnFile = (dir, session = 'default') => path.join(dir, `.claude/codemyrules/turn-${session}.txt`);
// change line n of src/f, and record it as edited this turn unless `track` is false
const edit = (dir, f, n, track = true) => {
  const p = path.join(dir, 'src', f);
  const l = fs.readFileSync(p, 'utf8').split('\n');
  l[n - 1] = 'changed';
  fs.writeFileSync(p, l.join('\n'));
  if (track) fs.appendFileSync(turnFile(dir), `src/${f}\n`);
};

const run = (dir, input) => spawnSync('node', [script], {
  input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});

function withRepo(command, fn) {
  const dir = setup(command);
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('blocks on an error on a changed line', () => withRepo(undefined, (dir) => {
  edit(dir, 'a.ts', 2);
  const r = run(dir, { stop_hook_active: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /src\/a\.ts:2/);
  assert.match(r.stderr, /Fix these before you finish/);
}));

test('ignores an error on an unchanged line', () => withRepo(undefined, (dir) => {
  edit(dir, 'a.ts', 5);
  const r = run(dir, { stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
}));

test('lets the turn end after one block with a systemMessage, logged once', () => withRepo(undefined, (dir) => {
  edit(dir, 'a.ts', 2);
  assert.equal(run(dir, { stop_hook_active: false }).status, 2);
  const r = run(dir, { stop_hook_active: true });
  assert.equal(r.status, 0);
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.ok(msg.startsWith('codemyrules: still failing after one retry:'));
  assert.match(msg, /src\/a\.ts:2/);
  assert.doesNotMatch(msg, /Fix these before you finish/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude/codemyrules/failures.log'), 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.existsSync(turnFile(dir)), false);
}));

test('a pre-existing error in a file not edited this turn does not block', () => withRepo(undefined, (dir) => {
  edit(dir, 'b.ts', 2, false);
  const r = run(dir, { stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  edit(dir, 'a.ts', 2);
  const r2 = run(dir, { stop_hook_active: false });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /src\/a\.ts:2/);
  assert.doesNotMatch(r2.stderr, /src\/b\.ts/);
}));

test('the set is per session and cleared after a pass', () => withRepo(undefined, (dir) => {
  edit(dir, 'a.ts', 5, false);
  fs.writeFileSync(turnFile(dir, 's-1'), 'src/a.ts\n');
  const r = run(dir, { session_id: 's-1', stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.equal(fs.existsSync(turnFile(dir, 's-1')), false);
}));

test('skips deleted files and handles spaces', () => withRepo(undefined, (dir) => {
  fs.rmSync(path.join(dir, 'src', 'b.ts'));
  edit(dir, 'my file.ts', 2);
  const r = run(dir, { stop_hook_active: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /src\/my file\.ts:2/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'fake-argv.json'), 'utf8')), ['src/my file.ts']);
}));

test('does not block when the linter is missing', () => withRepo(['nope-cmd', '{files}'], (dir) => {
  edit(dir, 'a.ts', 2);
  const r = run(dir, { stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /codemyrules: fake failed:/);
}));

test('writes the failure log', () => withRepo(undefined, (dir) => {
  edit(dir, 'a.ts', 2);
  run(dir, { stop_hook_active: false });
  const log = fs.readFileSync(path.join(dir, '.claude/codemyrules/failures.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.match(log[0], /"event":"turn"/);
}));

test('a malformed loop.json prints a note and exits 0', () => {
  const dir = setup();
  try {
    fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), '{nope');
    edit(dir, 'a.ts', 2);
    const r = run(dir, { stop_hook_active: false });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^codemyrules: loop\.json could not be read \(.+\)\n$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an edit recorded by lint-edited is checked at the end of the turn', () => withRepo(undefined, (dir) => {
  edit(dir, 'a.ts', 2, false);
  const post = spawnSync('node', [path.join(here, '..', 'lint-edited.mjs')], {
    input: JSON.stringify({ session_id: 'chain', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.ts') } }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.equal(post.status, 0, post.stdout + post.stderr);
  const r = run(dir, { session_id: 'chain', stop_hook_active: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^src\/a\.ts:2 fake\/rule bad/);
}));
