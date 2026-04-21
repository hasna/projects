import type { Database, SQLQueryBindings } from "bun:sqlite";
import { customAlphabet } from "nanoid";
import type {
  CreateProjectInput,
  UpdateProjectInput,
  Project,
  ProjectRow,
  ProjectFilter,
  ProjectIntegrations,
  SyncLog,
  SyncLogRow,
  SyncDirection,
} from "../types/index.js";
import {
  ProjectNotFoundError,
  ProjectSlugConflictError,
  ProjectPathConflictError,
} from "../types/index.js";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, now, uuid } from "./database.js";
import { gitInit, isGitRepo } from "../lib/git.js";
import { getConfig } from "../lib/config.js";
import { addWorkdir, getMachineId } from "./workdirs.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

export function generateProjectId(): string {
  return `prj_${nanoid()}`;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function scaffoldProject(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(path, { recursive: true });
  const config = getConfig();
  for (const dir of config.scaffold_dirs || ["data", "scripts", "assets", "docs"]) {
    mkdirSync(join(path, dir), { recursive: true });
  }
}

function ensureUniqueSlug(base: string, db: Database, excludeId?: string): string {
  let candidate = base;
  let suffix = 1;
  while (true) {
    const row = db
      .query("SELECT id FROM projects WHERE slug = ?")
      .get(candidate) as { id: string } | null;
    if (!row || row.id === excludeId) return candidate;
    suffix++;
    candidate = `${base}-${suffix}`;
  }
}

function rowToProject(row: ProjectRow): Project {
  return {
    ...row,
    status: row.status as Project["status"],
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    integrations: row.integrations ? (JSON.parse(row.integrations) as ProjectIntegrations) : {},
    last_opened_at: row.last_opened_at ?? null,
  };
}

export function createProject(input: CreateProjectInput, db?: Database): Project {
  const d = db || getDatabase();
  const id = generateProjectId();
  const ts = now();
  const baseSlug = input.slug || slugify(input.name);
  const slug = ensureUniqueSlug(baseSlug, d);

  // Check path uniqueness
  const existing = d
    .query("SELECT id FROM projects WHERE path = ?")
    .get(input.path) as { id: string } | null;
  if (existing) throw new ProjectPathConflictError(input.path);

  d.run(
    `INSERT INTO projects (id, slug, name, description, status, path, s3_bucket, s3_prefix, git_remote, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slug,
      input.name,
      input.description ?? null,
      input.path,
      input.s3_bucket ?? null,
      input.s3_prefix ?? null,
      input.git_remote ?? null,
      JSON.stringify(input.tags ?? []),
      ts,
      ts,
    ],
  );

  const project = getProject(id, d)!;

  // Scaffold directory if path doesn't exist yet
  scaffoldProject(input.path);

  // Auto-register primary workdir for this machine
  try {
    addWorkdir({ project_id: id, path: input.path, label: "main", is_primary: true }, d);
  } catch {
    // Non-fatal
  }

  // Auto-init git repo unless explicitly disabled
  const shouldGitInit = input.git_init !== false;
  if (shouldGitInit) {
    try {
      gitInit(project);
    } catch {
      // Non-fatal — project is registered even if git init fails
    }
  }

  return getProject(id, d)!;
}

export function getProject(id: string, db?: Database): Project | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | null;
  return row ? rowToProject(row) : null;
}

export function getProjectBySlug(slug: string, db?: Database): Project | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM projects WHERE slug = ?")
    .get(slug) as ProjectRow | null;
  return row ? rowToProject(row) : null;
}

export function getProjectByPath(path: string, db?: Database): Project | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM projects WHERE path = ?")
    .get(path) as ProjectRow | null;
  return row ? rowToProject(row) : null;
}

export function listProjects(filter: ProjectFilter = {}, db?: Database): Project[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;

  let rows = d
    .query(`SELECT * FROM projects ${where} ORDER BY name ASC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ProjectRow[];

  // Filter by tags in memory (tags stored as JSON array)
  if (filter.tags && filter.tags.length > 0) {
    rows = rows.filter((row) => {
      const rowTags: string[] = row.tags ? (JSON.parse(row.tags) as string[]) : [];
      return filter.tags!.every((t) => rowTags.includes(t));
    });
  }

  return rows.map(rowToProject);
}

export function updateProject(
  id: string,
  input: UpdateProjectInput,
  db?: Database,
): Project {
  const d = db || getDatabase();
  const project = getProject(id, d);
  if (!project) throw new ProjectNotFoundError(id);

  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name);
    // Also update slug to stay in sync with name
    const newSlug = ensureUniqueSlug(slugify(input.name), d, id);
    sets.push("slug = ?");
    params.push(newSlug);
  }
  if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
  if (input.path !== undefined) { sets.push("path = ?"); params.push(input.path); }
  if (input.tags !== undefined) { sets.push("tags = ?"); params.push(JSON.stringify(input.tags)); }
  if ("s3_bucket" in input) { sets.push("s3_bucket = ?"); params.push(input.s3_bucket ?? null); }
  if ("s3_prefix" in input) { sets.push("s3_prefix = ?"); params.push(input.s3_prefix ?? null); }
  if ("git_remote" in input) { sets.push("git_remote = ?"); params.push(input.git_remote ?? null); }
  if ("integrations" in input && input.integrations !== undefined) {
    sets.push("integrations = ?");
    params.push(JSON.stringify(input.integrations));
  }

  if (sets.length === 0) return project;

  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);

  d.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, params);
  return getProject(id, d)!;
}

