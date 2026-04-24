# open-projects

Project management CLI + MCP server for AI agents. Register projects once, open them anywhere, sync to S3, auto-init git, and wire into the `hasna` ecosystem (todos, mementos, conversations).

## Install

```bash
bun install -g @hasna/projects
```

## CLI

```bash
# Register a project
projects create --name my-app --path /path/to/my-app
projects create --name my-app                         # uses cwd as path

# List / search
projects list
projects list --status archived
projects list --tags web,ts                           # AND filter
projects list --json | jq '.[].path'                 # machine-readable

# Get / status
projects get my-app                                   # auto-detects from cwd
projects get my-app --json
projects status                                       # all projects at a glance
projects status my-app                                # single project detail
projects context my-app                               # full agent handoff context
projects where my-app                                 # paths/workdirs across machines
projects recent                                       # recently opened (with relative times)
projects doctor                                       # health-check all projects
projects doctor my-app --fix --dry-run                # preview safe repairs with issue codes
projects doctor my-app --fix                          # auto-repair what can be fixed
projects stale                                        # stale paths, workdirs, tmux sessions/windows
projects cleanup --dry-run                            # preview safe stale-record cleanup
projects setup-machine                                # check Bun/tmux/git/gh/aws/config readiness
projects stats                                        # disk / sync totals
projects stats my-app

# Modify
projects update my-app --description "My app" --tags "web,ts"
projects rename my-app my-app-v2                      # updates slug + .project.json
projects tag my-app infra cloud                       # add tags
projects untag my-app cloud                           # remove a tag
projects archive my-app
projects unarchive my-app

# Open (cd into it)
cd $(projects open my-app)                            # print path; auto-detects cwd
workon my-app                                         # shell function — actually cd's
penv my-app                                           # load project .env into shell
projects env my-app                                   # print export statements (eval)
projects env my-app --list                            # list keys only

# Working directories (multi-machine / multi-repo)
projects workdir add my-app /path/to/dir --label backend
projects workdir list my-app
projects workdir generate my-app                      # write CLAUDE.md + AGENTS.md
projects workdir generate my-app --dry-run
projects workdir remove my-app /path/to/dir

# Import existing directories
projects import /path/to/existing-project
projects import-bulk /path/to/workspace               # imports all subdirs
projects clone my-app /new/local/path                 # pull from S3 to new machine path

# Sync to/from S3
projects update my-app --s3-bucket my-bucket
projects sync my-app
projects sync my-app --direction push
projects sync-all                                     # sync all projects with S3 configured
projects watch my-app                                 # push changes live as you edit
projects sync-log my-app                              # show sync history

# Schedule auto-sync
projects schedule set --interval daily --direction both
projects schedule status
projects schedule remove

# Cloud sync (SQLite ↔ RDS PostgreSQL)
projects cloud status
projects cloud pull
projects cloud push

# tmux
projects tmux open --name my-app
projects tmux window-status my-app my-app --json      # alive/dead/missing window health
projects tmux dead-windows my-app                     # exited panes / dead windows
projects tmux revive-window my-app my-app             # recreates only missing/dead windows
projects tmux revive-window my-app my-app --force     # explicit live-window restart
projects tmux revive-window my-app my-app --force --cwd "$PWD" --command "claude"

# Publish to GitHub
projects publish my-app --org hasnaxyz
projects unpublish my-app

# Git passthrough
projects git my-app status
projects git my-app log --oneline -10

# Shell completion (includes workon + penv functions)
eval "$(projects completion)"                         # bash
eval "$(projects completion --shell zsh)"             # zsh
```

## MCP Server

Add to your Claude config:

```json
{
  "mcpServers": {
    "open-projects": {
      "command": "projects-mcp"
    }
  }
}
```

### Available tools

