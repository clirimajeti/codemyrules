import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FOOTER, parseHunks, unquotePath, dirtyFiles, changedLines, parseLinterOutput, onChangedLines,
  runLinters, formatFindings, logFindings, matchesPattern, readLoopConfig, isSecretFile,
} from '../core/lib.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
const withTmp = (fn) => {
  const dir = tmp();
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('parseHunks collects added ranges and skips pure deletions', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@', '+x', '+y', '@@ -9 +11 @@', '-a', '+b', '@@ -20,2 +7,0 @@', '-c', '-d',
  ].join('\n');
  assert.deepEqual(parseHunks(diff), new Map([['src/a.ts', [[4, 5], [11, 11]]]]));
});

test('changedLines is null outside a repo', () => {
  withTmp((dir) => assert.equal(changedLines(dir), null));
});

test('changedLines marks untracked files as all in a repo without commits', () => {
  withTmp((dir) => {
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x\n');
    assert.equal(changedLines(dir).get('a.ts'), 'all');
  });
});

test('changedLines returns edited ranges and all for new untracked files', () => {
  withTmp((dir) => {
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'a.ts'), '1\n2\n3\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'a.ts'), '1\nTWO\n3\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'new\n');
    const c = changedLines(dir);
    assert.deepEqual(c.get('a.ts'), [[2, 2]]);
    assert.equal(c.get('b.ts'), 'all');
  });
});

test('changedLines limited to given files reads only those, literally, and never secret files', () => {
  withTmp((dir) => {
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'a.ts'), '1\n2\n3\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), '1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'a.ts'), '1\nTWO\n3\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'ONE\n');
    fs.writeFileSync(path.join(dir, '[id].ts'), 'new\n');
    fs.writeFileSync(path.join(dir, 'i.ts'), 'new\n');
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
    const c = changedLines(dir, ['a.ts', '[id].ts', '.env']);
    assert.deepEqual([...c.keys()].sort(), ['[id].ts', 'a.ts']);
    assert.deepEqual(c.get('a.ts'), [[2, 2]]);
    assert.equal(c.get('[id].ts'), 'all');
  });
});

test('parseLinterOutput eslint', () => {
  const cwd = path.resolve('/repo');
  const out = JSON.stringify([{ filePath: path.join(cwd, 'src/a.ts'), messages: [
    { ruleId: 'eqeqeq', severity: 2, message: 'Expected ===', line: 3 },
    { ruleId: 'no-console', severity: 1, message: 'no', line: 4 },
  ] }]);
  const f = parseLinterOutput('eslint', out, cwd);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], { file: 'src/a.ts', line: 3, ruleId: 'eqeqeq', message: 'Expected ===', severity: 'error' });
  assert.equal(f[1].severity, 'warning');
});

test('parseLinterOutput ast-grep converts 0-based lines', () => {
  const out = JSON.stringify([{ file: 'src/a.kt', range: { start: { line: 4 } }, ruleId: 'gen-x', severity: 'error', message: 'm' }]);
  const [f] = parseLinterOutput('ast-grep', out, path.resolve('/repo'));
  assert.deepEqual(f, { file: 'src/a.kt', line: 5, ruleId: 'gen-x', message: 'm', severity: 'error' });
});

test('parseLinterOutput ruff', () => {
  const cwd = path.resolve('/repo');
  const out = JSON.stringify([{ filename: path.join(cwd, 'app/x.py'), code: 'S110', message: 'm', location: { row: 7 } }]);
  const [f] = parseLinterOutput('ruff', out, cwd);
  assert.deepEqual(f, { file: 'app/x.py', line: 7, ruleId: 'S110', message: 'm', severity: 'error' });
});

test('onChangedLines keeps only errors on changed lines', () => {
  const mk = (file, line, severity = 'error') => ({ file, line, ruleId: 'r', message: 'm', severity });
  const changed = new Map([['a.ts', [[4, 5]]], ['n.ts', 'all']]);
  const out = onChangedLines([mk('a.ts', 4), mk('a.ts', 6), mk('a.ts', 4, 'warning'), mk('n.ts', 99), mk('n.ts', 1, 'warning'), mk('z.ts', 1)], changed);
  assert.deepEqual(out.map((f) => `${f.file}:${f.line}`), ['a.ts:4', 'n.ts:99']);
});

test('runLinters reports a missing command as a note', () => {
  withTmp((dir) => {
    const r = runLinters(dir, [{ name: 'x', format: 'eslint', command: ['definitely-not-a-command', '{files}'], extensions: ['.ts'], tier: 'fast' }], ['a.ts']);
    assert.deepEqual(r.findings, []);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /^codemyrules: x failed:/);
  });
});

