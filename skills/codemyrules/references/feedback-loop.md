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
Files changed through `Bash` (a formatter, `sed`, a code generator) are not recorded and not checked in the turn; CI catches those.
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

A linter that is missing, crashes or runs past its time limit (10 seconds in the fast tier, 30 in the full tier) never blocks: the hook prints one line, `codemyrules: <name> failed: <reason>`, and treats that linter as clean.
Outside a git repository the hooks do nothing.

## The guard

A `PreToolUse` hook on `Edit|Write|MultiEdit` checks each edit before it happens.
It turns these into a permission prompt (`permissionDecision: "ask"`), so only the user can approve them:
- an edit that adds or changes a line with an ignore comment (`eslint-disable`, an inline `/* eslint rule: "off" */`, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `@Suppress`, `@SuppressWarnings`, `@SuppressLint`, `# noqa` and `# ruff: noqa`, `# type: ignore`, `pylint: disable`, `ast-grep-ignore`, `//nolint`, `#[allow(`, `#![allow(`, `biome-ignore`, `NOSONAR`)
  It compares the suppression lines before and after the edit, so swapping one ignore comment for another, or adding a rule name to an existing one, also asks.
- an edit to a path in `protect`: the lint configs, rule folders and baseline files
- an edit to `.claude/codemyrules/` itself or to `.claude/settings.local.json`

Everything else passes without output.
With nobody to approve, the edit does not happen.

The guard sees only the `Edit`, `Write` and `MultiEdit` tools.
Known gaps: a change made through `Bash` (`sed`, a script, `git checkout`) or through `NotebookEdit` is not checked, so it can still add an ignore comment or change a lint config.
CI, running the project's own lint setup, is the safety net for those.

## Files

Everything lives in the project, private to the user who installed it:

| Path | What |
|---|---|
| `.claude/codemyrules/guard.mjs`, `lint-edited.mjs`, `lint-turn.mjs`, `lib.mjs`, `secret-patterns.json` | the hooks, their shared code and the credential files they never touch, copied by `install.mjs` |
| `.claude/codemyrules/loop.json` | the linters per tier and the protected paths |
| `.claude/codemyrules/failures.log` | one JSON line per blocking finding: time, event (`edit` or `turn`), rule, file, line |
| `.claude/codemyrules/baseline.json` | doc tokens, rules and open hits when the loop was installed |
| `.claude/settings.local.json` | the three hook entries |

`install.mjs` adds `.claude/codemyrules/` and `.claude/settings.local.json` to `.git/info/exclude`, so no tracked file changes.
It merges its three entries into an existing `settings.local.json` without removing or duplicating anything, so running it again is safe.

## The failure log

`measure.mjs report` counts the log per rule and per event.
Only errors block, so a rule left at `warning` is invisible to the loop.
Every built rule is therefore an `error`: with no open hits in the main config, with open hits in the suggestions layer, which the loop runs instead of the main config.
The loop only checks lines the agent changes, so the old hits never block, and CI keeps running the main config.
Those are the rules agents break most, by copying the nearby code that already breaks them, so leaving them out of the loop would waste it where it matters.
The loop is a safety net that should rarely fire.
When the agent already knows a design-shaping rule through a one-line pointer, it writes the right code first and the hooks stay silent; without the pointer, the same rule gets caught and reworked again and again, which costs more than the pointer line ever does.
A rule that keeps failing in the same way is a sign the agent needs to know it before it writes code: offer a one-line pointer for it in the folder it applies to.
A rule that never fails after its doc lines were removed has paid off.

## Uninstall

1. Delete `.claude/codemyrules/`.
2. Remove the three entries whose command runs `.claude/codemyrules/` (`PreToolUse`, `PostToolUse`, `Stop`) from `.claude/settings.local.json`.

The two lines in `.git/info/exclude` are harmless and can stay or go.

## Sharing with the team

The first install is private, so an experiment affects only the user who ran it.
Moving the loop to the shared `.claude/settings.json` and tracked scripts is a later, separate step, done only when the user asks and approves the exact change.
