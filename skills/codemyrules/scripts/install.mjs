#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, SETTINGS_FILE, isMain } from './core/lib.mjs';

// the harness-neutral core, then the Claude Code adapters that the hook entries run
const SCRIPTS = [
  'core/lib.mjs', 'core/secret-patterns.json', 'core/checks.mjs', 'core/loop.mjs', 'core/snapshot.mjs',
  'guard.mjs', 'shell-guard.mjs', 'lint-edited.mjs', 'lint-turn.mjs',
];
// files earlier versions installed that nothing uses any more
const OBSOLETE = ['lib.mjs', 'secret-patterns.json'];
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXCLUDES = [`${CONFIG_DIR}/`, SETTINGS_FILE];

const entry = (matcher, script, timeout) => ({
  ...(matcher && { matcher }),
  hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${CONFIG_DIR}/${script}"`, timeout }],
});

export const HOOKS = {
  PreToolUse: [entry('Edit|Write|MultiEdit', 'guard.mjs', 10), entry('Bash|NotebookEdit', 'shell-guard.mjs', 10)],
  PostToolUse: [entry('Edit|Write|MultiEdit', 'lint-edited.mjs', 30), entry('Bash|NotebookEdit', 'shell-guard.mjs', 30)],
  Stop: [entry(undefined, 'lint-turn.mjs', 120)],
};

export function mergeSettings(existing, hooks = HOOKS) {
  const out = { ...existing, hooks: { ...existing.hooks } };
  for (const [event, entries] of Object.entries(hooks)) {
    const list = [...(out.hooks[event] ?? [])];
    const have = new Set(list.flatMap((e) => (e.hooks ?? []).map((h) => h.command)));
    for (const e of entries) if (!e.hooks.some((h) => have.has(h.command))) list.push(e);
    out.hooks[event] = list;
  }
  return out;
}

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

function excludePath(projectDir) {
  const p = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: projectDir,
    encoding: 'utf8',
  }).trim();
  return path.resolve(projectDir, p);
}

export function plan(projectDir, loopConfig) {
  const items = [];
  const add = (p, content, preview = content) => {
    const old = readIf(p);
    if (old !== content) items.push({ path: p, action: old === null ? 'create' : 'update', preview, content });
  };
  const dest = path.join(projectDir, CONFIG_DIR);
  for (const s of SCRIPTS) add(path.join(dest, s), fs.readFileSync(path.join(SELF_DIR, s), 'utf8'), `copy of ${s}`);
  for (const s of OBSOLETE) if (fs.existsSync(path.join(dest, s))) items.push({ path: path.join(dest, s), action: 'delete', preview: 'no longer used', content: null });
  add(path.join(dest, 'loop.json'), JSON.stringify(loopConfig, null, 2) + '\n');

  const sp = path.join(projectDir, SETTINGS_FILE);
  const settings = mergeSettings(JSON.parse(readIf(sp) ?? '{}'));
  add(sp, JSON.stringify(settings, null, 2) + '\n');

  const ep = excludePath(projectDir);
  const old = readIf(ep) ?? '';
  const missing = EXCLUDES.filter((l) => !old.split('\n').includes(l));
  if (missing.length) {
    const sep = old && !old.endsWith('\n') ? '\n' : '';
    items.push({ path: ep, action: readIf(ep) === null ? 'create' : 'update', preview: missing.join('\n'), content: old + sep + missing.join('\n') + '\n' });
  }
  return items;
}

const FORMATS = ['eslint', 'ast-grep', 'ruff'];
const TIERS = ['fast', 'full'];
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// A path is resolved from the project root, where the hooks run; a bare name is looked up on PATH.
export function findExecutable(cmd, projectDir, env = process.env) {
  if (cmd.includes('/') || cmd.includes(path.sep)) return fs.existsSync(path.resolve(projectDir, cmd));
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  return (env.PATH ?? '').split(path.delimiter).some((d) => d && exts.some((e) => fs.existsSync(path.join(d, cmd + e))));
}

// Package runners that look a package up (and may download it) on every call.
const packageRunner = ([cmd, sub]) =>
  cmd === 'npx' || cmd === 'bunx' ? cmd
    : (cmd === 'npm' && sub === 'exec') || ((cmd === 'pnpm' || cmd === 'yarn') && sub === 'dlx') ? `${cmd} ${sub}` : null;

