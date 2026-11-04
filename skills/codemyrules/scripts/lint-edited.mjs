#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { changedLines, formatFindings, logFindings, onChangedLines, readHookInput, readLoopConfig, realPath, runLinters, turnFile } from './lib.mjs';

const input = await readHookInput();
// realpath: linters report resolved paths, so a symlinked project dir (macOS /var) would never match
const cwd = fs.realpathSync(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

const abs = path.resolve(cwd, filePath);
const rel = path.relative(cwd, realPath(abs));
if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) process.exit(0);

// remember the file for the end-of-turn check, before anything below can exit
try {
  const tf = turnFile(cwd, input);
  fs.mkdirSync(path.dirname(tf), { recursive: true });
  fs.appendFileSync(tf, rel.split(path.sep).join('/') + '\n');
} catch (e) {
  console.log(`codemyrules: could not record the edited file (${e.message.split('\n')[0]})`);
}

let linters;
try { linters = readLoopConfig(cwd).linters.filter((l) => l.tier === 'fast'); } catch (e) {
  console.log(`codemyrules: loop.json could not be read (${e.message.split('\n')[0]})`);
  process.exit(0);
}
if (!linters.length) process.exit(0);

const { findings, notes } = runLinters(cwd, linters, [rel]);
const blocking = onChangedLines(findings, changedLines(cwd));
if (notes.length) process.stderr.write(notes.join('\n') + '\n');
if (!blocking.length) process.exit(0);

logFindings(cwd, blocking, 'edit');
process.stderr.write(formatFindings(blocking) + '\n');
process.exit(2);
