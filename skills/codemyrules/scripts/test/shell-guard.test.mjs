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

test('a failed command is checked too, through PostToolUseFailure', (t) => {
  const dir = repo(t);
  assert.equal(hook(dir, 'PreToolUse').status, 0);
  write(dir, 'src/a.ts', 'x(); // eslint-disable-line\n');
  const r = hook(dir, 'PostToolUseFailure');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(out.hookSpecificOutput.additionalContext, /lint suppression in src\/a\.ts/);
  assert.match(out.systemMessage, /src\/a\.ts/);
  assert.equal(turn(dir), 'src/a.ts\n');
});

test('snapshots and turn files left over for a day are swept, fresh ones stay', (t) => {
  const dir = repo(t);
  const state = path.join(dir, '.claude/codemyrules');
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  for (const f of ['shell-denied.json', 'turn-crashed.txt']) {
    fs.writeFileSync(path.join(state, f), '{}');
    fs.utimesSync(path.join(state, f), old, old);
  }
  fs.writeFileSync(path.join(state, 'shell-running.json'), '{}');
  fs.writeFileSync(path.join(state, 'turn-live.txt'), 'src/a.ts\n');
  assert.equal(hook(dir, 'PreToolUse').status, 0);
  const left = fs.readdirSync(state);
  assert.ok(!left.includes('shell-denied.json') && !left.includes('turn-crashed.txt'), left.join());
  assert.ok(left.includes('shell-running.json') && left.includes('turn-live.txt'), left.join());
});

test('a change to the pinned package the hooks run through the shell blocks', (t) => {
  const dir = repo(t);
  const core = path.join(dir, '.claude/codemyrules/pkg/skills/codemyrules/scripts/core');
  fs.mkdirSync(core, { recursive: true });
  write(dir, '.claude/codemyrules/pkg/skills/codemyrules/scripts/guard.mjs', 'export const main = () => 0;\n');
  write(dir, '.claude/codemyrules/pkg/skills/codemyrules/scripts/core/checks.mjs', 'export {};\n');
  const out = around(dir, () => write(dir, '.claude/codemyrules/pkg/skills/codemyrules/scripts/core/checks.mjs', 'export const protectReason = () => null;\n'));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /core\/checks\.mjs is part of the codemyrules setup/);
});

test('the codemyrules installer may change the setup: the user is told, the agent is not sent back', (t) => {
  const dir = repo(t);
  const installer = { tool_input: { command: 'codemyrules install . --config /tmp/loop.json --apply' } };
  assert.equal(hook(dir, 'PreToolUse', installer).status, 0);
  write(dir, '.claude/codemyrules/loop.json', '{"linters":[],"protect":["x/**"]}');
  write(dir, '.claude/settings.local.json', '{"hooks":{}}');
  const r = hook(dir, 'PostToolUse', installer);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /installer changed .*loop\.json/s);
  assert.match(out.systemMessage, /settings\.local\.json/);

  // a new pinned copy is named once, not file by file
  assert.equal(hook(dir, 'PreToolUse', installer).status, 0);
  fs.mkdirSync(path.join(dir, '.claude/codemyrules/pkg/skills/codemyrules/scripts/core'), { recursive: true });
  write(dir, '.claude/codemyrules/pkg/package.json', '{}');
  write(dir, '.claude/codemyrules/pkg/skills/codemyrules/scripts/cli.mjs', '');
  write(dir, '.claude/codemyrules/pkg/skills/codemyrules/scripts/core/lib.mjs', '');
  const again = JSON.parse(hook(dir, 'PostToolUse', installer).stdout);
  assert.match(again.systemMessage, /installer changed \.claude\/codemyrules\/pkg\/\.$/);
});

test('an installer command that also changes a protected file still blocks for that file', (t) => {
  const dir = repo(t);
  const both = { tool_input: { command: 'node ~/x/install.mjs . --apply; sed -i "" s/a/b/ eslint.config.mjs' } };
  assert.equal(hook(dir, 'PreToolUse', both).status, 0);
  write(dir, '.claude/codemyrules/loop.json', '{"linters":[],"protect":[]}');
  write(dir, 'eslint.config.mjs', 'export default [{ rules: {} }];\n');
  const out = JSON.parse(hook(dir, 'PostToolUse', both).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /eslint\.config\.mjs is protected/);
  assert.doesNotMatch(out.reason, /loop\.json/);
  assert.match(out.systemMessage, /installer changed .*loop\.json/s);
});

