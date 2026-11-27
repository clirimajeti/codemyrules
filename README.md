<h1 align="center">codemyrules</h1>
<p align="center">
  <a href="https://www.npmjs.com/package/codemyrules"><img alt="npm" src="https://img.shields.io/npm/v/codemyrules?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <a href="https://agentskills.io"><img alt="Agent Skill" src="https://img.shields.io/badge/agent-skill-purple?style=flat-square" /></a>
  <a href="https://github.com/clirimajeti/agent-rules-bench"><img alt="Benchmark" src="https://img.shields.io/badge/evidence-agent--rules--bench-green?style=flat-square" /></a>
</p>

<h3 align="center">Turn the rules in your agent docs into code rules your agent cannot ignore.</h3>

Every prose rule in `CLAUDE.md`, `AGENTS.md` or an instructions file is read in every agent session, whether the task needs it or not.
The agent can still ignore it.
A lint rule costs nothing until it is broken, and then it says exactly what is wrong.

codemyrules finds the conventions your code and docs already state, writes them as lint rules, slims the agent docs those rules now cover, and lets the agent meet the rules while it codes.

- **Finds your rules** - majority patterns in your code, your decision records (ADRs), and the rules written as prose in your agent docs.
- **Whole stack** - ESLint or oxlint for JavaScript, TypeScript, Vue and Svelte (Biome not yet); ast-grep or your existing linter for Java, Kotlin, Python, Go, C#, PHP, Rust and Ruby; PSScriptAnalyzer for PowerShell.
- **Slimmer agent docs** - every doc line a new rule covers can be deleted, shortened to a pointer, or kept.
- **Silent feedback loop** - the agent sees a broken rule seconds after it writes the code, not days later in review; a passing check costs no tokens.
- **A smaller model is enough** - in our benchmark, Haiku with rules broke no convention in 104 runs; Sonnet without rules broke one in 21% of its runs, at ten times the cost ([details](#a-smaller-model-with-rules)).
- **Asks first** - no rule, config change, doc edit, hook or baseline is written without your yes.

## Quick Start

In Claude Code:

```bash
claude plugin marketplace add clirimajeti/codemyrules
claude plugin install codemyrules@codemyrules
```

This also installs the two sub-skills codemyrules drives, [`eslint-pattern-rules`](https://github.com/clirimajeti/eslint-pattern-rules) and [`backend-pattern-rules`](https://github.com/clirimajeti/backend-pattern-rules), as dependencies.

The feedback loop's hooks ship as the [`codemyrules`](https://www.npmjs.com/package/codemyrules) npm package.
The skill installs it when you set up the loop, or install it yourself:

```bash
npm install -g codemyrules
```

Then ask in your own words.
The skill is model-invoked, so there is no command to remember:

- "Turn our ADRs and AGENTS.md into lint rules."
- "Our CLAUDE.md is too long. Which of it could a linter enforce instead?"
- "Set up lint feedback for agents in this repo."

<details>
<summary><strong>pi</strong></summary>

```bash
npx skills add clirimajeti/codemyrules -a pi
npx skills add clirimajeti/eslint-pattern-rules -a pi
npx skills add clirimajeti/backend-pattern-rules -a pi
```

Then ask in your own words, as above.
The skill installs the feedback loop as a pi extension in `.pi/extensions/`.
pi loads it only in a trusted project: run `/trust` once, or start pi with `-a`.

</details>

<details>
<summary><strong>opencode</strong></summary>

```bash
npx skills add clirimajeti/codemyrules -a opencode
npx skills add clirimajeti/eslint-pattern-rules -a opencode
npx skills add clirimajeti/backend-pattern-rules -a opencode
```

Then ask in your own words, as above.
The skill installs the feedback loop as an opencode plugin in `.opencode/plugins/`; it needs opencode 2.

</details>

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

```bash
npx skills add clirimajeti/codemyrules -a github-copilot
npx skills add clirimajeti/eslint-pattern-rules -a github-copilot
npx skills add clirimajeti/backend-pattern-rules -a github-copilot
```

Then ask in your own words, as above.
The skill installs the feedback loop as Copilot CLI hooks in `.github/hooks/codemyrules.json`.
Copilot runs repository hooks only in a trusted folder: trust the project when Copilot asks, or add it to `trustedFolders` in `~/.copilot/config.json`.

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

```bash
npx skills add clirimajeti/codemyrules -a gemini-cli
npx skills add clirimajeti/eslint-pattern-rules -a gemini-cli
npx skills add clirimajeti/backend-pattern-rules -a gemini-cli
```

Then ask in your own words, as above.
The skill installs the feedback loop as Gemini CLI hooks in `.gemini/settings.json`.
Gemini runs project hooks only in a trusted folder: trust the project when Gemini asks.

</details>

<details>
<summary><strong>Codex, Cursor and others</strong></summary>

```bash
npx skills add clirimajeti/codemyrules
npx skills add clirimajeti/eslint-pattern-rules
npx skills add clirimajeti/backend-pattern-rules
```

The rules and the doc cleanup work in every harness.
The feedback loop runs only in Claude Code, pi, opencode, the GitHub Copilot CLI and the Gemini CLI, see [Harness support](#harness-support).

</details>

<details>
<summary><strong>npm (the feedback loop only)</strong></summary>

The [`codemyrules`](https://www.npmjs.com/package/codemyrules) npm package holds the feedback loop's hooks and its CLI, without the skill.
The skill installs it for you when you set up the loop, but you can also install it yourself and set up the loop by hand:

```bash
npm install -g codemyrules
codemyrules install . --config loop.json           # dry run: shows the plan and the harness it picked
codemyrules install . --config loop.json --apply   # installs it
```

Without `--harness`, the installer picks the harness the project is set up for: `.claude/` gives Claude Code hooks, `.pi/` a pi extension, `.opencode/` or `opencode.json` an opencode plugin, `.github/hooks/` or `.github/copilot-instructions.md` Copilot CLI hooks, `.gemini/` or `GEMINI.md` Gemini CLI hooks.
A `.claude/` folder that holds only codemyrules' own setup does not count.
With none of them it installs for Claude Code, and with more than one it asks you to choose: `--harness claude`, `pi`, `opencode`, `copilot`, `gemini`, or a comma-separated list such as `claude,pi` for several.

`loop.json` names your linters per tier and the files the guard protects:

```json
{
  "linters": [
    { "name": "eslint", "format": "eslint", "tier": "full", "extensions": [".ts", ".tsx"],
      "command": ["node_modules/.bin/eslint", "--format", "json", "{files}"] }
  ],
  "protect": ["**/eslint.config.*", "eslint-rules/**"]
}
```

The installer checks the config and refuses a broken one before it writes anything.
Formats are `eslint`, `oxlint`, `ast-grep`, `ruff` and `psscriptanalyzer` (PowerShell 7, full tier only), and the tiers are `fast` (after every edit) and `full` (at the end of each turn); step 5 of [`SKILL.md`](skills/codemyrules/SKILL.md) has every option.
It needs Node 22 or later and Claude Code, pi, opencode 2, the GitHub Copilot CLI or the Gemini CLI.

</details>

<details>
<summary><strong>Manual</strong></summary>

Copy `skills/codemyrules/` into your agent's skills folder, for example `~/.claude/skills/codemyrules/`, next to the two sub-skills.
When a sub-skill is not installed, the skill asks for the path to its `SKILL.md`.

</details>

## Example

A decision record says:

> We inject `java.time.Clock`. Production code calls `Instant.now(clock)`, never a bare `Instant.now()`.

codemyrules offers it as a candidate labelled `documented, not enforced`, and on your yes writes an ast-grep rule with tests:

```yaml
id: use-clock-injection
language: Kotlin
severity: error
message: $T.now() without a clock (ADR 0043). Use $T.now(clock) instead.
rule:
  pattern: $T.now()
constraints:
  T: { regex: '^(Instant|LocalDate|LocalDateTime|ZonedDateTime|OffsetDateTime)$' }
```

The agent-doc line that said the same thing becomes a one-line pointer in the folder's `CLAUDE.md`.
When the agent then writes `Instant.now()`, the feedback loop tells it within seconds:

```
src/main/kotlin/mail/MailSender.kt:42 use-clock-injection Instant.now() without a clock (ADR 0043). Use Instant.now(clock) instead.
```

## Why Rules Instead of Prose

The defaults come from an experiment: 124 headless Claude Code sessions on two isolated copies of a real Kotlin/Spring backend.
It compared a rule written as prose with the same rule as a lint rule plus the feedback loop.
The tested rule was design-shaping (time through an injected `Clock`); a second, mechanical rule (lowercase log messages) was tested alongside.

| Setup | Runs left with the rule broken | Cost per task, including a review fix |
|---|---|---|
| Prose in a linked instructions file | most runs (Sonnet 8 of 8, Haiku 5 of 8) | baseline |
| Rule only, prose deleted | 0 | higher: the agent writes the wrong shape first and reworks it |
| Rule plus a one-line pointer in the folder's `CLAUDE.md` | 0 | about 22% lower, with a third fewer turns |
| Prose always loaded (root `AGENTS.md`), same batch as the row below | 0 of 12 | baseline for this comparison |
| Rule plus pointer, the rest of that prose kept | 0 of 12 | about the same (+6%, inside the spread) |

- The first draft with the rule costs more, because it writes the correct code; the saving comes from never needing a fix round.
- The mechanical rule was never broken, even with its prose deleted.
- Prose repeated the same break in every follow-up session, copying its own earlier code.
- Prose the agent always loads is followed too: there the rule adds a guarantee at no measurable cost, and every always-loaded line it lets you delete saves about $0.009 per 1,000 tokens per Sonnet session.
- So the token saving comes from slimmer always-loaded docs and from avoided fix rounds where prose is not seen, not from rules making a session cheaper by themselves.
- Limits: one module, two rules, 8-12 runs per setup with a wide spread, and an idealised review.

So codemyrules recommends: for a mechanical rule, the rule only; for a design-shaping rule, the rule plus a one-line pointer in the folder-level `CLAUDE.md`.

### A smaller model with rules

The benchmark also shows what rules do for a smaller model.
We combined 592 runs from seven studies on three open-source projects in TypeScript, Python and Java.
Haiku had the rules and the feedback loop.
Sonnet had the same conventions as prose, or no conventions.

| Setup | Runs that broke a convention | Cost per run, including a review fix | Build and tests pass |
|---|---|---|---|
| Haiku with rules | 0 of 104 | $0.015 | 91% |
| Sonnet without rules | 41 of 192 (21%) | $0.146 | 98% |

- With rules, Haiku follows the team's conventions better than Sonnet without rules, for about one tenth of the cost.
- Rules do not prevent functional errors.
  Haiku made more type and compile errors than Sonnet (91% against 98%), with or without rules.
- In these studies, the agent could not run the tests.
  In a later study, the agent could run the tests, and Haiku passed the build and the tests in 16 of 16 runs.
- Haiku was slower: 54 seconds per run against 36 seconds.
- Limits: we combined the studies after we saw the data, and we selected the tasks to test conventions.
  Thus, this result is exploratory.

The method, the harness to rerun it on your own repo, and related work are in [agent-rules-bench](https://github.com/clirimajeti/agent-rules-bench).

## How It Works

The [flowchart](#flowchart) at the end shows the same steps.

1. **Detects your stacks** and maps each source root to its sub-skill.
2. **Discovers candidates** through each sub-skill: your code's majority patterns, your decision records, the rules written as prose in your agent docs, and well-known rules your linters have but you don't use yet.
   A doc line the code no longer follows is raised as a question: update the doc to match the code, or enforce the doc.
3. **Selects the rules** after one first question: automatic or manual.
   Automatic builds every recommended rule and asks only for doc changes, doc-vs-code contradictions and high-risk rules.
   Manual shows every candidate in one selection, recommended ones marked, and builds only what you pick.
4. **Builds each pick** through the sub-skill that owns its stack: design questions, the rule and its tests, verification on your real code.
   It first checks which tools the project already uses, and writes the rule there, in their style: ESLint, detekt, Ruff, PSScriptAnalyzer, or an existing ArchUnit or Konsist test class; ast-grep only when none of them fits.
   Then, for each line in your agent docs the new rule enforces, you choose to delete it, shorten it to a pointer, or keep it.
   A pointer you keep can move to a `CLAUDE.md` in the folder it applies to, so it loads only when the agent works there.
5. **Sets up the feedback loop**: automatic mode installs it, manual mode asks first after showing exactly what it installs.
6. **Records a baseline**: agent-doc tokens, rules and open hits, so a later run can show what changed.
7. **Reports** the rules, doc lines removed, the loop and the baseline, and on a re-run the before and after.

A rule your existing code already breaks goes into a suggestions layer (`eslint.config.suggestions.mjs`, `sgconfig.suggestions.yml`).
CI stays green, and the feedback loop still applies the rule to new code, so the agent stops copying the old pattern.

### What it reads

| Source | Where |
|---|---|
| Decision records | `docs/adr/`, `docs/decisions/`, `notes/decisions/`, `ADR-*.md`, `CONTRIBUTING` |
| Agent docs | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/`, `.cursor/rules/`, `.cursorrules`, `.windsurfrules` |
| Docs linked from agent docs | `@file` imports and Markdown links to repo files, followed through linked files too (an `index.md` and the topic files it links) |
| Code | majority patterns, and code that goes around the project's own helpers |

## The Feedback Loop

Three tiers, each silent when clean:

| Tier | When | What runs |
|---|---|---|
| Fast | after every edit | ast-grep, oxlint, and ESLint through `eslint_d` when you have it, on the edited file |
| Full | at the end of each turn | all configured linters on the files the agent edited in this turn |
| Safety net | CI | your own lint run, including slow JVM tools like detekt |

- **Only new code blocks.**
  Only errors on lines changed since `HEAD` block, so the agent never fixes unrelated legacy code.
  The loop runs the suggestions layer, so rules the old code breaks still guard new code; warnings never block.
- **Rules cannot be quietly weakened.**
  A guard asks you before any edit that adds or moves an ignore comment or changes a lint config, rule file or baseline.
  A change made through `Bash` or `NotebookEdit` cannot be asked about first, so it is checked right after, and the agent is told to undo it or ask you.
- **Private.**
  The hooks go into `.claude/settings.local.json` (in pi, the extension into `.pi/extensions/codemyrules.js`; in opencode, the plugin into `.opencode/plugins/codemyrules.js`; in the Copilot CLI, the hooks into `.github/hooks/codemyrules.json`; in the Gemini CLI, the hooks into `.gemini/settings.json`), the config into `.claude/codemyrules/`, and all of them into `.git/info/exclude`.
  No tracked file changes.
  Sharing it with your team is a later, separate step.
- **Pinned per project.**
  The installer copies the globally installed [`codemyrules`](https://www.npmjs.com/package/codemyrules) npm package into `.claude/codemyrules/pkg/` and records its version and sha256 in `pin.json`, and the hooks run that copy.
  `npm update -g codemyrules` changes no project: a new release runs in a project only after `codemyrules install . --apply` there, whose dry run shows the version change first.
  A bad or compromised release therefore never reaches your projects on its own.

`codemyrules status .` shows what is installed and what failed lately; `codemyrules uninstall . --apply` removes it again (dry run without `--apply`).
[`references/feedback-loop.md`](skills/codemyrules/references/feedback-loop.md) has the details.

## Harness Support

| | Rules and doc cleanup | Feedback loop |
|---|---|---|
| Claude Code | yes | yes, through hooks |
| [pi](https://github.com/earendil-works/pi-coding-agent) | yes | yes, through a project extension (`codemyrules install . --harness pi --apply`) |
| [opencode](https://opencode.ai) 2 | yes | yes, through a project plugin (`codemyrules install . --harness opencode --apply`) |
| [GitHub Copilot CLI](https://github.com/github/copilot-cli) | yes | yes, through project hooks (`codemyrules install . --harness copilot --apply`) |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | yes | yes, through project hooks (`codemyrules install . --harness gemini --apply`) |
| Codex, Cursor and others | yes | not yet |

In pi the guard asks through pi's own confirm dialog; in print or JSON mode, with nobody to ask, a flagged edit is refused.
pi loads project extensions only in a trusted project (`/trust`, or `-a` for one run).
In opencode the guard asks through opencode's own permission prompt; in `opencode run`, with nobody to ask, a flagged edit is refused, and `--auto` approves it like any other question.
In the Copilot CLI the guard asks through Copilot's own permission prompt; in autopilot mode and in the Copilot cloud agent, with nobody to ask, Copilot refuses a flagged edit.
The hooks file is git-excluded, so the Copilot cloud agent does not run the loop.
The Copilot CLI skips repository hooks in a folder that is not trusted, and then says so in a warning.
In the Gemini CLI the guard asks through Gemini's own approval prompt, also in YOLO mode.
Gemini documents no `ask` decision for hooks yet, so this relies on behavior that can change (google-gemini/gemini-cli#28046).
In `gemini -p`, with nobody to ask, Gemini refuses a flagged edit.
But Gemini CLI 0.70 then does not stop, because of a bug in Gemini, not in codemyrules: any hook that asks causes this.
So when you run `gemini -p` in a script or in CI, give it a time limit.
Gemini runs project hooks only in a trusted folder, and reads project settings only from the folder where you start it.
The hooks use the absolute path of the project, so after you move the project, run the install again.
The install stops if `.gemini/settings.json` is tracked by git, has comments or is not valid JSON.
We tested this support with Gemini CLI 0.70.0 on macOS.
We did not test it on Windows.
Support for Codex and other harnesses is in progress.
If your harness has hooks or a plugin API and you want it supported, open an issue.

## What It Leaves Alone

- **Anything you have not approved**: no rule, config change, doc edit, hook or baseline is written without your yes; choosing automatic mode is that yes for the recommended rules, the loop and the baseline, never for a doc edit.
- **Build files and lockfiles**, as in both sub-skills.
- **Your agent docs**, except the lines you approve deleting, shortening or moving.

## Development

```
skills/codemyrules/
├── SKILL.md                    # the workflow
├── agents/openai.yaml          # Codex picker metadata
├── references/
│   └── feedback-loop.md        # tiers, what blocks, the guard, the log, uninstall
└── scripts/
    ├── cli.mjs                 # the `codemyrules` command of the npm package: hooks, install, measure
    ├── install.mjs             # installs the loop in a project (dry run by default)
    ├── measure.mjs             # baseline and before/after report
    ├── core/                   # harness-neutral: checks, snapshot, lint loop, git and linter helpers
    ├── guard.mjs               # Claude Code adapter: PreToolUse hook on edits
    ├── shell-guard.mjs         # Claude Code adapter: Pre- and PostToolUse hook on Bash and NotebookEdit
    ├── lint-edited.mjs         # Claude Code adapter: PostToolUse hook, fast tier
    ├── lint-turn.mjs           # Claude Code adapter: Stop hook, all tiers
    ├── pi.mjs                  # pi adapter: extension with the guard, shell guard and both tiers
    ├── opencode.mjs            # opencode adapter: plugin with the guard, shell guard and both tiers
    ├── copilot.mjs             # GitHub Copilot CLI adapter: hooks with the guard, shell guard and both tiers
    ├── gemini.mjs              # Gemini CLI adapter: hooks with the guard, shell guard and both tiers
    └── test/                   # node:test suites, and release-check.mjs
evals/                          # claude plugin eval cases for the skill
scripts/eval.sh                 # runs them, with the two sub-skill plugins staged next to it
```

Run the tests with `npm test`.
Before a release, `npm run release-check` packs the package, installs it into a throwaway npm prefix and drives a few headless Claude Code sessions (Haiku) against it in a throwaway repo; it needs `claude` logged in and takes about a minute.
To run the hooks from a working copy, run `npm link` in the repository root: the global `codemyrules` command then points at it, and a reinstall in a test project pins a copy of it (reinstall after each change).
`npm run eval` runs the skill's eval cases with `claude plugin eval` (pass `-- --runs 3` and the like through); it copies the two sibling sub-skill checkouts into `.eval-deps/` first, because an eval loads no other plugins.
A release bumps the version in `package.json`, `.claude-plugin/plugin.json` and `SKILL.md` (a test checks they match) and pushes that commit.
Once the test workflow is green on Linux, macOS and Windows, `npm publish` follows (it runs `npm test` first and stops when a test fails), and then the tag: `git tag v<version> && git push origin v<version>`.
For the minute between the push and the publish the skill names a version that npm does not have yet.

## Flowchart

```mermaid
flowchart TD
  A["Your agent docs, decisions<br/>and existing code patterns"] --> B["1-2. Find the rules"]
  B --> C{"Does the code<br/>follow the docs?"}
  C -- "no" --> D["You choose: fix the doc<br/>or enforce it"]
  C -- "yes" --> E
  D --> E["3. Automatic or you pick"]
  E --> F["4. Write each rule with tests, in the tools<br/>you already use (ESLint, detekt, ArchUnit, ...)"]
  F --> F2["Slim the agent docs"]
  F2 --> G["5. Feedback loop: the agent sees<br/>a broken rule while it codes"]
  G --> H["6-7. Baseline and report"]
```

## Related

- [eslint-pattern-rules](https://github.com/clirimajeti/eslint-pattern-rules) - the frontend sub-skill.
- [backend-pattern-rules](https://github.com/clirimajeti/backend-pattern-rules) - the backend sub-skill.
- [agent-rules-bench](https://github.com/clirimajeti/agent-rules-bench) - the benchmark behind the defaults.

## License

[MIT](LICENSE)
