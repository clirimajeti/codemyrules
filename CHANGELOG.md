# Changelog

All notable changes to codemyrules.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- GitHub Copilot CLI support: `codemyrules install` writes project hooks to `.github/hooks/codemyrules.json` that run the guard, the shell guard and both lint tiers.
- The installer detects Copilot projects from `.github/hooks/` or `.github/copilot-instructions.md`, and `status` and `uninstall` handle the Copilot hooks.
- `npm publish` runs the tests first, and the README documents the release order: push, green CI, publish, tag.

### Fixed

- The end-of-turn lint compares against the commit at the start of the turn, so an agent can no longer hide a change by committing it.
- An edit that changes part of a line is checked on the whole line.
- Shell snapshots moved into the git directory, out of the agent's working tree.
- Protected paths accept globs in the last segment, and paths are compared after resolving symlinks.
- The shell guard trusts only an installer outside the project or the pinned copy, rejects a `PATH=` prefix, and expands `~` in the installer path.
- The end-of-turn lint sends the same findings back only once, so a turn cannot loop.
- A hook that cannot run now blocks and tells the user to run `codemyrules install . --apply`, instead of failing silently.
- pi and opencode stay in installed mode once `loop.json` was seen.
- The shell guard skips the old-content read for files without a suppression.
- A finding sent back to the agent is one line of at most 1000 characters.
- codemyrules' own `.claude/codemyrules` folder no longer counts as a Claude Code marker.

## [0.8.0] - 2026-11-09

### Added

- pi support: a project extension in `.pi/extensions/` that runs the guard, the shell guard and the lint loop.
- opencode support: a v2 project plugin in `.opencode/plugins/` with the same features.
- On a first install, the installer detects the harness from the project (`--harness` to choose).
- README install steps for pi and opencode.

## [0.7.0] - 2026-11-07

### Added

- The hooks' package is pinned per project in `.claude/codemyrules/pkg/`.
- Discovery follows links through linked agent docs.
- Install from a repository subfolder.

### Fixed

- When the guard crashes, it asks instead of failing open.

## [0.6.0] - 2026-11-06

### Added

- `codemyrules status` and `codemyrules uninstall`.
- A linter working directory for monorepos.
- Evals.

### Changed

- Faster shell snapshots.

### Fixed

- Tests on Windows, and LF line endings everywhere.

## [0.5.0] - 2026-11-06

### Added

- The hooks ship as the `codemyrules` npm package.
- Failed shell commands are checked too.
- CI.

## [0.4.1] - 2026-11-06

### Changed

- The hooks are split into a harness-neutral core and a Claude Code adapter.

### Fixed

- Symlinked project paths.

## [0.4.0] - 2026-11-06

### Added

- The shell guard: catches lint suppressions and lint config changes made through shell commands.

### Fixed

- Hardening of the hooks after a review.

## Before 0.4.0 - 2026-11-04 to 2026-11-06

### Added

- The skill: turns a project's decisions, patterns and agent-doc instructions into lint rules through eslint-pattern-rules and backend-pattern-rules, slims the agent docs, and installs a lint feedback loop for Claude Code.
- The first question is automatic or manual mode, and all rules are selected in one turn.
- A How It Works flowchart in the README.

### Fixed

- Credential files are never read, diffed or linted.
- Only the linted files are diffed, and package runners stay out of the fast tier.
