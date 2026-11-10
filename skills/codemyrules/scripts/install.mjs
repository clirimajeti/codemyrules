#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { CONFIG_DIR, COPILOT_HOOKS, OPENCODE_PLUGIN, PI_EXTENSION, SETTINGS_FILE, isMain, readLoopConfig } from './core/lib.mjs';

// what versions before the npm package copied into the project; an install over them removes them
const COPIED = ['lib.mjs', 'secret-patterns.json', 'guard.mjs', 'shell-guard.mjs', 'lint-edited.mjs', 'lint-turn.mjs', 'core'];
const EXCLUDES = { claude: [`${CONFIG_DIR}/`, SETTINGS_FILE], pi: [`${CONFIG_DIR}/`, PI_EXTENSION], opencode: [`${CONFIG_DIR}/`, OPENCODE_PLUGIN], copilot: [`${CONFIG_DIR}/`, COPILOT_HOOKS] };
export const HARNESSES = Object.keys(EXCLUDES);
// where the CLI sits inside the npm package
const SCRIPTS = 'skills/codemyrules/scripts';
const CLI_IN_PACKAGE = `codemyrules/${SCRIPTS}/cli.mjs`;
// the project's pinned copy of the package, and its version and hash
const PIN_DIR = 'pkg';
const PIN_FILE = 'pin.json';

// The installer copies the globally installed npm package into the project, and the hooks run that copy.
// So `npm update -g codemyrules` changes no project: a release runs in a project only after `codemyrules install` there.
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
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// <root>/skills/codemyrules/scripts/cli.mjs
const packageRoot = (cli) => path.resolve(path.dirname(cli), '../../..');
export const pinnedCli = (projectDir) => path.join(projectDir, CONFIG_DIR, PIN_DIR, SCRIPTS, 'cli.mjs');

// GitHub Copilot CLI hooks, camelCase events: each passes its event name, since the payload has none.
// cwd is the project root, so a session started in a subfolder still finds the setup.
export const copilotHooks = (projectDir) => {
  const hook = (event, matcher, timeoutSec) => [{
    type: 'command', ...(matcher && { matcher }), command: `node "${pinnedCli(projectDir)}" hook copilot ${event}`, cwd: projectDir, timeoutSec,
  }];
  return JSON.stringify({ version: 1, hooks: {
    preToolUse: hook('preToolUse', 'edit|create|bash|powershell', 10),
    postToolUse: hook('postToolUse', 'edit|create|bash|powershell', 30),
    postToolUseFailure: hook('postToolUseFailure', 'bash|powershell', 30),
    agentStop: hook('agentStop', undefined, 120),
  } }, null, 2) + '\n';
};

// Harness files that hold only codemyrules: pi and opencode load every .js in a folder of their own (.pi/extensions,
// .opencode/plugins), Copilot every .json in .github/hooks.
// A .js file re-exports the harness's adapter from the pinned copy, by a relative path, so it keeps working when the project folder moves.
const EXTENSIONS = {
  pi: { file: PI_EXTENSION, adapter: 'pi.mjs', what: 'the pi extension' },
  opencode: { file: OPENCODE_PLUGIN, adapter: 'opencode.mjs', what: 'the opencode plugin' },
  copilot: { file: COPILOT_HOOKS, adapter: 'copilot.mjs', what: 'the GitHub Copilot CLI hooks', content: copilotHooks },
};
export function extensionFile(harness) {
  const { file, adapter } = EXTENSIONS[harness];
  const target = path.posix.relative(path.posix.dirname(file), `${CONFIG_DIR}/${PIN_DIR}/${SCRIPTS}/${adapter}`);
  return `// codemyrules lint feedback loop for ${harness}, written by \`codemyrules install\`; it runs the project's pinned copy.\nexport { default } from '${target}';\n`;
}
const hasExtension = (projectDir, harness) => readIf(path.join(projectDir, EXTENSIONS[harness].file))?.includes('codemyrules') ?? false;

// the harnesses a project has the loop for: codemyrules' hooks in the Claude Code settings, or its own harness file
export function installedHarnesses(projectDir) {
  const hooks = Object.values(readJson(path.join(projectDir, SETTINGS_FILE))?.hooks ?? {}).flat().flatMap((e) => e?.hooks ?? []);
  return [...(hooks.some((h) => ours(h.command)) ? ['claude'] : []), ...Object.keys(EXTENSIONS).filter((h) => hasExtension(projectDir, h))];
}

