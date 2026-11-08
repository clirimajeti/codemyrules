// pi adapter: a pi extension, loaded through the .pi/extensions/codemyrules.js the installer writes.
// Before an edit or write: the guard, asking the user through ctx.ui.confirm (no UI to ask: the edit is refused).
// Around bash: the before/after snapshot check. After an edit or write: fast linters, findings added to the tool result.
// Before the agent settles: all linters on the turn's files, one more turn with the findings.
import fs from 'node:fs';
import path from 'node:path';
import { checkEdit } from './core/checks.mjs';
import { CONFIG_DIR, formatFindings } from './core/lib.mjs';
import { lintEdited, lintTurn, stillFailing } from './core/loop.mjs';
import { changeBlock, checkChanges, installerNotice, takeSnapshot } from './core/snapshot.mjs';

// pi's edit and write input as the harness-neutral edit checkEdit takes, or null for other tools
export function toEdit(toolName, input = {}) {
  if (!input.path) return null;
  if (toolName === 'write') return { file: input.path, content: input.content ?? '' };
  if (toolName !== 'edit') return null;
  // older pi versions and some models send one top-level oldText/newText instead of edits[]
  const edits = Array.isArray(input.edits) ? input.edits : [{ oldText: input.oldText, newText: input.newText }];
  return { file: input.path, edits: edits.map((e) => ({ oldText: e?.oldText ?? '', newText: e?.newText ?? '' })) };
}

const text = (t) => ({ type: 'text', text: t });
const say = (ctx, lines, level = 'info') => { if (ctx.hasUI && lines.length) ctx.ui.notify(lines.join('\n'), level); };

export default function codemyrules(pi) {
  // the hooks run in the project root, with symlinks resolved: linters report resolved paths
  const root = (ctx) => fs.realpathSync(ctx.cwd);
  const installed = (ctx) => fs.existsSync(path.join(root(ctx), CONFIG_DIR, 'loop.json'));
  const session = (ctx) => ctx.sessionManager.getSessionId();

  pi.on('tool_call', async (event, ctx) => {
    if (!installed(ctx)) return;
    const cwd = root(ctx);
    if (event.toolName === 'bash') return void say(ctx, takeSnapshot(cwd, event.toolCallId));
    const edit = toEdit(event.toolName, event.input);
    if (!edit) return;
    let reason;
    try { reason = checkEdit(cwd, edit); } catch (e) { reason = `could not check this edit (${e.message.split('\n')[0]}), so it needs your approval.`; }
    if (!reason) return;
    if (!ctx.hasUI) return { block: true, reason: `codemyrules: ${reason} Only the user can approve this, and nobody can be asked in this session.` };
    if (await ctx.ui.confirm('codemyrules', `${reason}\n\nAllow this ${event.toolName} of ${edit.file}?`)) return;
    return { block: true, reason: `codemyrules: ${reason} The user declined it.` };
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!installed(ctx)) return;
    const cwd = root(ctx);
    if (event.toolName === 'bash') {
      // a failed command can still have changed files, so a failure is checked too
      const r = checkChanges(cwd, event.toolCallId, session(ctx), event.input?.command);
      if (!r) return;
      say(ctx, [...r.notes, ...(r.installed.length ? [installerNotice(r.installed)] : [])]);
      if (!r.reasons.length) return;
      const { toAgent, toUser } = changeBlock('command', 'bash', r.reasons);
      say(ctx, [toUser], 'warning');
      return { content: [...(event.content ?? []), text(toAgent)] };
    }
    if (event.isError) return;
    const edit = toEdit(event.toolName, event.input);
    if (!edit) return;
    const { info, notes, findings } = lintEdited(cwd, session(ctx), edit.file);
    say(ctx, info);
    if (!findings.length) return void say(ctx, notes);
    return { content: [...(event.content ?? []), text([...notes, formatFindings(findings)].join('\n'))] };
  });

  // as Claude Code's stop_hook_active: the settle right after the one that sent the agent back is let through
  let retried = false;
  pi.on('agent_before_settle', async (event, ctx) => {
    if (!installed(ctx)) return;
    const { action, findings, notes } = lintTurn(root(ctx), session(ctx), retried);
    retried = action === 'block';
    if (action === 'block') {
      const content = [...notes, formatFindings(findings)].join('\n');
      return { entries: [...event.entries, { type: 'custom_message', customType: 'codemyrules', content, display: false }], continue: true };
    }
    say(ctx, action === 'report' ? [...notes, stillFailing(findings)] : notes, action === 'report' ? 'warning' : 'info');
  });
}
