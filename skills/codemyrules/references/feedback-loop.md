# The feedback loop

A rule only helps an agent when the agent meets it while it codes, not days later in CI.
The loop runs the project's own lint setup in Claude Code hooks, with all its rules, not only the ones codemyrules wrote.
Every check is silent when clean, so a passing check costs no tokens.

## The three tiers

| Tier | When | What runs | Cost |
|---|---|---|---|
| Fast | after every edit (`PostToolUse`, matcher `Edit\|Write\|MultiEdit`) | the `fast` linters, on the edited file only | milliseconds; one short line per failure |
| Full | at the end of each turn (`Stop`) | every linter in `loop.json`, both tiers, on the files the agent edited in this turn | one lint start per turn, not per edit |
| Safety net | CI | the project's own lint run, including slow JVM tools | none for the agent |

ast-grep and an ESLint daemon (`eslint_d`) answer in milliseconds, so they can run after every edit.
A cold ESLint start takes seconds, mostly Node startup and config loading, so plain ESLint runs once per turn.
Gradle detekt and Error Prone need a JVM build and never run in a hook.

The fast check records each file it sees in `.claude/codemyrules/turn-<session>.txt`, and the end-of-turn check lints only those files, so uncommitted work from before the turn never blocks.
The end-of-turn check deletes that list when it lets the turn end.
Files changed through `Bash` or `NotebookEdit` (a formatter, `sed`, a code generator) are recorded by the shell guard below, so the end-of-turn check lints them too.
Credential files (`.env*`, `.envrc`, SSH keys, `*.pem` / `*.key`, `.aws/`, `.kube/`, `.netrc`, `.npmrc`, `*.tfvars`, the full list is `secret-patterns.json`) are never read, diffed or passed to a linter by any check.

## What blocks

- **Errors only.** Warnings never block.
- **On changed lines only.** A finding blocks only when its line was added or changed since `HEAD`, from the `git diff` hunks; an untracked file counts as changed throughout.
  Older hits elsewhere in the same file are ignored, so the agent never fixes unrelated legacy code.
- **At most 20 findings** reach the agent, plus `…and N more`, so one bad turn cannot flood its context.

A blocked check returns the findings to the agent with exit code 2, each as `file:line ruleId message`, followed by one instruction: fix them; when a case seems legitimate, ask the user and propose a change to the rule (an exclusion or a narrower pattern, plus a test case), not to the code; never add an ignore comment or change lint config on its own; with nobody to ask, finish the rest of the task and list them in the final report.
That instruction arrives only when a rule fails, so it needs no line in CLAUDE.md.

The end-of-turn check blocks once per turn.
When the turn ends again with findings left, it lets it end and shows the user what is still failing, so it never loops.

The fast tier runs only installed binaries: a package runner such as `npx` resolves the package on every edit, so the installer refuses one there.
Each check diffs only the files it lints, not the whole repository.
A linter with a `cwd` in `loop.json` (one package of a monorepo) runs in that folder, on the edited files inside it only.

A linter that is missing, crashes or runs past the time budget never blocks: the hook prints one line, `codemyrules: <name> failed: <reason>`, and treats that linter as clean.
The budget is shared by all linters of one check, 10 seconds after an edit and 60 at the end of the turn, so several linters cannot add up; a linter that starts after the budget is used up is skipped with a note.
A linter past the budget is killed with `SIGKILL`, so one that ignores `SIGTERM` cannot keep the hook waiting.
Outside a git repository the hooks do nothing.

## The guard

