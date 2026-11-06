#!/usr/bin/env node
// Claude Code adapter, PreToolUse and PostToolUse on Bash|NotebookEdit: snapshot before, check every changed file after.
// The change has already happened, so it cannot ask first: it blocks, and tells the agent and the user.
import fs from 'node:fs';
import { readHookInput } from './core/lib.mjs';
import { changeBlock, checkChanges, takeSnapshot } from './core/snapshot.mjs';

const input = await readHookInput();
const cwd = fs.realpathSync(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());

if (input.hook_event_name === 'PreToolUse') {
  for (const n of takeSnapshot(cwd, input.tool_use_id)) console.log(n);
  process.exit(0);
}

const r = checkChanges(cwd, input.tool_use_id, input.session_id);
if (!r) process.exit(0);
for (const n of r.notes) console.log(n);
if (r.reasons.length) {
  const what = input.tool_name === 'NotebookEdit' ? 'notebook edit' : 'command';
  const { toAgent, toUser } = changeBlock(what, input.tool_name, r.reasons);
  console.log(JSON.stringify({ decision: 'block', reason: toAgent, systemMessage: toUser }));
}
