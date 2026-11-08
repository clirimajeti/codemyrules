import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR = '.claude/codemyrules';
export const SETTINGS_FILE = '.claude/settings.local.json';
// the pi extension the installer writes; it loads the pi adapter from the pinned package
export const PI_EXTENSION = '.pi/extensions/codemyrules.js';
// the opencode plugin the installer writes; it loads the opencode adapter from the pinned package
export const OPENCODE_PLUGIN = '.opencode/plugins/codemyrules.js';
const CONFIG_FILE = 'loop.json';
const LOG_FILE = 'failures.log';

export const FOOTER = 'Fix these before you finish. If you think a case is legitimate, ask the user and show the rule, its message and why you think so. If they agree, propose a change to the rule (an exclusion or a narrower pattern, plus a test case), not to the code. Never add an ignore comment or change lint config on your own. With nobody to ask, finish the rest of the task and list these in your final report.';

// Files that hold credentials by convention (secret-patterns.json, lowercase, matched case-insensitively).
// codemyrules never reads them, diffs them or hands them to a linter.
export const SECRET_PATTERNS = JSON.parse(fs.readFileSync(new URL('./secret-patterns.json', import.meta.url), 'utf8'));
export const isSecretFile = (rel) => {
  const p = rel.split(path.sep).join('/').toLowerCase();
  return SECRET_PATTERNS.some((pat) => matchesPattern(p, pat));
};
// git pathspec: the given files (taken literally, `[id].ts` is no glob) or everything, except the secret files
const pathspec = (files) => ['--', ...(files ? files.map((f) => `:(literal)${f}`) : ['.']), ...SECRET_PATTERNS.map((p) => `:(exclude,glob,icase)${p}`)];

const toPosix = (p) => p.split(path.sep).join('/');
// linters report realpaths, so resolve a symlinked project dir (macOS /var) before going relative;
// a path that does not exist yet resolves through its nearest existing parent
export function realPath(p) {
  try { return fs.realpathSync(p); } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}
// a linter's path (absolute, or relative to the folder it ran in) as a path relative to the project root
const relFile = (cwd, file, base = cwd) => toPosix(path.relative(realPath(cwd), path.resolve(realPath(base), file)));

// git C-quotes a path that holds ", \ or a control character, even with core.quotepath=off: "b/we\"ird.ts"
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
export function unquotePath(p) {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const s = p.slice(1, -1);
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(/\\([0-7]{3}|.)/g)) {
    parts.push(Buffer.from(s.slice(last, m.index)));
    const e = m[1];
    parts.push(e.length === 3 ? Buffer.from([parseInt(e, 8)]) : ESCAPES[e] ? Buffer.from([ESCAPES[e]]) : Buffer.from(e));
    last = m.index + m[0].length;
  }
  parts.push(Buffer.from(s.slice(last)));
  return Buffer.concat(parts).toString('utf8');
}

