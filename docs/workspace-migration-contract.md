# Workspace Migration Contract

## Final Domain

The replacement domain is workspace-first and has no public Project compatibility layer.

Core entities:

- `Workspace`: any repository, app, docs folder, scaffold, experiment, remote-only repository, or project-like folder.
- `Root`: a registered base path with tags, kind defaults, GitHub defaults, templates, allowed recipes, and allowed agents.
- `Recipe`: reusable creation metadata and scaffold steps.
- `Agent`: human, CLI, service, or AI actor.
- `AgentRun`: prompt-loop execution ledger with model, prompt, status, tool calls, and result.
- `WorkspaceEvent`: immutable audit record for mutations and runtime actions.
- `WorkspaceLocation`: machine-local path for a workspace.
- `TmuxProfile`: reusable tmux session/window templates.
- `WorkspaceIntegrations`: external IDs such as GitHub, todos, mementos, conversations, and files.

## Tables And ID Prefixes

- `workspaces`: `wks_`
- `roots`: `root_`
- `recipes`: `rcp_`
- `agents`: `agt_`
- `agent_runs`: `run_`
- `workspace_events`: `evt_`
- `workspace_locations`: `loc_`
- `tmux_profiles`: `tmp_`
- `tmux_profile_windows`: `tmw_`
- `workspace_locks`: `lock_`
- `workspace_migration_map`: old project id to workspace id

## Old To New Mapping

- `projects.id` -> `workspace_migration_map.old_project_id`; new `workspaces.id` is generated.
- `projects.slug/name/description/status/path` -> `workspaces.slug/name/description/status/primary_path`.
- `projects.tags` -> `workspaces.tags`.
- `projects.integrations` -> `workspaces.integrations`.
- `projects.git_remote/s3_bucket/s3_prefix` -> same workspace columns.
- `projects.synced_at/last_opened_at/created_at/updated_at` -> same workspace columns.
- `project_workdirs` -> `workspace_locations`, preserving path, machine id, label, primary flag, creation time, and generated-doc metadata.
- Legacy migration metadata is stored under `workspaces.metadata.migration_inference`.

Dropped:

- Public Project SDK/CLI/MCP APIs.
- Project-specific sync/cloud command surface.
- Compatibility aliases such as `Project`, `CreateProjectInput`, and `ProjectIntegrations`.

## Root Inventory

Built-in legacy path inference recognizes these current conventions:

- `hasna-open-dev`: `/home/hasna/workspace/hasna/opensource/opensourcedev`, template `open-{slug}`
- `hasna-open`: `/home/hasna/workspace/hasna/opensource`, template `{slug}`
- `hasnaxyz-projects`: `/home/hasna/workspace/hasnaxyz/project`, template `project-{slug}`
- `hasnaxyz-internal`: `/home/hasna/workspace/hasnaxyz/internalapp`, template `iapp-{slug}`
- `hasnaxyz-companywebsites`: `/home/hasna/workspace/hasnaxyz/companywebsite`, template `cweb-{slug}`
- `hasnatools-platform`: `/home/hasna/workspace/hasnatools/platform`, template `platform-{slug}`
- `hasnastudio-platform`: `/home/hasna/workspace/hasnastudio/platform`, template `platform-{slug}`
- `hasna-scaffold`: `/home/hasna/workspace/hasna/scaffold`, template `scaffold-{slug}`
- `hasna-community`: `/home/hasna/workspace/hasna/community`, template `community-{slug}`

Unknown legacy paths create a root from the parent directory with template `{slug}`.

## Kind Inference

Kind is inferred from tags, path, and slug:

- `remote-only`: `remote-only` tag
- `company-website`: `/companywebsite/` or `cweb-`
- `internal-app`: `/internalapp/` or `iapp-`
- `platform`: `/platform/` or `platform-`
- `scaffold`: `/scaffold/` or `scaffold-`
- `community`: `/community/` or `community-`
- `open-source`: `open-` or `/opensource/`
- `project`: `project-` or `/project/`
- fallback: `generic`

## Marker Strategy

New runtime metadata uses `.workspace.json` with schema version `1`. It stores workspace id, slug, name, kind, root id, recipe id, primary path, git remote, tags, integrations, and generation time.

Legacy `.project.json` is not a public output. The import scanner can still treat legacy markers as signals during migration/import.

## Verification Contract

Migration must be run through `projects workspaces migrate-legacy`.

Required checks:

- Run `--dry-run --json` first; this executes against a temporary SQLite copy.
- Real migration creates a DB backup unless `--no-backup` is explicit.
- Validate `migration_map` accounts for every legacy project row.
- Validate every legacy workdir row was migrated or explicitly skipped as already present/unmapped.
- Review before/after counts and sample mappings in the JSON report.
- Run `projects workspaces doctor --json` after migration.
- Run typecheck, tests, build, MCP smoke, prompt eval, and package publish/update checks before release.
