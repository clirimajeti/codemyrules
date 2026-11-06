import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, isMain, matchesPattern } from './core/lib.mjs';

export const AGENT_DOC_PATTERNS = ['**/CLAUDE.md', '**/AGENTS.md', '**/GEMINI.md', '.github/copilot-instructions.md', '.github/instructions/*.md', '.cursor/rules/**', '.cursorrules', '.windsurfrules'];

// Loaded into every session by the agent itself; files they import with `@path` are loaded too.
export const ALWAYS_LOADED = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.github/copilot-instructions.md', '.cursorrules', '.windsurfrules'];

function imports(cwd, tracked) {
  const found = new Set();
  for (const root of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
    if (!tracked.has(root)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(cwd, root), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/(?:^|\s)@((?:\.\/)?[\w./-]+\.\w+)/g)) {
      const p = path.posix.normalize(m[1]);
      if (tracked.has(p)) found.add(p);
    }
  }
  return found;
}

// Markdown files an agent doc links to, like [backend](docs/backend.md): read only when the agent follows the link.
// ponytail: one level only; links inside linked docs are not followed, so a linked doc site is not counted whole.
function linked(cwd, tracked, docs) {
  const found = new Set();
  for (const doc of docs) {
    let text = '';
    try { text = fs.readFileSync(path.join(cwd, doc), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/\]\(<?([^)\s>#]+\.md)(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue; // http:, mailto: and other URLs
      const p = path.posix.normalize(path.posix.join(path.posix.dirname(doc), decodeURIComponent(m[1])));
      if (tracked.has(p)) found.add(p);
    }
  }
  return found;
}

export function docTokens(cwd) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files'], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const tracked = new Set(r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []);
  const imported = imports(cwd, tracked);
  const agentDocs = [...tracked].filter((p) => ALWAYS_LOADED.includes(p) || imported.has(p) || AGENT_DOC_PATTERNS.some((pat) => matchesPattern(p, pat)));
  const docs = new Set([...agentDocs, ...linked(cwd, tracked, agentDocs)]);
  const files = [];
  for (const p of [...docs].sort()) {
    const always = ALWAYS_LOADED.includes(p) || imported.has(p);
    try {
      files.push({ path: p, tokens: Math.ceil(fs.readFileSync(path.join(cwd, p), 'utf8').length / 4), loaded: always ? 'always' : 'on-demand' });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // tracked but deleted in the working tree
    }
  }
  const sum = (kind) => files.filter((f) => f.loaded === kind).reduce((n, f) => n + f.tokens, 0);
  const always = sum('always'), onDemand = sum('on-demand');
  return { files, total: always + onDemand, always, onDemand };
}

export function logStats(cwd) {
  const stats = { total: 0, byRule: {}, byEvent: { edit: 0, turn: 0 } };
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(cwd, CONFIG_DIR, 'failures.log'), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const l of raw.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(l); } catch { continue; } // skip a torn line
    stats.total++;
    stats.byRule[row.ruleId] = (stats.byRule[row.ruleId] ?? 0) + 1;
    if (row.event in stats.byEvent) stats.byEvent[row.event]++;
  }
  return stats;
}

function baseline(dir, rulesFile) {
  const rules = rulesFile ? JSON.parse(fs.readFileSync(rulesFile, 'utf8')) : {};
  const out = path.join(dir, CONFIG_DIR, 'baseline.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const d = docTokens(dir);
  fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), docTokens: d.total, alwaysTokens: d.always, onDemandTokens: d.onDemand, rules }, null, 2) + '\n');
  console.log(`baseline written: ${out}`);
}

function report(dir) {
  const b = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_DIR, 'baseline.json'), 'utf8'));
  const stats = logStats(dir);
  console.log(`baseline date: ${b.date}`);
  const now = docTokens(dir);
  if (b.alwaysTokens === undefined) console.log(`doc tokens: ${b.docTokens} -> ${now.total}`);
  else {
    console.log(`always-loaded doc tokens: ${b.alwaysTokens} -> ${now.always} (read in every session)`);
    console.log(`on-demand doc tokens: ${b.onDemandTokens} -> ${now.onDemand}`);
  }
  const ids = new Set([...Object.keys(b.rules), ...Object.keys(stats.byRule)]);
  console.log(`rules: ${Object.keys(b.rules).length} -> ${ids.size}`);
  for (const id of ids) console.log(`  ${id}: ${b.rules[id] ?? 0} open at baseline, ${stats.byRule[id] ?? 0} logged failures since`);
  console.log(`failures logged: ${stats.total} (edit: ${stats.byEvent.edit}, turn: ${stats.byEvent.turn})`);
}

// args: the command-line arguments after the script name; returns the exit code
export function main(args) {
  const [cmd, dir, ...rest] = args;
  const i = rest.indexOf('--rules');
  if (cmd === 'baseline' && dir) baseline(dir, i >= 0 ? rest[i + 1] : undefined);
  else if (cmd === 'report' && dir) report(dir);
  else { console.error('usage: measure.mjs baseline <project-dir> [--rules <json>] | report <project-dir>'); return 2; }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