// the harnesses a project shows signs of using, from their project folders and config files
const MARKERS = { claude: ['.claude'], pi: ['.pi'], opencode: ['.opencode', 'opencode.json', 'opencode.jsonc'], copilot: ['.github/hooks', '.github/copilot-instructions.md'] };
// codemyrules keeps its own folder in .claude for every harness, so .claude counts only when it holds something else
const hasMarker = (projectDir, m) => {
  const p = path.join(projectDir, m);
  if (m !== path.dirname(CONFIG_DIR)) return fs.existsSync(p);
  try { return fs.readdirSync(p).some((n) => n !== path.basename(CONFIG_DIR)); } catch { return false; }
};
export function detectedHarnesses(projectDir) {
  return HARNESSES.filter((h) => MARKERS[h].some((m) => hasMarker(projectDir, m)));
}

// what the hooks need from the package, as in its package.json "files": the scripts and core/, not the tests
export function packageFiles(root) {
  const list = (sub, keep) => { try { return fs.readdirSync(path.join(root, sub)).filter(keep).map((f) => path.posix.join(sub, f)); } catch { return []; } };
  return ['package.json', ...list(SCRIPTS, (f) => f.endsWith('.mjs')), ...list(`${SCRIPTS}/core`, () => true)]
    .filter((f) => fs.statSync(path.join(root, f), { throwIfNoEntry: false })?.isFile()).sort();
}

// sha256 over the file names and contents, so a changed, added or removed file changes it
export function treeHash(root, files = packageFiles(root)) {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(f).update('\0').update(fs.readFileSync(path.join(root, f))).update('\0');
  return h.digest('hex');
}

function excludePath(projectDir) {
  const p = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: projectDir,
    encoding: 'utf8',
  }).trim();
  return path.resolve(projectDir, p);
}

