# open-projects

Generic workspace orchestration CLI, MCP server, and SDK for AI coding agents. A workspace can be any repository, app, docs folder, scaffold, experiment, or remote-intended project in any folder. The app tracks roots, recipes, agents, tmux profiles, immutable workspace events, and prompt-driven AI agent runs.

## Install

```bash
bun install -g @hasna/projects
```

## CLI

The binary is still named `projects`, but the command surface is workspace-first.

```bash
# Prompt mode through AI SDK + OpenRouter
projects --dry-run --json "Plan a new open source workspace named Log Tools in /tmp/log-tools with tmux"
projects --yes "Create a docs workspace in /home/me/docs/new-docs and write a marker"
projects --model openai/gpt-4o-mini --max-steps 8 "Import this folder as a workspace"

# Roots
projects roots add --name "Open Source" --path /home/me/opensource --kind open-source --path-template "{slug}"
projects roots list --json
projects roots match --path /home/me/opensource/my-app --json
projects roots update open-source --github-org hasna --visibility public

# Recipes
projects recipes add --name "TypeScript Library" --kind open-source --tags typescript,library
projects recipes list
projects recipes built-ins
projects recipes seed-defaults --json

# Agents
projects agents add --name "Codex" --kind ai --provider openrouter --model openai/gpt-4o-mini
projects agents list

# Tmux profiles
projects tmux-profiles add --name "Dev" --slug dev --session-template "{slug}-dev" \
  --windows-json '[{"name":"editor"},{"name":"server","command":"bun run dev"}]'
projects tmux-profiles apply dev my-workspace --dry-run --json

# Workspaces
projects workspaces create --name "My App" --path /path/to/my-app --mkdir --git-init --marker --json
projects workspaces create --name "Planned App" --path /tmp/planned --mkdir --dry-run --json
projects workspaces cleanup-create my-app --dry-run --json
projects workspaces import /path/to/existing --json
projects workspaces import-github hasna/example --root open-source --clone --dry-run --json
projects workspaces import /path/to/root --bulk --dry-run --json
projects workspaces scan-roots --json
projects workspaces list --query app --tags web,ts --json
projects workspaces show my-app --json
projects workspaces update my-app --description "New description" --tags web,ts
projects workspaces publish my-app --dry-run --json
projects workspaces link my-app --github-url https://github.com/hasna/my-app --todos-project-id todo_123
projects workspaces archive my-app
projects workspaces unarchive my-app
projects workspaces delete my-app

# Workspace checks and migration
projects workspaces doctor my-app --fix --dry-run --json
projects workspaces lock my-app --reason "manual maintenance"
projects workspaces locks
projects workspaces unlock workspace:wks_abc123
projects workspaces migrate-legacy --dry-run --report /tmp/workspace-migration.json --json
projects workspaces migrate-legacy --backup-dir ~/.hasna/workspaces/backups --json

# Agent evals
projects workspaces agent-eval --json
projects workspaces agent-eval --mock --json
projects workspaces agent-eval --case create-explicit-path,tmux-apply-existing --fail-on-error

# Shell completion, including workon
eval "$(projects completion)"
eval "$(projects completion --shell zsh)"
```

`workspaces create --dry-run` is a true no-write creation plan. It returns planned DB writes, filesystem actions, tmux actions, verification steps, locks, and rollback records without writing rows or files. `workspaces cleanup-create` can apply those rollback records later, removing only safe creation artifacts such as the workspace row, marker file, `.git`, and empty created directory.

## MCP Server

Add to an MCP client config:

```json
{
  "mcpServers": {
    "open-projects": {
      "command": "projects-mcp"
    }
  }
}
```

## HTTP mode

MCP uses stdio by default. A long-lived Streamable HTTP transport is also available on `127.0.0.1`:

```bash
projects-mcp --http              # default port 8871
MCP_HTTP=1 MCP_HTTP_PORT=8871 projects-mcp
```

Endpoints: `GET /health` → `{"status":"ok","name":"projects"}`, MCP at `POST/GET /mcp`.

### Workspace Tools

| Tool | Purpose |
| --- | --- |
| `projects_roots_list` / `projects_roots_add` / `projects_roots_show` / `projects_roots_update` / `projects_roots_delete` / `projects_roots_match` | Register, inspect, score, update, and delete root folders/path templates |
| `projects_recipes_list` / `projects_recipes_add` | Manage recipe defaults for workspace creation |
| `projects_agents_list` / `projects_agents_add` | Register human, CLI, service, and AI agents |
| `projects_tmux_profiles_list` / `projects_tmux_profiles_add` / `projects_tmux_profiles_apply` | Manage reusable tmux sessions/windows |
| `projects_workspaces_list` / `projects_workspaces_show` | Search and inspect generic workspaces |
| `projects_workspaces_create` | Plan or create a workspace anywhere on disk |
| `projects_workspaces_cleanup_create` | Clean up DB/files created by a workspace creation run using rollback records |
| `projects_workspaces_import` | Import existing folders as workspaces |
| `projects_workspaces_scan_roots` | Scan registered roots and preview/import child folders |
| `projects_workspaces_import_github` | Import GitHub repos as local or remote-only workspaces |
| `projects_workspaces_github_publish` / `projects_workspaces_github_unpublish` | Publish/unlink GitHub workspace metadata |
| `projects_workspaces_integrations_link` | Merge external service IDs into workspace integrations |
| `projects_workspaces_update` | Update workspace metadata with audit events |
| `projects_workspaces_archive` / `projects_workspaces_unarchive` / `projects_workspaces_delete` | Change workspace lifecycle status |
| `projects_workspaces_doctor` | Validate markers, paths, locations, references, and failed runs |
| `projects_workspaces_lock` / `projects_workspaces_unlock` / `projects_workspaces_locks` | Coordinate workspace mutations |
| `projects_workspaces_migrate_legacy` | One-time migration from legacy project rows with dry-run, backup, and report support |
| `projects_agent_eval` | Run prompt-agent eval cases and return success/confidence |
| `projects_agent_prompt` | Run the AI SDK/OpenRouter workspace agent loop |

