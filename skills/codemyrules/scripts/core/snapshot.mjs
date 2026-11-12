// Harness-neutral before/after check for tools whose file changes are not known in advance (shell commands, notebooks).
// takeSnapshot stores every dirty file, plus the codemyrules setup, in git's object store;
// checkChanges finds every file changed since then and checks each one like an edit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { contentReason, protectReason } from './checks.mjs';
import { CONFIG_DIR, HARNESS_FILES, committedFiles, dirtyFiles, gitDir, hashFiles, headCommit, isSecretFile, matchesPattern, readBlob, readLoopConfig } from './lib.mjs';
import { recordEdited } from './loop.mjs';

// Snapshots live in the work tree's git folder, not the setup folder: a command that deletes the setup folder
// (`rm -rf .claude`, `git clean -fdx`) would otherwise delete the snapshot and leave nothing to check against.
// The name holds a hash of the project folder, since monorepo projects share one git folder.
const snapshotDir = (cwd) => { const g = gitDir(cwd); return g && path.join(g, 'codemyrules'); };
const snapshotPath = (cwd, id) => {
  const dir = snapshotDir(cwd);
  const project = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return dir && path.join(dir, `shell-${project}-${String(id || 'default').replace(/[^\w-]/g, '_')}.json`);
};
const firstLine = (e) => e.message.split('\n')[0];
const skipped = (e) => `codemyrules: shell guard skipped (${firstLine(e)})`;
// hook state (turn files, snapshots, the failure log) changes on every run and is not the agent's change
const ours = (f) => f.startsWith(`${CONFIG_DIR}/`);

// The setup itself is git-excluded, so dirtyFiles never lists it: always snapshot it.
// That is the harness files (Claude Code settings, pi extension, opencode plugin, Copilot hooks), loop.json, the pinned package the hooks run (pin.json and pkg/),
// plus scripts copied by versions before the npm package (top level and core/).
// Not recursive: a project may keep its linters' own node_modules in this folder, thousands of files to hash per command.
const PKG_SCRIPTS = 'pkg/skills/codemyrules/scripts';
function setupFiles(cwd) {
  const dir = path.join(cwd, CONFIG_DIR);
  const scripts = (sub) => {
    try { return fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.mjs') || f.endsWith('.json')).map((f) => path.posix.join(sub, f)); } catch { return []; }
  };
  const pinned = ['pin.json', 'pkg/package.json', ...scripts(PKG_SCRIPTS), ...scripts(`${PKG_SCRIPTS}/core`)];
  return [...HARNESS_FILES, `${CONFIG_DIR}/loop.json`, ...[...pinned, ...scripts('core')].map((f) => `${CONFIG_DIR}/${f}`),
    ...scripts('.').filter((f) => f.endsWith('.mjs') || f === 'secret-patterns.json').map((f) => `${CONFIG_DIR}/${path.posix.normalize(f)}`)];
}

// A snapshot whose tool never finished (the user denied it, the session crashed) and a turn that never
// reached its end-of-turn check leave their file behind; a day old is long past any real tool call or turn.
const STALE_MS = 24 * 3600 * 1000;
function sweep(cwd) {
  for (const dir of [path.join(cwd, CONFIG_DIR), snapshotDir(cwd)].filter(Boolean)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((f) => /^(?:shell-.*\.json|turn-.*\.(?:txt|base|retry))$/.test(f))) {
      const p = path.join(dir, n);
      try { if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { force: true }); } catch { /* gone already */ }
    }
  }
}

// Protected files that git ignores never show up as dirty, so they are always snapshotted, like the setup.
// ponytail: literal paths and globs in the last path part only (`rules/*.js`); an ignored file matched only by
// a `**` pattern stays invisible to the shell guard (the edit guard still sees it). Expand `**` if that matters.
function protectedFiles(cwd) {
  let protect;
  try { protect = readLoopConfig(cwd).protect; } catch { return []; }
  return protect.flatMap((p) => {
    const dir = path.posix.dirname(p);
    if (/[*?]/.test(dir)) return [];
    if (!/[*?]/.test(path.posix.basename(p))) return [p];
    try { return fs.readdirSync(path.join(cwd, dir)).map((n) => path.posix.join(dir, n)).filter((f) => matchesPattern(f, p)); } catch { return []; }
  }).filter((f) => !isSecretFile(f));
}