export function plan(projectDir, loopConfig, cli, harnesses = ['claude']) {
  const items = [];
  const add = (p, content, preview = content) => {
    const old = readIf(p);
    if (old !== content) items.push({ path: p, action: old === null ? 'create' : 'update', preview, content });
  };
  const dest = path.join(projectDir, CONFIG_DIR);
  for (const s of COPIED) if (fs.existsSync(path.join(dest, s))) items.push({ path: path.join(dest, s), action: 'delete', preview: 'a copy from before the npm package', content: null });

  // the pinned copy: replaced when the package differs from it, or when the copy was changed
  const src = packageRoot(cli);
  const files = packageFiles(src);
  const pin = { version: readJson(path.join(src, 'package.json'))?.version ?? 'unknown', sha256: treeHash(src, files) };
  const pkgDir = path.join(dest, PIN_DIR);
  if (!fs.existsSync(pkgDir) || treeHash(pkgDir) !== pin.sha256) {
    const old = readJson(path.join(dest, PIN_FILE));
    items.push({
      path: pkgDir,
      action: fs.existsSync(pkgDir) ? 'update' : 'create',
      preview: `codemyrules ${old?.version && old.version !== pin.version ? `${old.version} -> ` : ''}${pin.version} (sha256 ${pin.sha256}), copied from ${src}\nthe hooks run this copy; a newer release reaches this project only when you install again`,
      copy: { from: src, files },
    });
  }
  add(path.join(dest, PIN_FILE), JSON.stringify(pin, null, 2) + '\n');
  add(path.join(dest, 'loop.json'), JSON.stringify(loopConfig, null, 2) + '\n');

  if (harnesses.includes('claude')) {
    const sp = path.join(projectDir, SETTINGS_FILE);
    const settings = mergeSettings(JSON.parse(readIf(sp) ?? '{}'), hookEntries(pinnedCli(projectDir)));
    add(sp, JSON.stringify(settings, null, 2) + '\n');
  }
  for (const [h, x] of Object.entries(EXTENSIONS)) if (harnesses.includes(h)) add(path.join(projectDir, x.file), x.content?.(projectDir) ?? extensionFile(h));

  const ep = excludePath(projectDir);
  const old = readIf(ep) ?? '';
  // info/exclude patterns are anchored at the repo root, so a project in a subfolder needs its path in front
  const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: projectDir, encoding: 'utf8' }).trim();
  const missing = [...new Set(harnesses.flatMap((h) => EXCLUDES[h]))].map((l) => prefix + l).filter((l) => !old.split('\n').includes(l));
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
    // a linter with a cwd runs in that folder, so its command and config paths resolve from there
    let base = projectDir;
    if (l && typeof l === 'object' && l.cwd !== undefined) {
      if (typeof l.cwd !== 'string' || !l.cwd) errs.push(`${at}.cwd must be a path relative to the project root`);
      else {
        const abs = path.resolve(projectDir, l.cwd);
        const rel = path.relative(projectDir, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) errs.push(`${at}.cwd "${l.cwd}" is not a folder in the project`);
        else base = abs;
      }
    }
    if (!l || typeof l !== 'object') return errs.push(`${at} must be an object`);
    if (typeof l.name !== 'string' || !l.name.trim()) errs.push(`${at}.name must be a non-empty string`);
    if (!FORMATS.includes(l.format)) errs.push(`${at}.format is "${l.format}", expected one of ${FORMATS.join(', ')}`);
    if (!isStrList(l.command) || !l.command.length) errs.push(`${at}.command must be a list of strings, not one string`);
    else if (!l.command.includes('{files}')) errs.push(`${at}.command must contain the element "{files}"`);
    if (!isStrList(l.extensions) || !l.extensions.length || !l.extensions.every((e) => e.startsWith('.'))) errs.push(`${at}.extensions must be a list like [".ts", ".vue"]`);
    if (!TIERS.includes(l.tier)) errs.push(`${at}.tier is "${l.tier}", expected fast or full`);
    if (isStrList(l.command) && l.command.length && !findExecutable(l.command[0], base)) {
      errs.push(`${at}: "${l.command[0]}" is not installed (not on PATH, or no such file in the project); every run would fail, so this linter would never block anything. Install it, or use a command that is available`);
    }
    const runner = isStrList(l.command) && packageRunner(l.command);
    if (runner && l.tier === 'fast') {
      errs.push(`${at}: runs through "${runner}", which resolves the package on every edit (about 0.4 s with a warm cache, seconds or a download when cold, and a run past the 10 s limit counts as clean). Use the installed binary (node_modules/.bin/<tool>, or the tool on PATH), or move it to the full tier`);
    }
    if (isStrList(l.command)) {
      l.command.forEach((c, j) => {
        const file = (c === '-c' || c === '--config') ? l.command[j + 1] : undefined;
        if (file && file !== '{files}' && !fs.existsSync(path.resolve(base, file))) {
          errs.push(`${at}: the config "${file}" after ${c} does not exist in the project; every run would fail`);
        }
      });
    }
    if (l.format === 'ast-grep' && isStrList(l.command) && !l.command.some((c) => c === '-c' || c === '--config')
        && !['sgconfig.yml', 'sgconfig.yaml'].some((f) => fs.existsSync(path.join(base, f)))) {
      errs.push(`${at}: ast-grep needs an sgconfig.yml in the folder it runs in (the project root, or its cwd), or "-c <path>" in its command; without one every scan fails`);
    }
  });
  return errs;
}

