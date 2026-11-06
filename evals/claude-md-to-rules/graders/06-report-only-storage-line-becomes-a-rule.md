---
type: llm
focus: last_message
weight: 1
---
PASS if the final report turns only the browser-storage line into a lint rule, keeps the order-lifecycle and pnpm lines as prose with a reason, says ESLint (run with the configuration it wrote) reported CartBadge.tsx and theme.ts and not storage.ts or language.ts, and lists the storage line as one that could be deleted or shortened once the user agrees.
FAIL if it builds a rule for the other lines, edits CLAUDE.md, says ESLint could not be run, or leaves out which files were reported.