The MCP server no longer exposes legacy project-specific tools such as `projects_create`, `projects_list`, `projects_update`, or `projects_sync`.

## Prompt Mode

Prompt mode uses AI SDK with OpenRouter. Configure the key with `OPENROUTER_API_KEY`, `WORKSPACES_OPENROUTER_API_KEY`, or the local secrets vault. The default model is `openai/gpt-4o-mini`.

Mutations require `--yes`. Without approval, mutating tools return structured plans/previews. `--dry-run` forces no-write behavior even if `--yes` is present.

The prompt agent can inspect roots, recipes, agents, tmux profiles, and workspaces; create/update/archive/delete/import workspaces; import/publish GitHub repos; link external integrations; and plan/apply tmux profiles. It records agent runs and tool calls in SQLite.

`projects workspaces agent-eval` seeds temporary workspace fixtures and runs a repeatable 32-case prompt suite over root registration/matching, recipe and agent planning, workspace listing/show/events, create/deduplication, import/scan, update, archive/unarchive, delete/hard-delete, cleanup, verification, tmux planning, GitHub publish/unpublish/import, and integration linking. Live mode uses OpenRouter; `--mock` runs deterministic create-path coverage and skips live-only cases. The JSON summary reports `success_rate` and `confidence`.

## Data Model

Core tables:

- `roots`: named base folders, tags, path templates, default kind/recipe/tmux profile, GitHub defaults
- `recipes`: reusable creation metadata, variables, default tags, and scaffold steps
- `agents`: human, CLI, service, and AI actors with provider/model/permissions metadata
- `workspaces`: generic workspace records with kind, status, root, recipe, path, tags, integrations, and metadata
- `workspace_locations`: machine-local paths for a workspace
- `workspace_events`: immutable audit events for mutations and runtime actions
- `agent_runs`: prompt-loop run ledger with tool calls and results
- `tmux_profiles` / `tmux_profile_windows`: reusable tmux session/window templates
- `workspace_locks`: short-lived mutation locks
- `workspace_migration_map`: one-time legacy project-to-workspace mapping

DB path: `~/.hasna/workspaces/workspaces.db`

Override: `HASNA_WORKSPACES_DB_PATH`

## Legacy Migration

`projects workspaces migrate-legacy` is a one-time full migration from old `projects` and `project_workdirs` rows into generic workspace tables. Use `--dry-run` first; it runs against a temporary SQLite copy and leaves the source DB untouched. Real runs create a pre-migration database snapshot by default unless `--no-backup` is passed.

JSON output includes before/after counts, project/workdir validation, sample mappings, backup paths, report path, and a release checklist for MCP config review, verification, publish, and rollback.

The final domain, root inventory, ID prefixes, marker strategy, and old-to-new mapping are documented in [docs/workspace-migration-contract.md](docs/workspace-migration-contract.md).

## SDK

The public SDK exports workspace domain types and services only:

```ts
import {
  createWorkspace,
  updateWorkspace,
  planWorkspaceCreation,
  executeWorkspaceCreation,
  runWorkspaceAgentPrompt,
} from "@hasna/projects";
```

## Architecture

```text
src/
├── cli/
│   ├── index.ts                 # workspace CLI and prompt entrypoint
│   └── commands/
│       ├── workspaces.ts         # roots, recipes, agents, tmux profiles, workspaces
│       └── completion.ts         # workspace shell completion
├── db/
│   ├── database.ts               # SQLite init/path resolution
│   ├── schema.ts                 # migrations
│   └── workspaces.ts             # workspace/root/recipe/agent/tmux services
├── lib/
│   ├── workspace-agent.ts        # AI SDK/OpenRouter prompt loop
│   ├── workspace-github.ts       # GitHub import/publish and integration linking
│   ├── workspace-plan.ts         # deterministic creation plans/executor
│   ├── workspace-runtime.ts      # directory/git/marker/tmux runtime actions
│   ├── workspace-import.ts       # arbitrary folder and registered-root import scanner
│   ├── workspace-migration.ts    # legacy migration dry-run, backup, and reports
│   └── workspace-doctor.ts       # marker/path/reference validation
├── mcp/
│   └── index.ts                  # workspace-only MCP server
├── types/
│   └── workspace.ts              # public workspace domain types
└── index.ts                      # workspace-only SDK exports
```

Legacy `project` modules may still exist internally during the migration window so existing rows can be migrated once with `projects workspaces migrate-legacy`, but they are no longer part of the CLI, MCP, or public SDK surface.

## License

Apache-2.0
