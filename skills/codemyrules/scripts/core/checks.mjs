// Harness-neutral checks for one change to one file: protected paths, added or moved lint suppressions,
// and lint settings inside shared build files. Each returns a reason the user must approve, or null.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, HARNESS_FILES, isSecretFile, matchesPattern, readLoopConfig, realPath } from './lib.mjs';

export const SUPPRESSION = new RegExp([
  /eslint-disable/, /oxlint-disable/, /\/[*/]\s*eslint\s+[@\w/-]+\s*:/, // inline ESLint config: /* eslint no-console: "off" */
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

// alsoProtect: patterns that count too, such as the protect list from before a command that may have rewritten loop.json
export function protectReason(cwd, rel, alsoProtect = []) {
  if (rel.startsWith(`${CONFIG_DIR}/`) || HARNESS_FILES.includes(rel)) return `${rel} is part of the codemyrules setup.`;
  let protect;
  try {
    protect = readLoopConfig(cwd).protect;
  } catch (e) {
    return `loop.json could not be read (${e.message.split('\n')[0]}), so this edit needs your approval.`;
  }
  const hit = [...protect, ...alsoProtect].find((p) => matchesPattern(rel, p));
  return hit ? `${rel} is protected (${hit}).` : null;
}

// why changing a file from before() to after() needs the user, or null; the thunks read whole files only when needed.
// oldTexts/newTexts are the edited pieces (one pair per edit), by default the whole file.
// The new text is looked at first: without a suppression in it nothing was added, and before() is not called.
// After a shell command before() is one git call per changed file, 8 s for 1500 files.
export function contentReason(rel, before, after, oldTexts, newTexts) {
  const added = newTexts ?? [after()];
  if (added.some((t) => SUPPRESSION.test(t ?? '')) && addsSuppression(rel, oldTexts ?? [before()], added)) return `this edit adds or changes a lint suppression in ${rel}.`;
  if (EMBEDS_LINT(rel) && lintSettings(rel, before()) !== lintSettings(rel, after())) return `this edit changes lint settings in ${rel}.`;
  return null;
}

const applyEdit = (text, e) => (e.replaceAll ? text.split(e.oldText ?? '').join(e.newText ?? '') : text.replace(e.oldText ?? '', () => e.newText ?? ''));

// The whole lines each replacement touches, before and after it, so an edit of part of a line is judged by the line:
// replacing `no-console` with `no-console, no-eval` widens the suppression on that line.
// Edits apply in order; an edit whose old text is not in the file is judged by its own pieces (the tool will fail it anyway).
function touchedLines(text, edits) {
  const olds = [];
  const news = [];
  for (const e of edits) {
    const old = e.oldText ?? '';
    const add = e.newText ?? '';
    const at = [];
    for (let i = old ? text.indexOf(old) : -1; i >= 0; i = e.replaceAll ? text.indexOf(old, i + old.length) : -1) at.push(i);
    if (!at.length) { olds.push(old); news.push(add); text = applyEdit(text, e); continue; }
    for (const i of at) {
      const start = text.lastIndexOf('\n', i - 1) + 1;
      const end = text.indexOf('\n', i + old.length);
      const stop = end < 0 ? text.length : end;
      olds.push(text.slice(start, stop));
      news.push(text.slice(start, i) + add + text.slice(i + old.length, stop));
    }
    text = applyEdit(text, e);
  }
  return { olds, news };
}

// edit: { file, content } for a whole-file write, or { file, edits: [{ oldText, newText, replaceAll }] } for replacements
export function checkEdit(cwd, edit) {
  const inside = projectPath(cwd, edit.file);
  if (inside !== null) {
    const r = protectReason(cwd, inside);
    if (r) return r;
  }
  const rel = inside ?? path.relative(realPath(cwd), realPath(path.resolve(cwd, edit.file))).split(path.sep).join('/');
  if (isSecretFile(rel)) return null;
  const disk = () => readOrEmpty(path.resolve(cwd, edit.file));
  if (edit.content !== undefined) {
    const old = disk();
    return contentReason(rel, () => old, () => edit.content);
  }
  const edits = edit.edits ?? [];
  const before = disk();
  const { olds, news } = touchedLines(before, edits);
  return contentReason(rel, () => before, () => edits.reduce(applyEdit, before), olds, news);
}
