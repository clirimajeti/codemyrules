#!/usr/bin/env node
// Claude Code adapter, Stop: exit 2 sends Claude back once; after that retry, a systemMessage tells the user.
import { formatFindings, isMain, readHookInput } from './core/lib.mjs';
import { lintTurn, stillFailing } from './core/loop.mjs';

// one hook call; returns the exit code
export async function main(input) {
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const { action, findings, notes } = lintTurn(cwd, input.session_id, !!input.stop_hook_active);
  if (action === 'block') {
    if (notes.length) console.log(notes.join('\n'));
    console.error(formatFindings(findings));
    return 2;
  }
  if (action === 'report') console.log(JSON.stringify({ systemMessage: [...notes, stillFailing(findings)].join('\n') }));
  else if (notes.length) console.log(notes.join('\n'));
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(await readHookInput());
