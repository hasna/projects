import type { Database } from "bun:sqlite";

export const MIGRATIONS: string[] = [
  // Migration 1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    path TEXT UNIQUE NOT NULL,
    s3_bucket TEXT,
    s3_prefix TEXT,
    git_remote TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    synced_at TEXT,
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
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
  CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
  CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);
  CREATE INDEX IF NOT EXISTS idx_sync_log_project ON sync_log(project_id);
  CREATE INDEX IF NOT EXISTS idx_sync_log_status ON sync_log(status);

  INSERT OR IGNORE INTO _migrations (id) VALUES (1);
  `,

  // Migration 2: Add integrations column
  `
  ALTER TABLE projects ADD COLUMN integrations TEXT NOT NULL DEFAULT '{}';
  INSERT OR IGNORE INTO _migrations (id) VALUES (2);
  `,
];

export function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const migrationId = i + 1;
    const exists = db
      .query("SELECT id FROM _migrations WHERE id = ?")
      .get(migrationId);
    if (!exists) {
      db.run(MIGRATIONS[i]!);
    }
  }
}
