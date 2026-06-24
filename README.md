# open-projects

High-level project management CLI, MCP server, and SDK for AI coding agents. A project can be any repository, app, docs folder, scaffold, experiment, or remote-intended project in any folder. Projects tracks roots, recipes, agents, tmux profiles, immutable project events, and prompt-driven AI agent runs.

## Install

```bash
bun install -g @hasna/projects
```

## CLI

The app and binary are named `projects`, and the public command surface is project-first.

```bash
# Prompt mode through AI SDK + OpenRouter
projects --dry-run --json "Plan a new open source project named Log Tools in /tmp/log-tools with tmux"
projects --yes "Create a docs project in /home/me/docs/new-docs and write a marker"
projects --model openai/gpt-4o-mini --max-steps 8 "Import this folder as a project"

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
projects tmux-profiles apply dev my-project --dry-run --json

# Projects
projects create --name "My App" --path /path/to/my-app --stage active --priority high \
  --owner hasna --launch-profile dev --start-agent claude --start-command "claude --resume" \
  --start-session-policy error-if-running \
  --start-windows-json '[{"name":"server","command":"bun run dev"}]' \
  --todos-project-id todo_123 --brief-id brief_123 --mkdir --git-init --marker --json
projects create --name "Planned App" --path /tmp/planned --mkdir --dry-run --json
projects start                              # from inside a registered repo
projects start open-notes                  # by slug/id/name/path
projects start --json                      # operational structured output
projects start --render-spec               # validated JSON Render spec
projects start my-app --agent codewith
projects start /path/to/existing --agent claude
projects start my-app --windows-json '[{"name":"editor","command":"code ."},{"name":"server","command":"bun run dev"}]'
projects start /path/to/new-folder --tags family,security --metadata-json '{"domain":"home-security"}' --dry-run --json
projects start my-app --profile dev --agent claude --new
projects start my-app --error-if-running --agent none
projects start --rename-report --agent codewith
projects sessions my-app --unrenamed --json
projects start --bulk my-app docs-site service-api --agent opencode --dry-run --json
projects start --bulk-file ./project-targets.json --agent claude --dry-run --json
projects status my-app --profile dev --json
projects import /path/to/existing --json
projects import-github hasna/example --root open-source --clone --dry-run --json
projects scan-roots --root open-source --repo-prefix project- --clone --json
projects sync-roots --root open-source --repo-prefix project- --tags open-source,project --json
projects import /path/to/root --bulk --dry-run --json
projects list --query app --tags web,ts --json
projects show my-app --json
projects get my-app --json
projects update my-app --description "New description" --tags web,ts --priority critical --launch-profile dev
projects tag my-app security cameras
projects untag my-app cameras
projects link my-app --github-url https://github.com/hasna/my-app --todos-project-id todo_123 --todos-task-list-id list_123
projects unlink my-app --todos --brief
projects locations add my-app /path/to/another-folder --label docs
projects locations list my-app
projects archive my-app
projects unarchive my-app
projects delete my-app

# Budgets
projects budgets set --project my-app --max-usd 5 --max-total-tokens 100000 --json
projects budgets remaining --project my-app --json
projects --budget-project my-app --run-budget-tokens 2000 --json "Plan the next release"

# Project checks
projects doctor my-app --fix --dry-run --json

# Agent evals
projects agent-eval --json
projects agent-eval --mock --json
projects agent-eval --case create-explicit-path,tmux-apply-existing --fail-on-error

# Shell completion, including workon
eval "$(projects completion)"
eval "$(projects completion --shell zsh)"
```

Projects stores high-level management fields directly on the project record:
`stage`, `priority`, `owner`, `launch_profile`, `start_agent`,
`start_command`, `start_session_policy`, `start_windows`, todos links, and
brief links. `projects start` and `projects status` use those launch defaults
unless the command passes an explicit override. By default, `projects start`
detects the current repo/project, creates or reuses the project tmux session,
and ensures base windows named `01` and `02`. Window `01` is the managed
coding-agent/work window when a start command is launched; `02` is the
secondary workspace. Existing unrelated tmux windows are left alone. Pass
`--windows-json` or the MCP/API `windows` field to request the exact tmux
window names for a single start/status operation.

