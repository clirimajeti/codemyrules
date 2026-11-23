// Gemini CLI adapter: the hooks in .gemini/settings.json run `codemyrules hook gemini`; the event is hook_event_name in the payload.
// BeforeTool on write_file|replace: the guard, as decision "ask" (implemented in Gemini but undocumented, gemini-cli#28046; headless runs refuse).
// BeforeTool, AfterTool on run_shell_command: the before/after snapshot check.
// AfterTool on write_file|replace: fast linters, findings added to the tool result as additionalContext.
// AfterAgent: all linters on the turn's files; decision "deny" sends the agent back once.
// stdout must hold one JSON object or nothing, so notes for the user go in systemMessage; every hook exits 0 (any other code than 0 or 1 denies).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { checkEdit } from './core/checks.mjs';
import { formatFindings, isMain, readHookInput } from './core/lib.mjs';
import { lintEdited, lintTurn, stillFailing } from './core/loop.mjs';
import { changeBlock, checkChanges, installerNotice, takeSnapshot } from './core/snapshot.mjs';

export const EDIT_TOOLS = ['write_file', 'replace'];
export const SHELL_TOOL = 'run_shell_command';

// Gemini's write_file and replace input as the harness-neutral edit checkEdit takes, or null for other tools
export function toEdit(toolName, input) {
  if (!input?.file_path) return null;
  if (toolName === 'write_file') return { file: input.file_path, content: input.content ?? '' };
  if (toolName === 'replace') return { file: input.file_path, edits: [{ oldText: input.old_string ?? '', newText: input.new_string ?? '', replaceAll: !!input.allow_multiple }] };
  return null;
}

// The payload has no tool call id, so the snapshot is keyed by session and command: before and after see the same pair.
const snapshotId = (session, command) => `gemini-${crypto.createHash('sha1').update(`${session}\0${command ?? ''}`).digest('hex').slice(0, 16)}`;

// one hook call; returns the exit code
export async function main(input) {
  // Gemini runs hooks with cwd = the folder it started in, where it read the settings
  const cwd = fs.realpathSync.native(input.cwd ?? process.cwd());
  const session = input.session_id;
  const event = input.hook_event_name;
  const tool = input.tool_name;
  const args = input.tool_input ?? {};
  const out = (o) => console.log(JSON.stringify(o));
  const say = (lines) => (lines.length ? { systemMessage: lines.join('\n') } : {});

  if (event === 'AfterAgent') {
    const { action, findings, notes } = lintTurn(cwd, session, !!input.stop_hook_active);
    if (action === 'block') out({ decision: 'deny', reason: [...notes, formatFindings(findings)].join('\n') });
    else if (action === 'report') out(say([...notes, stillFailing(findings)]));
    else if (notes.length) out(say(notes));
    return 0;
  }

  if (tool === SHELL_TOOL) {
    const id = snapshotId(session, args.command);
    if (event === 'BeforeTool') {
      const notes = takeSnapshot(cwd, id);
      if (notes.length) out(say(notes));
      return 0;
    }
    if (event !== 'AfterTool') return 0;
    // a failed command can still have changed files, so a failure is checked too
    const r = checkChanges(cwd, id, session, args.command);
    if (!r) return 0;
    const notes = [...r.notes, ...(r.installed.length ? [installerNotice(r.installed)] : [])];
    if (r.reasons.length) {
      const { toAgent, toUser } = changeBlock('command', tool, r.reasons);
      out({ hookSpecificOutput: { additionalContext: toAgent }, ...say([...notes, toUser]) });
    } else if (notes.length) out(say(notes));
    return 0;
  }

  const edit = EDIT_TOOLS.includes(tool) ? toEdit(tool, args) : null;
  if (!edit) return 0;
  if (event === 'BeforeTool') {
    // a crash would exit 1, which Gemini lets through; asking is what the other adapters do
    let reason;
    try { reason = checkEdit(cwd, edit); } catch (e) { reason = `could not check this edit (${e.message.split('\n')[0]}), so it needs your approval.`; }
    if (reason) out({ decision: 'ask', systemMessage: `codemyrules: ${reason} Only the user can approve this.` });
    return 0;
  }
  if (event !== 'AfterTool' || input.tool_response?.error) return 0;
  const { info, notes, findings } = lintEdited(cwd, session, edit.file);
  const lines = [...info, ...notes];
  if (findings.length) out({ hookSpecificOutput: { additionalContext: formatFindings(findings) }, ...say(lines) });
  else if (lines.length) out(say(lines));
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(await readHookInput());
