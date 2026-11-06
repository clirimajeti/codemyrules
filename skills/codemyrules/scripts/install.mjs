#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG_DIR, SETTINGS_FILE, isMain } from './core/lib.mjs';

// what versions before the npm package copied into the project; an install over them removes them
const COPIED = ['lib.mjs', 'secret-patterns.json', 'guard.mjs', 'shell-guard.mjs', 'lint-edited.mjs', 'lint-turn.mjs', 'core'];
const EXCLUDES = [`${CONFIG_DIR}/`, SETTINGS_FILE];
// where the CLI sits inside the npm package
const CLI_IN_PACKAGE = 'codemyrules/skills/codemyrules/scripts/cli.mjs';

// The hooks run the CLI of the globally installed npm package, so `npm update -g codemyrules` updates every project.
// Not the CLI next to this installer: run through npx or from a plugin cache, that path is temporary or versioned.
// Found through the `codemyrules` command on PATH, not `npm root -g`: npm masks token-like path parts as *** in its output.
export function findCli(env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (process.platform === 'win32') {
      // npm puts codemyrules.cmd in the prefix, next to node_modules
      const cli = path.join(dir, 'node_modules', CLI_IN_PACKAGE);
      if (fs.existsSync(path.join(dir, 'codemyrules.cmd')) && fs.existsSync(cli)) return cli;
      continue;
    }
    // a symlink to cli.mjs, from `npm install -g` or `npm link`
    try {
      const cli = fs.realpathSync(path.join(dir, 'codemyrules'));
      if (path.basename(cli) === 'cli.mjs') return cli;
    } catch { /* not in this directory */ }
  }
  return null;
}

const entry = (matcher, cli, hook, timeout) => ({
  ...(matcher && { matcher }),
  hooks: [{ type: 'command', command: `node "${cli}" hook ${hook}`, timeout }],
});

export const hookEntries = (cli) => ({
  PreToolUse: [entry('Edit|Write|MultiEdit', cli, 'guard', 10), entry('Bash|NotebookEdit', cli, 'shell', 10)],
  PostToolUse: [entry('Edit|Write|MultiEdit', cli, 'edited', 30), entry('Bash|NotebookEdit', cli, 'shell', 30)],
  PostToolUseFailure: [entry('Bash|NotebookEdit', cli, 'shell', 30)],
  Stop: [entry(undefined, cli, 'turn', 120)],
});

// a hook command codemyrules wrote: a copied script (before the npm package) or the CLI, wherever it was installed
const ours = (command) => typeof command === 'string'
  && (command.includes(`/${CONFIG_DIR}/`) || /cli\.mjs" hook (?:guard|shell|edited|turn)$/.test(command));

// drop every hook codemyrules wrote before, then add these; everything else in the settings stays as it was
export function mergeSettings(existing, hooks) {
  const out = { ...existing, hooks: { ...existing.hooks } };
  for (const [event, list] of Object.entries(out.hooks)) {
    if (!Array.isArray(list)) continue;
    out.hooks[event] = list.map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !ours(h.command)) })).filter((e) => e.hooks.length);
  }
  for (const [event, entries] of Object.entries(hooks)) out.hooks[event] = [...(out.hooks[event] ?? []), ...entries];
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

export function plan(projectDir, loopConfig, cli) {
  const items = [];
  const add = (p, content, preview = content) => {
    const old = readIf(p);
    if (old !== content) items.push({ path: p, action: old === null ? 'create' : 'update', preview, content });
  };
  const dest = path.join(projectDir, CONFIG_DIR);
  for (const s of COPIED) if (fs.existsSync(path.join(dest, s))) items.push({ path: path.join(dest, s), action: 'delete', preview: 'a copy from before the npm package', content: null });
  add(path.join(dest, 'loop.json'), JSON.stringify(loopConfig, null, 2) + '\n');

  const sp = path.join(projectDir, SETTINGS_FILE);
  const settings = mergeSettings(JSON.parse(readIf(sp) ?? '{}'), hookEntries(cli));
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

// args: the command-line arguments after the script name; returns the exit code
export function main(args) {
  const apply = args.includes('--apply');
  const ci = args.indexOf('--config');
  const values = new Set(['--config', '--cli'].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
  const dir = args.find((a, i) => !a.startsWith('--') && !values.has(i));
  const projectDir = dir && path.resolve(dir);
  // without --config, a reinstall with the project's installed loop.json
  const installed = projectDir && path.join(projectDir, CONFIG_DIR, 'loop.json');
  const cfgPath = ci >= 0 ? args[ci + 1] : installed && fs.existsSync(installed) ? installed : undefined;
  if (!projectDir || !cfgPath) {
    console.error('usage: install.mjs <project-dir> --config <loop.json> [--cli <cli.mjs>] [--apply]\n       install.mjs <project-dir> [--apply]   (reinstall, keeping the installed loop.json)');
    return 2;
  }
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
  const li = args.indexOf('--cli');
  const cli = li >= 0 ? path.resolve(args[li + 1]) : findCli();
  if (!cli) {
    console.error('codemyrules: the hooks run the codemyrules npm package, which is not installed globally. Install it with: npm install -g codemyrules');
    return 1;
  }
  const items = plan(projectDir, cfg, cli);
  for (const i of items) console.log(`${i.action} ${i.path}\n${i.preview.replace(/^/gm, '  ')}`);
  if (!items.length) console.log('nothing to change');
  if (!apply) {
    console.log('\ndry run: nothing written, re-run with --apply');
    return 0;
  }
  for (const i of items) {
    if (i.action === 'delete') { fs.rmSync(i.path, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(i.path), { recursive: true });
    fs.writeFileSync(i.path, i.content);
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
