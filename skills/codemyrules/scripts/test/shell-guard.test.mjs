import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.join(import.meta.dirname, '..', 'shell-guard.mjs');

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sh = (...a) => { const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  sh('init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), JSON.stringify({ protect: ['**/eslint.config.*'] }));
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'x();\n');
  fs.writeFileSync(path.join(dir, 'src/b.ts'), 'y();\n');
  fs.writeFileSync(path.join(dir, 'eslint.config.mjs'), 'export default [];\n');
  sh('add', 'src', 'eslint.config.mjs');
  sh('commit', '-q', '-m', 'init');
  return dir;
}

const hook = (dir, event, extra = {}) => spawnSync('node', [SCRIPT], {
  encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  input: JSON.stringify({ hook_event_name: event, tool_name: 'Bash', tool_use_id: 'tu_1', session_id: 's1', tool_input: { command: 'x' }, ...extra }),
});
// run the hook pair around `change`, the stand-in for what the shell command did
function around(dir, change) {
  const pre = hook(dir, 'PreToolUse');
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, '');
  change();
  const post = hook(dir, 'PostToolUse');
  assert.equal(post.status, 0, post.stderr);
  return post.stdout ? JSON.parse(post.stdout) : null;
}
const write = (dir, f, s) => fs.writeFileSync(path.join(dir, f), s);
const turn = (dir) => { try { return fs.readFileSync(path.join(dir, '.claude/codemyrules/turn-s1.txt'), 'utf8'); } catch { return ''; } };

test('a suppression added through the shell blocks and tells the user', (t) => {
  const dir = repo(t);
  const out = around(dir, () => write(dir, 'src/a.ts', 'x(); // eslint-disable-line\n'));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /src\/a\.ts/);
  assert.match(out.reason, /lint suppression/);
  assert.match(out.systemMessage, /^codemyrules: .*src\/a\.ts/s);
  assert.equal(turn(dir), 'src/a.ts\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, '.claude/codemyrules')).filter((f) => f.startsWith('shell-')), []);
});

test('a change to a protected file through the shell blocks', (t) => {
  const dir = repo(t);
  const out = around(dir, () => write(dir, 'eslint.config.mjs', 'export default [{ rules: {} }];\n'));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /eslint\.config\.mjs is protected/);
});

test('a change to the codemyrules setup through the shell blocks, hook state does not', (t) => {
  const dir = repo(t);
  const out = around(dir, () => {
    write(dir, '.claude/codemyrules/loop.json', '{}');
    write(dir, '.claude/codemyrules/failures.log', 'x\n');
  });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /loop\.json is part of the codemyrules setup/);
  assert.doesNotMatch(out.reason, /failures\.log/);
  assert.equal(around(dir, () => write(dir, '.claude/codemyrules/turn-x.txt', 'a\n')), null);
});

test('a new untracked file with a suppression blocks', (t) => {
  const dir = repo(t);
  const out = around(dir, () => write(dir, 'src/c.py', 'import os  # noqa\n'));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /src\/c\.py/);
});

test('a plain change is recorded for the end-of-turn check and passes', (t) => {
  const dir = repo(t);
  assert.equal(around(dir, () => write(dir, 'src/b.ts', 'z();\n')), null);
  assert.equal(turn(dir), 'src/b.ts\n');
});

test('a file that was already dirty is compared with its state before the command', (t) => {
  const dir = repo(t);
  write(dir, 'src/a.ts', 'x(); // eslint-disable-line\n'); // the user's own uncommitted change
  assert.equal(around(dir, () => write(dir, 'src/a.ts', 'x(); // eslint-disable-line\nmore();\n')), null);
  assert.equal(turn(dir), 'src/a.ts\n');
  // reverting a file to HEAD is a change, and adds nothing
  assert.equal(around(dir, () => write(dir, 'src/a.ts', 'x();\n')), null);
});

test('a command that changes nothing is silent and records nothing', (t) => {
  const dir = repo(t);
  write(dir, 'src/b.ts', 'dirty();\n');
  assert.equal(around(dir, () => {}), null);
  assert.equal(turn(dir), '');
});

test('prose files may mention suppressions', (t) => {
  const dir = repo(t);
  assert.equal(around(dir, () => write(dir, 'README.md', 'Never add `// eslint-disable-next-line`.\n')), null);
});

test('without a snapshot the post hook does nothing', (t) => {
  const dir = repo(t);
  write(dir, 'src/a.ts', 'x(); // eslint-disable-line\n');
  const post = hook(dir, 'PostToolUse');
  assert.equal(post.status, 0);
  assert.equal(post.stdout, '');
});

test('outside a git repository both hooks do nothing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const e of ['PreToolUse', 'PostToolUse']) {
    const r = hook(dir, e);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
  }
});

test('secret files are never snapshotted or read', (t) => {
  const dir = repo(t);
  write(dir, '.env', 'A=1\n');
  assert.equal(around(dir, () => write(dir, '.env', 'A=1 # noqa\n')), null);
  assert.equal(turn(dir), '');
});
