// opencode adapter: an opencode 2 plugin, loaded through the .opencode/plugins/codemyrules.js the installer writes.
// Guard: opencode asks for the "edit" permission before every edit, write and patch (offered instead of edit to gpt- models); the evaluate hook turns
// a flagged one into a question to the user, with the reason. With nobody to ask, opencode itself refuses it.
// Around shell: the before/after snapshot check. After an edit: fast linters, findings added to the tool result.
// When the agent goes idle: all linters on the turn's files, sent back once as a synthetic message.
// opencode gives plugins no way to show the user a notice, so notices meant only for the user are dropped.
import fs from 'node:fs';
import path from 'node:path';
import { checkEdit } from './core/checks.mjs';
import { CONFIG_DIR, formatFindings } from './core/lib.mjs';
import { lintEdited, lintTurn } from './core/loop.mjs';
import { changeBlock, checkChanges, takeSnapshot } from './core/snapshot.mjs';

// opencode's edit and write input as the harness-neutral edit checkEdit takes, or null for other tools
export function toEdit(tool, input = {}) {
  if (!input.path) return null;
  if (tool === 'write') return { file: input.path, content: input.content ?? '' };
  if (tool === 'edit') return { file: input.path, edits: [{ oldText: input.oldString ?? '', newText: input.newString ?? '', replaceAll: !!input.replaceAll }] };
  return null;
}

// one file's unified diff from a permission request as an edit: each hunk's old side and new side
export function patchEdit(file, patch) {
  const hunks = [];
  for (const l of patch.split('\n')) {
    if (l.startsWith('@@')) { hunks.push({ old: [], new: [] }); continue; }
    const h = hunks.at(-1);
    if (!h || !/^[ +-]/.test(l)) continue;
    if (l[0] !== '+') h.old.push(l.slice(1));
    if (l[0] !== '-') h.new.push(l.slice(1));
  }
  return { file, edits: hunks.map((h) => ({ oldText: h.old.join('\n'), newText: h.new.join('\n') })) };
}

const text = (t) => ({ type: 'text', text: t });
const firstLine = (e) => e.message.split('\n')[0];

// why an edit permission request needs the user, or null; known: the tool's own input, when it was an edit or write
export function editReason(cwd, request, known) {
  // patch: the diffs opencode attaches; every resource also gets the protected-path check (moves, deletes)
  const edits = known ? [known] : (request.metadata?.files ?? []).filter((f) => f?.file && typeof f.patch === 'string').map((f) => patchEdit(f.file, f.patch));
  for (const edit of [...edits, ...(request.resources ?? []).map((file) => ({ file }))]) {
    const reason = checkEdit(cwd, edit);
    if (reason) return reason;
  }
  return null;
}

export default {
  id: 'codemyrules',
  async setup(ctx) {
    // the hooks run in the project root, with symlinks resolved: linters report resolved paths
    const cwd = fs.realpathSync(ctx.location.directory);
    const installed = () => fs.existsSync(path.join(cwd, CONFIG_DIR, 'loop.json'));
    const edits = new Map(); // tool call id -> its edit or write input, from execute.before
    const touched = new Map(); // tool call id -> the files its edit permission named
    const held = new Map(); // session id -> messages for the agent that had no tool result to go into
    const retried = new Set(); // sessions just sent back by the end-of-turn check

    await ctx.tool.hook('execute.before', (e) => {
      if (!installed()) return;
      if (e.tool === 'shell') return void takeSnapshot(cwd, e.id);
      const edit = toEdit(e.tool, e.input);
      if (edit) edits.set(e.id, edit);
    });

    await ctx.permission.hook('evaluate', (e) => {
      if (e.action !== 'edit' || !installed()) return;
      const id = e.source?.id;
      if (id) touched.set(id, e.resources ?? []);
      let reason;
      try { reason = editReason(cwd, e, id && edits.get(id)); } catch (err) { reason = `could not check this edit (${firstLine(err)}), so it needs your approval.`; }
      if (!reason) return;
      e.effect = 'ask';
      e.message = `codemyrules: ${reason} Only the user can approve this.`;
    });

    await ctx.tool.hook('execute.after', (e) => {
      const files = touched.get(e.id) ?? [];
      edits.delete(e.id);
      touched.delete(e.id);
      if (!installed()) return;
      let say = [];
      if (e.tool === 'shell') {
        // a failed command can still have changed files, so a failure is checked too
        const r = checkChanges(cwd, e.id, e.sessionID, e.input?.command);
        if (r?.reasons.length) say = [changeBlock('command', 'shell', r.reasons).toAgent];
      } else if (e.status === 'completed') {
        for (const f of files.filter((f) => fs.statSync(path.resolve(cwd, f), { throwIfNoEntry: false })?.isFile())) {
          const { notes, findings } = lintEdited(cwd, e.sessionID, f);
          if (findings.length) say.push(...notes, formatFindings(findings));
        }
      }
      if (!say.length) return;
      if (e.status !== 'completed') return void held.set(e.sessionID, [...(held.get(e.sessionID) ?? []), ...say]);
      const content = typeof e.result.content === 'string' ? [text(e.result.content)] : e.result.content ?? [];
      e.result = { ...e.result, content: [...content, text(say.join('\n'))] };
    });

    // as Claude Code's stop_hook_active: the idle right after the one that sent the agent back is let through
    await ctx.session.hook('experimental.idle', async (e) => {
      if (!installed()) return;
      const { action, findings, notes } = lintTurn(cwd, e.sessionID, retried.has(e.sessionID));
      const pending = held.get(e.sessionID) ?? [];
      held.delete(e.sessionID);
      if (action === 'block') retried.add(e.sessionID);
      else retried.delete(e.sessionID);
      const say = [...pending, ...(action === 'block' ? [...notes, formatFindings(findings)] : [])];
      if (say.length) await ctx.session.synthetic({ sessionID: e.sessionID, text: say.join('\n'), metadata: { source: 'codemyrules' } });
    });
  },
};
