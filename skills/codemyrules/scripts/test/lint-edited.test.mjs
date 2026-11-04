import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'lint-edited.mjs');
const fake = path.join(here, 'fixtures', 'fake-fast.mjs');

function setup(tier) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  const sh = (...a) => spawnSync('git', a, { cwd: dir });
  sh('init', '-q');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), JSON.stringify({
    linters: [{ name: 'fake', tier, extensions: ['.ts'], format: 'eslint', command: ['node', fake, '{files}'] }],
  }));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\n');
  return dir;
}

function run(dir, filePath, extra = {}) {
  return spawnSync('node', [script], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath }, ...extra }),
  });
}
const turn = (dir, session = 'default') => {
  try { return fs.readFileSync(path.join(dir, `.claude/codemyrules/turn-${session}.txt`), 'utf8'); } catch { return null; }
};

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('blocks on an error in the edited file', () => {
  const dir = setup('fast');
  try {
    const r = run(dir, path.join(dir, 'a.ts'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /a\.ts:2 fake\/rule fake error/);
  } finally { cleanup(dir); }
});

test('skips full-tier linters but still records the edit for the turn', () => {
  const dir = setup('full');
  try {
    const r = run(dir, path.join(dir, 'a.ts'), { session_id: 'abc' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
    run(dir, 'a.ts', { session_id: 'abc' });
    assert.equal(turn(dir, 'abc'), 'a.ts\na.ts\n');
    assert.equal(turn(dir), null);
  } finally { cleanup(dir); }
});

test('ignores files outside the project', () => {
  const dir = setup('fast');
  try {
    const r = run(dir, '/tmp/x.ts');
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
    assert.equal(turn(dir), null);
  } finally { cleanup(dir); }
});

test('exits silently without a file_path', () => {
  const dir = setup('fast');
  try {
    const r = spawnSync('node', [script], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, input: '{}' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  } finally { cleanup(dir); }
});

test('logs edit events', () => {
  const dir = setup('fast');
  try {
    run(dir, path.join(dir, 'a.ts'));
    const log = fs.readFileSync(path.join(dir, '.claude/codemyrules/failures.log'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(log[0].event, 'edit');
    assert.equal(log[0].file, 'a.ts');
    assert.equal(log[0].line, 2);
  } finally { cleanup(dir); }
});

test('a malformed loop.json prints a note and exits 0', () => {
  const dir = setup('fast');
  try {
    fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), '{nope');
    const r = run(dir, path.join(dir, 'a.ts'));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^codemyrules: loop\.json could not be read \(.+\)\n$/);
  } finally { cleanup(dir); }
});

test('blocks through a symlinked project dir when the linter reports realpaths', () => {
  const dir = setup('fast');
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    const link = path.join(holder, 'link');
    fs.symlinkSync(dir, link);
    fs.writeFileSync(path.join(dir, 'real.cjs'), `process.stdout.write(JSON.stringify(process.argv.slice(2).map((f) => ({ filePath: require('node:fs').realpathSync(f), messages: [{ line: 2, severity: 2, ruleId: 'x/y', message: 'bad' }] }))))`);
    fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), JSON.stringify({ linters: [{ name: 'real', tier: 'fast', extensions: ['.ts'], format: 'eslint', command: ['node', path.join(dir, 'real.cjs'), '{files}'] }] }));
    const r = run(link, path.join(link, 'a.ts'));
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /^a\.ts:2 x\/y bad/);
  } finally { cleanup(dir); cleanup(holder); }
});
