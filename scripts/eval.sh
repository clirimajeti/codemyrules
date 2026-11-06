#!/usr/bin/env bash
# Runs codemyrules' eval suite. An eval run loads only the plugin under test, and plugins a case lists must live inside it,
# so the two sub-skill plugins it depends on are copied into .eval-deps/ (git-ignored) from their sibling checkouts first.
# Extra arguments go to `claude plugin eval`, for example --case claude-md-to-rules or --runs 3.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
siblings="${CODEMYRULES_SIBLINGS:-$(dirname "$root")}"
rm -rf "$root/.eval-deps" && mkdir -p "$root/.eval-deps"
for dep in eslint-pattern-rules backend-pattern-rules; do
  [ -f "$siblings/$dep/.claude-plugin/plugin.json" ] || { echo "eval: $siblings/$dep is not a checkout of the $dep plugin (set CODEMYRULES_SIBLINGS)" >&2; exit 1; }
  rsync -a --exclude .git --exclude notes --exclude evals --exclude node_modules "$siblings/$dep/" "$root/.eval-deps/$dep/"
done
exec claude plugin eval "$root" --scaffold --allow-tools Bash Write Edit --no-publish "$@"
