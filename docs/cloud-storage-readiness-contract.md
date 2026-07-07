# Cloud Storage Readiness Contract

This contract describes what is cloud-ready in `@hasna/projects` today and what
still requires an approval-backed migration task. It is intentionally narrower
than a cutover plan: no production AWS, RDS, S3, secret, Terraform, or live data
mutation is allowed by this document.

## Runtime Selection

Default runtime storage is local.

| Surface | Local runtime | Remote runtime today | Cloud-backed blocker |
| --- | --- | --- | --- |
| Global project registry | `HASNA_PROJECTS_DB_PATH` or `~/.hasna/projects/projects.db` SQLite | PostgreSQL is available only through explicit `projects storage push`, `pull`, and `sync` | Runtime reads/writes still use local SQLite until a future runtime adapter changes that contract |
| Per-project app store | `$HASNA_PROJECTS_HOME/data/<workspace_id>/project.db` SQLite | Not active | Requires approved Postgres schema, migration plan, and backfill for `project_canvases`, `project_data_models`, `project_data_records`, and `project_loop_links` |
| Project assets and canvas files | `$HASNA_PROJECTS_HOME/data/<workspace_id>/{assets,canvases}` local files | Not active | Requires approved S3 adapter, key contract, backfill, and rollback plan |

`projects storage status --json` exposes this as
`readiness.cloudBackedRuntimeReady`, `readiness.surfaces`, and per-surface
`migration` blockers. A configured `HASNA_PROJECTS_DATABASE_URL` means the
global registry sync target is configured; it does not make `project.db` or
local asset folders cloud-backed.

## Adapter Rules

- Local mode is selected when no remote database URL is configured.
- Hybrid mode is selected when `HASNA_PROJECTS_DATABASE_URL` or
  `PROJECTS_DATABASE_URL` is configured without an explicit storage mode.
- `HASNA_PROJECTS_STORAGE_MODE=remote` records an operator request, but the
  current runtime still uses local SQLite for project registry operations and
  local `project.db` for canvas/data/loop-link operations.
- Remote PostgreSQL writes are limited to explicit storage sync commands and
  the tables listed by `PROJECTS_STORAGE_TABLES`.
- `workspaces.s3_bucket` and `workspaces.s3_prefix` are registry metadata only;
  they do not imply an active S3 asset adapter.

## Migration Approval Gate

A follow-up approval task is required before any of these actions:

- create or mutate production RDS schemas for per-project app store tables
- backfill real `project.db` data into Postgres
- create, select, or write production S3 buckets or object prefixes
- move user project data from local files to cloud storage
- change runtime reads/writes from local SQLite/local files to remote services

The approval task should include source data inventory, dry-run output, rollback
steps, read-only smoke evidence, secret provisioning evidence without secret
values, and a maintenance window.