// args: the command-line arguments after the script name; returns the exit code
export function main(args) {
  const apply = args.includes('--apply');
  const ci = args.indexOf('--config');
  const values = new Set(['--config', '--cli', '--harness'].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
  const dir = args.find((a, i) => !a.startsWith('--') && !values.has(i));
  const projectDir = dir && path.resolve(dir);
  // without --config, a reinstall with the project's installed loop.json
  const installed = projectDir && path.join(projectDir, CONFIG_DIR, 'loop.json');
  const cfgPath = ci >= 0 ? args[ci + 1] : installed && fs.existsSync(installed) ? installed : undefined;
  if (!projectDir || !cfgPath) {
    console.error(`usage: install.mjs <project-dir> --config <loop.json> [--harness ${HARNESSES.join(',')}] [--cli <cli.mjs>] [--apply]\n       install.mjs <project-dir> [--apply]   (reinstall, keeping the installed loop.json and harnesses)`);
    return 2;
  }
  // any folder inside a work tree: a monorepo package is a project of its own
  if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, encoding: 'utf8' }).stdout?.trim() !== 'true') {
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
  // without --harness: the harnesses already installed, else the one harness the project has a folder for, else Claude Code
  const hi = args.indexOf('--harness');
  const harnesses = hi >= 0 ? [...new Set(String(args[hi + 1] ?? '').split(',').map((h) => h.trim()).filter(Boolean))] : installedHarnesses(projectDir);
  if (!harnesses.length) {
    const found = detectedHarnesses(projectDir);
    if (found.length > 1) {
      console.error(`codemyrules: this project has setup for ${found.join(' and ')}; name the harness to install for: --harness ${found.join('|')} (or --harness ${found.join(',')} for all)`);
      return 2;
    }
    harnesses.push(found[0] ?? 'claude');
    console.log(`harness: ${harnesses[0]} (${found.length ? `found ${MARKERS[found[0]].find((m) => hasMarker(projectDir, m))}` : 'no harness folder found, defaulting to Claude Code'}; pass --harness ${HARNESSES.join('|')} to choose)\n`);
  }
  const unknown = harnesses.filter((h) => !HARNESSES.includes(h));
  if (unknown.length || (hi >= 0 && !args[hi + 1])) {
    console.error(`codemyrules: unknown harness ${unknown.join(', ') || '(none given)'}, expected a comma-separated list of ${HARNESSES.join(', ')}`);
    return 2;
  }
  const li = args.indexOf('--cli');
  const cli = li >= 0 ? path.resolve(args[li + 1]) : findCli();
  if (!cli) {
    console.error('codemyrules: the hooks run the codemyrules npm package, which is not installed globally. Install it with: npm install -g codemyrules');
    return 1;
  }
  return carryOut(plan(projectDir, cfg, cli, harnesses), apply);
}

// print the plan, and with apply carry it out
function carryOut(items, apply) {
  for (const i of items) console.log(`${i.action} ${i.path}\n${i.preview.replace(/^/gm, '  ')}`);
  if (!items.length) console.log('nothing to change');
  if (!apply) {
    if (items.length) console.log('\ndry run: nothing written, re-run with --apply');
    return 0;
  }
  for (const i of items) {
    if (i.action === 'delete') { fs.rmSync(i.path, { recursive: true, force: true }); continue; }
    if (i.copy) {
      fs.rmSync(i.path, { recursive: true, force: true });
      for (const f of i.copy.files) {
        fs.mkdirSync(path.dirname(path.join(i.path, f)), { recursive: true });
        fs.copyFileSync(path.join(i.copy.from, f), path.join(i.path, f));
      }
      continue;
    }
    fs.mkdirSync(path.dirname(i.path), { recursive: true });
    fs.writeFileSync(i.path, i.content);
  }
  return 0;
}

const projectArg = (args) => { const d = args.find((a) => !a.startsWith('--')); return d && path.resolve(d); };

// removes the setup folder and codemyrules' own hook entries; the .git/info/exclude lines are harmless and stay
export function uninstall(args) {
  const projectDir = projectArg(args);
  if (!projectDir) { console.error('usage: codemyrules uninstall <project-dir> [--apply]'); return 2; }
  const items = [];
  const dest = path.join(projectDir, CONFIG_DIR);
  if (fs.existsSync(dest)) {
    const files = fs.readdirSync(dest).join(', ');
    items.push({ path: dest, action: 'delete', preview: `the loop config and its state: ${files || 'empty'}`, content: null });
  }
  const sp = path.join(projectDir, SETTINGS_FILE);
  const settings = readJson(sp);
  if (settings) {
    const out = mergeSettings(settings, {});
    const content = JSON.stringify(out, null, 2) + '\n';
    const count = (s) => Object.values(s.hooks ?? {}).flat().flatMap((e) => e?.hooks ?? []).length;
    if (count(out) !== count(settings)) items.push({ path: sp, action: 'update', preview: `removes ${count(settings) - count(out)} codemyrules hook entries, keeps the rest`, content });
  }
  for (const [h, x] of Object.entries(EXTENSIONS)) if (hasExtension(projectDir, h)) items.push({ path: path.join(projectDir, x.file), action: 'delete', preview: x.what, content: null });
  const apply = args.includes('--apply');
  const code = carryOut(items, apply);
  // a .claude or .github/hooks folder that held nothing but the setup goes too; rmdir leaves a folder with anything else in it alone
  if (apply) for (const d of [path.dirname(dest), path.join(projectDir, path.dirname(COPILOT_HOOKS))]) try { fs.rmdirSync(d); } catch { /* not empty, or not there */ }
  return code;
}

