---
name: codemyrules
description: Turn a project's decisions, coding patterns and agent-doc instructions into lint rules across its whole stack, slim the CLAUDE.md / AGENTS.md / instructions files those rules now cover, and set up a private, silent lint feedback loop for Claude Code. Routes JS/TS/Vue/Svelte to eslint-pattern-rules and Java, Kotlin, Python, Go, C#, PHP, Rust and Ruby to backend-pattern-rules, merges their candidates into one selection, and builds what the user picks. Use when the user wants to turn their decisions, patterns or agent docs into rules, slim or shrink CLAUDE.md or AGENTS.md, set up lint feedback for agents, or names codemyrules. Not for fixing existing lint errors or tuning an off-the-shelf linter config.
version: "0.5.0"
metadata:
  author: clirimajeti <clirimajeti@gmail.com>
  tags: [lint, agent-docs, claude-md, hooks, code-quality]
---

# codemyrules

Every prose rule in CLAUDE.md, AGENTS.md or an instructions file is read in every agent session, whether the task needs it or not, and the agent can still ignore it.
A lint rule costs nothing until it is broken, and then it says exactly what is wrong.
This skill turns a project's conventions into rules, slims the agent docs those rules now cover, and sets up a feedback loop so the agent meets the rules while it codes.

It is a manager over two skills and does not repeat their work:
- `eslint-pattern-rules`: JavaScript, TypeScript, Vue, Svelte, including Node backends.
- `backend-pattern-rules`: Java, Kotlin, Python, Go, C#, PHP, Rust, Ruby and other languages ast-grep parses.

Invoke each with the Skill tool when it is installed.
Otherwise ask the user for the path to its `SKILL.md`, read it, and follow it from there, with its `references/` beside it.
Both have the same steps (1 detect, 2 pick, 3 design, 4 write, 5 verify, 6 agent-doc cleanup, 7 report), the same coverage labels and the same report shape.

Nothing is written to the project without the user's approval: no rule, config change, doc edit, hook or baseline.
The mode question below is that approval for everything automatic mode builds.
The sub-skills ask the same mode question; hand them the answer from step 0 so it is asked once.

## 0. Mode

Before anything else, ask one single-select `AskUserQuestion` (header `Mode`):
- **Automatic (Recommended)**: build every recommended candidate (step 3), install the feedback loop and write the baseline without asking.
  Ask only at the critical points: a change to an agent doc or decision record, a contradiction between doc and code, and a `high` risk candidate.
- **Manual**: pick the rules yourself from one selection with the recommended ones marked, and approve each later step.

When the user already said which mode in the request, skip the question.
When the user said to go ahead with your recommendations, that is automatic.
With nobody to answer and no such word, use manual and build nothing that needs a pick.

## 1. Detect the stacks

Look these up rather than asking:
- **JS/TS**: `package.json`, `tsconfig.json`, `.vue`, `.svelte`, `.ts`, `.js` sources, and where they live (`frontend/`, `apps/web/`, the root).
  Goes to `eslint-pattern-rules`.
- **Other backend languages**: `pom.xml`, `build.gradle(.kts)`, `pyproject.toml`, `go.mod`, `*.csproj`, `composer.json`, `Cargo.toml`, `Gemfile`.
  Goes to `backend-pattern-rules`.
- **Generated code**: generator markers such as `.yo-rc.json`, `.jhipster/`, `.openapi-generator/`, `@Generated`, or `DO NOT EDIT` headers.
  Note which source folders a generator owns: a rule still guards new code there, but existing hits are fixed in the generator's template or blueprint, and hand edits are lost on the next run.
- **Shared context, detected once here**: agent docs (always loaded or on demand), decision records, and the CI steps that run lint.
  Hand them to both sub-skills in step 2 instead of letting each detect them again.
- **A previous run**: `.claude/codemyrules/baseline.json`.
  When it exists, run `node <skill-dir>/scripts/measure.mjs report <project-dir>` now, for step 7.

Count with `rg -c` and `rg --files`, always with a path (with several `-g` globs the last matching one wins, so put exclusions like `-g '!*.spec.ts'` after the includes), and leave out vendored and generated folders (`node_modules/`, `dist/`, `build/`, `target/`).
A repository with both stacks: note each stack's root folder, so every candidate has one owner.

Done when every source root has its sub-skill, or the user knows which one has none.

## 2. Discover

Run each matched sub-skill's step 1 and its discovery (its step 2, through `references/discovery.md`) up to and including the labelling, unchanged except that the shared context from step 1 here is reused, not detected again.
Stop before its selection dialog: step 3 here selects once for both.
When the user named one convention, run only the sub-skill that owns its stack, and its step 2 as written.

Keep from each sub-skill, for steps 3 to 6:
- every candidate with its label, risk, flagged files, why-sentence and evidence
- the lint config files, rule folders and baseline files its step 1 found
- the lint tools the project runs and how (the command, a pinned version, a CI step)
- the agent docs and the lines that state each candidate's convention

Done when each sub-skill has labelled its candidates.

## 3. One selection

