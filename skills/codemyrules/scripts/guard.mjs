import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR, SETTINGS_FILE, matchesPattern, readHookInput, readLoopConfig, realPath } from './lib.mjs';

export const SUPPRESSION = new RegExp([
  /eslint-disable/, /\/[*/]\s*eslint\s+[@\w/-]+\s*:/, // inline ESLint config: /* eslint no-console: "off" */
  /@ts-ignore/, /@ts-nocheck/, /@ts-expect-error/,
  /@Suppress\(/, /@SuppressWarnings/, /@SuppressLint/,
  /#.*\b[Nn][Oo][Qq][Aa]\b/, /#\s*type:\s*ignore/, /pylint:\s*disable/,
  /ast-grep-ignore/, /\/\/\s*nolint/, /#!?\[allow\(/, /biome-ignore/, /NOSONAR/,
].map((r) => r.source).join('|'));

export const suppressionLines = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter((l) => SUPPRESSION.test(l));

// any suppression line in the new text that the old text does not have (multiset difference)
function addsSuppression(oldText, newText) {
  const left = suppressionLines(oldText);
  return suppressionLines(newText).some((l) => {
    const i = left.indexOf(l);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

const readOrEmpty = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
};

export function decide(input, cwd) {
  const ti = input.tool_input ?? {};
  if (!ti.file_path) return null;
  const rel = path.relative(realPath(cwd), realPath(path.resolve(cwd, ti.file_path))).split(path.sep).join('/');
  if (rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel)) {
    if (rel.startsWith(`${CONFIG_DIR}/`) || rel === SETTINGS_FILE) return { reason: `${rel} is part of the codemyrules setup.` };
    let protect;
    try {
      protect = readLoopConfig(cwd).protect;
    } catch (e) {
      return { reason: `loop.json could not be read (${e.message.split('\n')[0]}), so this edit needs your approval.` };
    }
    const hit = protect.find((p) => matchesPattern(rel, p));
    if (hit) return { reason: `${rel} is protected (${hit}).` };
  }
  let added = false;
  if (input.tool_name === 'Edit') {
    added = addsSuppression(ti.old_string, ti.new_string);
  } else if (input.tool_name === 'MultiEdit') {
    const edits = ti.edits ?? [];
    added = addsSuppression(edits.map((e) => e.old_string ?? '').join('\n'), edits.map((e) => e.new_string ?? '').join('\n'));
  } else if (input.tool_name === 'Write') {
    added = addsSuppression(readOrEmpty(path.resolve(cwd, ti.file_path)), ti.content);
  }
  return added ? { reason: `this edit adds or changes a lint suppression in ${rel}.` } : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = await readHookInput();
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const d = decide(input, cwd);
  if (d) {
    console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: `codemyrules: ${d.reason} Only the user can approve this.`,
    } }));
  }
}