// Size, mtime and ctime, as git compares them: no tool can set ctime back, so an edit that restores the mtime still shows.
const statKey = (cwd, f) => {
  const st = fs.statSync(path.join(cwd, f), { throwIfNoEntry: false });
  return st?.isFile() ? `${st.size}:${st.mtimeMs}:${st.ctimeMs}` : null;
};
// Hashes of dirty files from the previous command, so an unchanged file is not read again.
// Entries older than a day are not trusted: git prunes unreferenced objects after about two weeks.
const cachePath = (cwd) => path.join(cwd, CONFIG_DIR, 'hash-cache.json');
const CACHE_MS = 24 * 3600 * 1000;
// an entry of a snapshot: { h: blob id or null, k: stat key }; snapshots from before the cache held the bare id
const entry = (v) => (v && typeof v === 'object' ? v : { h: v ?? null });

// before the tool runs; returns notes (empty when fine)
export function takeSnapshot(cwd, id) {
  sweep(cwd);
  try {
    const dirty = dirtyFiles(cwd);
    if (!dirty) return [];
    const file = snapshotPath(cwd, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const files = [...new Set([...[...dirty].filter((f) => !ours(f)), ...setupFiles(cwd), ...protectedFiles(cwd)])];
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cachePath(cwd), 'utf8')); } catch { /* first command, or unreadable: hash everything */ }
    const now = Date.now();
    const entries = {};
    const toHash = [];
    for (const f of files) {
      const k = statKey(cwd, f);
      const c = cache[f];
      if (!k) entries[f] = { h: null, k: null };
      else if (c?.k === k && c.h && now - c.t < CACHE_MS) entries[f] = c;
      else { entries[f] = { k, t: now }; toHash.push(f); }
    }
    // -w keeps the content in git's object store, so checkChanges can diff against it
    for (const [f, h] of hashFiles(cwd, toHash, true)) entries[f].h = h;
    // head: a commit inside the command makes its changes clean again, so they are found by comparing commits
    fs.writeFileSync(file, JSON.stringify({ head: headCommit(cwd), files: entries }));
    fs.mkdirSync(path.join(cwd, CONFIG_DIR), { recursive: true });
    fs.writeFileSync(cachePath(cwd), JSON.stringify(Object.fromEntries(Object.entries(entries).filter(([, e]) => e.h))));
    return [];
  } catch (e) { return [skipped(e)]; }
}

// A command part that starts the codemyrules installer: `codemyrules install`, `npx codemyrules@x uninstall`, `node …/install.mjs`.
// Only a part's first word counts, so a mention in a comment or an argument is not the installer.
// An install.mjs counts only outside the project (the skill's own copy) or as the pinned copy: any script in the
// project can be named install.mjs, and the agent can write one. PATH= in front could run another `codemyrules`.
const INSTALLER = /^(?:(?!PATH=)\w+=\S*\s+)*(?:(?:npx\s+(?:-y\s+)?)?codemyrules(?:@\S+)?(?:\.cmd)?\s+(?:un)?install\b|node\s+"?([^"\s]*install\.mjs)"?(?:\s|$))/;
export function runsInstaller(command, cwd) {
  const trusted = (script) => {
    if (!script) return true; // the `codemyrules` command
    // the shell expands ~ before node sees it
    const abs = path.resolve(cwd, script.replace(/^~(?=[/\\])/, os.homedir()));
    const rel = path.relative(cwd, abs);
    const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    return outside || abs === path.join(cwd, CONFIG_DIR, 'pkg', 'skills', 'codemyrules', 'scripts', 'install.mjs');
  };
  return String(command ?? '').split(/;|&&|\|\||\||\n/).some((part) => {
    const m = INSTALLER.exec(part.trim());
    return !!m && trusted(m[1]);
  });
}
const isSetup = (f) => HARNESS_FILES.includes(f) || ours(f);

