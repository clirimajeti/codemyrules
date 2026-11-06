import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { docTokens, logStats } from '../measure.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'measure.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
const withRepo = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try { git(dir, 'init', '-q'); return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('docTokens counts tracked agent docs and ignores untracked ones', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'a'.repeat(400));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'CLAUDE.md'), 'b'.repeat(400));
    git(dir, 'add', 'AGENTS.md');
    assert.deepEqual(docTokens(dir), { files: [{ path: 'AGENTS.md', tokens: 100, loaded: 'always' }], total: 100, always: 100, onDemand: 0 });
  });
});

test('docTokens splits always-loaded from on-demand docs, following @imports from root docs', () => {
  withRepo((dir) => {
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.mkdirSync(path.join(dir, 'api'));
    fs.mkdirSync(path.join(dir, '.github/instructions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '@AGENTS.md\nsee @docs/rules.md for more\n'.padEnd(40, ' '));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'a'.repeat(400));
    fs.writeFileSync(path.join(dir, 'docs/rules.md'), 'r'.repeat(200));
    fs.writeFileSync(path.join(dir, 'api/CLAUDE.md'), 'c'.repeat(80));
    fs.writeFileSync(path.join(dir, '.github/instructions/backend.instructions.md'), 'i'.repeat(120));
    git(dir, 'add', '-A');
    const r = docTokens(dir);
    const loaded = Object.fromEntries(r.files.map((f) => [f.path, f.loaded]));
    assert.deepEqual(loaded, { '.github/instructions/backend.instructions.md': 'on-demand', 'AGENTS.md': 'always', 'CLAUDE.md': 'always', 'api/CLAUDE.md': 'on-demand', 'docs/rules.md': 'always' });
    assert.equal(r.always, 10 + 100 + 50);
    assert.equal(r.onDemand, 30 + 20);
    assert.equal(r.total, r.always + r.onDemand);
  });
});

test('docTokens counts Markdown files an agent doc links to as on-demand, one level deep', () => {
  withRepo((dir) => {
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'See [backend](docs/backend.md#rules), [web](https://x.dev/a.md) and [gone](docs/gone.md).'.padEnd(120, ' '));
    fs.writeFileSync(path.join(dir, 'docs/backend.md'), 'Also [deep](deep.md).'.padEnd(200, ' '));
    fs.writeFileSync(path.join(dir, 'docs/deep.md'), 'd'.repeat(400));
    fs.writeFileSync(path.join(dir, 'docs/api.md'), 'u'.repeat(400));
    git(dir, 'add', '-A');
    const r = docTokens(dir);
    assert.deepEqual(r.files.map((f) => [f.path, f.loaded]), [['CLAUDE.md', 'always'], ['docs/backend.md', 'on-demand']]);
    assert.deepEqual([r.always, r.onDemand], [30, 50]);
  });
});

test('logStats aggregates by rule and event', () => {
  withRepo((dir) => {
    fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
    const row = (event, ruleId) => JSON.stringify({ ts: 't', event, ruleId, file: 'a', line: 1 });
    fs.writeFileSync(path.join(dir, '.claude/codemyrules/failures.log'), [row('edit', 'gen-a'), row('turn', 'gen-a'), row('edit', 'gen-b')].join('\n') + '\n');
    assert.deepEqual(logStats(dir), {
      total: 3, byRule: { 'gen-a': 2, 'gen-b': 1 }, byEvent: { edit: 2, turn: 1 },
      files: { 'gen-a': ['a', 'a'], 'gen-b': ['a'] }, ruleEvents: { 'gen-a': { edit: 1, turn: 1 }, 'gen-b': { edit: 1, turn: 0 } },
    });
    assert.deepEqual(logStats(os.tmpdir() + '/nonexistent-cmr'), { total: 0, byRule: {}, byEvent: { edit: 0, turn: 0 }, files: {}, ruleEvents: {} });
  });
});

test('baseline then report prints before and now', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'a'.repeat(400));
    git(dir, 'add', 'AGENTS.md');
    const rules = path.join(dir, 'r.json');
    fs.writeFileSync(rules, JSON.stringify({ 'gen-a': 5 }));
    execFileSync('node', [script, 'baseline', dir, '--rules', rules]);
    const b = JSON.parse(fs.readFileSync(path.join(dir, '.claude/codemyrules/baseline.json'), 'utf8'));
    assert.deepEqual([b.docTokens, b.alwaysTokens, b.onDemandTokens, b.rules], [100, 100, 0, { 'gen-a': 5 }]);
    const out = execFileSync('node', [script, 'report', dir], { encoding: 'utf8' });
    assert.match(out, /always-loaded doc tokens: 100 -> 100 \(read in every session\)/);
    assert.match(out, /on-demand doc tokens: 0 -> 0/);
    assert.match(out, /gen-a: 5 open at baseline, 0 logged failures since/);
  });
});

test('report still reads an old baseline without the always/on-demand split', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'a'.repeat(400));
    git(dir, 'add', 'AGENTS.md');
    fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude/codemyrules/baseline.json'), JSON.stringify({ date: 'd', docTokens: 140, rules: {} }));
    const out = execFileSync('node', [script, 'report', dir], { encoding: 'utf8' });
    assert.match(out, /doc tokens: 140 -> 100/);
  });
});

test('report advises from the failure log and the doc growth', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'a'.repeat(400));
    git(dir, 'add', 'CLAUDE.md');
    const rules = path.join(dir, 'r.json');
    fs.writeFileSync(rules, JSON.stringify({ 'gen-often': 0, 'gen-never': 0, 'gen-late': 2 }));
    execFileSync('node', [script, 'baseline', dir, '--rules', rules]);
    const row = (ruleId, file, event) => JSON.stringify({ ts: new Date().toISOString(), event, ruleId, file, line: 1 });
    fs.writeFileSync(path.join(dir, '.claude/codemyrules/failures.log'), [
      row('gen-often', 'src/domain/orders/a.ts', 'edit'), row('gen-often', 'src/domain/orders/b.ts', 'edit'),
      row('gen-often', 'src/domain/billing/c.ts', 'edit'), row('gen-often', 'src/api/d.ts', 'turn'),
      row('gen-late', 'src/x.ts', 'turn'), row('gen-late', 'src/y.ts', 'turn'), row('gen-late', 'src/z.ts', 'turn'),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'a'.repeat(600));
    const out = execFileSync('node', [script, 'report', dir], { encoding: 'utf8' });
    assert.match(out, /gen-often failed 4 times[^\n]*mostly in src\/domain\/[^\n]*pointer in src\/domain\/CLAUDE\.md/);
    assert.match(out, /gen-never has not failed since/);
    assert.match(out, /gen-late is caught mostly at the end of the turn[^\n]*fast tier/);
    assert.doesNotMatch(out, /gen-never is caught/);
    assert.match(out, /always-loaded agent docs grew by 50 tokens/);
  });
});

test('report gives no advice when there is nothing to act on', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'a'.repeat(400));
    git(dir, 'add', 'CLAUDE.md');
    execFileSync('node', [script, 'baseline', dir]);
    const out = execFileSync('node', [script, 'report', dir], { encoding: 'utf8' });
    assert.doesNotMatch(out, /advice/i);
  });
});
