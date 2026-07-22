import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export const MIGRATIONS: string[] = [
  // Migration 1-4 were legacy project-only schemas. Fresh databases no longer create them.
  `
  INSERT OR IGNORE INTO _migrations (id) VALUES (1);
  `,

  `
  INSERT OR IGNORE INTO _migrations (id) VALUES (2);
  `,

  `
  INSERT OR IGNORE INTO _migrations (id) VALUES (3);
  `,

  `
  INSERT OR IGNORE INTO _migrations (id) VALUES (4);
  `,

  // Migration 5: Generic workspace/root/recipe/agent domain
  `
  CREATE TABLE IF NOT EXISTS roots (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    base_path TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    default_kind TEXT,
    default_recipe_id TEXT,
    default_tmux_profile_id TEXT,
    github_org TEXT,
    repo_visibility TEXT CHECK(repo_visibility IS NULL OR repo_visibility IN ('public', 'private')),
    path_template TEXT,
    name_template TEXT,
    allowed_recipes TEXT NOT NULL DEFAULT '[]',
    allowed_agents TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    steps TEXT NOT NULL DEFAULT '[]',
    variables TEXT NOT NULL DEFAULT '{}',
    default_tags TEXT NOT NULL DEFAULT '[]',
    default_tmux_profile_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('human', 'ai', 'service', 'cli')),
    provider TEXT,
    model TEXT,
    role TEXT,
    permissions TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL DEFAULT 'generic',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'deleted')),
    root_id TEXT REFERENCES roots(id) ON DELETE SET NULL,
    recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
    primary_path TEXT UNIQUE,
    git_remote TEXT,
    s3_bucket TEXT,
    s3_prefix TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    integrations TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    last_opened_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS workspace_locations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'main',
    kind TEXT NOT NULL DEFAULT 'local',
    is_primary INTEGER NOT NULL DEFAULT 0,
    exists_at_create INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workspace_id, path, machine_id)
  );

  CREATE TABLE IF NOT EXISTS workspace_agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'contributor',
    assigned_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workspace_id, agent_id, role)
  );

  CREATE TABLE IF NOT EXISTS workspace_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('cli', 'mcp', 'agent', 'migration', 'system')),
    prompt TEXT,
    command TEXT,
    before_json TEXT,
    after_json TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    provider TEXT,
    model TEXT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'running', 'completed', 'failed')),
    plan_json TEXT,
    tool_calls_json TEXT NOT NULL DEFAULT '[]',
    result_json TEXT,
    error TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS project_budgets (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('project', 'run')),
    scope_id TEXT NOT NULL,
    window TEXT NOT NULL CHECK(window IN ('daily', 'monthly', 'lifetime')),
    mode TEXT NOT NULL DEFAULT 'hard' CHECK(mode IN ('hard', 'soft')),
    max_usd REAL,
    max_input_tokens INTEGER,
    max_output_tokens INTEGER,
    max_total_tokens INTEGER,
    warning_threshold REAL,
    reset_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_budget_spend (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    run_id TEXT,
    provider TEXT,
    model TEXT,
    usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tmux_profiles (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    session_template TEXT NOT NULL DEFAULT '{slug}',
    attach INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tmux_profile_windows (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES tmux_profiles(id) ON DELETE CASCADE,
    window_name_template TEXT NOT NULL,
    path_template TEXT,
    command TEXT,
    window_index INTEGER,
    detached INTEGER NOT NULL DEFAULT 1,
    env TEXT NOT NULL DEFAULT '{}',
    revive INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(profile_id, window_name_template)
  );

  CREATE TABLE IF NOT EXISTS workspace_tmux_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    profile_id TEXT REFERENCES tmux_profiles(id) ON DELETE SET NULL,
    session_name TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workspace_id, session_name)
  );

  CREATE TABLE IF NOT EXISTS workspace_locks (
    id TEXT PRIMARY KEY,
    lock_key TEXT UNIQUE NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS workspace_migration_map (
    old_project_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    migrated_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_roots_slug ON roots(slug);
  CREATE INDEX IF NOT EXISTS idx_roots_base_path ON roots(base_path);
  CREATE INDEX IF NOT EXISTS idx_recipes_slug ON recipes(slug);
  CREATE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug);
  CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
  CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind);
  CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
  CREATE INDEX IF NOT EXISTS idx_workspaces_root ON workspaces(root_id);
  CREATE INDEX IF NOT EXISTS idx_workspaces_primary_path ON workspaces(primary_path);
  CREATE INDEX IF NOT EXISTS idx_workspace_locations_workspace ON workspace_locations(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_locations_machine ON workspace_locations(machine_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_events_workspace ON workspace_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_events_agent ON workspace_events(agent_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_events_type ON workspace_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
  CREATE INDEX IF NOT EXISTS idx_project_budgets_scope ON project_budgets(scope_type, scope_id);
  CREATE INDEX IF NOT EXISTS idx_project_budget_spend_workspace ON project_budget_spend(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_project_budget_spend_run ON project_budget_spend(run_id);
  CREATE INDEX IF NOT EXISTS idx_tmux_profiles_slug ON tmux_profiles(slug);

  INSERT OR IGNORE INTO _migrations (id) VALUES (5);
  `,

  // Migration 6: Project and run budget/cost control
  `
  CREATE TABLE IF NOT EXISTS project_budgets (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('project', 'run')),
    scope_id TEXT NOT NULL,
    window TEXT NOT NULL CHECK(window IN ('daily', 'monthly', 'lifetime')),
    mode TEXT NOT NULL DEFAULT 'hard' CHECK(mode IN ('hard', 'soft')),
    max_usd REAL,
    max_input_tokens INTEGER,
    max_output_tokens INTEGER,
    max_total_tokens INTEGER,
    warning_threshold REAL,
    reset_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_budget_spend (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    run_id TEXT,
    provider TEXT,
    model TEXT,
    usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_project_budgets_scope ON project_budgets(scope_type, scope_id);
  CREATE INDEX IF NOT EXISTS idx_project_budget_spend_workspace ON project_budget_spend(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_project_budget_spend_run ON project_budget_spend(run_id);

  INSERT OR IGNORE INTO _migrations (id) VALUES (6);
  `,

  // Migration 7: canonical project identity bindings and authority idempotency.
  // The data backfill is performed by migrateProjectIdentityBindings below so
  // real paths can be resolved safely and historical collisions can be
  // audited without selecting a winner.
  `
  CREATE TABLE IF NOT EXISTS workspace_identity_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    location_owner_id TEXT NOT NULL,
    real_path TEXT NOT NULL,
    logical_path TEXT,
    station_id TEXT,
    machine_id TEXT,
    source TEXT NOT NULL DEFAULT 'location',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(location_owner_id, real_path),
    UNIQUE(workspace_id, location_owner_id, real_path)
  );

  CREATE TABLE IF NOT EXISTS project_identity_migration_audit (
    id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    location_owner_id TEXT NOT NULL,
    real_path TEXT NOT NULL,
    workspace_ids TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_idempotency (
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(operation, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS idx_workspace_identity_workspace
    ON workspace_identity_bindings(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_project_identity_audit_owner_path
    ON project_identity_migration_audit(location_owner_id, real_path);

  `,
];

