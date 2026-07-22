-- Canonical project-context identity and create idempotency.
--
-- Historical workspace_locations contain machine-scoped logical paths but no
-- separately attested realpath. They are audit evidence only: PostgreSQL
-- cannot prove filesystem canonicalization, even when one stored path maps to
-- one project. Subsequent clients establish explicit machine+realpath bindings.

ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_primary_path_key;

CREATE TABLE IF NOT EXISTS project_idempotency (
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS workspace_identity_bindings (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  location_owner_id TEXT NOT NULL,
  real_path TEXT NOT NULL,
  logical_path TEXT,
  station_id TEXT,
  machine_id TEXT,
  source TEXT NOT NULL DEFAULT 'authority',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(location_owner_id, real_path),
  UNIQUE(workspace_id, location_owner_id, real_path)
);

CREATE TABLE IF NOT EXISTS project_identity_migration_audit (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  location_owner_id TEXT NOT NULL,
  real_path TEXT NOT NULL,
  workspace_ids JSONB NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO project_identity_migration_audit (
  id,
  reason,
  location_owner_id,
  real_path,
  workspace_ids,
  details
)
SELECT
  'identity_collision_' || md5(machine_id || chr(31) || path),
  'historical_identity_collision',
  machine_id,
  path,
  jsonb_agg(DISTINCT workspace_id ORDER BY workspace_id),
  jsonb_build_object('source', 'workspace_locations', 'binding_created', false)
FROM workspace_locations
GROUP BY machine_id, path
HAVING COUNT(DISTINCT workspace_id) > 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO project_identity_migration_audit (
  id,
  reason,
  location_owner_id,
  real_path,
  workspace_ids,
  details
)
SELECT
  'unattested_location_' || md5(machine_id || chr(31) || path),
  'historical_location_unattested',
  machine_id,
  path,
  jsonb_agg(DISTINCT workspace_id ORDER BY workspace_id),
  jsonb_build_object(
    'source', 'workspace_locations',
    'binding_created', false,
    'reason', 'stored logical path is not an attested realpath'
  )
FROM workspace_locations
GROUP BY machine_id, path
HAVING COUNT(DISTINCT workspace_id) = 1
ON CONFLICT (id) DO NOTHING;

-- A legacy primary_path without an exact machine-scoped location cannot be
-- promoted to a canonical machine+realpath binding safely. Preserve it as a
-- fail-closed audit record; the authority rejects reuse until an operator or
-- attested client establishes the missing binding.
INSERT INTO project_identity_migration_audit (
  id,
  reason,
  location_owner_id,
  real_path,
  workspace_ids,
  details
)
SELECT
  'unbound_primary_path_' || md5(w.id || chr(31) || w.primary_path),
  'historical_primary_path_unbound',
  'unresolved-primary-path',
  w.primary_path,
  jsonb_build_array(w.id),
  jsonb_build_object('source', 'workspaces.primary_path', 'binding_created', false)
FROM workspaces w
WHERE w.primary_path IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM workspace_identity_bindings binding
    WHERE binding.workspace_id = w.id
      AND (binding.logical_path = w.primary_path OR binding.real_path = w.primary_path)
  )
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_workspace_identity_workspace
  ON workspace_identity_bindings(workspace_id);
CREATE INDEX IF NOT EXISTS idx_project_idempotency_updated
  ON project_idempotency(updated_at);
CREATE INDEX IF NOT EXISTS idx_project_identity_audit_owner_path
  ON project_identity_migration_audit(location_owner_id, real_path);