// The hooks silently skip malformed entries, so a broken config must be refused here, before anything is installed.
export function validateLoopConfig(cfg, projectDir) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['the config must be a JSON object with "linters" and "protect"'];
  for (const k of Object.keys(cfg)) if (k !== 'linters' && k !== 'protect') errs.push(`unknown key "${k}" (expected "linters" and "protect")`);
  if (cfg.protect !== undefined && !isStrList(cfg.protect)) errs.push('protect must be a list of path patterns (strings)');
  if (cfg.linters !== undefined && !Array.isArray(cfg.linters)) return [...errs, 'linters must be a list'];
  (cfg.linters ?? []).forEach((l, i) => {
    const at = `linters[${i}]`;
    if (!l || typeof l !== 'object') return errs.push(`${at} must be an object`);
    if (typeof l.name !== 'string' || !l.name.trim()) errs.push(`${at}.name must be a non-empty string`);
    if (!FORMATS.includes(l.format)) errs.push(`${at}.format is "${l.format}", expected one of ${FORMATS.join(', ')}`);
    if (!isStrList(l.command) || !l.command.length) errs.push(`${at}.command must be a list of strings, not one string`);
    else if (!l.command.includes('{files}')) errs.push(`${at}.command must contain the element "{files}"`);
    if (!isStrList(l.extensions) || !l.extensions.length || !l.extensions.every((e) => e.startsWith('.'))) errs.push(`${at}.extensions must be a list like [".ts", ".vue"]`);
    if (!TIERS.includes(l.tier)) errs.push(`${at}.tier is "${l.tier}", expected fast or full`);
    if (isStrList(l.command) && l.command.length && !findExecutable(l.command[0], projectDir)) {
      errs.push(`${at}: "${l.command[0]}" is not installed (not on PATH, or no such file in the project); every run would fail, so this linter would never block anything. Install it, or use a command that is available`);
    }
    const runner = isStrList(l.command) && packageRunner(l.command);
    if (runner && l.tier === 'fast') {
      errs.push(`${at}: runs through "${runner}", which resolves the package on every edit (about 0.4 s with a warm cache, seconds or a download when cold, and a run past the 10 s limit counts as clean). Use the installed binary (node_modules/.bin/<tool>, or the tool on PATH), or move it to the full tier`);
    }
    if (isStrList(l.command)) {
      l.command.forEach((c, j) => {
        const file = (c === '-c' || c === '--config') ? l.command[j + 1] : undefined;
        if (file && file !== '{files}' && !fs.existsSync(path.resolve(projectDir, file))) {
          errs.push(`${at}: the config "${file}" after ${c} does not exist in the project; every run would fail`);
        }
      });
    }
    if (l.format === 'ast-grep' && isStrList(l.command) && !l.command.some((c) => c === '-c' || c === '--config')
        && !['sgconfig.yml', 'sgconfig.yaml'].some((f) => fs.existsSync(path.join(projectDir, f)))) {
      errs.push(`${at}: ast-grep needs an sgconfig.yml in the project root, or "-c <path>" in its command; without one every scan fails`);
    }
  });
  return errs;
}

function main(argv) {
  const args = argv.slice(2);
  const apply = args.includes('--apply');
  const ci = args.indexOf('--config');
  const cfgPath = ci >= 0 ? args[ci + 1] : undefined;
  const dir = args.find((a, i) => !a.startsWith('--') && i !== ci + 1);
  if (!dir || !cfgPath) {
    console.error('usage: install.mjs <project-dir> --config <loop.json> [--apply]');
    return 2;
  }
  const projectDir = path.resolve(dir);
  if (!fs.existsSync(path.join(projectDir, '.git'))) {
    console.error(`codemyrules: ${projectDir} is not a git repository`);
    return 1;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.error(`codemyrules: could not read loop config ${cfgPath}: ${String(e.message).split('\n')[0]}`);
    return 1;
  }
  const errs = validateLoopConfig(cfg, projectDir);
  if (errs.length) {
    console.error(`codemyrules: invalid loop config ${cfgPath}, nothing written:\n${errs.map((e) => `  - ${e}`).join('\n')}`);
    return 1;
  }
  const items = plan(projectDir, cfg);
  for (const i of items) console.log(`${i.action} ${i.path}\n${i.preview.replace(/^/gm, '  ')}`);
  if (!items.length) console.log('nothing to change');
  if (!apply) {
    console.log('\ndry run: nothing written, re-run with --apply');
    return 0;
  }
  for (const i of items) {
    if (i.action === 'delete') { fs.rmSync(i.path, { force: true }); continue; }
    fs.mkdirSync(path.dirname(i.path), { recursive: true });
    fs.writeFileSync(i.path, i.content);
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv);
