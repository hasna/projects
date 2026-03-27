/**
 * PostgreSQL migrations for open-projects cloud sync.
 * Mirror of the SQLite schema in schema.ts, translated for PostgreSQL.
 */
export const PG_MIGRATIONS: string[] = [
  // Migration 1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    path TEXT NOT NULL,
    s3_bucket TEXT,
    s3_prefix TEXT,
    git_remote TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    integrations TEXT NOT NULL DEFAULT '{}',
    last_opened_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    synced_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS project_workdirs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'main',
    is_primary INTEGER NOT NULL DEFAULT 0,
    claude_md_generated INTEGER NOT NULL DEFAULT 0,
    agents_md_generated INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, path)
  );

  CREATE TABLE IF NOT EXISTS project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    synced_at TIMESTAMPTZ,
    UNIQUE(project_id, relative_path)
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK(direction IN ('push', 'pull', 'both')),
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed')),
    files_synced INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
  CREATE INDEX IF NOT EXISTS idx_workdirs_project ON project_workdirs(project_id);
  CREATE INDEX IF NOT EXISTS idx_workdirs_machine ON project_workdirs(machine_id);
  CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);
  CREATE INDEX IF NOT EXISTS idx_sync_log_project ON sync_log(project_id);

  INSERT INTO _migrations (id) VALUES (1) ON CONFLICT DO NOTHING;
  `,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runPgMigrations(pg: any): Promise<void> {
  await pg.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (let i = 0; i < PG_MIGRATIONS.length; i++) {
    const migrationId = i + 1;
    const exists = await pg.get(`SELECT id FROM _migrations WHERE id = ${migrationId}`);
    if (!exists) {
      await pg.run(PG_MIGRATIONS[i]!);
    }
  }
}
