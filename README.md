# open-projects

Project management CLI + MCP server for AI agents. Register projects once, open them anywhere, sync to S3, auto-init git, and wire into the `hasna` ecosystem (todos, mementos, conversations).

## Install

```bash
bun install -g @hasna/open-projects
```

## CLI

```bash
# Register a project
projects create --name my-app --path /path/to/my-app

# List projects
projects list
projects list --status archived

# Get details
projects get my-app

# Open a project (cd into it)
cd $(projects open my-app)

# Update metadata
projects update my-app --description "My app" --tags "web,ts"

# Archive / unarchive
projects archive my-app
projects unarchive my-app

# Import existing directories
projects import /path/to/existing-project
projects import-bulk /path/to/workspace     # imports all subdirs

# Sync to/from S3
projects update my-app --s3-bucket my-bucket
projects sync my-app
projects sync my-app --direction push
projects sync-all                           # sync all projects with S3 configured

# Schedule auto-sync
projects schedule set --interval daily --direction both
projects schedule status
projects schedule remove

# Publish to GitHub
projects publish my-app --org hasnaxyz
projects unpublish my-app

# Git passthrough
projects git my-app status
projects git my-app log --oneline -10

# Shell completion
eval "$(projects completion)"          # bash
eval "$(projects completion --shell zsh)"  # zsh
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
| `projects_list` | List projects, filter by status |
| `projects_get` | Get project by ID or slug. Returns `workingDirectory` |
| `projects_update` | Update project metadata |
| `projects_archive` | Archive a project |
| `projects_open` | Get `workingDirectory` for a project |
| `projects_sync` | Sync to/from S3 (incremental, by file hash) |
| `projects_sync_all` | Sync all active projects with S3 configured |
| `projects_link` | Store integration IDs (todos, mementos, conversations, files) |
| `projects_import` | Import an existing directory as a project |
| `projects_import_bulk` | Import all subdirectories of a path |
| `projects_publish` | Create GitHub repo, add remote, push |
| `projects_schedule_set` | Enable cron-based auto-sync |
| `projects_schedule_status` | Get current schedule config |
| `projects_sync_log` | List recent sync history |

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
