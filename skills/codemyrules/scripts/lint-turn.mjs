#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { FOOTER, changedLines, formatFindings, logFindings, onChangedLines, readHookInput, readLoopConfig, runLinters, turnFile } from './lib.mjs';

const input = await readHookInput();
const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const tf = turnFile(cwd, input);
// the turn ends unless we block, so its set of edited files is done
const end = (code = 0) => { fs.rmSync(tf, { force: true }); process.exit(code); };

let edited = [];
try { edited = [...new Set(fs.readFileSync(tf, 'utf8').split('\n').filter(Boolean))]; } catch { /* no edits this turn */ }
if (!edited.length) end();

const changed = changedLines(cwd);
const files = edited.filter((f) => changed?.has(f) && fs.existsSync(path.join(cwd, f)));
if (!files.length) end();

let linters;
try { linters = readLoopConfig(cwd).linters; } catch (e) {
  console.log(`codemyrules: loop.json could not be read (${e.message.split('\n')[0]})`);
  end();
}
const { findings, notes } = runLinters(cwd, linters, files);
const mine = onChangedLines(findings, changed);

if (mine.length && !input.stop_hook_active) {
  if (notes.length) console.log(notes.join('\n'));
  logFindings(cwd, mine, 'turn');
  console.error(formatFindings(mine));
  process.exit(2);
}
if (mine.length) {
  const still = `codemyrules: still failing after one retry:\n${formatFindings(mine).replace(`\n${FOOTER}`, '')}`;
  console.log(JSON.stringify({ systemMessage: [...notes, still].join('\n') }));
} else if (notes.length) {
  console.log(notes.join('\n'));
}
end();