Machine-readable outputs for `projects list`, `projects show`/`projects get`,
`projects status`, `projects start`, `projects sessions`, `projects roots list`,
and `projects recipes list` can emit validated JSON Render specs with
`--render-spec`. Existing `--json` payloads preserve their operational fields and
render specs are available from `--render-spec` and matching `projects_render_*`
MCP tools. Claude starts are annotated with `--name` when safe.
Codewith, Cursor, and OpenCode rename support is reported as manual or
unsupported unless a stable programmatic rename path is available; Open Projects
does not force text into unknown panes. Use `projects start --rename-report` or
`projects sessions <project> --unrenamed` to inspect rename status. Detailed
execution still belongs in `todos`; long-form specs and decisions still belong
in `brief`.

## Storage Sync

Production storage for Hasna XYZ uses the `projects` database on
`hasna-xyz-infra-apps-prod-postgres`. The runtime secret path is
`hasna/xyz/opensource/projects/prod/rds`; load that secret into
`HASNA_PROJECTS_DATABASE_URL` for runtime or smoke commands and do not print
the value. `PROJECTS_DATABASE_URL` remains available as a local/self-hosted
fallback.

```bash
export HASNA_PROJECTS_DATABASE_URL="<value from hasna/xyz/opensource/projects/prod/rds>"
projects storage status --json
projects storage push
projects storage pull
```

Before cutover, verify `projects storage status --json`, run a read-only smoke
against the canonical database, and keep legacy sources read-only until the
central rollback window closes.

`projects create --dry-run` is a true no-write creation plan. It returns planned DB writes, filesystem actions, tmux actions, verification steps, locks, and rollback records without writing rows or files. Creation cleanup remains available through MCP as `projects_cleanup_create`, removing only safe creation artifacts such as the project row, marker file, `.git`, and empty created directory.

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

### Project Tools

| Tool | Purpose |
| --- | --- |
| `projects_roots_list` / `projects_roots_add` / `projects_roots_show` / `projects_roots_update` / `projects_roots_delete` / `projects_roots_match` | Register, inspect, score, update, and delete root folders/path templates |
| `projects_recipes_list` / `projects_recipes_add` | Manage recipe defaults for project creation |
| `projects_agents_list` / `projects_agents_add` | Register human, CLI, service, and AI agents |
| `projects_tmux_profiles_list` / `projects_tmux_profiles_add` / `projects_tmux_profiles_apply` | Manage reusable tmux sessions/windows |
| `projects_list` / `projects_show` | Search and inspect projects |
| `projects_render_list` / `projects_render_show` / `projects_render_start` / `projects_render_status` / `projects_render_sessions` / `projects_render_roots` / `projects_render_recipes` | Emit validated JSON Render specs for project surfaces |
| `projects_locations_list` / `projects_locations_add` | Inspect and register additional folder locations for a project |
| `projects_create` | Plan or create a project anywhere on disk |
| `projects_start` | Open or reuse a tmux session, ensure default `01`/`02` windows, and launch Codewith, Claude, OpenCode, Cursor, or no tool, with optional exact tmux windows |
| `projects_tmux_status` | Inspect expected and current tmux session/window status for a project |
| `projects_cleanup_create` | Clean up DB/files created by a project creation run using rollback records |
| `projects_import` / `projects_scan_local_roots` | Import existing folders as projects |
| `projects_import_github` / `projects_scan_roots` / `projects_sync_roots` | Import GitHub repos as local or remote-only projects, including configured GitHub root scans/syncs |
| `projects_github_publish` / `projects_github_unpublish` | Publish/unlink GitHub project metadata |
| `projects_link` | Merge external service IDs into project integrations |
| `projects_unlink` | Clear external service IDs from project integrations |
| `projects_update` | Update project metadata with audit events |
| `projects_tag` / `projects_untag` | Add or remove project tags without replacing the full tag list |
| `projects_archive` / `projects_unarchive` / `projects_delete` | Change project lifecycle status |
| `projects_doctor` | Validate markers, paths, locations, references, and failed runs |
| `projects_events_list` / `projects_event_record` | Inspect or record project audit events |
| `projects_lock` / `projects_unlock` / `projects_locks` | Coordinate project mutations |
| `projects_agent_eval` | Run prompt-agent eval cases and return success/confidence |
| `projects_agent_prompt` | Run the AI SDK/OpenRouter project agent loop |

