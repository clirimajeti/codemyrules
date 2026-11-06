import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decide, suppressionLines } from '../guard.mjs';

const GUARD = path.join(import.meta.dirname, '..', 'guard.mjs');

function project(protect = ['**/eslint.config.*']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  fs.mkdirSync(path.join(dir, '.claude/codemyrules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), JSON.stringify({ protect }));
  return dir;
}
const edit = (dir, file, old_string, new_string) => ({
  tool_name: 'Edit', tool_input: { file_path: path.join(dir, file), old_string, new_string },
});

test('suppressionLines collects trimmed suppression lines', () => {
  assert.deepEqual(suppressionLines('  // eslint-disable-next-line\nplain\nx = 1  # noqa\n'), ['// eslint-disable-next-line', 'x = 1  # noqa']);
  assert.deepEqual(suppressionLines('plain'), []);
});

test('each suppression form is detected', () => {
  const forms = [
    '// eslint-disable-next-line no-console', '/* eslint no-console: "off" */', '// eslint @typescript-eslint/no-explicit-any: 0',
    '// @ts-ignore', '// @ts-nocheck', '// @ts-expect-error', '@Suppress("x")', '@SuppressWarnings("x")', '@SuppressLint("x")',
    'x = 1  # noqa', '# ruff: noqa', 'x = 1  #noqa: E501', 'x = 1  # NOQA', 'x  # type: ignore', '# pylint: disable=foo',
    '// ast-grep-ignore', '//nolint', '#[allow(dead_code)]', '#![allow(unused)]', '// biome-ignore lint: x', 'x(); // NOSONAR',
    '# pylint: skip-file', 'x = 1  # pyright: ignore', '# pyright: basic', '# mypy: ignore-errors', '# mypy: disable-error-code="x"',
    'int x; // NOLINT', '// NOLINTNEXTLINE(foo)', '#pragma warning disable CS0168', '[SuppressMessage("x", "y")]',
    '[assembly: SuppressMessage("x", "y")]', '@file:Suppress("x")', '@SuppressFBWarnings("x")', '# rubocop:disable Style/Foo',
    '# rubocop:todo Style/Foo', '// @phpstan-ignore-next-line', '/** @psalm-suppress Foo */', '// phpcs:ignore', '// phpcs:disable',
    '/* tslint:disable */', '//lint:ignore SA1000 reason',
  ];
  for (const f of forms) assert.equal(suppressionLines(f).length, 1, f);
  for (const f of ['const eslint = 1;', '// eslint is great', 'allow(x)', 'notanoqa', 'class SuppressMessages {}', 'lint(x)']) assert.deepEqual(suppressionLines(f), [], f);
});

test('Edit adding a suppression is flagged, an unchanged suppression line is not', () => {
  const dir = project();
  try {
    assert.ok(decide(edit(dir, 'src/a.ts', 'x', 'x // eslint-disable-line'), dir));
    assert.equal(decide(edit(dir, 'src/a.ts', 'x // eslint-disable-line\na', 'x // eslint-disable-line\nb'), dir), null);
    // the same suppression now covers different code
    assert.ok(decide(edit(dir, 'src/a.ts', 'x // eslint-disable-line', 'y // eslint-disable-line'), dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('swapping one suppression for another is flagged', () => {
  const dir = project();
  try {
    assert.ok(decide(edit(dir, 'src/a.ts', '// eslint-disable-next-line a', '// @ts-expect-error'), dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('adding a rule name to an existing disable comment is flagged', () => {
  const dir = project();
  try {
    assert.ok(decide(edit(dir, 'src/a.ts', '/* eslint-disable a */', '/* eslint-disable a, b */'), dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('removing a suppression passes', () => {
  const dir = project();
  try { assert.equal(decide(edit(dir, 'src/a.ts', 'x\n// @ts-ignore\ny', 'x\ny'), dir), null); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings.local.json always asks', () => {
  const dir = project([]);
  try {
    assert.ok(decide({ tool_name: 'Write', tool_input: { file_path: path.join(dir, '.claude/settings.local.json'), content: '{}' } }, dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('protected paths match through a symlinked project dir, also for new files', () => {
  const dir = project();
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  try {
    const link = path.join(holder, 'link');
    fs.symlinkSync(dir, link);
    fs.writeFileSync(path.join(dir, 'eslint.config.mjs'), 'x');
    const w = (cwd, file) => decide({ tool_name: 'Write', tool_input: { file_path: file, content: 'y' } }, cwd);
    assert.ok(w(link, path.join(dir, 'eslint.config.mjs')));
    assert.ok(w(dir, path.join(link, 'eslint.config.mjs')));
    assert.ok(w(dir, path.join(link, 'pkg/eslint.config.js')));
    assert.ok(w(link, path.join(dir, 'pkg/eslint.config.js')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(holder, { recursive: true, force: true }); }
});

test('MultiEdit sums its edits', () => {
  const dir = project();
  try {
    const input = { tool_name: 'MultiEdit', tool_input: { file_path: path.join(dir, 'src/a.ts'), edits: [
      { old_string: 'a', new_string: 'a // @ts-ignore' }, { old_string: 'b', new_string: 'c' }] } };
    assert.ok(decide(input, dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Write compares against the file on disk', () => {
  const dir = project();
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'x(); // eslint-disable-line\n');
    const w = (content) => ({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.ts'), content } });
    assert.equal(decide(w('x(); // eslint-disable-line\nmore\n'), dir), null);
    assert.ok(decide(w('x(); // eslint-disable-line\nx(); // eslint-disable-line\n'), dir));
    assert.ok(decide({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/new.ts'), content: '# noqa' } }, dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('protected paths and the codemyrules folder are flagged', () => {
  const dir = project();
  try {
    const w = (file) => ({ tool_name: 'Write', tool_input: { file_path: path.join(dir, file), content: 'x' } });
    assert.ok(decide(w('eslint.config.mjs'), dir));
    assert.ok(decide(w('pkg/eslint.config.js'), dir));
    assert.ok(decide(w('.claude/codemyrules/rules/r.mjs'), dir));
    assert.equal(decide(w('src/a.ts'), dir), null);
    assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: '/elsewhere/eslint.config.mjs', content: 'x' } }, dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('normal Edit passes', () => {
  const dir = project();
  try { assert.equal(decide(edit(dir, 'src/a.ts', 'a', 'b'), dir), null); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('script prints an ask decision for a suppression', () => {
  const dir = project();
  try {
    const r = spawnSync('node', [GUARD], { input: JSON.stringify(edit(dir, 'src/a.ts', 'x', '// eslint-disable-line')), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.equal(out.permissionDecision, 'ask');
    assert.match(out.permissionDecisionReason, /^codemyrules: .* Only the user can approve this\.$/);
    const ok = spawnSync('node', [GUARD], { input: JSON.stringify(edit(dir, 'src/a.ts', 'x', 'y')), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed loop.json fails closed with an ask', () => {
  const dir = project();
  try {
    fs.writeFileSync(path.join(dir, '.claude/codemyrules/loop.json'), '{ nope');
    const r = spawnSync('node', [GUARD], { input: JSON.stringify(edit(dir, 'src/a.ts', 'x', 'y')), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'ask');
    assert.match(out.permissionDecisionReason, /loop\.json could not be read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Write to a secret file never reads it', () => {
  const dir = project();
  try {
    fs.mkdirSync(path.join(dir, '.env')); // reading it would throw EISDIR
    assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: path.join(dir, '.env'), content: '# noqa' } }, dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('moving a next-line suppression to other code is flagged', () => {
  const dir = project();
  try {
    assert.ok(decide(edit(dir, 'src/a.ts', '// eslint-disable-next-line\nA\nB', 'A\n// eslint-disable-next-line\nB'), dir));
    assert.ok(decide(edit(dir, 'src/a.py', '# pylint: disable=x\ndef a(): pass', '# pylint: disable=x\ndef b(): pass'), dir));
    // stacked annotations all cover the declaration below them
    assert.equal(decide(edit(dir, 'src/A.kt', '@Suppress("a")\n@Deprecated("x")\nfun a()', '@Suppress("a")\n@Deprecated("y")\nfun a()'), dir), null);
    // code on other lines of the edit is free to change
    assert.equal(decide(edit(dir, 'src/a.ts', 'q\n// eslint-disable-next-line\nA', 'r\n// eslint-disable-next-line\nA'), dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MultiEdit compares each edit on its own', () => {
  const dir = project();
  try {
    const input = { tool_name: 'MultiEdit', tool_input: { file_path: path.join(dir, 'src/a.ts'), edits: [
      { old_string: 'a\n// @ts-ignore', new_string: 'a\n// @ts-ignore' }, { old_string: 'b', new_string: 'c' }] } };
    assert.equal(decide(input, dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('suppressions mentioned in prose files do not ask', () => {
  const dir = project();
  try {
    for (const f of ['README.md', 'docs/x.mdx', 'notes.txt', 'CLAUDE.md']) {
      assert.equal(decide(edit(dir, f, 'a', 'Never add `// eslint-disable-next-line` or `# noqa`.'), dir), null, f);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lint settings inside package.json and pyproject.toml ask, other edits there pass', () => {
  const dir = project([]);
  try {
    const pkg = JSON.stringify({ name: 'x', version: '1.0.0', eslintConfig: { rules: { eqeqeq: 'error' } } }, null, 2);
    fs.writeFileSync(path.join(dir, 'package.json'), pkg);
    assert.ok(decide(edit(dir, 'package.json', '"eqeqeq": "error"', '"eqeqeq": "off"'), dir));
    assert.equal(decide(edit(dir, 'package.json', '"version": "1.0.0"', '"version": "1.1.0"'), dir), null);
    const toml = '[project]\nname = "x"\n\n[tool.ruff.lint]\nselect = ["E"]\n\n[[tool.mypy.overrides]]\nmodule = "a"\n';
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), toml);
    assert.ok(decide(edit(dir, 'pyproject.toml', 'select = ["E"]', 'select = []'), dir));
    assert.ok(decide(edit(dir, 'pyproject.toml', 'module = "a"', 'module = "b"'), dir));
    assert.equal(decide(edit(dir, 'pyproject.toml', 'name = "x"', 'name = "y"'), dir), null);
    const w = (content) => ({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'pyproject.toml'), content } });
    assert.ok(decide(w(toml + '\n[tool.pylint]\ndisable = "all"\n'), dir));
    assert.equal(decide(w(toml.replace('"x"', '"z"')), dir), null);
    fs.writeFileSync(path.join(dir, 'setup.cfg'), '[metadata]\nname = x\n');
    assert.ok(decide(edit(dir, 'setup.cfg', 'name = x', 'name = x\n\n[flake8]\nignore = E501'), dir));
    assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'pkg/package.json'), content: '{"name":"n"}' } }, dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
