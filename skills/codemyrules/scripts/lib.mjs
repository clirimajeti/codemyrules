import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_DIR = '.claude/codemyrules';
export const SETTINGS_FILE = '.claude/settings.local.json';
const CONFIG_FILE = 'loop.json';
const LOG_FILE = 'failures.log';

export const FOOTER = 'Fix these before you finish. If you think a case is legitimate, ask the user and show the rule, its message and why you think so. If they agree, propose a change to the rule (an exclusion or a narrower pattern, plus a test case), not to the code. Never add an ignore comment or change lint config on your own. With nobody to ask, finish the rest of the task and list these in your final report.';

const toPosix = (p) => p.split(path.sep).join('/');
// linters report realpaths, so resolve a symlinked project dir (macOS /var) before going relative;
// a path that does not exist yet resolves through its nearest existing parent
export function realPath(p) {
  try { return fs.realpathSync(p); } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realPath(parent), path.basename(p));
  }
}
const relFile = (cwd, file) => { const real = realPath(cwd); return toPosix(path.relative(real, path.resolve(real, file))); };

export function parseHunks(diff) {
  const result = new Map();
  let file = null;
  let prev = '';
  for (const line of diff.split('\n')) {
    const header = line.startsWith('+++ ') && prev.startsWith('--- ');
    prev = line;
    if (header) {
      file = line === '+++ /dev/null' ? null : line.slice(4).replace(/\t.*$/, '').replace(/^b\//, '');
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
const git = (cwd, args) => spawnSync('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const lines = (s) => s.split('\n').filter(Boolean);

export function changedLines(cwd) {
  if (git(cwd, ['rev-parse', '--is-inside-work-tree']).status !== 0) return null;
  const result = new Map();
  const markAll = (out) => lines(out).forEach((f) => result.set(f, 'all'));
  const hasHead = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).status === 0;
  if (hasHead) {
    for (const [f, ranges] of parseHunks(git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--relative', 'HEAD']).stdout)) result.set(f, ranges);
  } else {
    markAll(git(cwd, ['ls-files', '--cached']).stdout);
  }
  markAll(git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout);
  return result;
}

const parsers = {
  eslint: (data, cwd) => data.flatMap((r) => r.messages.map((m) => ({
    file: relFile(cwd, r.filePath), line: m.line, ruleId: m.ruleId ?? 'eslint',
    message: m.message, severity: m.severity === 2 ? 'error' : 'warning',
  }))),
  'ast-grep': (data, cwd) => data.map((m) => ({
    file: relFile(cwd, m.file), line: m.range.start.line + 1, ruleId: m.ruleId,
    message: m.message, severity: m.severity === 'error' ? 'error' : 'warning',
  })),
  ruff: (data, cwd) => data.map((m) => ({
    file: relFile(cwd, m.filename), line: m.location.row, ruleId: m.code,
    message: m.message, severity: 'error',
  })),
};

export function parseLinterOutput(format, stdout, cwd) {
  return parsers[format](JSON.parse(stdout), cwd);
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

export const TIMEOUT_MS = { fast: 10000, full: 30000 };

export function runLinters(cwd, linters, files, timeouts = TIMEOUT_MS) {
  const findings = [];
  const notes = [];
  for (const l of linters) {
    const mine = files.filter((f) => l.extensions.includes(path.extname(f)));
    if (!mine.length) continue;
    const command = l.command.flatMap((a) => (a === '{files}' ? mine : [a]));
    const timeout = l.tier === 'fast' ? timeouts.fast : timeouts.full;
    const r = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout });
    try {
      if (r.error?.code === 'ETIMEDOUT') throw new Error(`timed out after ${timeout / 1000}s`);
      if (r.error) throw r.error;
      findings.push(...parseLinterOutput(l.format, r.stdout, cwd));
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
export const turnFile = (cwd, input) =>
  path.join(cwd, CONFIG_DIR, `turn-${String(input.session_id || 'default').replace(/[^\w-]/g, '_')}.txt`);

export function readLoopConfig(cwd) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(cwd, CONFIG_DIR, CONFIG_FILE), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    linters: list(raw?.linters).filter((l) => Array.isArray(l?.command) && Array.isArray(l.extensions)),
    protect: list(raw?.protect).filter((p) => typeof p === 'string'),
  };
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
