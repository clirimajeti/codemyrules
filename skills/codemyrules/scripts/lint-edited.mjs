#!/usr/bin/env node
// Claude Code adapter, PostToolUse on Edit|Write|MultiEdit: exit 2 hands errors on the changed lines back to Claude.
import fs from 'node:fs';
import { formatFindings, readHookInput } from './core/lib.mjs';
import { lintEdited } from './core/loop.mjs';

const input = await readHookInput();
// realpath: linters report resolved paths, so a symlinked project dir (macOS /var) would never match
const cwd = fs.realpathSync(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

const { info, notes, findings } = lintEdited(cwd, input.session_id, filePath);
for (const i of info) console.log(i);
if (notes.length) process.stderr.write(notes.join('\n') + '\n');
if (!findings.length) process.exit(0);
process.stderr.write(formatFindings(findings) + '\n');
process.exit(2);