| Tool | Description |
|------|-------------|
| `projects_create` | Register a new project. Returns `workingDirectory` + `post_create_actions` |
| `projects_list` | List projects, filter by `status` and/or `tags` |
| `projects_get` | Get project by ID or slug. Returns `workingDirectory` |
| `projects_update` | Update project metadata |
| `projects_archive` | Archive a project |
| `projects_open` | Get `workingDirectory` for a project (also tracks `last_opened_at`) |
| `projects_sync` | Sync to/from S3 (incremental, by file hash) |
| `projects_sync_all` | Sync all active projects with S3 configured |
| `projects_sync_log` | List recent sync history |
| `projects_link` | Store integration IDs (todos, mementos, conversations, files) |
| `projects_import` | Import an existing directory as a project |
| `projects_import_bulk` | Import all subdirectories of a path |
| `projects_publish` | Create GitHub repo, add remote, push |
| `projects_workdir_add` | Add a working directory; optionally generate CLAUDE.md + AGENTS.md |
| `projects_workdir_list` | List all working directories for a project |
| `projects_workdir_generate` | Generate CLAUDE.md + AGENTS.md in working directories |
| `projects_schedule_set` | Enable cron-based auto-sync |
| `projects_schedule_status` | Get current schedule config |
| `projects_cloud_status` | Show RDS connection health |
| `projects_cloud_pull` | Pull from cloud PostgreSQL to local SQLite |
| `projects_cloud_push` | Push local SQLite to cloud PostgreSQL |
| `projects_context` | Full agent handoff context for one project |
| `projects_where` | Workdir locations across machines with existence flags |
| `projects_setup_machine` | Machine readiness checks for Bun, tmux, git, gh, AWS, paths |
| `projects_stale` | Find stale paths, workdirs, orphan tmux sessions, and dead windows |
| `projects_cleanup` | Preview/apply safe stale workdir cleanup |
| `projects_tmux_window_status` | Check tmux window alive/dead/missing state |
| `projects_tmux_dead_windows` | List dead tmux windows |
| `projects_tmux_revive_window` | Safely recreate missing/dead tmux windows |

### projects_create response

```json
{
  "id": "prj_abc123",
  "name": "my-app",
  "path": "/path/to/my-app",
  "workingDirectory": "/path/to/my-app",
  "instruction": "Project created. workingDirectory: /path/to/my-app",
  "post_create_actions": [
    {
      "description": "Register with open-todos for task tracking",
      "tool": "mcp__todos__create_project",
      "args": { "name": "my-app", "path": "/path/to/my-app" },
      "on_complete": "Call projects_link with todos_project_id=<returned id>"
    }
  ]
}
```

## Architecture

```
src/
├── cli/
│   ├── index.ts              # CLI entry point (commander)
│   └── commands/
│       ├── projects.ts       # All project commands
│       └── completion.ts     # Shell completion
├── db/
│   ├── database.ts           # SQLite init, path resolution
│   ├── schema.ts             # Migrations
│   └── projects.ts           # CRUD + sync log
├── lib/
│   ├── git.ts                # git init, .gitignore, passthrough
│   ├── sync.ts               # S3 incremental sync
│   ├── project-context.ts    # Agent handoff context
│   ├── setup-machine.ts      # Machine readiness checks
│   ├── stale.ts              # Stale project/workdir/tmux findings
│   ├── import.ts             # Import existing projects
│   ├── github.ts             # GitHub publish via gh CLI
│   └── scheduler.ts          # Cron auto-sync
├── mcp/
│   └── index.ts              # MCP server (all tools)
├── types/
│   └── index.ts              # Types + error classes
└── index.ts                  # SDK exports
```

## Data model

**projects** — `id` (`prj_` + nanoid12), `slug`, `name`, `description`, `status`, `path`, `s3_bucket`, `s3_prefix`, `git_remote`, `tags`, `integrations`, `created_at`, `updated_at`, `synced_at`

**project_files** — `project_id`, `relative_path`, `size`, `hash`, `synced_at`

**sync_log** — `project_id`, `direction`, `status`, `files_synced`, `bytes`, `error`, `started_at`, `completed_at`

DB path: `~/.hasna/projects/projects.db` (override: `HASNA_PROJECTS_DB_PATH`)

## Ecosystem integration

`projects_create` returns `post_create_actions` — an array of MCP calls the agent should make to register the project with:

- **open-todos** (`mcp__todos__create_project`) — task tracking
- **open-mementos** (`mcp__mementos__register_project`) — persistent memory
- **open-conversations** (`mcp__conversations__create_space`) — team coordination (optional)

After each call, use `projects_link` to store the returned IDs in the project record and `.project.json`.

## S3 sync

- S3 path: `s3://{bucket}/{prefix}/projects/{project-id}/{relative-path}`
- Incremental: compares local MD5 vs S3 ETag, skips unchanged files
- Skips files >100MB
- Includes `.git/` for full restorability
- Writes sync history to `sync_log` table

## License

Apache-2.0