test('runLinters reports non-JSON output as a note', () => {
  withTmp((dir) => {
    const r = runLinters(dir, [{ name: 'y', format: 'eslint', command: [process.execPath, '-e', 'console.log("not json")', '{files}'], extensions: ['.ts'], tier: 'fast' }], ['a.ts']);
    assert.deepEqual(r.findings, []);
    assert.match(r.notes[0], /^codemyrules: y failed:/);
  });
});

test('runLinters builds the note from the first line of stderr', () => {
  withTmp((dir) => {
    const script = 'console.error("boom: bad config\\nsecond line"); process.stdout.write("not json"); process.exit(2)';
    const r = runLinters(dir, [{ name: 'w', format: 'eslint', command: [process.execPath, '-e', script, '{files}'], extensions: ['.ts'], tier: 'fast' }], ['a.ts']);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, ['codemyrules: w failed: boom: bad config']);
  });
});

test('runLinters passes only files with matching extensions', () => {
  withTmp((dir) => {
    const script = 'require("fs").writeFileSync("seen.json", JSON.stringify(process.argv.slice(1))); process.stdout.write("[]")';
    const r = runLinters(dir, [{ name: 'z', format: 'eslint', command: [process.execPath, '-e', script, '{files}'], extensions: ['.ts'], tier: 'fast' }], ['a.ts', 'b.py', 'c.vue', 'd.ts']);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8')), ['a.ts', 'd.ts']);
  });
});

test('formatFindings truncates at the limit and appends the footer', () => {
  const fs25 = Array.from({ length: 25 }, (_, i) => ({ file: 'a.ts', line: i + 1, ruleId: 'r', message: 'msg', severity: 'error' }));
  const lines = formatFindings(fs25).split('\n');
  assert.equal(lines[0], 'a.ts:1 r msg');
  assert.equal(lines.slice(0, 20).filter((l) => /^a\.ts:\d+ r msg$/.test(l)).length, 20);
  assert.equal(lines[20], '…and 5 more');
  assert.equal(lines.slice(21).join('\n').trim(), FOOTER);
  assert.equal(formatFindings([]), '');
});