A `PreToolUse` hook on `Edit|Write|MultiEdit` checks each edit before it happens.
It turns these into a permission prompt (`permissionDecision: "ask"`), so only the user can approve them:
- an edit that adds or changes a line with an ignore comment:
  - JS/TS: `eslint-disable`, an inline `/* eslint rule: "off" */`, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `tslint:disable`, `biome-ignore`
  - JVM and C#: `@Suppress…` (also `@file:Suppress`), `[SuppressMessage(`, `#pragma warning disable`, `NOSONAR`
  - Python: `# noqa`, `# type: ignore`, `pylint: disable` and `skip-file`, `# pyright:`, `# mypy:`
  - Go, Rust, C/C++: `//nolint`, `//lint:ignore`, `NOLINT`, `#[allow(`, `#![allow(`
  - Ruby and PHP: `rubocop:disable` and `todo`, `@phpstan-ignore`, `@psalm-suppress`, `phpcs:ignore` and `disable`
  - ast-grep: `ast-grep-ignore`

  It compares the suppressions before and after the edit, so swapping one ignore comment for another, or adding a rule name to an existing one, also asks.
  An ignore comment on a line of its own counts together with the next line of code, so moving it onto other code also asks.
  Prose files (`.md`, `.mdx`, `.rst`, `.txt`, `.adoc`) are left out, so docs can name an ignore comment; a string literal in code that holds one still asks.
- an edit to the lint settings inside a shared build file: `eslintConfig` and `eslintIgnore` in `package.json`, and the `[tool.ruff]`, `[tool.mypy]`, `[tool.pylint]`, `[flake8]` and similar sections in `pyproject.toml`, `setup.cfg` and `tox.ini`; any other edit to those files passes
- an edit to a path in `protect`: the lint configs, rule folders and baseline files
- an edit to `.claude/codemyrules/` itself, to `.claude/settings.local.json` or to `.pi/extensions/codemyrules.js`

Everything else passes without output.
With nobody to approve, the edit does not happen.

### Changes through the shell

A command can change any file (`sed -i`, `echo >>`, `git apply`, a script), so a second hook, `codemyrules hook shell`, runs before and after each `Bash` and `NotebookEdit` call, also after one that fails (`PostToolUseFailure`): a failed command can still have changed files.
Before, it stores the content of every file that differs from `HEAD`, plus the codemyrules setup, in git's object store; after, it finds every file the call changed and checks it like an edit, including the protected paths.
The change has already happened, so it cannot ask first: it tells the agent to undo the change or ask the user (a `PostToolUse` block, or added context after a failed command), and shows the user the same list.
The files it changed are also recorded for the end-of-turn check.
It reads only what can have changed: git's stat data finds the uncommitted files, and a file is hashed again only when its size or times moved, so a hook takes about 60 ms in a small repository and about 100 ms with 5,000 uncommitted files.
Credential files are never read.
When two commands run in parallel, each one may also report the other's changes.
A snapshot whose command never ran (the user denied it) and a turn list whose turn never ended are deleted once they are a day old.
A command that runs the codemyrules installer (a part of it starting with `codemyrules install` or `uninstall`, or `node …/install.mjs`) may change the setup: those changes are shown to the user, and the agent is not sent back; every other file it changes is still checked.
A file counts as protected when it was protected before the command or after it, so rewriting `loop.json` and editing a lint config in one command still blocks.
CI, running the project's own lint setup, stays the safety net.

## pi

`codemyrules install <project-dir> --harness pi` writes `.pi/extensions/codemyrules.js` instead of the Claude Code hooks; `--harness claude,pi` writes both.
A reinstall without `--harness` keeps the harnesses already installed.
The extension re-exports `pi.mjs` from the pinned copy and runs the same checks as the hooks:
- `tool_call` on `edit` and `write`: the guard; a flagged edit opens pi's confirm dialog, and a no blocks it.
  Without a UI (print or JSON mode) a flagged edit is refused, since nobody can be asked.
- `tool_call` and `tool_result` on `bash`: the shell guard; its message to undo the change is added to the tool result.
- `tool_result` on `edit` and `write`: the fast tier; findings are added to the tool result.
- `agent_before_settle`: the full tier; findings go back as a hidden message with one more turn, and after that one retry the user sees what is still failing.

pi loads a project extension only once the project is trusted (`/trust`, or `-a` for one run).
The file is git-excluded and protected like the rest of the setup.

## Files

Everything lives in the project, private to the user who installed it:

