# Changelog

All notable changes to `@hasna/projects` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Compact terminal defaults for noisy project list/detail/history commands,
  with `--limit` and `--verbose` controls while keeping `--json` detailed.
- Opt-in compact MCP summaries via `compact: true` while preserving existing
  full-record defaults for MCP clients.
- Agent-assist CLI commands and MCP tools to help coding agents orient, decide,
  and continue: `projects context` (one-shot priming bundle), `projects next`
  (high-leverage next-action suggestions), `projects why` (resolution trace and
  fix tips), `projects handoff` (cross-agent/machine handoff bundle), and
  `projects runs list` / `projects runs show` (prompt-agent run ledger read
  view). All emit JSON (`-j/--json`) or LLM-friendly text (`--for-agent`), and
  are exposed as `projects_context`, `projects_next`, `projects_why`,
  `projects_handoff`, `projects_runs_list`, and `projects_runs_show` MCP tools.
- `--for-agent` output mode for the agent-assist commands: compact, references
  resolved, truncated long values.
- Goal-continue Cursor `stop` hook (`.cursor/hooks.json` +
  `.cursor/hooks/goal-continue.sh`) that blocks an agent's stop with a
  continuation prompt when an active goal is set, folding in `projects next`
  suggestions. Modeled on the codewith `/goal` slash command.

### Changed

- Prompt-agent project list/show/event tools now use compact wrapper payloads by
  default and point agents to verbose detail lookups when needed.

## [0.1.64] - 2026-06-24

### Added

- Root open-source release and community files: `CHANGELOG.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md`.
- npm package metadata now includes the changelog, security policy,
  contribution guide, and code of conduct in the publish whitelist.

### Fixed

- Hardened tmux session and window creation against project path and cwd command
  injection by invoking `tmux` with argv arrays, using tmux `-c` cwd arguments,
  and escaping tmux `#(...)` format command substitution.
- Added regression tests covering shell `$()` and tmux-native `#()` path/cwd
  injection cases.

## [0.1.63] - 2026-06-24

### Fixed

- Bulk project start now reports individual start failures without losing the
  successful results.

## [0.1.62] - 2026-06-24

### Added

- JSON Render specs for project list, detail, start, status, sessions, roots,
  and recipes surfaces.
- GitHub root scan/sync support for configured project roots.

## [0.1.60] - 2026-06-20

### Fixed

- Hardened project budget enforcement.

## Historical Releases

### Changed

- Earlier package versions were published before this changelog existed. Use the
  git history and npm registry metadata for detailed provenance before `0.1.60`;
  the only pre-existing repository tag was `v0.1.47`.