test('logFindings appends JSON lines and creates the folder', () => {
  withTmp((dir) => {
    logFindings(dir, [{ file: 'a.ts', line: 2, ruleId: 'r', message: 'm', severity: 'error' }], 'edit');
    logFindings(dir, [{ file: 'b.ts', line: 3, ruleId: 's', message: 'm', severity: 'error' }], 'turn');
    const rows = fs.readFileSync(path.join(dir, '.claude/codemyrules/failures.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]), ['ts', 'event', 'ruleId', 'file', 'line']);
    assert.deepEqual([rows[1].event, rows[1].ruleId, rows[1].file, rows[1].line], ['turn', 's', 'b.ts', 3]);
  });
});

test('matchesPattern', () => {
  assert.equal(matchesPattern('src/eslint.config.mjs', '**/eslint.config.*'), true);
  assert.equal(matchesPattern('eslint.config.mjs', '**/eslint.config.*'), true);
  assert.equal(matchesPattern('a/b/detekt-baseline.xml', '**/*baseline*'), true);
  assert.equal(matchesPattern('src/app.ts', '**/eslint.config.*'), false);
  assert.equal(matchesPattern('rules/a/b.js', 'rules/**'), true);
  assert.equal(matchesPattern('rules/a/b.js', 'rules/*'), false);
  assert.equal(matchesPattern('x/eslint.configXmjs', '**/eslint.config.*'), false);
});

test('parseHunks strips the trailing tab git adds to paths with spaces', () => {
  const diff = '--- a/src/my file.ts\t\n+++ b/src/my file.ts\t\n@@ -2 +2 @@\n-a\n+b\n';
  assert.deepEqual([...parseHunks(diff)], [['src/my file.ts', [[2, 2]]]]);
});

test('parseLinterOutput resolves repo-relative paths through a symlinked project dir', () => {
  withTmp((real) => withTmp((holder) => {
    const link = path.join(holder, 'link');
    fs.symlinkSync(real, link);
    fs.writeFileSync(path.join(real, 'a.ts'), 'x\n');
    const abs = fs.realpathSync(path.join(real, 'a.ts'));
    const out = JSON.stringify([{ filePath: abs, messages: [{ line: 1, severity: 2, ruleId: 'r', message: 'm' }] }]);
    assert.equal(parseLinterOutput('eslint', out, link)[0].file, 'a.ts');
  }));
});

test('readLoopConfig normalises wrong shapes and still throws on invalid JSON', () => {
  withTmp((dir) => {
    fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
    const f = path.join(dir, '.claude/codemyrules/loop.json');
    fs.writeFileSync(f, '{"protect": "x", "linters": {}}');
    assert.deepEqual(readLoopConfig(dir), { linters: [], protect: [] });
    fs.writeFileSync(f, '{nope');
    assert.throws(() => readLoopConfig(dir));
  });
});

test('logFindings swallows write failures with a note', { skip: process.getuid?.() === 0 }, () => {
  withTmp((dir) => {
    fs.chmodSync(dir, 0o555);
    try {
      const lines = [];
      const orig = console.log;
      console.log = (m) => lines.push(m);
      try { logFindings(dir, [{ file: 'a.ts', line: 2, ruleId: 'r' }], 'edit'); } finally { console.log = orig; }
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^codemyrules: could not write failures\.log \(.+\)$/);
    } finally { fs.chmodSync(dir, 0o755); }
  });
});

test('changedLines ignores colour, mnemonic prefix and noprefix git config', () => {
  withTmp((dir) => {
    git(dir, 'init', '-q');
    fs.mkdirSync(path.join(dir, 'w'));
    fs.writeFileSync(path.join(dir, 'w/x.ts'), '1\n2\n3\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    for (const [k, v] of [['color.ui', 'always'], ['color.diff', 'always'], ['diff.mnemonicPrefix', 'true']]) git(dir, 'config', k, v);
    fs.writeFileSync(path.join(dir, 'w/x.ts'), '1\nTWO\n3\n');
    assert.deepEqual([...changedLines(dir)], [['w/x.ts', [[2, 2]]]]);
    git(dir, 'config', 'diff.noprefix', 'true');
    assert.deepEqual([...changedLines(dir)], [['w/x.ts', [[2, 2]]]]);
  });
});

test('parseHunks does not treat an added line starting with ++ as a file header', () => {
  const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,0 +2,2 @@', '+++ x', '+y', '@@ -5 +7 @@', '-p', '+q'].join('\n');
  assert.deepEqual([...parseHunks(diff)], [['a.ts', [[2, 3], [7, 7]]]]);
});

test('runLinters turns a timeout into a failure note', () => {
  withTmp((dir) => {
    const t0 = Date.now();
    const r = runLinters(dir, [{ name: 'slow', format: 'eslint', command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)', '{files}'], extensions: ['.ts'], tier: 'fast' }], ['a.ts'], 200);
    assert.ok(Date.now() - t0 < 4000);
    assert.deepEqual(r.notes, ['codemyrules: slow failed: timed out (time budget 0.2s)']);
  });
});

test('readLoopConfig drops malformed entries', () => {
  withTmp((dir) => {
    fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
    const good = { name: 'g', format: 'eslint', command: ['x'], extensions: ['.ts'] };
    fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), JSON.stringify({
      protect: ['a/**', 3, null, { x: 1 }],
      linters: [good, null, 'x', { name: 'n', command: 'eslint', extensions: ['.ts'] }, { name: 'm', command: ['x'] }],
    }));
    assert.deepEqual(readLoopConfig(dir), { linters: [good], protect: ['a/**'] });
  });
});

test('isSecretFile matches credential files anywhere and leaves source alone', () => {
  for (const f of ['.env', 'api/.env.local', '.ENV.production', '.envrc', 'certs/tls.pem', 'tls.key', '.ssh/id_ed25519', 'deploy/id_rsa.pub',
    '.aws/credentials', 'home/.kube/config', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.docker/config.json',
    '.config/gcloud/application_default_credentials.json', '.claude/.credentials.json', 'infra/prod.tfvars', 'keystore.jks', 'cert.p12']) {
    assert.ok(isSecretFile(f), f);
  }
  for (const f of ['src/env.ts', 'src/credentials.ts', 'environment.md', 'src/keys.ts', 'docs/ssh.md', 'config.json']) {
    assert.ok(!isSecretFile(f), f);
  }
});

test('runLinters never passes a secret file, even with a matching extension', () => {
  withTmp((dir) => {
    const script = 'require("fs").writeFileSync("seen.json", JSON.stringify(process.argv.slice(1))); process.stdout.write("[]")';
    const r = runLinters(dir, [{ name: 'z', format: 'eslint', command: [process.execPath, '-e', script, '{files}'], extensions: ['.json', '.pem', ''], tier: 'fast' }],
      ['config.json', '.docker/config.json', 'tls.pem', '.env', 'app.json']);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8')), ['config.json', 'app.json']);
  });
});

test('runLinters skips the linter when only secret files are left', () => {
  withTmp((dir) => {
    const r = runLinters(dir, [{ name: 'x', format: 'eslint', command: ['definitely-not-a-command', '{files}'], extensions: [''], tier: 'fast' }], ['.env']);
    assert.deepEqual(r, { findings: [], notes: [] });
  });
});

test('changedLines leaves secret files out of the diff and the untracked list', () => {
  withTmp((dir) => {
    git(dir, 'init', '-q');
    fs.mkdirSync(path.join(dir, 'api'));
    for (const f of ['a.ts', '.env', 'api/.env']) fs.writeFileSync(path.join(dir, f), '1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    for (const f of ['a.ts', '.env', 'api/.env']) fs.writeFileSync(path.join(dir, f), 'TOKEN=x\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'TOKEN=y\n');
    fs.writeFileSync(path.join(dir, 'b.ts'), 'new\n');
    assert.deepEqual([...changedLines(dir).keys()].sort(), ['a.ts', 'b.ts']);
  });
});

test('changedLines leaves secret files out in a repo without commits', () => {
  withTmp((dir) => {
    git(dir, 'init', '-q');
    for (const f of ['a.ts', '.env']) fs.writeFileSync(path.join(dir, f), 'x\n');
    git(dir, 'add', '.');
    assert.deepEqual([...changedLines(dir).keys()], ['a.ts']);
  });
});

test('runLinters kills a linter that ignores SIGTERM', () => {
  withTmp((dir) => {
    const t0 = Date.now();
    const script = 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 5000)';
    const r = runLinters(dir, [{ name: 'stubborn', format: 'eslint', command: [process.execPath, '-e', script, '{files}'], extensions: ['.ts'], tier: 'fast' }], ['a.ts'], 300);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
    assert.deepEqual(r.notes, ['codemyrules: stubborn failed: timed out (time budget 0.3s)']);
  });
});

test('runLinters shares one time budget across linters', () => {
  withTmp((dir) => {
    const slow = (name) => ({ name, format: 'eslint', command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)', '{files}'], extensions: ['.ts'], tier: 'fast' });
    const t0 = Date.now();
    const r = runLinters(dir, [slow('a'), slow('b'), slow('c')], ['a.ts'], 300);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
    assert.deepEqual(r.notes, ['codemyrules: a failed: timed out (time budget 0.3s)',
      'codemyrules: b skipped: time budget 0.3s used up', 'codemyrules: c skipped: time budget 0.3s used up']);
  });
});

test('unquotePath reads the C-quoted form git uses for odd names', () => {
  assert.equal(unquotePath('b/plain.ts'), 'b/plain.ts');
  assert.equal(unquotePath('"b/we\\"ird.ts"'), 'b/we"ird.ts');
  assert.equal(unquotePath('"b/back\\\\slash.ts"'), 'b/back\\slash.ts');
  assert.equal(unquotePath('"b/tab\\there.ts"'), 'b/tab\there.ts');
  assert.equal(unquotePath('"b/\\303\\244.ts"'), 'b/\u00e4.ts');
});

test('parseHunks reads quoted file names', () => {
  const diff = '--- "a/we\\"ird.ts"\n+++ "b/we\\"ird.ts"\n@@ -1 +1 @@\n-a\n+b\n';
  assert.deepEqual([...parseHunks(diff)], [['we"ird.ts', [[1, 1]]]]);
});

test('changedLines handles names git has to quote, tracked and untracked', () => {
  withTmp((dir) => {
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'we"ird.ts'), '1\n2\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'we"ird.ts'), '1\nTWO\n');
    fs.writeFileSync(path.join(dir, 'back\\slash.ts'), 'new\n');
    const c = changedLines(dir);
    assert.deepEqual(c.get('we"ird.ts'), [[2, 2]]);
    assert.equal(c.get('back\\slash.ts'), 'all');
  });
});

test('dirtyFiles lists changed, deleted and untracked files, never secret files', () => {
  withTmp((dir) => {
    assert.equal(dirtyFiles(dir), null);
    git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'a.ts'), '1\n');
    assert.deepEqual([...dirtyFiles(dir)], ['a.ts']);
    fs.writeFileSync(path.join(dir, 'b.ts'), '1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    assert.deepEqual([...dirtyFiles(dir)], []);
    fs.writeFileSync(path.join(dir, 'a.ts'), '2\n');
    fs.rmSync(path.join(dir, 'b.ts'));
    fs.writeFileSync(path.join(dir, 'we"ird.ts'), 'x\n');
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
    assert.deepEqual([...dirtyFiles(dir)].sort(), ['a.ts', 'b.ts', 'we"ird.ts']);
  });
});
