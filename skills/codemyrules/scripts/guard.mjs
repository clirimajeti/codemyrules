// Claude Code adapter, PreToolUse on Edit|Write|MultiEdit: asks the user before an edit the checks flag.
import { checkEdit } from './core/checks.mjs';
import { isMain, readHookInput } from './core/lib.mjs';

// Claude Code's tool input as the harness-neutral edit that checkEdit takes, or null when there is no file
export function toEdit(input) {
  const ti = input.tool_input ?? {};
  if (!ti.file_path) return null;
  const replacement = (e) => ({ oldText: e.old_string, newText: e.new_string, replaceAll: e.replace_all });
  if (input.tool_name === 'Write') return { file: ti.file_path, content: ti.content ?? '' };
  if (input.tool_name === 'Edit') return { file: ti.file_path, edits: [replacement(ti)] };
  if (input.tool_name === 'MultiEdit') return { file: ti.file_path, edits: (ti.edits ?? []).map(replacement) };
  return { file: ti.file_path }; // another tool with a path: only the protected-path check applies
}

export function decide(input, cwd) {
  const edit = toEdit(input);
  const reason = edit && checkEdit(cwd, edit);
  return reason ? { reason } : null;
}

// one hook call; returns the exit code
export async function main(input) {
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const d = decide(input, cwd);
  if (d) {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: `codemyrules: ${d.reason} Only the user can approve this.`,
    } }));
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main(await readHookInput());
