---
tags: [codemyrules]
# codemyrules depends on two sibling plugins, which an eval cannot resolve; `npm run eval` copies them into .eval-deps/
plugins: [../.., ../../.eval-deps/eslint-pattern-rules, ../../.eval-deps/backend-pattern-rules]
max_turns: 80
timeout_seconds: 1800
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

Our CLAUDE.md in shop-web keeps growing. Turn whatever a linter can enforce into lint rules. Don't set up the agent feedback loop for now. I'm not around to answer questions, so go with your recommendations and write down what you decided and why.

Input files: shop-web
