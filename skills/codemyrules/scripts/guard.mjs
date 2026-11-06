import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR, SETTINGS_FILE, isSecretFile, matchesPattern, readHookInput, readLoopConfig, realPath } from './lib.mjs';

export const SUPPRESSION = new RegExp([
  /eslint-disable/, /\/[*/]\s*eslint\s+[@\w/-]+\s*:/, // inline ESLint config: /* eslint no-console: "off" */
  /@ts-ignore/, /@ts-nocheck/, /@ts-expect-error/, /tslint:disable/, /biome-ignore/,
  /@(?:file:)?Suppress\w*/, /\[\s*(?:assembly:\s*)?SuppressMessage/, /#pragma\s+warning\s+disable/, /NOSONAR/,
  /#.*\b[Nn][Oo][Qq][Aa]\b/, /#\s*type:\s*ignore/, /pylint:\s*(?:disable|skip-file)/, /#\s*pyright:/, /#\s*mypy:/,
  /ast-grep-ignore/, /\/\/\s*nolint/, /\/\/\s*lint:(?:file-)?ignore/, /NOLINT/, /#!?\[allow\(/,
  /rubocop:(?:disable|todo)/, /@phpstan-ignore/, /@psalm-suppress/, /phpcs:(?:ignore|disable)/,
].map((r) => r.source).join('|'));

export const suppressionLines = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter((l) => SUPPRESSION.test(l));

// Docs mention ignore comments ("never add eslint-disable"); no linter reads them there.
const PROSE = new Set(['.md', '.mdx', '.markdown', '.rst', '.txt', '.adoc']);
// what may stand before a directive on a line that holds nothing else: comment markers and brackets
const COMMENT_ONLY = /^[\s/*#!@[<{-]*$/;
const ANNOTATION = /^(?:@|#\[|\[)/;

// A suppression on a line of its own covers the code below it, so it is keyed with the next line of code;
// one at the end of a line of code is keyed with that line. Moving a suppression changes its key.
function suppressionKeys(text) {
  const ls = (text ?? '').split('\n').map((l) => l.trim());
  return ls.flatMap((l, i) => {
    const m = SUPPRESSION.exec(l);
    if (!m) return [];
    if (!COMMENT_ONLY.test(l.slice(0, m.index))) return [l];
    const next = ls.slice(i + 1).find((x) => x && !SUPPRESSION.test(x) && !ANNOTATION.test(x)) ?? '';
    return [`${l}\n${next}`];
  });
}

// any suppression key in the new texts that the old texts do not have (multiset difference); each pair of texts is one edit
function addsSuppression(rel, oldTexts, newTexts) {
  if (PROSE.has(path.extname(rel).toLowerCase())) return false;
  const left = oldTexts.flatMap(suppressionKeys);
  return newTexts.flatMap(suppressionKeys).some((k) => {
    const i = left.indexOf(k);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

// Shared build files that can carry lint settings; only those settings are compared, so other edits there pass.
const LINT_SECTION = /^\[\[?(?:tool\.)?(?:ruff|pylint|mypy|pyright|basedpyright|flake8|pycodestyle|pyflakes|pydocstyle|bandit)\b/;
function lintSettings(rel, text) {
  const base = path.posix.basename(rel);
  if (base === 'package.json') {
    // unparsable JSON configures no linter
    try { const j = JSON.parse(text); return j?.eslintConfig === undefined && j?.eslintIgnore === undefined ? null : JSON.stringify([j.eslintConfig, j.eslintIgnore]); } catch { return null; }
  }
  if (!['pyproject.toml', 'setup.cfg', 'tox.ini'].includes(base)) return null;
  let on = false;
  return text.split('\n').map((l) => l.trim()).filter((t) => {
    if (t.startsWith('[')) on = LINT_SECTION.test(t);
    return on && t;
  }).join('\n');
}
const EMBEDS_LINT = (rel) => ['package.json', 'pyproject.toml', 'setup.cfg', 'tox.ini'].includes(path.posix.basename(rel));

const readOrEmpty = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
};

// the project-relative path, or null when the file is outside the project
export function projectPath(cwd, file) {
  const rel = path.relative(realPath(cwd), realPath(path.resolve(cwd, file))).split(path.sep).join('/');
  return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? null : rel;
}

export function protectReason(cwd, rel) {
  if (rel.startsWith(`${CONFIG_DIR}/`) || rel === SETTINGS_FILE) return `${rel} is part of the codemyrules setup.`;
  let protect;
  try {
    protect = readLoopConfig(cwd).protect;
  } catch (e) {
    return `loop.json could not be read (${e.message.split('\n')[0]}), so this edit needs your approval.`;
  }
  const hit = protect.find((p) => matchesPattern(rel, p));
  return hit ? `${rel} is protected (${hit}).` : null;
}

// why changing a file from before() to after() needs the user, or null; the thunks read whole files only when needed.
// oldTexts/newTexts are the edited pieces (one pair per edit), by default the whole file.
export function contentReason(rel, before, after, oldTexts, newTexts) {
  if (addsSuppression(rel, oldTexts ?? [before()], newTexts ?? [after()])) return `this edit adds or changes a lint suppression in ${rel}.`;
  if (EMBEDS_LINT(rel) && lintSettings(rel, before()) !== lintSettings(rel, after())) return `this edit changes lint settings in ${rel}.`;
  return null;
}

const applyEdit = (text, e) => (e.replace_all ? text.split(e.old_string ?? '').join(e.new_string ?? '') : text.replace(e.old_string ?? '', () => e.new_string ?? ''));

export function decide(input, cwd) {
  const ti = input.tool_input ?? {};
  if (!ti.file_path) return null;
  const inside = projectPath(cwd, ti.file_path);
  if (inside !== null) {
    const r = protectReason(cwd, inside);
    if (r) return { reason: r };
  }
  const rel = inside ?? path.relative(realPath(cwd), realPath(path.resolve(cwd, ti.file_path))).split(path.sep).join('/');
  if (isSecretFile(rel)) return null;
  const abs = path.resolve(cwd, ti.file_path);
  const disk = () => readOrEmpty(abs);
  let edits;
  if (input.tool_name === 'Edit') edits = [ti];
  else if (input.tool_name === 'MultiEdit') edits = ti.edits ?? [];
  else if (input.tool_name === 'Write') {
    const old = disk();
    const reason = contentReason(rel, () => old, () => ti.content ?? '');
    return reason ? { reason } : null;
  } else return null;
  const reason = contentReason(rel, disk, () => edits.reduce(applyEdit, disk()), edits.map((e) => e.old_string), edits.map((e) => e.new_string));
  return reason ? { reason } : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = await readHookInput();
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const d = decide(input, cwd);
  if (d) {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: `codemyrules: ${d.reason} Only the user can approve this.`,
    } }));
  }
}
