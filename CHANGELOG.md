# Changelog

All notable changes to `@hasna/projects` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.95]

### Fixed

- **Grouped tmux sessions moved into a group outside the CLI keep the project
  working directory** ([#2](https://github.com/hasna/projects/issues/2),
  duplicate of [#1](https://github.com/hasna/projects/issues/1)). 0.1.93 anchored
  the groups Projects itself creates and made `createWindow()` fall back to
  `#{session_path}`, but a session added to a group by hand
  (`tmux new-session -t <project> -s <peer>`) still records the cwd of the shell
  that ran the move — usually `/home/<user>`. tmux resolves the start directory
  of a window opened by an *attached* client from that session cwd, so grouped
  windows opened by hand kept landing outside the project. `projects start` now
  realigns every session in the target session's group onto the project path
  (new `alignGroupedSessionWorkingDirectories()` / `listSessionLocations()` /
  `setSessionWorkingDirectory()` helpers). Ungrouped sessions are deliberately
  left untouched, so shared sessions keep the cwd of whoever created them, and a
  failed realign can never fail a start.

## [0.1.94]

### Fixed

- **`projects create` no longer drops registry flags in api/cloud mode
  ([#27](https://github.com/hasna/projects/issues/27)).** The api branch
  forwarded only `name`/`slug`/`description`/`kind`/`root`/`recipe`/`tags` plus
  the raw `--metadata-json`/`--integrations-json` blobs, so `--path`,
  `--git-remote` and every management/integration flag (`--stage`,
  `--priority`, `--owner`, `--launch-profile`, `--start-agent`,
  `--start-command`, `--start-session-policy`, `--start-windows-json`,
  `--todos-project-id`, `--todos-task-list-id`, `--brief-id`, `--brief-path`)
  were silently ignored, producing a bare row that then had to be repaired with
  `projects update --path`. Registry input is now parsed and merged once, ahead
  of the store branch, and forwarded to the cloud create exactly as it is for a
  local create.

### Changed

- **`projects create` now fails before creating a row when machine-local
  runtime flags are requested in api/cloud mode
  ([#27](https://github.com/hasna/projects/issues/27)).** `--mkdir`,
  `--git-init`, `--marker`, `--tmux-session`, `--tmux-windows-json` and
  `--tmux-profile` cannot be applied to a remote project row, and no api-mode
  command can apply them afterwards. Instead of creating the row and silently
  skipping the runtime work (leaving a partial, row-only project), the command
  now exits non-zero with a `local-only operation ...` message naming the
  offending flags, and issues no create request at all. Use `--dry-run` to
  preview the full local plan.
- **Tests no longer inherit the operator shell's cloud selectors.** A new
  `testSpawnEnv()` helper (and the matching in-process guard) strips
  `HASNA_PROJECTS_API_URL`/`HASNA_PROJECTS_API_KEY` unless a test opts into api
  mode explicitly, so `bun test` exercises the local store instead of silently
  running against — and creating real rows in — the live cloud registry.

## [0.1.93]

### Fixed

- **Grouped tmux sessions no longer lose the project working directory**
  ([#1](https://github.com/hasna/projects/issues/1)). `createGroup()` created
  the group session with neither a start directory nor a group target, so the
  session was anchored in the working directory of whatever process created it
  (typically `/home/hasna`). Because tmux resolves a new window's start
  directory from the client's cwd — and grouped sessions share their window
  list — every window opened in the group landed in `/home/hasna` instead of
  the project path. `createGroup(name, { cwd, windowName, group })` now passes
  `-c <project path>` and joins an existing group with `-t` (omitting `-n`,
  which tmux rejects alongside `-t`).
- **`createWindow()` falls back to the session's own start directory.** When no
  explicit `cwd` is supplied, the window start directory is now resolved from
  `#{session_path}` (new exported `sessionPath()` helper) instead of silently
  inheriting the CLI process cwd. The resolved path is escaped through the same
  tmux format-literal guard as explicit paths, and window creation still
  succeeds when the lookup fails.
- **`projects channel --ensure` no longer reports total failure after its side
  effects landed (api/cloud mode).** `ensureProjectChannelViaStore` performs
  three independent mutations — create the Conversations channel, persist
  `integrations.conversations_channel`, append a `channel_ensured` audit event.
  The final step POSTs to `/projects/:id/events`, which the cloud API does not
  serve, so a fully completed ensure exited 1 with a raw
  `Hasna request failed: POST /projects/<id>/events -> 404` while the channel
  and the project link were already committed. Agents then treated a linked
  channel as missing and retried into drift. The audit event is now recorded
  best-effort and reported through a non-fatal `warnings` entry; the store
  read-back and the integration link are fenced too, so a failure there returns
  a structured result instead of throwing a raw transport error. (#28)
- **Ensure results now carry structured partial-state evidence.**
  `ProjectChannelEnsureResult` gained `warnings: string[]` and
  `side_effects: { channel_created, channel_present, integration_linked,
  event_recorded }`, both surfaced in `projects channel --ensure --json` and
  printed on failure in text mode, so a retry is informed rather than blind.
  Ensure remains idempotent: a second run on an existing, already-linked channel
  reports `status: "exists"` with no duplicate write.
- **The derived channel class is passed to Conversations.** `channel create` is
  now invoked with `--class <package|product|initiative|loop-lane>` and
  `--topic`, so project channels satisfy the fleet naming/class convention
  instead of landing without `metadata.channel_schema.class`. Older
  `conversations` builds that reject those flags are detected and retried with
  the previous minimal arg set.

## [0.1.92]

### Added

- **Projects secret redaction across every output surface.** New
  `src/lib/redaction.ts` scrubs secret-shaped keys (password/token/api_key/
  client_secret/authorization/cookie/dsn/connection_string/…), URL credentials,
  `Authorization` headers, secret CLI flags, `ENV=value` assignments, PEM
  private-key blocks, and known token prefixes (`sk-`, `ghp_`, `github_pat_`,
  `npm_`, `xox*`, `AKIA…`). It is wired through CLI JSON/text printers, the MCP
  JSON-RPC tool responses, the SDK row mappers (`rowTo*`), the dashboard/reports
  servers, and the agent context/handoff/runs surfaces, and is also applied at
  write time for agent-run and workspace-event records.
- **`projects permissions repair` (CLI) and `projects_permissions_repair` (MCP)
  plus SDK export.** Dry-run by default; `--apply` tightens local Projects
  registry DB/WAL/SHM, backups, canonical stores, and (optionally) registered
  project report and dashboard artifacts to private modes (0600/0700). Skips
  symlinks, never deletes, and reports per-path actions.

## [0.1.91]

### Security

- **Scrub internal infra identifiers from the shipped `README.md`.** The
  Storage Sync section named the internal production RDS cluster
  (`hasna-xyz-infra-apps-prod-postgres`) and the Secrets Manager runtime-secret
  path in prose and an `export` example. `README.md` ships in the published npm
  tarball (`files`), so these leaked to every installer. Replaced with generic,
  operator-supplied guidance ("your PostgreSQL connection string"); the package
  ships no default database, cluster, or secret-manager identifier. Also dropped
  the stale `projects storage status/push/pull` command examples from that block
  (those subcommands were removed in the 0.1.90 `ProjectStore` reconciliation).
  The runtime-code leak (the removed `getCanonicalProjectsRdsConfig()` constants
  echoed by the old `storage status` CLI/MCP surface) was already eliminated in
  0.1.90; this is the last remaining occurrence, in documentation only.

## [0.1.90]

### Reconciled

- **`main` reconciled with the published npm line.** `main` (0.1.84) had
  diverged from the deployed `@hasna/projects@0.1.89`: the published
  `ProjectStore` seam refactor (0.1.85–0.1.89 — unify the registry behind one
  `ProjectStore` and route all CLI + MCP registry / status / dashboard /
  GitHub-import / coordination / cloud-api writes and the prompt-agent through
  the Store to kill split-brain, plus the production Docker prod-deps image fix)
  was live on npm but never landed on `main`, while a set of `main`-only
  CLI/UX fixes had never been published. This release merges the published tag
  into `main`, preserving both histories, so npm and `main` agree again.
  Overlapping storage/backend/canvas surfaces were reconciled in favour of the
  published `ProjectStore` seam while keeping the `main`-only behaviour: the
  canvas `upsert`/`compose` CLI + MCP tools and the `assertLocalOnlyWrite`
  guard now resolve targets, read data models, record events and inspect the
  app store through the Store instead of the removed direct-DB / `http/backend`
  helpers.

### Fixed (previously unpublished on `main`)

- `projects sessions` with no target reports recent project start sessions
  aggregated across all projects instead of failing with `Project not found`.
- `projects events record` fails fast with a clear local-only message in
  api/cloud mode instead of silently writing local sqlite or leaking a raw
  upstream `404` for `POST /projects/:id/events`.
- Generic project canvas blocks + canvas geometry hardening, dashboard render
  manifest imports and linked-canvas surfacing, the dashboard Todos provider
  link, subcommand `--help`/`-h` routing to commander, shell completion derived
  from the live CLI surface, and `projects create --dry-run` no-persist
  semantics in cloud mode.

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

## [0.1.84] - 2026-07-07

### Fixed

- Hardened generic canvas block validation so malformed public layout,
  viewport, explicit position, width, or height JSON fails fast instead of
  generating invalid React Flow canvas geometry.

### Tests

- Added regression coverage for malformed canvas block geometry through the
  typed compiler, CLI `projects canvases compose`, and MCP
  `projects_canvases_compose` / `projects_canvases_upsert` JSON-RPC calls.

## [0.1.83] - 2026-07-07

### Added

- Added generic scalable canvas composition for Projects canvases:
  `projects canvases compose <project>` compiles domain-neutral block/link specs
  into React Flow nodes and edges, and `projects canvases upsert <project>`
  idempotently creates or updates a canvas by slug from either raw React Flow
  JSON or block specs.
- Added a typed `project-canvas-blocks` library layer and SDK exports for
  composing reusable blocks such as summary cards, tables, groups, links,
  roadmap/checklist cards, and hierarchy-style views without adding a one-off
  org-chart command.
- Added MCP parity for the new canvas surface through
  `projects_canvases_upsert` and `projects_canvases_compose`.

### Fixed

- Preserved existing dashboard render imports when `projects dashboard render
  --write` rewrites `.hasna/project/dashboard/render.json`, and exposed linked
  stored canvases plus dashboard imports in the default dashboard render model.
- Made dashboard server canvas routes use the enriched dashboard render so
  linked canvases/imports remain visible when served.
- Removed the broken unpublished `@hasna/mcp-harness` dev dependency and kept
  the MCP HTTP transport local to this package using the official MCP SDK
  web-standard transport, restoring install/typecheck/build safety.

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
