#!/usr/bin/env node
// PreToolUse and PostToolUse on Bash|NotebookEdit: a shell command can change any file, so this compares the
// work tree before and after the tool runs and checks every file it changed, the way guard.mjs checks an edit.
// The change has already happened, so it cannot ask first: it blocks, and tells the agent and the user.
import fs from 'node:fs';
import path from 'node:path';
import { contentReason, protectReason } from './guard.mjs';
import { CONFIG_DIR, SETTINGS_FILE, dirtyFiles, hashFiles, readBlob, readHookInput, turnFile } from './lib.mjs';

const input = await readHookInput();
const cwd = fs.realpathSync(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
const snapshot = path.join(cwd, CONFIG_DIR, `shell-${String(input.tool_use_id || 'default').replace(/[^\w-]/g, '_')}.json`);
// the setup itself is git-excluded, so dirtyFiles never lists it: always snapshot it
const SETUP = [SETTINGS_FILE, ...['loop.json', 'secret-patterns.json', 'lib.mjs', 'guard.mjs', 'shell-guard.mjs', 'lint-edited.mjs', 'lint-turn.mjs'].map((f) => `${CONFIG_DIR}/${f}`)];
// hook state (turn files, snapshots, the failure log) changes on every run and is not the agent's change
const ours = (f) => f.startsWith(`${CONFIG_DIR}/`);
const note = (e) => console.log(`codemyrules: shell guard skipped (${e.message.split('\n')[0]})`);

if (input.hook_event_name === 'PreToolUse') {
  try {
    const dirty = dirtyFiles(cwd);
    if (dirty) {
      fs.mkdirSync(path.dirname(snapshot), { recursive: true });
      // the dirty files' content goes into git's object store, so the post hook can diff against it
      const files = [...new Set([...[...dirty].filter((f) => !ours(f)), ...SETUP])];
      fs.writeFileSync(snapshot, JSON.stringify(Object.fromEntries(hashFiles(cwd, files, true))));
    }
  } catch (e) { note(e); }
  process.exit(0);
}

let before;
try { before = JSON.parse(fs.readFileSync(snapshot, 'utf8')); } catch { process.exit(0); } // no snapshot: nothing to compare
fs.rmSync(snapshot, { force: true });

const findings = [];
try {
  const now = dirtyFiles(cwd) ?? new Set();
  const known = Object.keys(before);
  const current = hashFiles(cwd, known);
  // a file dirty before changed when its content did; a file clean before changed when it is dirty now
  const changed = [...known.filter((f) => current.get(f) !== before[f]), ...[...now].filter((f) => !(f in before) && !ours(f))];
  if (changed.length) {
    try {
      fs.mkdirSync(path.join(cwd, CONFIG_DIR), { recursive: true });
      fs.appendFileSync(turnFile(cwd, input), changed.filter((f) => !SETUP.includes(f) && fs.existsSync(path.join(cwd, f))).map((f) => `${f}\n`).join(''));
    } catch (e) { console.log(`codemyrules: could not record the changed files (${e.message.split('\n')[0]})`); }
  }
  for (const f of changed) {
    const old = () => (f in before ? (before[f] ? readBlob(cwd, before[f]) : '') : readBlob(cwd, `HEAD:./${f}`));
    const cur = () => { try { return fs.readFileSync(path.join(cwd, f), 'utf8'); } catch { return ''; } };
    const reason = protectReason(cwd, f) ?? contentReason(f, old, cur);
    if (reason) findings.push(reason.replace(/^this edit/, 'this command'));
  }
} catch (e) { note(e); }

if (findings.length) {
  const list = findings.map((r) => `- ${r}`).join('\n');
  console.log(JSON.stringify({
    decision: 'block',
    reason: `codemyrules: the last ${input.tool_name === 'NotebookEdit' ? 'notebook edit' : 'command'} made changes only the user can approve:\n${list}\nUndo them now. If you think they are needed, ask the user and show the change and why.`,
    systemMessage: `codemyrules: the agent was told to undo changes made through ${input.tool_name}:\n${list}`,
  }));
}