function canonicalMigrationPath(path: string): string {
  const logical = resolve(path);
  if (!existsSync(logical)) return logical;
  try {
    return realpathSync.native(logical);
  } catch {
    return logical;
  }
}

interface HistoricalLocationRow {
  workspace_id: string;
  path: string;
  machine_id: string;
  workspace_exists: number;
}

interface HistoricalPrimaryPathRow {
  workspace_id: string;
  primary_path: string;
}

/**
 * Backfill canonical identity bindings. A machine+realpath group that maps to
 * multiple projects is written to the audit table and deliberately left
 * unbound; choosing either project would silently corrupt identity.
 */
export function migrateProjectIdentityBindings(db: Database): void {
  const table = db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_locations'",
  ).get();
  if (!table) return;

  const rows = db.query(
    `SELECT loc.workspace_id, loc.path, loc.machine_id,
            CASE WHEN w.id IS NULL THEN 0 ELSE 1 END AS workspace_exists
     FROM workspace_locations loc
     LEFT JOIN workspaces w ON w.id = loc.workspace_id
     ORDER BY loc.machine_id, loc.path, loc.workspace_id`,
  ).all() as HistoricalLocationRow[];
  const locationPaths = new Set<string>();
  const groups = new Map<string, {
    owner: string;
    realPath: string;
    logicalPaths: string[];
    workspaceIds: Set<string>;
  }>();
  for (const row of rows) {
    const owner = row.machine_id.trim();
    if (!owner || !row.path.trim()) continue;
    const realPath = canonicalMigrationPath(row.path);
    locationPaths.add(`${row.workspace_id}\0${realPath}`);
    if (!row.workspace_exists) {
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["orphan", owner, realPath, row.workspace_id]))
        .digest("hex");
      db.run(
        `INSERT OR IGNORE INTO project_identity_migration_audit (
          id, reason, location_owner_id, real_path, workspace_ids, details
        ) VALUES (?, 'historical_orphan_location', ?, ?, ?, ?)`,
        [
          `identity_orphan_${fingerprint}`,
          owner,
          realPath,
          JSON.stringify([row.workspace_id]),
          JSON.stringify({ logical_path: resolve(row.path) }),
        ],
      );
      continue;
    }
    const key = `${owner}\0${realPath}`;
    const group = groups.get(key) ?? {
      owner,
      realPath,
      logicalPaths: [],
      workspaceIds: new Set<string>(),
    };
    group.logicalPaths.push(resolve(row.path));
    group.workspaceIds.add(row.workspace_id);
    groups.set(key, group);
  }

  const workspaceColumns = db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  if (workspaceColumns.some((column) => column.name === "primary_path")) {
    const primaryPaths = db.query(
      `SELECT id AS workspace_id, primary_path
       FROM workspaces
       WHERE primary_path IS NOT NULL AND trim(primary_path) <> ''
       ORDER BY id`,
    ).all() as HistoricalPrimaryPathRow[];
    for (const row of primaryPaths) {
      const realPath = canonicalMigrationPath(row.primary_path);
      if (locationPaths.has(`${row.workspace_id}\0${realPath}`)) continue;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["unattested-primary-path", row.workspace_id, realPath]))
        .digest("hex");
      db.run(
        `INSERT OR IGNORE INTO project_identity_migration_audit (
          id, reason, location_owner_id, real_path, workspace_ids, details
        ) VALUES (?, 'historical_primary_path_unattested', 'unknown', ?, ?, ?)`,
        [
          `identity_unattested_${fingerprint}`,
          realPath,
          JSON.stringify([row.workspace_id]),
          JSON.stringify({ logical_path: resolve(row.primary_path) }),
        ],
      );
    }
  }

  const migrate = db.transaction(() => {
    for (const group of groups.values()) {
      const workspaceIds = [...group.workspaceIds].sort();
      if (workspaceIds.length > 1) {
        db.run(
          "DELETE FROM workspace_identity_bindings WHERE location_owner_id = ? AND real_path = ?",
          [group.owner, group.realPath],
        );
        const fingerprint = createHash("sha256")
          .update(JSON.stringify([group.owner, group.realPath, workspaceIds]))
          .digest("hex");
        db.run(
          `INSERT OR IGNORE INTO project_identity_migration_audit (
            id, reason, location_owner_id, real_path, workspace_ids, details
          ) VALUES (?, 'historical_identity_collision', ?, ?, ?, ?)`,
          [
            `identity_collision_${fingerprint}`,
            group.owner,
            group.realPath,
            JSON.stringify(workspaceIds),
            JSON.stringify({ logical_paths: [...new Set(group.logicalPaths)].sort() }),
          ],
        );
        continue;
      }
      const workspaceId = workspaceIds[0];
      if (!workspaceId) continue;
      db.run(
        `INSERT INTO workspace_identity_bindings (
          workspace_id, location_owner_id, real_path, logical_path, machine_id, source
        ) VALUES (?, ?, ?, ?, ?, 'migration')
        ON CONFLICT(workspace_id, location_owner_id, real_path) DO UPDATE SET
          logical_path = excluded.logical_path,
          machine_id = excluded.machine_id,
          updated_at = datetime('now')`,
        [workspaceId, group.owner, group.realPath, group.logicalPaths[0] ?? null, group.owner],
      );
    }
  });
  migrate();
}

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
      if (migrationId === 7) {
        const applyIdentityMigration = db.transaction(() => {
          db.run(MIGRATIONS[i]!);
          migrateProjectIdentityBindings(db);
          db.run("INSERT INTO _migrations (id) VALUES (7)");
        });
        applyIdentityMigration();
      } else {
        db.run(MIGRATIONS[i]!);
      }
    }
  }
}