export function parseHunks(diff) {
  const result = new Map();
  let file = null;
  let prev = '';
  for (const line of diff.split('\n')) {
    const header = line.startsWith('+++ ') && prev.startsWith('--- ');
    prev = line;
    if (header) {
      const name = unquotePath(line.slice(4).replace(/\t.*$/, ''));
      file = name === '/dev/null' ? null : name.replace(/^b\//, '');
      continue;
    }
    const m = file && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    if (!result.has(file)) result.set(file, []);
    result.get(file).push([start, start + count - 1]);
  }
  return result;
}

// pin every output-shaping setting, so user git config cannot change what we parse
const git = (cwd, args, input) => spawnSync('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], { cwd, input, encoding: 'utf8', maxBuffer: 1 << 28 });
// NUL-separated output (-z) is never quoted, whatever the file name
const names = (s) => s.split('\0').filter(Boolean);
const inRepo = (cwd) => git(cwd, ['rev-parse', '--is-inside-work-tree']).status === 0;
const hasHead = (cwd) => git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).status === 0;

// files: limit the diff to these paths (relative to cwd); a whole-repo diff costs seconds with thousands of changed files
export function changedLines(cwd, files) {
  if (!inRepo(cwd)) return null;
  const spec = pathspec(files);
  const result = new Map();
  const markAll = (out) => names(out).forEach((f) => result.set(f, 'all'));
  if (hasHead(cwd)) {
    for (const [f, ranges] of parseHunks(git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--relative', 'HEAD', ...spec]).stdout)) result.set(f, ranges);
  } else {
    markAll(git(cwd, ['ls-files', '--cached', '-z', ...spec]).stdout);
  }
  markAll(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...spec]).stdout);
  return result;
}

// every file that differs from HEAD (changed, deleted or untracked), relative to cwd, secret files left out; null outside a repo
export function dirtyFiles(cwd) {
  if (!inRepo(cwd)) return null;
  const spec = pathspec();
  const tracked = hasHead(cwd)
    // diff-index compares stat data only (git diff reads every changed file: 350 ms against 16 ms for 5000 files);
    // a file that was only touched is listed too, and the content hash then shows it unchanged
    ? git(cwd, ['diff-index', '--name-only', '-z', '--no-renames', '--relative', 'HEAD', ...spec])
    : git(cwd, ['ls-files', '--cached', '-z', ...spec]);
  return new Set([...names(tracked.stdout), ...names(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...spec]).stdout)]);
}

// git blob ids of the given files as they are on disk (null for a file that is gone); write keeps the content in git's object store
export function hashFiles(cwd, files, write = false) {
  const result = new Map(files.map((f) => [f, null]));
  const present = files.filter((f) => !f.includes('\n') && fs.statSync(path.join(cwd, f), { throwIfNoEntry: false })?.isFile());
  if (!present.length) return result;
  const r = git(cwd, ['hash-object', '--no-filters', ...(write ? ['-w'] : []), '--stdin-paths'], present.join('\n'));
  if (r.status !== 0) throw new Error(`git hash-object failed: ${r.stderr.split('\n')[0]}`);
  r.stdout.trim().split('\n').forEach((h, i) => result.set(present[i], h));
  return result;
}

// a blob's text, or a file's text at HEAD; '' when there is none
export const readBlob = (cwd, rev) => { const r = git(cwd, ['cat-file', 'blob', rev]); return r.status === 0 ? r.stdout : ''; };

const parsers = {
  eslint: (data, cwd, base) => data.flatMap((r) => r.messages.map((m) => ({
    file: relFile(cwd, r.filePath, base), line: m.line, ruleId: m.ruleId ?? 'eslint',
    message: m.message, severity: m.severity === 2 ? 'error' : 'warning',
  }))),
  'ast-grep': (data, cwd, base) => data.map((m) => ({
    file: relFile(cwd, m.file, base), line: m.range.start.line + 1, ruleId: m.ruleId,
    message: m.message, severity: m.severity === 'error' ? 'error' : 'warning',
  })),
  ruff: (data, cwd, base) => data.map((m) => ({
    file: relFile(cwd, m.filename, base), line: m.location.row, ruleId: m.code,
    message: m.message, severity: 'error',
  })),
};

// base: the folder the linter ran in, when it is not the project root
export function parseLinterOutput(format, stdout, cwd, base = cwd) {
  return parsers[format](JSON.parse(stdout), cwd, base);
}

export function onChangedLines(findings, changed) {
  if (!changed) return [];
  return findings.filter((f) => {
    if (f.severity !== 'error') return false;
    const ranges = changed.get(f.file);
    if (ranges === 'all') return true;
    return !!ranges && ranges.some(([a, b]) => f.line >= a && f.line <= b);
  });
}

// one time budget per hook run, shared by all its linters, so several linters cannot add up past the hook's own timeout
export const BUDGET_MS = { edit: 10000, turn: 60000 };

