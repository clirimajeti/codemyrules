#!/usr/bin/env node
// codemyrules: one command for the hooks a harness runs, and for installing and measuring the loop.
// Published to npm, so the hooks of every project run one current copy instead of copies in each project.
import fs from 'node:fs';
import { readHookInput } from './core/lib.mjs';

// the Claude Code adapter for each hook; other harnesses get their own names here
const HOOKS = { guard: './guard.mjs', shell: './shell-guard.mjs', edited: './lint-edited.mjs', turn: './lint-turn.mjs' };
const USAGE = `usage: codemyrules hook <${Object.keys(HOOKS).join('|')}>   run one hook, its input on stdin
       codemyrules install <project-dir> [--config <loop.json>] [--harness claude,pi,opencode] [--apply]
       codemyrules uninstall <project-dir> [--apply]
       codemyrules status <project-dir>
       codemyrules measure baseline|report <project-dir>
       codemyrules --version`;

const [cmd, ...args] = process.argv.slice(2);
if (cmd === '--version') {
  console.log(JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version);
} else if (cmd === 'hook' && Object.hasOwn(HOOKS, args[0])) {
  process.exitCode = await (await import(HOOKS[args[0]])).main(await readHookInput());
} else if (cmd === 'install') {
  process.exitCode = (await import('./install.mjs')).main(args);
} else if (cmd === 'uninstall' || cmd === 'status') {
  process.exitCode = (await import('./install.mjs'))[cmd](args);
} else if (cmd === 'measure') {
  process.exitCode = (await import('./measure.mjs')).main(args);
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
