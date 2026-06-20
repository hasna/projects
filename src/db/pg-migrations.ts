export const PG_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS roots (
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
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS recipes (
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
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('human', 'ai', 'service', 'cli')),
    provider TEXT,
    model TEXT,
    role TEXT,
    permissions TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS tmux_profiles (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    session_template TEXT NOT NULL DEFAULT '{slug}',
    attach BOOLEAN NOT NULL DEFAULT FALSE,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS workspaces (
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
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text,
    synced_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_locations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'main',
    kind TEXT NOT NULL DEFAULT 'local',
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    exists_at_create BOOLEAN NOT NULL DEFAULT FALSE,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    UNIQUE(workspace_id, path, machine_id)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_agents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'contributor',
    assigned_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    UNIQUE(workspace_id, agent_id, role)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_events (
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
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS agent_runs (
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
    started_at TEXT NOT NULL DEFAULT NOW()::text,
    completed_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS project_budgets (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('project', 'run')),
    scope_id TEXT NOT NULL,
    window TEXT NOT NULL CHECK(window IN ('daily', 'monthly', 'lifetime')),
    mode TEXT NOT NULL DEFAULT 'hard' CHECK(mode IN ('hard', 'soft')),
    max_usd DOUBLE PRECISION,
    max_input_tokens INTEGER,
    max_output_tokens INTEGER,
    max_total_tokens INTEGER,
    warning_threshold DOUBLE PRECISION,
    reset_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS project_budget_spend (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    run_id TEXT,
    provider TEXT,
    model TEXT,
    usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS tmux_profile_windows (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES tmux_profiles(id) ON DELETE CASCADE,
    window_name_template TEXT NOT NULL,
    path_template TEXT,
    command TEXT,
    window_index INTEGER,
    detached BOOLEAN NOT NULL DEFAULT TRUE,
    env TEXT NOT NULL DEFAULT '{}',
    revive BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    UNIQUE(profile_id, window_name_template)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_tmux_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    profile_id TEXT REFERENCES tmux_profiles(id) ON DELETE SET NULL,
    session_name TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    UNIQUE(workspace_id, session_name)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_locks (
    id TEXT PRIMARY KEY,
    lock_key TEXT UNIQUE NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    expires_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_migration_map (
    old_project_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    migrated_at TEXT NOT NULL DEFAULT NOW()::text,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE INDEX IF NOT EXISTS idx_roots_slug ON roots(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_roots_base_path ON roots(base_path)`,
  `CREATE INDEX IF NOT EXISTS idx_recipes_slug ON recipes(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status)`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_root ON workspaces(root_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_primary_path ON workspaces(primary_path)`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_locations_workspace ON workspace_locations(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_locations_machine ON workspace_locations(machine_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_events_workspace ON workspace_events(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_events_agent ON workspace_events(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_events_type ON workspace_events(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace ON agent_runs(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_project_budgets_scope ON project_budgets(scope_type, scope_id)`,
  `CREATE INDEX IF NOT EXISTS idx_project_budget_spend_workspace ON project_budget_spend(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_project_budget_spend_run ON project_budget_spend(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tmux_profiles_slug ON tmux_profiles(slug)`,
];