export function runLinters(cwd, linters, files, budget = BUDGET_MS.edit) {
  const findings = [];
  const notes = [];
  const deadline = Date.now() + budget;
  for (const l of linters) {
    // a linter with a cwd (one package of a monorepo) runs there, on its own files only, named relative to it
    const base = l.cwd ? path.join(cwd, l.cwd) : cwd;
    const inside = (f) => { const r = path.relative(base, path.join(cwd, f)); return !r.startsWith('..') && !path.isAbsolute(r); };
    const mine = files.filter((f) => !isSecretFile(f) && l.extensions.includes(path.extname(f)) && (!l.cwd || inside(f)));
    if (!mine.length) continue;
    const timeout = deadline - Date.now();
    if (timeout <= 0) { notes.push(`codemyrules: ${l.name} skipped: time budget ${budget / 1000}s used up`); continue; }
    const args = l.cwd ? mine.map((f) => path.relative(base, path.join(cwd, f))) : mine;
    const command = l.command.flatMap((a) => (a === '{files}' ? args : [a]));
    // SIGKILL: a linter that ignores SIGTERM would otherwise keep the hook waiting
    const r = spawnSync(command[0], command.slice(1), { cwd: base, encoding: 'utf8', maxBuffer: 1 << 28, timeout, killSignal: 'SIGKILL' });
    try {
      if (r.error?.code === 'ETIMEDOUT') throw new Error(`timed out (time budget ${budget / 1000}s)`);
      if (r.error) throw r.error;
      findings.push(...parseLinterOutput(l.format, r.stdout, cwd, base));
    } catch (e) {
      const reason = (r.error ? '' : (r.stderr || '').split('\n')[0].trim()) || e.message.split('\n')[0];
      notes.push(`codemyrules: ${l.name} failed: ${reason}`);
    }
  }
  return { findings, notes };
}

export function formatFindings(findings, limit = 20) {
  if (!findings.length) return '';
  const out = findings.slice(0, limit).map((f) => `${f.file}:${f.line} ${f.ruleId} ${f.message}`);
  if (findings.length > limit) out.push(`…and ${findings.length - limit} more`);
  out.push(FOOTER);
  return out.join('\n');
}

export function logFindings(cwd, findings, event) {
  if (!findings.length) return;
  try {
    const dir = path.join(cwd, CONFIG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const rows = findings.map((f) => JSON.stringify({ ts, event, ruleId: f.ruleId, file: f.file, line: f.line }));
    fs.appendFileSync(path.join(dir, LOG_FILE), rows.join('\n') + '\n');
  } catch (e) {
    console.log(`codemyrules: could not write ${LOG_FILE} (${e.message.split('\n')[0]})`);
  }
}

// the project-relative paths edited in this session's current turn, one per line
export const turnFile = (cwd, sessionId) =>
  path.join(cwd, CONFIG_DIR, `turn-${String(sessionId || 'default').replace(/[^\w-]/g, '_')}.txt`);

export function readLoopConfig(cwd) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(cwd, CONFIG_DIR, CONFIG_FILE), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    linters: list(raw?.linters).filter((l) => Array.isArray(l?.command) && Array.isArray(l.extensions) && (l.cwd === undefined || typeof l.cwd === 'string')),
    protect: list(raw?.protect).filter((p) => typeof p === 'string'),
  };
}

// true when this module is the script node was started with; compared resolved, because a symlinked path
// (macOS /var, a symlinked project dir) gives a different argv[1] and the script would silently do nothing
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(metaUrl)); } catch { return false; }
}

export async function readHookInput() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() ? JSON.parse(data) : {};
}

export function matchesPattern(p, pattern) {
  const re = pattern.split(/(\*\*\/|\*\*|\*)/).map((t) => {
    if (t === '**/') return '(?:.*/)?';
    if (t === '**') return '.*';
    if (t === '*') return '[^/]*';
    return t.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${re}$`).test(p);
}