test('a command that only mentions install.mjs in passing is not the installer', (t) => {
  const dir = repo(t);
  const fake = { tool_input: { command: 'echo {} > .claude/codemyrules/loop.json # not install.mjs' } };
  assert.equal(hook(dir, 'PreToolUse', fake).status, 0);
  write(dir, '.claude/codemyrules/loop.json', '{}');
  assert.equal(JSON.parse(hook(dir, 'PostToolUse', fake).stdout).decision, 'block');
});

test('runsInstaller knows the installer by the first word of a command part', async () => {
  const { runsInstaller } = await import('../core/snapshot.mjs');
  const cwd = path.resolve('/proj');
  for (const c of ['codemyrules install . --apply', 'npx -y codemyrules@0.5.0 install . --apply', 'cd x && codemyrules uninstall . --apply',
    `node ${path.resolve('/p/skills/codemyrules/scripts/install.mjs')} . --config a.json`, `node "${path.resolve('/p/install.mjs')}" .`, 'node ~/x/install.mjs .',
    'node ../other/install.mjs .', 'node .claude/codemyrules/pkg/skills/codemyrules/scripts/install.mjs .', 'FOO=1 codemyrules install .']) assert.equal(runsInstaller(c, cwd), true, c);
  // a script inside the project, which the agent can write, and a PATH that could put another codemyrules first
  for (const c of ['echo codemyrules install', 'cat install.mjs', 'echo x # node install.mjs', 'codemyrules status .', 'node reinstall.mjs.bak', undefined,
    'node tmp/install.mjs .', 'node ./install.mjs', 'PATH=./bin:$PATH codemyrules install .']) assert.equal(runsInstaller(c, cwd), false, String(c));
});

test('emptying the protect list and editing a protected file in one command still blocks', (t) => {
  const dir = repo(t);
  assert.equal(hook(dir, 'PreToolUse').status, 0);
  write(dir, '.claude/codemyrules/loop.json', '{"linters":[],"protect":[]}');
  write(dir, 'eslint.config.mjs', 'export default [{ rules: {} }];\n');
  const out = JSON.parse(hook(dir, 'PostToolUse').stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /eslint\.config\.mjs is protected/);
});

test('tools installed inside the setup folder are not snapshotted', (t) => {
  const dir = repo(t);
  const nm = path.join(dir, '.claude/codemyrules/node_modules/eslint/lib');
  fs.mkdirSync(nm, { recursive: true });
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(nm, `m${i}.mjs`), 'export {};\n');
  assert.equal(hook(dir, 'PreToolUse').status, 0);
  // the snapshot lives in the git folder, where a command that deletes the setup folder does not reach it
  const snapDir = path.join(dir, '.git/codemyrules');
  const snap = JSON.parse(fs.readFileSync(path.join(snapDir, fs.readdirSync(snapDir).find((f) => f.endsWith('-tu_1.json'))), 'utf8')).files;
  assert.deepEqual(Object.keys(snap).filter((f) => f.includes('node_modules')), []);
  assert.ok('.claude/codemyrules/loop.json' in snap);
});

test('a content change that keeps the size and restores the mtime is still caught', (t) => {
  const dir = repo(t);
  write(dir, 'src/a.ts', 'x();\n// aaaaaaaaaaaaaaaaaaaaa\n'); // dirty before the command
  const p = path.join(dir, 'src/a.ts');
  const { atime, mtime } = fs.statSync(p);
  const out = around(dir, () => {
    fs.writeFileSync(p, 'x();\n// eslint-disable-line\n'); // same length as before
    fs.utimesSync(p, atime, mtime);
  });
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /src\/a\.ts/);
});

test('touching a file without changing it is not a change', (t) => {
  const dir = repo(t);
  write(dir, 'src/a.ts', 'x(); // eslint-disable-line\n'); // the user's own suppression
  const p = path.join(dir, 'src/a.ts');
  assert.equal(around(dir, () => { const later = new Date(Date.now() + 5000); fs.utimesSync(p, later, later); }), null);
  assert.equal(turn(dir), '');
});

test('a second command reuses the hashes of files that did not change, and stale cache entries are not trusted', (t) => {
  const dir = repo(t);
  write(dir, 'src/a.ts', 'x(); // eslint-disable-line\n');
  assert.equal(around(dir, () => {}), null);
  const cache = path.join(dir, '.claude/codemyrules/hash-cache.json');
  const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.ok(c['src/a.ts']?.h, 'the dirty file is cached');
  // a cache entry from long ago with a wrong hash: trusting it would make the suppression look new
  c['src/a.ts'] = { ...c['src/a.ts'], h: '0'.repeat(40), t: Date.now() - 3 * 24 * 3600 * 1000 };
  fs.writeFileSync(cache, JSON.stringify(c));
  assert.equal(around(dir, () => write(dir, 'src/b.ts', 'z();\n')), null);
});
