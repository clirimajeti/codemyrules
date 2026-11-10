// Harness-neutral lint loop: lint a file after an edit, and lint everything edited at the end of a turn.
// Results are plain data; each harness adapter decides how to hand them to its agent and user.
import fs from 'node:fs';
import path from 'node:path';
import { BUDGET_MS, FOOTER, changedLines, formatFindings, headCommit, logFindings, onChangedLines, readLoopConfig, realPath, runLinters, turnBaseFile, turnFile, turnRetryFile } from './lib.mjs';

const firstLine = (e) => e.message.split('\n')[0];

// remember files for the end-of-turn check; throws when it cannot write.
// base: the commit HEAD was at before this change; the first record of a turn keeps it, so a commit
// later in the turn does not hide the turn's changes (they are compared with that commit, not the new HEAD)
export function recordEdited(cwd, sessionId, files, base = headCommit(cwd)) {
  if (!files.length) return;
  const tf = turnFile(cwd, sessionId);
  fs.mkdirSync(path.dirname(tf), { recursive: true });
  const bf = turnBaseFile(cwd, sessionId);
  if (base && !fs.existsSync(bf)) fs.writeFileSync(bf, base);
  fs.appendFileSync(tf, files.map((f) => `${f}\n`).join(''));
}
const turnBase = (cwd, sessionId) => { try { return fs.readFileSync(turnBaseFile(cwd, sessionId), 'utf8').trim() || 'HEAD'; } catch { return 'HEAD'; } };

// After an edit: fast linters on the file, errors on changed lines only.
// info: setup problems to show quietly; notes: linter failures; findings: errors that should go back to the agent.
export function lintEdited(cwd, sessionId, filePath) {
  const result = { info: [], notes: [], findings: [] };
  const rel = path.relative(cwd, realPath(path.resolve(cwd, filePath)));
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return result;
  // record before anything below can return
  try { recordEdited(cwd, sessionId, [rel.split(path.sep).join('/')]); } catch (e) {
    result.info.push(`codemyrules: could not record the edited file (${firstLine(e)})`);
  }
  let linters;
  try { linters = readLoopConfig(cwd).linters.filter((l) => l.tier === 'fast'); } catch (e) {
    result.info.push(`codemyrules: loop.json could not be read (${firstLine(e)})`);
    return result;
  }
  if (!linters.length) return result;
  const { findings, notes } = runLinters(cwd, linters, [rel], BUDGET_MS.edit);
  result.notes = notes;
  result.findings = onChangedLines(findings, changedLines(cwd, [rel], turnBase(cwd, sessionId)));
  logFindings(cwd, result.findings, 'edit');
  return result;
}

// End of turn: all linters on the files edited this turn.
// action 'block': send the findings back once; 'report': still failing after that retry, tell the user;
// 'pass': nothing to block (notes may still be set).
// sentBack: the harness says a stop hook sent this turn back (Claude Code's stop_hook_active). It counts as our retry only
// together with our own mark: another hook (a notes or test check) also sets it, and that is no reason to only report.
export function lintTurn(cwd, sessionId, sentBack) {
  const tf = turnFile(cwd, sessionId);
  const mark = turnRetryFile(cwd, sessionId);
  const retried = !!sentBack && fs.existsSync(mark);
  // the turn ends unless we block, so its set of edited files, its base commit and the mark are done
  const done = (result) => {
    if (result.action === 'block') fs.writeFileSync(mark, '');
    else for (const f of [tf, mark, turnBaseFile(cwd, sessionId)]) fs.rmSync(f, { force: true });
    return result;
  };
  const pass = (notes = []) => done({ action: 'pass', findings: [], notes });

  let edited = [];
  try { edited = [...new Set(fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean))]; } catch { /* no edits this turn */ }
  if (!edited.length) return pass();
  const changed = changedLines(cwd, edited, turnBase(cwd, sessionId));
  const files = edited.filter((f) => changed?.has(f) && fs.existsSync(path.join(cwd, f)));
  if (!files.length) return pass();
  let linters;
  try { linters = readLoopConfig(cwd).linters; } catch (e) {
    return pass([`codemyrules: loop.json could not be read (${firstLine(e)})`]);
  }
  const { findings, notes } = runLinters(cwd, linters, files, BUDGET_MS.turn);
  const mine = onChangedLines(findings, changed);
  if (!mine.length) return pass(notes);
  if (retried) return done({ action: 'report', findings: mine, notes });
  logFindings(cwd, mine, 'turn');
  return done({ action: 'block', findings: mine, notes });
}

// the user-facing text for findings left after the one retry
export const stillFailing = (findings) => `codemyrules: still failing after one retry:\n${formatFindings(findings).replace(`\n${FOOTER}`, '')}`;
