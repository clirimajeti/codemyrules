#!/usr/bin/env node
// Claude Code adapter, PreToolUse, PostToolUse and PostToolUseFailure on Bash|NotebookEdit: snapshot before,
// check every changed file after. A failed command can still have changed files, so failure is checked too.
// The change has already happened, so it cannot ask first: it tells the agent to undo it, and tells the user.
import fs from 'node:fs';
import { isMain, readHookInput } from './core/lib.mjs';
import { changeBlock, checkChanges, installerNotice, takeSnapshot } from './core/snapshot.mjs';

// one hook call; returns the exit code
export async function main(input) {
  const cwd = fs.realpathSync(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
  if (input.hook_event_name === 'PreToolUse') {
    for (const n of takeSnapshot(cwd, input.tool_use_id)) console.log(n);
    return 0;
  }
  const r = checkChanges(cwd, input.tool_use_id, input.session_id, input.tool_input?.command);
  if (!r) return 0;
  for (const n of r.notes) console.log(n);
  const notice = r.installed.length ? installerNotice(r.installed) : null;
  if (r.reasons.length) {
    const what = input.tool_name === 'NotebookEdit' ? 'notebook edit' : 'command';
    const { toAgent, toUser } = changeBlock(what, input.tool_name, r.reasons);
    const systemMessage = [toUser, notice].filter(Boolean).join('\n');
    // after a failure the tool result is already an error, so the message goes in as extra context
    console.log(JSON.stringify(input.hook_event_name === 'PostToolUseFailure'
      ? { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: toAgent }, systemMessage }
      : { decision: 'block', reason: toAgent, systemMessage }));
  } else if (notice) {
    console.log(JSON.stringify({ systemMessage: notice }));
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(await readHookInput());
