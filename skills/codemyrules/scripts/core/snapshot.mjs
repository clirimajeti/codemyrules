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
// That is the settings file, loop.json, and every script and data file of the hooks, at any depth.
function setupFiles(cwd) {
  const dir = path.join(cwd, CONFIG_DIR);
  let found = [];
  try {
    found = fs.readdirSync(dir, { recursive: true })
      .map((f) => String(f).split(path.sep).join('/'))
      .filter((f) => f === 'loop.json' || f.endsWith('.mjs') || f.endsWith('secret-patterns.json'));
  } catch { /* not installed here */ }
  return [SETTINGS_FILE, ...new Set([`${CONFIG_DIR}/loop.json`, ...found.map((f) => `${CONFIG_DIR}/${f}`)])];
}

// before the tool runs; returns notes (empty when fine)
export function takeSnapshot(cwd, id) {
  try {
    const dirty = dirtyFiles(cwd);
    if (!dirty) return [];
    const file = snapshotPath(cwd, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const files = [...new Set([...[...dirty].filter((f) => !ours(f)), ...setupFiles(cwd)])];
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(hashFiles(cwd, files, true))));
    return [];
  } catch (e) { return [skipped(e)]; }
}

// after the tool runs; null without a snapshot, else { reasons, notes }. The changed files are recorded for the end-of-turn check.
export function checkChanges(cwd, id, sessionId) {
  const file = snapshotPath(cwd, id);
  let before;
  try { before = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  fs.rmSync(file, { force: true });

  const reasons = [];
  const notes = [];
  try {
    const now = dirtyFiles(cwd) ?? new Set();
    const known = Object.keys(before);
    const current = hashFiles(cwd, known);
    const setup = new Set(setupFiles(cwd));
    // a file dirty before changed when its content did; a file clean before changed when it is dirty now
    const changed = [...known.filter((f) => current.get(f) !== before[f]), ...[...now].filter((f) => !(f in before) && !ours(f))];
    try { recordEdited(cwd, sessionId, changed.filter((f) => !setup.has(f) && !ours(f) && fs.existsSync(path.join(cwd, f)))); } catch (e) {
      notes.push(`codemyrules: could not record the changed files (${firstLine(e)})`);
    }
    for (const f of changed) {
      const old = () => (f in before ? (before[f] ? readBlob(cwd, before[f]) : '') : readBlob(cwd, `HEAD:./${f}`));
      const cur = () => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } };
      const reason = protectReason(cwd, f) ?? contentReason(f, old, cur);
      if (reason) reasons.push(reason.replace(/^this edit/, 'this command'));
    }
  } catch (e) { notes.push(skipped(e)); }
  return { reasons, notes };
}

// what to tell the agent and the user; what: "command" or "notebook edit", tool: the harness's tool name
export function changeBlock(what, tool, reasons) {
  const list = reasons.map((r) => `- ${r}`).join('\n');
  return {
    toAgent: `codemyrules: the last ${what} made changes only the user can approve:\n${list}\nUndo them now. If you think they are needed, ask the user and show the change and why.`,
    toUser: `codemyrules: the agent was told to undo changes made through ${tool}:\n${list}`,
  };
}
