// Harness-neutral before/after check for tools whose file changes are not known in advance (shell commands, notebooks).
// takeSnapshot stores every dirty file, plus the codemyrules setup, in git's object store;
// checkChanges finds every file changed since then and checks each one like an edit.
import fs from 'node:fs';
import path from 'node:path';
import { contentReason, protectReason } from './checks.mjs';
import { CONFIG_DIR, SETTINGS_FILE, dirtyFiles, hashFiles, readBlob } from './lib.mjs';
import { recordEdited } from './loop.mjs';

const snapshotPath = (cwd, id) => path.join(cwd, CONFIG_DIR, `shell-${String(id || 'default').replace(/[^\w-]/g, '_')}.json`);
const firstLine = (e) => e.message.split('\n')[0];
const skipped = (e) => `codemyrules: shell guard skipped (${firstLine(e)})`;
// hook state (turn files, snapshots, the failure log) changes on every run and is not the agent's change
const ours = (f) => f.startsWith(`${CONFIG_DIR}/`);

// The setup itself is git-excluded, so dirtyFiles never lists it: always snapshot it.
// That is the settings file and loop.json, plus scripts copied by versions before the npm package (top level and core/).
// Not recursive: a project may keep its linters' own node_modules in this folder, thousands of files to hash per command.
function setupFiles(cwd) {
  const dir = path.join(cwd, CONFIG_DIR);
  const scripts = (sub) => {
    try { return fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.mjs') || f === 'secret-patterns.json').map((f) => path.posix.join(sub, f)); } catch { return []; }
  };
  return [SETTINGS_FILE, `${CONFIG_DIR}/loop.json`, ...[...scripts('.'), ...scripts('core')].map((f) => `${CONFIG_DIR}/${path.posix.normalize(f)}`)];
}

// A snapshot whose tool never finished (the user denied it, the session crashed) and a turn that never
// reached its end-of-turn check leave their file behind; a day old is long past any real tool call or turn.
const STALE_MS = 24 * 3600 * 1000;
function sweep(cwd) {
  const dir = path.join(cwd, CONFIG_DIR);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names.filter((f) => /^(?:shell-.*\.json|turn-.*\.txt)$/.test(f))) {
    const p = path.join(dir, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { force: true }); } catch { /* gone already */ }
  }
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
    const files = [...new Set([...[...dirty].filter((f) => !ours(f)), ...setupFiles(cwd)])];
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
    fs.writeFileSync(file, JSON.stringify(entries));
    fs.writeFileSync(cachePath(cwd), JSON.stringify(Object.fromEntries(Object.entries(entries).filter(([, e]) => e.h))));
    return [];
  } catch (e) { return [skipped(e)]; }
}

// A command part that starts the codemyrules installer: `codemyrules install`, `npx codemyrules@x uninstall`, `node …/install.mjs`.
// Only a part's first word counts, so a mention in a comment or an argument is not the installer.
const INSTALLER = /^(?:\w+=\S*\s+)*(?:(?:npx\s+(?:-y\s+)?)?codemyrules(?:@\S+)?(?:\.cmd)?\s+(?:un)?install\b|node\s+"?[^"\s]*install\.mjs"?(?:\s|$))/;
export const runsInstaller = (command) => String(command ?? '').split(/;|&&|\|\||\||\n/).some((part) => INSTALLER.test(part.trim()));
const isSetup = (f) => f === SETTINGS_FILE || ours(f);

// after the tool runs; null without a snapshot, else { reasons, notes, installed }. The changed files are recorded for the end-of-turn check.
// command: the shell command; when it runs the codemyrules installer, its changes to the setup are listed in `installed`
// for the user instead of sending the agent back, and every other changed file is still checked.
export function checkChanges(cwd, id, sessionId, command) {
  const file = snapshotPath(cwd, id);
  let before;
  try { before = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  fs.rmSync(file, { force: true });

  const reasons = [];
  const notes = [];
  const installed = [];
  const installer = runsInstaller(command);
  try {
    const now = dirtyFiles(cwd) ?? new Set();
    const known = Object.keys(before);
    // only a file whose size or times moved can have new content; hash just those
    const moved = known.filter((f) => { const e = entry(before[f]); return e.k === undefined || statKey(cwd, f) !== e.k; });
    const current = hashFiles(cwd, moved);
    const setup = new Set(setupFiles(cwd));
    // a file dirty before changed when its content did; a file clean before changed when it is dirty now
    const changed = [...moved.filter((f) => current.get(f) !== entry(before[f]).h), ...[...now].filter((f) => !(f in before) && !ours(f))];
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
      const old = () => (f in before ? (entry(before[f]).h ? readBlob(cwd, entry(before[f]).h) : '') : readBlob(cwd, `HEAD:./${f}`));
      const cur = () => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } };
      const reason = protectReason(cwd, f, wasProtected.filter((p) => typeof p === 'string')) ?? contentReason(f, old, cur);
      if (reason) reasons.push(reason.replace(/^this edit/, 'this command'));
    }
  } catch (e) { notes.push(skipped(e)); }
  return { reasons, notes, installed };
}

// the user-facing line for setup files the installer changed
export const installerNotice = (files) => `codemyrules: the codemyrules installer changed ${files.join(', ')}.`;

// what to tell the agent and the user; what: "command" or "notebook edit", tool: the harness's tool name
export function changeBlock(what, tool, reasons) {
  const list = reasons.map((r) => `- ${r}`).join('\n');
  return {
    toAgent: `codemyrules: the last ${what} made changes only the user can approve:\n${list}\nUndo them now. If you think they are needed, ask the user and show the change and why.`,
    toUser: `codemyrules: the agent was told to undo changes made through ${tool}:\n${list}`,
  };
}
