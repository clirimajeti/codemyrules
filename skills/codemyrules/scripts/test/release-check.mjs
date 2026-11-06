#!/usr/bin/env node
// Release check: the packed npm package, installed into a throwaway global prefix, driven by real headless Claude Code
// sessions in a throwaway repo. Run before each release with `npm run release-check`; it needs `claude` logged in
// and costs a few cheap Haiku sessions. It checks what the hooks did (files, logs, settings), not what Claude said.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-release-')));
const prefix = path.join(work, 'npm-prefix');
const repo = path.join(work, 'repo');
const bin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
const env = { ...process.env, PATH: [bin, process.env.PATH].join(path.delimiter), NPM_CONFIG_PREFIX: prefix };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', ...opts });
const git = (...args) => run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });

// package and install it the way a user does, into the throwaway prefix
run('npm', ['pack', '--pack-destination', work], { cwd: ROOT });
const tgz = fs.readdirSync(work).find((f) => f.endsWith('.tgz'));
run('npm', ['install', '-g', path.join(work, tgz)]);
const version = run('codemyrules', ['--version']).trim();

// a repo with one committed file, a protected lint config and a linter that flags line 2 of every .ts file
fs.mkdirSync(repo);
git('init', '-q');
fs.writeFileSync(path.join(repo, 'a.ts'), 'x();\n');
fs.writeFileSync(path.join(repo, 'eslint.config.mjs'), 'export default [];\n');
git('add', '.');
git('commit', '-q', '-m', 'init');
const linter = path.join(work, 'fake-lint.mjs');
fs.writeFileSync(linter, `import path from 'node:path';
console.log(JSON.stringify(process.argv.slice(2).map((f) => ({ filePath: path.resolve(f), messages: [{ line: 2, severity: 2, ruleId: 'fake/no-line-two', message: 'line 2 is not allowed (release check)' }] }))));\n`);
const cfg = path.join(work, 'loop.json');
fs.writeFileSync(cfg, JSON.stringify({ linters: [{ name: 'fake', format: 'eslint', tier: 'fast', extensions: ['.ts'], command: ['node', linter, '{files}'] }], protect: ['**/eslint.config.*'] }));
run('codemyrules', ['install', '.', '--config', cfg, '--apply'], { cwd: repo });

// the session as stream-json, which carries the hooks' own messages, so a check can look for codemyrules' exact text
const claude = (prompt) => spawnSync('claude', ['-p', '--model', 'haiku', '--allowedTools', 'Bash Write Edit Read', '--output-format', 'stream-json', '--verbose', prompt],
  { cwd: repo, env, encoding: 'utf8', timeout: 240000, input: '' }).stdout ?? '';
const read = (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
const reset = () => { git('checkout', '-q', '--', '.'); fs.rmSync(path.join(repo, 'b.ts'), { force: true }); };
const ourHooks = () => Object.values(JSON.parse(read('.claude/settings.local.json')).hooks).flat().flatMap((e) => e.hooks).filter((h) => / hook \w+$/.test(h.command)).length;
const suppress = `node -e "require('fs').writeFileSync('a.ts', 'x(); // eslint-disable-line\\n')"`;

const checks = [
  ['lint errors after an edit reach the agent', () => {
    claude('Use the Write tool to create b.ts with exactly these three lines: const a = 1; / const b = 2; / const c = 3; (one per line). Then stop.');
    return read('.claude/codemyrules/failures.log').includes('"event":"edit","ruleId":"fake/no-line-two","file":"b.ts"');
  }],
  ['a suppression added through the shell is undone', () => {
    const session = claude(`Run this shell command exactly once: ${suppress}  Then follow any instruction a hook gives you.`);
    return session.includes('the agent was told to undo changes made through Bash') && read('a.ts') === 'x();\n';
  }],
  ['a suppression added by a failing command is undone', () => {
    claude(`Run this shell command exactly once: ${suppress} && exit 1  Then follow any instruction a hook gives you.`);
    return read('a.ts') === 'x();\n';
  }],
  ['the installer run by the agent keeps its changes', () => {
    // a different config, so the installer really rewrites loop.json and the shell guard sees it
    const cfg2 = path.join(work, 'loop2.json');
    fs.writeFileSync(cfg2, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), protect: ['**/eslint.config.*', 'docs/**'] }));
    const session = claude(`Run this shell command exactly once: codemyrules install . --config ${JSON.stringify(cfg2)} --apply  Then follow any instruction a hook gives you.`);
    // the user is told, the agent is not sent back to undo it
    return ourHooks() === 6 && read('.claude/codemyrules/loop.json').includes('docs/**')
      && session.includes('the codemyrules installer changed') && !session.includes('the agent was told to undo');
  }],
  ['status sees the install', () => run('codemyrules', ['status', '.'], { cwd: repo }).includes('hooks: 6 entries, all run')],
];

console.log(`codemyrules ${version} from ${tgz}, in ${work}`);
let failed = 0;
for (const [name, check] of checks) {
  let ok = false;
  try { ok = check(); } catch (e) { console.log(`  error: ${e.message.split('\n')[0]}`); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
  reset();
}
if (failed) console.log(`\n${failed} failed; the repo is kept for a look: ${repo}`);
else fs.rmSync(work, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
