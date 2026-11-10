// GitHub Copilot CLI adapter: the hooks in .github/hooks/codemyrules.json run `codemyrules hook copilot <event>`.
// The camelCase payloads carry no event name, so the hooks file passes it as an argument.
// preToolUse on edit|create: the guard, as permissionDecision "ask" (Copilot treats ask as deny in autopilot and the cloud agent).
// preToolUse, postToolUse, postToolUseFailure on bash|powershell: the before/after snapshot check.
// postToolUse on edit|create: fast linters, findings appended to the tool result as additionalContext.
// agentStop: all linters on the turn's files; decision "block" sends the agent back once.
// stdout must hold one JSON object or nothing, so notes for the user go to stderr; exit 2 is how Copilot surfaces stderr.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { checkEdit } from './core/checks.mjs';
import { formatFindings, isMain, readHookInput } from './core/lib.mjs';
import { lintEdited, lintTurn, stillFailing } from './core/loop.mjs';
import { changeBlock, checkChanges, installerNotice, takeSnapshot } from './core/snapshot.mjs';

export const EDIT_TOOLS = ['edit', 'create'];
export const SHELL_TOOLS = ['bash', 'powershell'];

// toolArgs is an object, or a JSON string in some Copilot versions
export function toolArgs(input) {
  const a = input.toolArgs ?? {};
  if (typeof a !== 'string') return a ?? {};
  try { return JSON.parse(a) ?? {}; } catch { return {}; }
}

// Copilot's edit and create input as the harness-neutral edit checkEdit takes, or null for other tools
export function toEdit(toolName, args) {
  if (!args?.path) return null;
  if (toolName === 'create') return { file: args.path, content: args.file_text ?? '' };
  if (toolName === 'edit') return { file: args.path, edits: [{ oldText: args.old_str ?? '', newText: args.new_str ?? '' }] };
  return null;
}

// The payload has no tool call id, so the snapshot is keyed by session and command: pre and post see the same pair.
const snapshotId = (session, command) => `copilot-${crypto.createHash('sha1').update(`${session}\0${command ?? ''}`).digest('hex').slice(0, 16)}`;

// one hook call; returns the exit code
export async function main(input, event) {
  // the hooks file sets cwd to the project root; the payload's cwd is wherever the session started
  const cwd = fs.realpathSync(process.cwd());
  const session = input.sessionId ?? input.session_id;
  const tool = input.toolName;
  const args = toolArgs(input);
  const out = (o) => console.log(JSON.stringify(o));
  const tell = (lines) => { if (lines.length) process.stderr.write(lines.join('\n') + '\n'); };

  if (event === 'agentStop') {
    const { action, findings, notes } = lintTurn(cwd, session, !!(input.stop_hook_active ?? input.stopHookActive));
    if (action === 'block') { out({ decision: 'block', reason: [...notes, formatFindings(findings)].join('\n') }); return 0; }
    if (action === 'report') { tell([...notes, stillFailing(findings)]); return 2; }
    tell(notes);
    return 0;
  }

  if (SHELL_TOOLS.includes(tool)) {
    const id = snapshotId(session, args.command);
    if (event === 'preToolUse') { tell(takeSnapshot(cwd, id)); return 0; }
    // a failed command can still have changed files, so a failure is checked too
    const r = checkChanges(cwd, id, session, args.command);
    if (!r) return 0;
    tell([...r.notes, ...(r.installed.length ? [installerNotice(r.installed)] : [])]);
    if (r.reasons.length) {
      const { toAgent, toUser } = changeBlock('command', tool, r.reasons);
      tell([toUser]);
      out({ additionalContext: toAgent });
    }
    return 0;
  }

  const edit = toEdit(tool, args);
  if (!edit) return 0;
  if (event === 'preToolUse') {
    // a crash would exit 1, which Copilot treats as deny; asking is what the other adapters do
    let reason;
    try { reason = checkEdit(cwd, edit); } catch (e) { reason = `could not check this edit (${e.message.split('\n')[0]}), so it needs your approval.`; }
    if (reason) out({ permissionDecision: 'ask', permissionDecisionReason: `codemyrules: ${reason} Only the user can approve this.` });
    return 0;
  }
  if (event !== 'postToolUse') return 0;
  const { info, notes, findings } = lintEdited(cwd, session, edit.file);
  tell([...info, ...notes]);
  if (findings.length) out({ additionalContext: formatFindings(findings) });
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(await readHookInput(), process.argv[2]);
