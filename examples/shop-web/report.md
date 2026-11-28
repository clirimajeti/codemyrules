# codemyrules report: shop-web

Mode: automatic.
Stack: one frontend, React + TypeScript under `src/`, ESLint 9.39.0 with flat config (`eslint.config.js`, `typescript-eslint` recommended), vitest, no test files yet.
No backend language, no generated code, no decision records, no CI lint step.
Agent docs: the root `CLAUDE.md` only (always loaded).
backend-pattern-rules was not needed.

## Agent-doc tokens

| | Before | After |
|---|---|---|
| Always loaded (`CLAUDE.md`) | 70 tokens (279 chars) | 35 tokens (140 chars) |
| On demand | 0 | 0 |

That is 35 tokens less in every session.
The bigger gain is not the token count: an agent that writes `localStorage` directly now gets the rule's message on that line, in the same turn, instead of a reviewer finding it later.

## Frontend rules built

| Rule | Convention | Open hits | Layer |
|---|---|---|---|
| `no-restricted-globals` (`localStorage`, `sessionStorage`) | Browser storage only through `src/shared/storage.ts` (`CLAUDE.md` line 5) | 1 | suggestions |
| `no-restricted-properties` (`window` / `globalThis` / `self` `.localStorage` / `.sessionStorage`) | same convention | 1 | suggestions |
| `no-restricted-properties` (`it.only`, `describe.only`, `test.only`) | no focused tests | 0 | main |
| `complexity` 10, `max-depth` 4, `max-lines-per-function` 50, `max-params` 3, `max-lines` 400 | clean-code limits (standard values) | 0 each | main |
| `no-nested-ternary`, `no-else-return`, `no-console`, `no-debugger`, `eqeqeq` | clean code, no leftover debug output | 0 each | main |
| `no-fallthrough`, `no-unreachable-loop`, `no-self-compare`, `no-constant-binary-expression`, `no-constant-condition`, `array-callback-return`, `no-unsafe-optional-chaining` | bug prevention | 0 each | main |
| `no-eval`, `no-implied-eval`, `no-new-func`, `no-script-url` | security basics | 0 each | main |

Why each was built without asking:
- Storage through `src/shared/storage.ts`: documented, not enforced, always-loaded line, low risk (pure AST, no fix), 2 files.
  The code mostly bypasses the helper (2 files call storage directly, 1 uses the helper), so it was a contradiction; the answer was "enforce the doc".
- Every general rule above: low risk, 0 hits, and the project already runs ESLint for it.

Hits of the storage rule (suggestions layer):

```
src/features/cart/CartBadge.tsx
  2:24  error  Unexpected use of 'localStorage'. Use readSetting/writeSetting from src/shared/storage.ts instead; browser storage goes only through that module (shop-web CLAUDE.md)  no-restricted-globals
src/features/profile/theme.ts
  2:3   error  'window.localStorage' is restricted from being used. Use readSetting/writeSetting from src/shared/storage.ts instead; browser storage goes only through that module (shop-web CLAUDE.md)  no-restricted-properties
```

When you fix these two, note that `readSetting`/`writeSetting` prefix keys with `shop:` and store JSON, so `theme` becomes `shop:theme` and a value saved before the change is not read back.

Verified with the project's own ESLint: `eslint .` (main config) is still clean, and `eslint -c eslint.config.suggestions.mjs .` reports exactly the 2 hits above.
Edge cases checked through `--stdin` (no files written): `window['localStorage']`, `const { localStorage } = window`, `globalThis.sessionStorage` and `typeof localStorage` are flagged; a parameter named `localStorage`, `src/shared/storage.ts` and test files are not; `it.only` in a test file and `==` are flagged.

Rule ids are shared: the storage convention and the focused-test check both use `no-restricted-properties` (in different files: app code and test files), so the baseline counts them together.

## Config changes

`eslint.config.js` (main config, CI runs it through `npm run lint`):