// after the tool runs; null without a snapshot, else { reasons, notes, installed }. The changed files are recorded for the end-of-turn check.
// command: the shell command; when it runs the codemyrules installer, its changes to the setup are listed in `installed`
// for the user instead of sending the agent back, and every other changed file is still checked.
export function checkChanges(cwd, id, sessionId, command) {
  const file = snapshotPath(cwd, id);
  let before;
  let head = null;
  try { ({ head, files: before } = JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
  fs.rmSync(file, { force: true });
  if (!before) return null;

  const reasons = [];
  const notes = [];
  const installed = [];
  const installer = runsInstaller(command, cwd);
  try {
    const now = dirtyFiles(cwd) ?? new Set();
    const known = Object.keys(before);
    // only a file whose size or times moved can have new content; hash just those
    const moved = known.filter((f) => { const e = entry(before[f]); return e.k === undefined || statKey(cwd, f) !== e.k; });
    const current = hashFiles(cwd, moved);
    const setup = new Set(setupFiles(cwd));
    // a file dirty before changed when its content did; a file clean before changed when it is dirty now
    const changed = [...moved.filter((f) => current.get(f) !== entry(before[f]).h), ...[...now].filter((f) => !(f in before) && !ours(f))];
    // a commit inside the command: its files are clean now, but changed since the snapshot
    const headNow = headCommit(cwd);
    if (head && headNow && headNow !== head) {
      const seen = new Set(changed);
      for (const f of committedFiles(cwd, head, headNow)) if (!seen.has(f) && !(f in before) && !ours(f)) changed.push(f);
    }
    // a command that rewrites loop.json and edits a file in one go is judged by the protect list from before it too
    const loop = `${CONFIG_DIR}/loop.json`;
    let wasProtected = [];
    try { wasProtected = entry(before[loop]).h ? JSON.parse(readBlob(cwd, entry(before[loop]).h)).protect ?? [] : []; } catch { /* unreadable before: the current list decides */ }
    if (!Array.isArray(wasProtected)) wasProtected = [];
    try { recordEdited(cwd, sessionId, changed.filter((f) => !setup.has(f) && !ours(f) && fs.existsSync(path.join(cwd, f)))); } catch (e) {
      notes.push(`codemyrules: could not record the changed files (${firstLine(e)})`);
    }
    for (const f of changed) {
      if (installer && isSetup(f)) { installed.push(f); continue; }
      const old = () => (f in before ? (entry(before[f]).h ? readBlob(cwd, entry(before[f]).h) : '') : readBlob(cwd, `${head ?? 'HEAD'}:./${f}`));
      const cur = () => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } };
      const reason = protectReason(cwd, f, wasProtected.filter((p) => typeof p === 'string')) ?? contentReason(f, old, cur);
      if (reason) reasons.push(reason.replace(/^this edit/, 'this command'));
    }
  } catch (e) { notes.push(skipped(e)); }
  return { reasons, notes, installed };
}

// the user-facing line for setup files the installer changed
// the pinned copy counts as one entry, not one per file
export const installerNotice = (files) => `codemyrules: the codemyrules installer changed ${[...new Set(files.map((f) => (f.startsWith(`${CONFIG_DIR}/pkg/`) ? `${CONFIG_DIR}/pkg/` : f)))].join(', ')}.`;

// what to tell the agent and the user; what: "command" or "notebook edit", tool: the harness's tool name
export function changeBlock(what, tool, reasons) {
  const list = reasons.map((r) => `- ${r}`).join('\n');
  return {
    toAgent: `codemyrules: the last ${what} made changes only the user can approve:\n${list}\nUndo them now. If you think they are needed, ask the user and show the change and why.`,
    toUser: `codemyrules: the agent was told to undo changes made through ${tool}:\n${list}`,
  };
}
