# Changelog

All notable changes to `@hasna/projects` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.89]

### Fixed

- **Prompt-agent cloud-write split-brain**: in api/cloud mode the LLM
  prompt-agent (`projects agent "..."` / MCP `projects_agent_prompt`) now
  routes every shared-registry mutation through the `ProjectStore` (cloud
  HTTP `<url>/v1`) instead of writing directly to local sqlite. Previously
  only `projects_create` used the store; `update`, `archive`, `unarchive`,
  `delete`, `tag`, `untag`, `integration_unlink` and `event_record` wrote to
  the local island while the project lived in the cloud, and target
  resolution read local. The per-project local-only sub-resources
  (`agents_assign`, `locations_add`) now surface the store's
  `LocalOnlyOperationError` as a clean tool error in cloud mode rather than
  silently writing local sqlite. Local mode behaviour is unchanged.

## [Unreleased]

### Added

- **Project -> conversations channel linkage** (fleet comms workflow, todos
  task `c4bee3e0`): the channel name is stored on the project record as
  `integrations.conversations_channel` and derived from the slug + kind per
  the fleet channel naming convention when unset (`open-source` -> flat repo
  name, `platform` -> `platform-*`, `internal-app` -> `iapp-*`,
  `company-website` -> `cweb-*`, `community` -> `community-*`, `experiment` ->
  `research-*`, everything else -> `internal-*`; already-prefixed slugs are
  kept as-is).
- **Ensure-channel on create/start** — `projects create` and `projects start`
  create the conversations channel when missing (create-first probe against
  the `conversations` CLI, 15s timeout, never fatal: failures surface as
  `channel.status === "error"`), link it on the project record, and record a
  `channel_ensured` audit event. Opt out with `PROJECTS_CHANNEL_ENSURE=0`;
  defaults off under `NODE_ENV=test`.
- **Channel resolution surface parity** — `projects channel [target]` CLI
  command (prints the bare channel name for loops/scripts; `--json`,
  `--ensure`, `--from`, `--dry-run`), `projects_channel` MCP tool,
  `projects_channel` prompt-agent tool (approval-gated ensure), and SDK
  exports (`deriveProjectChannel`, `resolveProjectChannel`,
  `resolveProjectChannelForProject`, `ensureProjectChannel`).
- `projects link --conversations-channel <name>`, `channel` integration alias,
  `conversations_channel` in the `conversations` unlink group, agent
  context/handoff integration payloads, and `projects show` channel line.

## [0.1.79] - 2026-07-06

### Added

- **`projects-serve` HTTP API** — a new self-hosted HTTP surface for the project
  domain. Unauthenticated probes `GET /health`, `/ready`, `/version` (each
  returns `{status, version, mode}`) plus `GET /openapi.json`, and an
  API-key-guarded versioned `/v1` covering project (workspace) CRUD
  (`/v1/projects` list/create/get/patch/delete + `/archive`, `/unarchive`,
  `/events`) and roots/agents/recipes. Amendment A1 pure-remote: the service
  reads and writes cloud Postgres directly through the vendored storage kit,
  with no local cache or sync engine.
- **API-key authentication** via `@hasna/contracts/auth` (`verifyApiKey`) —
  stateless HMAC-verified `hasna_projects_*` tokens with `projects:read` /
  `projects:write` scope gating and DB-backed revocation.
- **Generated SDK** (`@hasna/projects/sdk`) — a typed, dependency-free
  `ProjectsClient` generated from the serve OpenAPI document
  (`bun run sdk:generate`), plus `createProjectsClientFromEnv()` for the
  `PROJECTS_API_URL` + `PROJECTS_API_KEY` self_hosted convention.
- **Cloud storage + migrations** — vendored `@hasna/contracts` storage kit under
  `src/generated/storage-kit`, a `migrations/` directory, and a migration runner
  (`projects-serve migrate`) driven by the kit's checksum-guarded ledger.
- **Container + deploy** — ARM64 Bun `Dockerfile`, `docker-compose.yml`,
  `hasna.contract.json` manifest, and a `.github/workflows/deploy.yml` pipeline
  for building/pushing the image and rolling the ECS service.

## [0.1.78] - 2026-07-04

### Added

- Added `projects reports serve` to browse registered project report files over
  HTTP, rendering Markdown reports with light/dark typography and serving HTML
  reports as-is.

## [0.1.69] - 2026-06-29

### Fixed

- Hardened project dashboard serving: non-loopback hosts now require an
  explicit dashboard access token or explicit `--trust-network`, and token mode
  uses a browser unlock endpoint instead of self-issuing cookies to any visitor.
- Kept dashboard snapshot, render, and validate commands read-only unless
  `--write` is passed.
- Removed generic top-level dashboard aliases so prompt-agent routing is not
  hijacked by natural-language prompts starting with words such as `render` or
  `validate`.

## [0.1.67] - 2026-06-28

### Added

- Canonical ID-based project store support:
  `$HASNA_PROJECTS_HOME/workspaces/<workspace_id>/` for physical workspace
  folders and `$HASNA_PROJECTS_HOME/data/<workspace_id>/` for runtime state.
- `projects store inspect`, `projects store ensure`, and dry-run-first
  `projects store migrate` with explicit `--apply`/`--yes` migration, plan
  artifacts, previous-location registration, marker rewrite, and verification.
- `projects labels` / `projects label` commands for add/remove/list workflows
  over normalized project tags, plus `--label` filters on `projects list` and
  targetless `projects start`.
- `projects oss matrix`, a bounded routing matrix for open-source workspace
  roots that reports repo paths, package metadata, git status, tmux hints, and
  best-effort latest task/PR refs for `open-*` work.

### Changed

- Rootless non-remote project creation now defaults the primary path to the
  canonical ID-based workspace store unless an explicit path or root is passed.
- Documented labels as metadata/query filters rather than path identity.

## [0.1.65] - 2026-06-26

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