```diff
 export default tseslint.config(
   {ignores: ['dist']},
   ...tseslint.configs.recommended,
+  {
+    name: 'general',
+    files: ['src/**/*.{ts,tsx}'],
+    rules: {
+      complexity: ['error', 10],
+      'max-depth': ['error', 4],
+      'max-lines-per-function': ['error', {max: 50, skipBlankLines: true, skipComments: true}],
+      'max-params': ['error', 3],
+      'max-lines': ['error', {max: 400, skipBlankLines: true, skipComments: true}],
+      'no-nested-ternary': 'error', 'no-else-return': 'error', 'no-console': 'error', ...
+      (21 core rules, all at error)
+    },
+  },
+  {
+    name: 'test-hygiene',
+    files: ['**/*.{test,spec}.{ts,tsx,js,jsx}'],
+    rules: {'no-restricted-properties': ['error', /* it.only, describe.only, test.only, with a message */]},
+  },
 )
```

New `eslint.config.suggestions.mjs` (suggestions layer):

```js
import base from './eslint.config.js'
const storageMessage = 'Use readSetting/writeSetting from src/shared/storage.ts instead; browser storage goes only through that module (shop-web CLAUDE.md).'
export default [
  ...base,
  {
    name: 'suggestions',
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/shared/storage.ts', '**/*.{test,spec}.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-globals': ['error', /* localStorage, sessionStorage */],
      'no-restricted-properties': ['error', /* window|globalThis|self . localStorage|sessionStorage */],
    },
  },
]
```

Run it with `npx --no-install eslint -c eslint.config.suggestions.mjs .`.
Proposed script (not added, `package.json` is unchanged): `"lint:suggestions": "eslint -c eslint.config.suggestions.mjs ."`.
When the storage rule's open hits reach 0, move its object into `eslint.config.js` and delete the suggestions config.

## CLAUDE.md changes

Deleted, always loaded, 35 tokens:

```diff
 - Orders move from draft to paid to shipped; only the backend changes an order's state.
 - Use pnpm, not npm, for every install.
-- Browser storage only through `src/shared/storage.ts` (`readSetting`, `writeSetting`), never `localStorage` or `sessionStorage` directly.
```

The rule's message carries the whole line (the helper module, both function names, both storage objects), and the fix is local, so no pointer was kept.

Kept unchanged, no rule covers them:
- Line 3, order lifecycle: a domain rule the backend owns; the frontend has no order code to check.
- Line 4, pnpm: a tool rule, not something a linter checks.
  Note: the repo has a `package-lock.json` (npm), which does not match this line.

## Not built

- High risk, need type-aware linting (not configured today), 0 hits on a type-aware probe: `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `@typescript-eslint/switch-exhaustiveness-check`.
  Answer: build none.
- Need a plugin the project does not have (options, not installed):
  - React hooks rules: `pnpm add -D -E eslint-plugin-react-hooks@7.1.1`
  - `react/no-danger`, `react/jsx-no-target-blank`: `pnpm add -D -E eslint-plugin-react@7.37.5`
  - `vitest/no-disabled-tests`, `vitest/expect-expect`, `vitest/no-identical-title`: `pnpm add -D -E @vitest/eslint-plugin@1.6.28`
  - No commented-out code: `pnpm add -D -E eslint-plugin-sonarjs@4.2.3` (`sonarjs/no-commented-code`)
  - Report only: a secret scanner in CI (gitleaks), `knip` for unused files and exports.

## Feedback loop (Claude Code), installed

- Fast tier (after each edit): no linter; the project has no `eslint_d`, ast-grep or oxlint, so the fast check only records the edited files.
- Full tier (end of turn): `node_modules/.bin/eslint -c eslint.config.suggestions.mjs --format json {files}` on `.ts`, `.tsx`, `.js`, `.mjs`, so the storage rule guards every changed line while CI keeps the main config.
- Guard: asks before an edit adds an ignore comment or touches a protected path; the shell guard checks files changed through `Bash`.
- Protected: `eslint.config.*`, `**/eslint.config.*`, plus `.claude/codemyrules/` and `.claude/settings.local.json`; lint settings inside `package.json` (`eslintConfig`, `eslintIgnore`) are guarded too.
- Private: `.claude/settings.local.json` (6 hook entries) and `.claude/codemyrules/` (`pkg/`, `pin.json`, `loop.json`, `baseline.json`), both added to `.git/info/exclude`; no tracked file changed.
- Pinned copy: codemyrules 0.9.2 (sha256 `9ef1677f...0407`).
  *Changed after the run:* the global package on the test machine was 0.8.0, and the run skipped the plan's `npm install -g codemyrules@0.9.2` step, so it pinned 0.8.0 first.
  The loop was then installed again with the same `loop.json` and the 0.9.2 CLI on `PATH`, so the hooks run 0.9.2.
- Smoke test, nothing left behind: `status` (0.9.2 CLI) shows all 6 hooks run the pinned copy; the guard, fed a payload on stdin, asks for an `eslint-disable` line and for an edit to `eslint.config.js`, and passes a clean edit.

Install plan (dry run output, applied with `--apply`):

```
create .claude/codemyrules/pkg          codemyrules 0.9.2 (0.8.0 in the first install, see above)
create .claude/codemyrules/pin.json
create .claude/codemyrules/loop.json
create .claude/settings.local.json      PreToolUse guard (Edit|Write|MultiEdit), shell guard (Bash|NotebookEdit),
                                         PostToolUse edited + shell, PostToolUseFailure shell, Stop turn