| Path | What |
|---|---|
| `.claude/codemyrules/pkg/` | the pinned copy of the `codemyrules` npm package the hooks run (`codemyrules hook guard\|shell\|edited\|turn`): their shared code and `secret-patterns.json`, the credential files they never touch |
| `.claude/codemyrules/pin.json` | the pinned version and the sha256 of the copy |
| `.claude/codemyrules/loop.json` | the linters per tier and the protected paths |
| `.claude/codemyrules/failures.log` | one JSON line per blocking finding: time, event (`edit` or `turn`), rule, file, line |
| `.claude/codemyrules/baseline.json` | doc tokens, rules and open hits when the loop was installed |
| `.claude/codemyrules/turn-*.txt`, `shell-*.json`, `hash-cache.json` | runtime state: the files edited this turn, the snapshot around a shell command, and the hashes it reuses; left-overs older than a day are deleted |
| `.claude/settings.local.json` | the six hook entries |
| `.pi/extensions/codemyrules.js` | with `--harness pi`: the pi extension, a one-line re-export of the pinned `pi.mjs` |

`install.mjs` adds `.claude/codemyrules/` and `.claude/settings.local.json` to `.git/info/exclude`, so no tracked file changes.
It merges its six entries into an existing `settings.local.json`, replacing any entries codemyrules wrote before and keeping everything else, so running it again is safe.
Each entry runs `node "<project>/.claude/codemyrules/pkg/skills/codemyrules/scripts/cli.mjs" hook <name>`.
The installer copies the package it finds through the `codemyrules` command on `PATH` (the global install) and refuses to install without it.
The copy sits in the setup folder, so the guard asks before any edit to it, and the shell guard catches a command that changes it.

## Updates

Updating is an explicit act per project: `npm update -g codemyrules` changes only the global package, and the project keeps running its pinned copy.
Run `codemyrules install <project-dir>` to see the change (`codemyrules 0.6.0 -> 0.7.0` and the new sha256), and add `--apply` to take it.
So a bad or compromised release never runs in a project on its own, inside a hook that sees every edit.
Versions 0.5 and 0.6 ran the global package directly; installing again pins a copy.
Versions before 0.5 copied the scripts into `.claude/codemyrules/`; installing again removes those copies and their hook entries and keeps `loop.json`, the failure log and the baseline.
`codemyrules install <project-dir> --apply` without `--config` reinstalls with the project's own `loop.json`.

## The failure log

`measure.mjs report` counts the log per rule and per event, and ends with advice drawn from it: a rule that keeps failing gets a pointer suggestion for the folder it fails in, a rule caught mostly at the end of the turn a suggestion to lint it in the fast tier, a rule that never failed the note that its doc line can likely go, and growth of the always-loaded docs is named.
Only errors block, so a rule left at `warning` is invisible to the loop.
Every built rule is therefore an `error`: with no open hits in the main config, with open hits in the suggestions layer, which the loop runs instead of the main config.
The loop only checks lines the agent changes, so the old hits never block, and CI keeps running the main config.
Those are the rules agents break most, by copying the nearby code that already breaks them, so leaving them out of the loop would waste it where it matters.
The loop is a safety net that should rarely fire.
When the agent already knows a design-shaping rule through a one-line pointer, it writes the right code first and the hooks stay silent; without the pointer, the same rule gets caught and reworked again and again, which costs more than the pointer line ever does.
A rule that keeps failing in the same way is a sign the agent needs to know it before it writes code: offer a one-line pointer for it in the folder it applies to.
A rule that never fails after its doc lines were removed has paid off.

## Uninstall

`codemyrules uninstall <project-dir>` shows what it removes, and with `--apply` removes it: `.claude/codemyrules/` (with the failure log and the baseline) and codemyrules' own entries in `.claude/settings.local.json`, keeping every other hook.
When no other project uses it, `npm uninstall -g codemyrules` removes the package.
The two lines in `.git/info/exclude` are harmless and can stay or go.

## Status

`codemyrules status <project-dir>` shows what is installed: the package version, whether every hook entry runs a CLI that exists, the pinned version and whether the copy still matches its sha256, hooks that are not pinned, copies left from before the npm package, the linters, the protected paths and the failures of the last 7 days per rule.

## Sharing with the team

The first install is private, so an experiment affects only the user who ran it.
Moving the loop to the shared `.claude/settings.json` and tracked scripts is a later, separate step, done only when the user asks and approves the exact change.