Workspace-named MCP aliases are removed from the public contract.

## Prompt Mode

Prompt mode uses AI SDK with OpenRouter. Configure the key with `OPENROUTER_API_KEY`, `PROJECTS_OPENROUTER_API_KEY`, or the local secrets vault. The default model is `openai/gpt-4o-mini`.

Mutations require `--yes`. Without approval, mutating tools return structured plans/previews. `--dry-run` forces no-write behavior even if `--yes` is present.

The prompt agent can inspect roots, recipes, agents, tmux profiles, and projects; create/update/tag/untag/archive/delete/import projects; import/publish GitHub repos; link/unlink external integrations; start projects with saved launch defaults; and plan/apply tmux profiles. It records agent runs and tool calls in SQLite.

`projects agent-eval` seeds temporary project fixtures into an isolated SQLite database under the eval base path and runs a repeatable prompt suite over root registration/matching, recipe and agent planning, project listing/show/events, create/deduplication, import/scan, update, archive/unarchive, delete/hard-delete, cleanup, verification, tmux planning, GitHub publish/unpublish/import, and integration linking. Live mode uses OpenRouter; `--mock` runs deterministic create-path coverage and skips live-only cases. The JSON summary reports `success_rate`, `confidence`, and `db_path`.

Normal `projects list` output hides prompt-agent eval fixtures. Use `projects list --include-evals` to inspect old fixtures and `projects cleanup-evals --dry-run --json` followed by `projects cleanup-evals --apply` to remove them.

## Data Model

Core internal tables:

- `roots`: named base folders, tags, path templates, default kind/recipe/tmux profile, GitHub defaults
- `recipes`: reusable creation metadata, variables, default tags, and scaffold steps
- `agents`: human, CLI, service, and AI actors with provider/model/permissions metadata
- `workspaces`: storage records backing projects with kind, status, root, recipe, path, tags, integrations, and metadata
- `workspace_locations`: machine-local paths for a project
- `workspace_events`: immutable project audit events for mutations and runtime actions
- `agent_runs`: prompt-loop run ledger with tool calls and results
- `tmux_profiles` / `tmux_profile_windows`: reusable tmux session/window templates
- `workspace_locks`: short-lived mutation locks
- `workspace_migration_map`: one-time legacy project-to-workspace mapping

DB path: `~/.hasna/projects/projects.db`

Override: `HASNA_PROJECTS_DB_PATH`

## SDK

The public SDK exports project-named functions and types. Storage-layer modules still use workspace names internally, but the package boundary is project-first.

```ts
import {
  createProject,
  updateProject,
  planProjectCreation,
  executeProjectCreation,
  runProjectAgentPrompt,
  startProject,
} from "@hasna/projects";
```

## Architecture

```text
src/
├── cli/
│   ├── index.ts                 # project CLI and prompt entrypoint
│   └── commands/
│       ├── workspaces.ts         # project, roots, recipes, agents, tmux profiles
│       └── completion.ts         # project shell completion
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
│   └── index.ts                  # project-first MCP server
├── types/
│   └── workspace.ts              # internal storage/project domain types
└── index.ts                      # SDK exports
```

## License

Apache-2.0