// Merge new integration IDs into existing integrations (non-destructive)
export function setIntegrations(
  id: string,
  integrations: ProjectIntegrations,
  db?: Database,
): Project {
  const d = db || getDatabase();
  const project = getProject(id, d);
  if (!project) throw new ProjectNotFoundError(id);
  const merged = { ...project.integrations, ...integrations };
  d.run("UPDATE projects SET integrations = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(merged),
    now(),
    id,
  ]);
  // Also update .project.json if it exists
  try {
    const jsonPath = join(project.path, ".project.json");
    if (existsSync(jsonPath)) {
      const existing = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
      writeFileSync(jsonPath, JSON.stringify({ ...existing, integrations: merged }, null, 2) + "\n", "utf-8");
    }
  } catch {
    // Non-fatal
  }
  return getProject(id, d)!;
}

export function archiveProject(id: string, db?: Database): Project {
  const d = db || getDatabase();
  const project = getProject(id, d);
  if (!project) throw new ProjectNotFoundError(id);
  d.run("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?", [now(), id]);
  return getProject(id, d)!;
}

export function unarchiveProject(id: string, db?: Database): Project {
  const d = db || getDatabase();
  const project = getProject(id, d);
  if (!project) throw new ProjectNotFoundError(id);
  d.run("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?", [now(), id]);
  return getProject(id, d)!;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
  return dp[m]![n]!;
}

// Resolve id-or-slug to a full project: exact → slug → partial ID → substring → Levenshtein
export function resolveProject(idOrSlug: string, db?: Database): Project | null {
  const d = db || getDatabase();

  // 1. Exact ID
  let project = getProject(idOrSlug, d);
  if (project) return project;

  // 2. Exact slug
  project = getProjectBySlug(idOrSlug, d);
  if (project) return project;

  // 3. Partial ID prefix
  const prefixRow = d
    .query("SELECT id FROM projects WHERE id LIKE ? LIMIT 1")
    .get(`${idOrSlug}%`) as { id: string } | null;
  if (prefixRow) return getProject(prefixRow.id, d);

  // 4. Exact name match
  const nameRow = d
    .query("SELECT id FROM projects WHERE name = ? LIMIT 1")
    .get(idOrSlug) as { id: string } | null;
  if (nameRow) return getProject(nameRow.id, d);

  // 5. Substring match on slug or name
  const subRow = d
    .query("SELECT id FROM projects WHERE slug LIKE ? OR name LIKE ? ORDER BY length(slug) ASC LIMIT 1")
    .get(`%${idOrSlug}%`, `%${idOrSlug}%`) as { id: string } | null;
  if (subRow) return getProject(subRow.id, d);

  // 6. Levenshtein ≤ 2 on slug
  const allRows = d.query("SELECT id, slug FROM projects WHERE status = 'active'").all() as { id: string; slug: string }[];
  const best = allRows
    .map((r) => ({ id: r.id, dist: levenshtein(idOrSlug, r.slug) }))
    .filter((r) => r.dist <= 2)
    .sort((a, b) => a.dist - b.dist)[0];
  return best ? getProject(best.id, d) : null;
}

// Sync log helpers
function syncRowToLog(row: SyncLogRow): SyncLog {
  return { ...row, direction: row.direction as SyncDirection, status: row.status as SyncLog["status"] };
}

export function startSyncLog(
  projectId: string,
  direction: SyncDirection,
  db?: Database,
): SyncLog {
  const d = db || getDatabase();
  const id = uuid();
  const ts = now();
  d.run(
    "INSERT INTO sync_log (id, project_id, direction, status, started_at) VALUES (?, ?, ?, 'running', ?)",
    [id, projectId, direction, ts],
  );
  return d.query("SELECT * FROM sync_log WHERE id = ?").get(id) as SyncLog;
}

export function completeSyncLog(
  id: string,
  result: { files_synced?: number; bytes?: number; error?: string },
  db?: Database,
): SyncLog {
  const d = db || getDatabase();
  const status = result.error ? "failed" : "completed";
  d.run(
    "UPDATE sync_log SET status = ?, files_synced = ?, bytes = ?, error = ?, completed_at = ? WHERE id = ?",
    [status, result.files_synced ?? 0, result.bytes ?? 0, result.error ?? null, now(), id],
  );
  const row = d.query("SELECT * FROM sync_log WHERE id = ?").get(id) as SyncLogRow;
  return syncRowToLog(row);
}

export function listSyncLogs(projectId: string, limit = 20, db?: Database): SyncLog[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM sync_log WHERE project_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(projectId, limit) as SyncLogRow[];
  return rows.map(syncRowToLog);
}