// what is installed in a project, whether its hooks can run, and what failed lately
export function status(args) {
  const projectDir = projectArg(args);
  if (!projectDir) { console.error('usage: codemyrules status <project-dir>'); return 2; }
  const version = readJson(new URL('../../../package.json', import.meta.url))?.version ?? 'unknown';
  console.log(`codemyrules ${version}`);
  const dest = path.join(projectDir, CONFIG_DIR);
  const commands = Object.values(readJson(path.join(projectDir, SETTINGS_FILE))?.hooks ?? {}).flat()
    .flatMap((e) => e?.hooks ?? []).map((h) => h.command).filter(ours);
  const extensions = Object.keys(EXTENSIONS).filter((h) => hasExtension(projectDir, h));
  if (!commands.length && !extensions.length && !fs.existsSync(path.join(dest, 'loop.json'))) {
    console.log(`not installed in ${projectDir}`);
    return 0;
  }
  const targets = [...new Set(commands.map((c) => /^node "(.+)" hook \w+$/.exec(c)?.[1]).filter(Boolean))];
  const copyHooks = commands.filter((c) => !/cli\.mjs" hook \w+$/.test(c)).length;
  const missing = targets.filter((t) => !fs.existsSync(t));
  if (targets.length === 1 && !missing.length && !copyHooks) console.log(`hooks: ${commands.length} entries, all run ${targets[0]}`);
  else {
    console.log(`hooks: ${commands.length} entries`);
    for (const t of targets) console.log(`  ${missing.includes(t) ? 'missing' : 'runs'}: ${t}`);
    if (copyHooks) console.log(`  ${copyHooks} run copies from before the npm package; reinstall to replace them`);
  }
  for (const h of extensions) {
    const { file, adapter } = EXTENSIONS[h];
    console.log(`${h}: ${file}${fs.existsSync(path.join(dest, PIN_DIR, SCRIPTS, adapter)) ? '' : `, but the pinned copy has no ${h} adapter; reinstall`}`);
  }
  const pinned = pinnedCli(projectDir);
  if (targets.some((t) => t !== pinned)) console.log(`  not pinned: every npm update of what they run reaches this project. Reinstall to pin a copy: codemyrules install ${projectDir} --apply`);
  const pin = readJson(path.join(dest, PIN_FILE));
  if (pin) {
    const intact = fs.existsSync(path.join(dest, PIN_DIR)) && treeHash(path.join(dest, PIN_DIR)) === pin.sha256;
    console.log(`pinned: codemyrules ${pin.version} (sha256 ${pin.sha256})${intact ? '' : ', but the copy was changed since; reinstall to restore it'}`);
    if (pin.version !== version) console.log(`  this CLI is ${version}; to move the project to it: codemyrules install ${projectDir} --apply`);
  }
  const copies = COPIED.filter((f) => fs.existsSync(path.join(dest, f)));
  if (copies.length) console.log(`copies from before the npm package: ${copies.join(', ')} (reinstall to remove them)`);
  let cfg;
  try { cfg = readLoopConfig(projectDir); } catch (e) { console.log(`loop.json could not be read: ${e.message.split('\n')[0]}`); return 0; }
  console.log(`linters: ${cfg.linters.length ? '' : 'none'}`);
  for (const l of cfg.linters) console.log(`  ${l.name} (${l.tier}, ${l.extensions.join(' ')}${l.cwd ? `, cwd ${l.cwd}` : ''})`);
  console.log(`protected: ${cfg.protect.join(', ') || 'none'}`);
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  const byRule = {};
  for (const line of (fs.existsSync(path.join(dest, 'failures.log')) ? fs.readFileSync(path.join(dest, 'failures.log'), 'utf8') : '').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (Date.parse(row.ts) >= since) byRule[row.ruleId] = (byRule[row.ruleId] ?? 0) + 1;
  }
  const rules = Object.entries(byRule).sort((a, b) => b[1] - a[1]);
  console.log(`failures in the last 7 days: ${rules.length ? '' : 'none'}`);
  for (const [r, n] of rules) console.log(`  ${r}: ${n}`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
