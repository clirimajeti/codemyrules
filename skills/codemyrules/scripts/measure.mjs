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
// Links in those files are followed too, so an index.md that links one file per topic brings in every topic file.
function linked(cwd, tracked, docs) {
  const found = new Set();
  const queue = [...docs];
  for (const doc of queue) {
    let text = '';
    try { text = fs.readFileSync(path.join(cwd, doc), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/\]\(<?([^)\s>#]+\.md)(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue; // http:, mailto: and other URLs
      const p = path.posix.normalize(path.posix.join(path.posix.dirname(doc), decodeURIComponent(m[1])));
      if (tracked.has(p) && !found.has(p) && !docs.includes(p)) { found.add(p); queue.push(p); }
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
  const stats = { total: 0, byRule: {}, byEvent: { edit: 0, turn: 0 }, files: {}, ruleEvents: {} };
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
    if (row.file) (stats.files[row.ruleId] ??= []).push(row.file);
    const ev = (stats.ruleEvents[row.ruleId] ??= { edit: 0, turn: 0 });
    if (row.event in ev) ev[row.event]++;
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

// What to do next, from the failure log and the doc tokens; no line without numbers behind it.
export function advice(b, stats, now) {
  const out = [];
  const since = b.date.slice(0, 10);
  for (const [id, n] of Object.entries(stats.byRule).sort((x, y) => y[1] - x[1])) {
    const ev = stats.ruleEvents[id] ?? { edit: 0, turn: 0 };
    if (n >= 3) {
      // the folder two levels deep where it fails most, where a folder CLAUDE.md loads only for that code
      const counts = {};
      for (const f of stats.files[id] ?? []) { const d = f.split('/').slice(0, -1).slice(0, 2).join('/'); if (d) counts[d] = (counts[d] ?? 0) + 1; }
      const [top, c] = Object.entries(counts).sort((x, y) => y[1] - x[1])[0] ?? [];
      const where = top && c * 2 >= n ? `, mostly in ${top}/` : '';
      const pointer = top && c * 2 >= n ? `${top}/CLAUDE.md` : 'the CLAUDE.md of the folder it applies to';
      out.push(`${id} failed ${n} times since ${since}${where}: the agent meets it only after writing the code; a one-line pointer in ${pointer} lets it write the right code first.`);
    }
    if (n >= 3 && ev.turn > 2 * ev.edit) {
      out.push(`${id} is caught mostly at the end of the turn (${ev.turn} of ${n}): a linter for it in the fast tier would tell the agent while it is still in the file.`);
    }
  }
  for (const id of Object.keys(b.rules ?? {})) {
    if (!stats.byRule[id]) out.push(`${id} has not failed since ${since}: if an agent doc still states it, that line can likely go.`);
  }
  if (b.alwaysTokens !== undefined && now.always > b.alwaysTokens * 1.1) {
    out.push(`always-loaded agent docs grew by ${now.always - b.alwaysTokens} tokens since ${since}, which every session pays: check whether the new lines could be rules.`);
  }
  return out;
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
  const tips = advice(b, stats, now);
  if (tips.length) console.log(`advice:\n${tips.map((t) => `  - ${t}`).join('\n')}`);
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