update .git/info/exclude                .claude/codemyrules/  .claude/settings.local.json
```

## Baseline

`.claude/codemyrules/baseline.json`:
- Always-loaded doc tokens: 35 per session (was 70 before the cleanup).
- On-demand doc tokens: 0.
- Rules: 23 rule ids, 2 open hits (`no-restricted-globals` 1, `no-restricted-properties` 1, every other rule 0).

The next run of codemyrules compares against it and reads the failure log: a rule that keeps failing should get a one-line pointer, and a rule that never fails confirms its doc line could go.

## Design answers taken on your behalf

1. Storage convention as built-in `no-restricted-globals` + `no-restricted-properties`, not a custom `local/gen-*` rule, because built-in rules express it with a message.
   Alternative: one custom rule, which would give it its own rule id in the baseline.
2. Storage rule scope: `src/**/*.{ts,tsx}` without `src/shared/storage.ts` and without test files (narrower scope, tests may set up storage).
   Alternative: include test files.
3. `typeof localStorage` is flagged too, so feature detection also lives in the helper.
   Alternative: allow `typeof` checks.
4. No autofix or suggestion for the storage rule: the helper prefixes keys and JSON-encodes values, so a mechanical rewrite would change stored data.
5. Storage rule in the suggestions layer at `error` (2 open hits), so CI stays green and the loop still blocks new direct storage calls.
6. Limits at the standard values (complexity 10, max-depth 4, max-lines-per-function 50, max-params 3, max-lines 400).
   Alternative: the strictest values the code meets today, also 0 hits: complexity 3, max-depth 1, max-lines-per-function 8, max-params 2, max-lines 15.
7. General rules scoped to `src/**/*.{ts,tsx}` at `error` in the main config (0 hits each).
8. Focused-test check through `no-restricted-properties` on `**/*.{test,spec}.{ts,tsx,js,jsx}`, since no vitest plugin is installed.

## Decisions taken without asking

- Mode: automatic (step 0), so every recommended candidate was built and the loop and baseline were written without a question.
- Contradiction between doc and code: enforce the doc (step 3), for the storage convention, where 2 of 3 files bypass `src/shared/storage.ts`.
- High-risk candidates: build none (step 3), for the three type-aware rules.
- Agent-doc cleanup: the recommended edit (step 4 and the sub-skill's step 6), deleting `CLAUDE.md` line 5; lines 3 and 4 left unchanged because no rule covers them.
- Feedback loop: installed as planned with `--apply` and `--harness claude` (step 5), then the baseline written (step 6).
- `npm install -g codemyrules@0.9.2` from the install plan: skipped as instructed; the loop was installed again with 0.9.2 after the run (see Feedback loop).
