# Example run: shop-web

This folder holds the output of one real codemyrules run on the sample project [`evals/claude-md-to-rules/files/shop-web`](../../evals/claude-md-to-rules/files/shop-web).
shop-web is a small React and TypeScript app with ESLint 9 and a three-line `CLAUDE.md`.

## The run

- Request: "Our CLAUDE.md in shop-web keeps growing. Turn whatever a linter can enforce into lint rules, slim the CLAUDE.md, and set up the lint feedback loop for Claude Code. Go ahead with your recommendations."
- Agent: Claude Code with Claude Opus 5.5, on 2026-11-28.
- Skills: codemyrules 0.9.2 and eslint-pattern-rules 0.3.0, the versions on `main`.
- Mode: automatic.
  The run was headless, so the questions that automatic mode still asks were answered in advance: build no high-risk rule, enforce the doc when the code contradicts it, apply the recommended `CLAUDE.md` edit, and install the loop.
  The report lists where each answer was used.
- One change after the run: the test machine had codemyrules 0.8.0 installed globally, so the first install pinned 0.8.0.
  The loop was installed again with the same `loop.json` and the 0.9.2 CLI, so the hooks run 0.9.2.

## The result

| | Before | After |
|---|---|---|
| Always-loaded agent-doc tokens per session | 70 | 35 |
| Lint rules for the `CLAUDE.md` storage line | none | 2, in a suggestions layer, 2 open hits |
| General rules (clean code, bug prevention, security) | `typescript-eslint` recommended | 21 more core rules and a check for focused tests, 0 hits |
| Feedback loop | none | Claude Code hooks, private to this clone |

- The `CLAUDE.md` line "Browser storage only through `src/shared/storage.ts`" became two built-in ESLint rules, `no-restricted-globals` and `no-restricted-properties`.
  The rule message names the helper functions, so the line was deleted from `CLAUDE.md`.
- The skill used built-in rules because they can express this convention with a message.
  So there is no custom rule and no RuleTester test in this run.
  The skill checked the edge cases with `eslint --stdin` instead; the report lists them.
- The two existing files that break the rule are in a suggestions layer at `error`, so CI stays green and the loop blocks new breaks.
- The lines about the order lifecycle and pnpm stayed in `CLAUDE.md`, because a linter cannot check them.

## Files

- [`report.md`](report.md): the skill's final report, as the user sees it, with the token numbers, each rule and its hits, the config diffs, the loop install plan and the baseline.
- [`project.diff`](project.diff): every change to tracked project files: `CLAUDE.md`, `eslint.config.js` and the new `eslint.config.suggestions.mjs`.
- [`loop/`](loop): the feedback loop's files, which the project keeps out of git through `.git/info/exclude`:
  - `settings.local.json`: the Claude Code hooks, in `.claude/settings.local.json` in the project.
  - `loop.json`: the linters per tier and the protected files, in `.claude/codemyrules/loop.json`.
  - `baseline.json`: the doc tokens and open hits per rule at install, in `.claude/codemyrules/baseline.json`.
  - `pin.json`: the version and hash of the pinned package copy in `.claude/codemyrules/pkg/`, which is not in this folder.