Merge every candidate from both sub-skills into one list: project candidates, `built, not enabled`, `switched off` and general ones together, never split by family (no separate call for general, bug-prevention or style rules).
Order it by the sub-skills' rules: coverage (`documented, not enforced` and `built, not enabled` first), then always-loaded agent-doc lines before on-demand ones, then risk, then fewest flagged files; general and `switched off` candidates after the project ones.
An agent-doc rule the agent does not load today (a linked file, a folder doc outside where it works) is where a rule changes the most, and an always-loaded line is where deleting prose saves context in every session.

**Recommended** is every candidate whose risk is below `high`, except `switched off` ones (someone decided against them) and general ones with no hits and no tool the project already runs for them.
`covered` candidates appear only as notes, and `contradicted` ones only as their question.

**Automatic mode:**
- Build every recommended candidate without asking, and name each in one line with its reason ("low risk, 1 file").
- Ask in one `AskUserQuestion` call, and only when there is something to ask: each contradiction as a single-select ("update the doc to match the code" or "enforce the doc"), and the `high` risk candidates as one multi-select ("These rules are high risk, which should I build?").
- Everything not recommended and not asked goes to the report as not built.

**Manual mode:**
- One `AskUserQuestion` call with every candidate, `multiSelect: true`, up to 4 options per question and 4 questions per call.
  Fill the questions in list order, frontend and backend in separate questions, each naming its side ("Which of these frontend rules should I build?").
  Put `(Recommended)` at the end of each recommended option's label.
  Each option's description is the why-sentence plus the flagged files and the risk; a general rule also names its standard value.
- Contradictions are single-select questions in the same call, ahead of the rest.
- Past 16 options in one call, offer the recommended ones first and list the rest in the report.

Without the tool, list the candidates in chat, recommended ones marked, and ask for names.
In manual mode, build nothing until the user answers.

Done when every candidate is built, picked, not picked, asked, or a note.

## 4. Build

Hand each picked candidate to the sub-skill that owns its stack and follow that sub-skill's steps 3 to 6 for it: design, write, verify, agent-doc cleanup.
A `built, not enabled` or general candidate is a config change, as the sub-skill describes.
In automatic mode, answer the sub-skill's design questions with its recommended default, unless the answer changes a doc, and list each answer for step 7.
Note each rule's open hits on the real code from its verify step, and its layer (main config or suggestions layer), for steps 5 and 6.
A rule the existing code breaks goes into the sub-skill's suggestions layer at `error`, never into the main config at `warning`: at `warning` the loop would never show it, and these are the rules agents break by copying nearby code.

The agent-doc cleanup always asks, in both modes: it changes a doc.
In automatic mode, ask all doc edits from every picked candidate in one `AskUserQuestion` call after the builds, not one call per rule.
In the agent-doc cleanup, when the user keeps a one-line pointer, propose where it goes in the same question: a `CLAUDE.md` in the folder the rule applies to, or an instructions file with an `applyTo` glob such as `.github/instructions/domain.instructions.md`, rather than the root doc.
Then the pointer loads only when the agent works in that folder.
Offer the root doc as the other option when the rule applies to the whole repo.

Done when every picked candidate is built and verified, or reported as not built with the reason.

## 5. Offer the feedback loop

The loop runs the project's lint setup in Claude Code hooks: a guard before each edit and around each shell command, a fast check after each edit, and a full check at the end of each turn.
It is private (`.claude/settings.local.json` and `.git/info/exclude`) and silent when clean.
[`references/feedback-loop.md`](references/feedback-loop.md) explains it; read it before offering.
Offer it only when you are running in Claude Code.
In any other harness, skip this step and the baseline, and say in the report that the feedback loop needs Claude Code hooks and is not available here.

Draft the config in a temporary file outside the project, as `loop.json`:

```json
{
  "linters": [
    { "name": "ast-grep", "format": "ast-grep", "command": ["node_modules/.bin/ast-grep", "scan", "-c", "sgconfig.suggestions.yml", "--json=compact", "{files}"], "extensions": [".kt", ".java"], "tier": "fast" },
    { "name": "eslint", "format": "eslint", "command": ["node_modules/.bin/eslint", "-c", "eslint.config.suggestions.mjs", "--format", "json", "{files}"], "extensions": [".ts", ".vue"], "tier": "full" },
    { "name": "ruff", "format": "ruff", "command": ["ruff", "check", "--output-format=json", "{files}"], "extensions": [".py"], "tier": "full" }
  ],
  "protect": ["**/eslint.config.*", "**/.eslintrc*", "sgconfig*.yml", "ast-grep/**", "eslint-rules/**", "**/detekt-baseline.xml"]
}
```

- **Fast tier**: ast-grep only when the project has an `sgconfig.yml` (or the command passes `-c <path>` to one), run the way the project runs it; without one every scan fails, so leave ast-grep out, and the installer refuses such a config; ESLint only through `eslint_d` when the project has it (`["eslint_d", "--format", "json", "{files}"]`).
  Only an installed binary: `node_modules/.bin/ast-grep` or `ast-grep` on `PATH`.
  A package runner (`npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx`) resolves the package on every edit, about 0.4 s warm and seconds or a download cold, and a run past the time budget counts as clean, so the installer refuses one in the fast tier.
- **Full tier**: ESLint, ast-grep and Ruff, each only when the project runs it; ast-grep here when the project runs it only through a package runner.
  Through `npx`, name the package `@ast-grep/cli` with `-p` and pin the version the project uses: `npx ast-grep` alone resolves an unrelated npm package.
  The end-of-turn check runs both tiers, so list each linter once, in the fastest tier it qualifies for.
- **Never**: Gradle detekt, Error Prone, or any tool that starts a JVM build; those stay in CI.
- **Suggestions layer**: when a sub-skill built one, the loop runs it instead of the main config (`-c eslint.config.suggestions.mjs`, `-c sgconfig.suggestions.yml`, as in the example), so rules the existing code breaks still guard every changed line; without one, drop the `-c`.
- `command` is the project's own invocation with JSON output, and `"{files}"` is its own element.
  `extensions` are the file types that linter covers in this project.
- `protect`: paths relative to the project root for every file that decides what counts as a violation: lint configs (`eslint.config.*` including the suggestions config, `.eslintrc*`, `sgconfig*.yml`, `detekt*.yml`, `ruff.toml`, `checkstyle.xml`, `.golangci.yml`), rule folders (`eslint-rules/**`, `ast-grep/**`, the project's own rule-set module), baseline files, and architecture tests (`*Arch*Test*`, `*TechnicalStructure*`).
  Leave out shared build files such as `package.json`, `pom.xml` or `pyproject.toml`, where an ask on every edit would be noise: the guard already asks for edits to the lint settings inside `package.json`, `pyproject.toml`, `setup.cfg` and `tox.ini`; mention in the report that lint settings inside other build files, such as plugin config in `pom.xml` or `build.gradle`, are not guarded.
  `.claude/codemyrules/` and `.claude/settings.local.json` are always guarded.

The installer validates the config (formats, tiers, `command` as a list with `"{files}"`, every `-c` or `--config` path existing, the command's tool installed (on `PATH`, or a path in the project), `protect` as a list) and refuses a broken one with a message per field, before it writes anything.
The hooks run the `codemyrules` npm package, installed globally, so one `npm update -g codemyrules` updates every project; nothing is copied into the project.
Check it with `codemyrules --version`: when it is missing or older than this skill's `version`, the plan starts with `npm install -g codemyrules@<this skill's version>`, approved together with the loop, and run before the installer.
Run the installer as a dry run and show its plan:

```bash
node <skill-dir>/scripts/install.mjs <project-dir> --config <tmp>/loop.json
```

In automatic mode, run the same command with `--apply` and put the plan in the report.
In manual mode, ask one `AskUserQuestion`: install the loop as planned, or skip it.
Show the hook config, the files it creates and the `.git/info/exclude` lines in the question or its `preview`.
On a yes, run the same command with `--apply`.
With nobody to answer, do not install, and put the plan in the report.

Done when the loop is installed or declined.

## 6. Baseline

Only when the loop was installed: write the open hits per rule from step 4 to a temporary JSON file, `{"local/gen-no-direct-fetch": 4, "gen-no-clock-in-domain": 0}`, and run:

```bash
node <skill-dir>/scripts/measure.mjs baseline <project-dir> --rules <tmp>/rules.json
```

Rules are keyed by their linter rule id; when two picked conventions share one (two `no-restricted-syntax` entries), they are counted together, so say so in the report or build one of them as a named custom rule.
It records the agent-doc tokens (characters / 4), split into always-loaded docs (root `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, the files they import with `@path`, and the root Copilot, Cursor and Windsurf files) and on-demand docs (folder agent docs, plus the Markdown files any agent doc links to, one level deep), plus the rules and their open hits, in `.claude/codemyrules/baseline.json`.
A later run of this skill compares against it.

Done when `baseline.json` exists, or the loop was not installed.

## 7. Report

Keep it short, frontend and backend apart:
- the sub-skills' report items: each rule with its hit count, layer (main or suggestions) and a few hits, the config changes as short diffs, install commands, agent-doc lines deleted, shortened or kept with the doc tokens removed (always-loaded and on-demand apart), general rules not picked, conventions not built, and the scan logs
- where each kept pointer went
- the feedback loop: installed (the linters per tier and the protected paths) or not (the plan and how to install it later)
- the baseline: always-loaded and on-demand doc tokens, rule count, open hits; the always-loaded number is the context every session pays for, so report it as tokens per session rather than as a one-off saving
- on a re-run, the output of `measure.mjs report`: always-loaded and on-demand doc tokens then and now, and per rule its open hits at baseline and the failures logged since

A rule that fails often in the log is a sign it needs an up-front pointer: say so.
Present the benefit honestly: the doc tokens removed matter only for always-loaded lines; the larger effect is fewer fix rounds, which shows up in the failure log and in review, not in the character count.
Close with the sub-skills' step 7 round for any design questions answered on the user's behalf.
