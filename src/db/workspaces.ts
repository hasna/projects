import type { Database, SQLQueryBindings } from "bun:sqlite";
import { customAlphabet } from "nanoid";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getDatabase, now, uuid } from "./database.js";
import { assertProjectWorkspaceId, projectWorkspaceStorePath } from "../lib/project-store-paths.js";
import type {
  Agent,
  AgentRow,
  AgentRun,
  AgentRunRow,
  CreateAgentInput,
  CreateRecipeInput,
  CreateRootInput,
  CreateTmuxProfileInput,
  CreateTmuxProfileWindowInput,
  CreateWorkspaceInput,
  EventSource,
  JsonObject,
  Recipe,
  RecipeRow,
  RecordWorkspaceEventInput,
  Root,
  RootRow,
  TmuxProfile,
  TmuxProfileRow,
  TmuxProfileWindow,
  TmuxProfileWindowRow,
  UpdateWorkspaceInput,
  UpdateRootInput,
  Workspace,
  WorkspaceAgentAssignment,
  WorkspaceAgentAssignmentRow,
  WorkspaceEvent,
  WorkspaceEventRow,
  WorkspaceIntegrations,
  WorkspaceKind,
  WorkspaceLocation,
  WorkspaceLocationRow,
  WorkspaceLock,
  WorkspaceLockRow,
  WorkspaceRow,
  WorkspaceStatus,
} from "../types/workspace.js";

const nanoid = customAlphabet(`0123456789${"abcdefghijklmnopqrstuvwxyz"}`, 12);

export function generateWorkspaceId(): string { return `wks_${nanoid()}`; }
export function generateRootId(): string { return `root_${nanoid()}`; }
export function generateRecipeId(): string { return `rcp_${nanoid()}`; }
export function generateAgentId(): string { return `agt_${nanoid()}`; }
export function generateWorkspaceEventId(): string { return `evt_${nanoid()}`; }
export function generateAgentRunId(): string { return `run_${nanoid()}`; }
export function generateLocationId(): string { return `loc_${nanoid()}`; }
export function generateTmuxProfileId(): string { return `tmp_${nanoid()}`; }
export function generateTmuxProfileWindowId(): string { return `tmw_${nanoid()}`; }
export function generateWorkspaceLockId(): string { return `lock_${nanoid()}`; }

export function workspaceSlugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function ensureUniqueSlug(table: string, base: string, db: Database, excludeId?: string): string {
  const safeBase = base || "workspace";
  let candidate = safeBase;
  let suffix = 1;
  while (true) {
    const row = db
      .query(`SELECT id FROM ${table} WHERE slug = ?`)
      .get(candidate) as { id: string } | null;
    if (!row || row.id === excludeId) return candidate;
    suffix++;
    candidate = `${safeBase}-${suffix}`;
  }
}

function rowToRoot(row: RootRow): Root {
  return {
    ...row,
    tags: parseJson<string[]>(row.tags, []),
    default_kind: row.default_kind as Root["default_kind"],
    repo_visibility: row.repo_visibility as Root["repo_visibility"],
    allowed_recipes: parseJson<string[]>(row.allowed_recipes, []),
    allowed_agents: parseJson<string[]>(row.allowed_agents, []),
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToAgent(row: AgentRow): Agent {
  return {
    ...row,
    kind: row.kind as Agent["kind"],
    permissions: parseJson<string[]>(row.permissions, []),
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    ...row,
    kind: row.kind as Recipe["kind"],
    steps: parseJson<JsonObject[]>(row.steps, []),
    variables: parseJson<JsonObject>(row.variables, {}),
    default_tags: parseJson<string[]>(row.default_tags, []),
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    ...row,
    kind: row.kind as WorkspaceKind,
    status: row.status as WorkspaceStatus,
    tags: parseJson<string[]>(row.tags, []),
    integrations: parseJson<WorkspaceIntegrations>(row.integrations, {}),
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToLocation(row: WorkspaceLocationRow): WorkspaceLocation {
  return {
    ...row,
    is_primary: row.is_primary === 1,
    exists_at_create: row.exists_at_create === 1,
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToWorkspaceAgentAssignment(row: WorkspaceAgentAssignmentRow, db: Database): WorkspaceAgentAssignment {
  return {
    ...row,
    metadata: parseJson<JsonObject>(row.metadata, {}),
    agent: getAgent(row.agent_id, db),
  };
}

function rowToEvent(row: WorkspaceEventRow): WorkspaceEvent {
  return {
    ...row,
    source: row.source as WorkspaceEvent["source"],
    before_json: parseJson<JsonObject | null>(row.before_json, null),
    after_json: parseJson<JsonObject | null>(row.after_json, null),
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToAgentRun(row: AgentRunRow): AgentRun {
  return {
    ...row,
    status: row.status as AgentRun["status"],
    plan_json: parseJson<JsonObject | null>(row.plan_json, null),
    tool_calls_json: parseJson<JsonObject[]>(row.tool_calls_json, []),
    result_json: parseJson<JsonObject | null>(row.result_json, null),
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToTmuxProfile(row: TmuxProfileRow): TmuxProfile {
  return {
    ...row,
    attach: row.attach === 1,
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToTmuxProfileWindow(row: TmuxProfileWindowRow): TmuxProfileWindow {
  return {
    ...row,
    detached: row.detached === 1,
    env: parseJson<Record<string, string>>(row.env, {}),
    revive: row.revive === 1,
  };
}

function rowToWorkspaceLock(row: WorkspaceLockRow): WorkspaceLock {
  return row;
}

export function renderTemplate(template: string, values: Record<string, string | null | undefined>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => values[key] ?? "");
}

export function createRoot(input: CreateRootInput, db?: Database): Root {
  const d = db || getDatabase();
  const id = generateRootId();
  const ts = now();
  const slug = ensureUniqueSlug("roots", input.slug ?? workspaceSlugify(input.name), d);
  const basePath = resolve(input.base_path);

  d.run(
    `INSERT INTO roots (
      id, slug, name, base_path, tags, default_kind, default_recipe_id,
      default_tmux_profile_id, github_org, repo_visibility, path_template,
      name_template, allowed_recipes, allowed_agents, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slug,
      input.name,
      basePath,
      json(normalizeList(input.tags)),
      input.default_kind ?? null,
      input.default_recipe_id ?? null,
      input.default_tmux_profile_id ?? null,
      input.github_org ?? null,
      input.repo_visibility ?? null,
      input.path_template ?? null,
      input.name_template ?? null,
      json(normalizeList(input.allowed_recipes)),
      json(normalizeList(input.allowed_agents)),
      json(input.metadata ?? {}),
      ts,
      ts,
    ],
  );

  return getRoot(id, d)!;
}

export function getRoot(id: string, db?: Database): Root | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM roots WHERE id = ?").get(id) as RootRow | null;
  return row ? rowToRoot(row) : null;
}

export function getRootBySlug(slug: string, db?: Database): Root | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM roots WHERE slug = ?").get(slug) as RootRow | null;
  return row ? rowToRoot(row) : null;
}

export function listRoots(db?: Database): Root[] {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM roots ORDER BY slug ASC").all() as RootRow[]).map(rowToRoot);
}

export function updateRoot(id: string, input: UpdateRootInput, db?: Database): Root {
  const d = db || getDatabase();
  const before = getRoot(id, d);
  if (!before) throw new Error(`Root not found: ${id}`);
  const updates: string[] = [];
  const params: SQLQueryBindings[] = [];
  const set = (column: string, value: SQLQueryBindings) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  if (input.slug !== undefined) set("slug", ensureUniqueSlug("roots", workspaceSlugify(input.slug), d, id));
  if (input.name !== undefined) set("name", input.name);
  if (input.base_path !== undefined) set("base_path", resolve(input.base_path));
  if (input.tags !== undefined) set("tags", json(normalizeList(input.tags)));
  if (input.default_kind !== undefined) set("default_kind", input.default_kind);
  if (input.default_recipe_id !== undefined) set("default_recipe_id", input.default_recipe_id);
  if (input.default_tmux_profile_id !== undefined) set("default_tmux_profile_id", input.default_tmux_profile_id);
  if (input.github_org !== undefined) set("github_org", input.github_org);
  if (input.repo_visibility !== undefined) set("repo_visibility", input.repo_visibility);
  if (input.path_template !== undefined) set("path_template", input.path_template);
  if (input.name_template !== undefined) set("name_template", input.name_template);
  if (input.allowed_recipes !== undefined) set("allowed_recipes", json(normalizeList(input.allowed_recipes)));
  if (input.allowed_agents !== undefined) set("allowed_agents", json(normalizeList(input.allowed_agents)));
  if (input.metadata !== undefined) set("metadata", json(input.metadata));

  if (!updates.length) return before;
  set("updated_at", now());
  params.push(id);
  d.run(`UPDATE roots SET ${updates.join(", ")} WHERE id = ?`, params);
  return getRoot(id, d)!;
}

export function deleteRoot(id: string, options: { detachWorkspaces?: boolean } = {}, db?: Database): { root: Root; detached_workspaces: number } {
  const d = db || getDatabase();
  const root = getRoot(id, d);
  if (!root) throw new Error(`Root not found: ${id}`);
  const count = (d.query("SELECT COUNT(*) as n FROM workspaces WHERE root_id = ?").get(id) as { n: number }).n;
  if (count > 0 && !options.detachWorkspaces) {
    throw new Error(`Root ${root.slug} is used by ${count} workspace(s); pass detachWorkspaces to clear those references before deletion.`);
  }
  if (count > 0) {
    d.run("UPDATE workspaces SET root_id = NULL, updated_at = ? WHERE root_id = ?", [now(), id]);
  }
  d.run("DELETE FROM roots WHERE id = ?", [id]);
  return { root, detached_workspaces: count };
}

export interface RootMatchInput {
  path?: string;
  tags?: string[];
  kind?: WorkspaceKind;
  github_org?: string;
}

export interface RootMatchResult {
  root: Root;
  score: number;
  reasons: string[];
}

/**
 * Pure root scoring over an in-memory list — no db access. Shared by the local
 * `scoreRoots` (which reads sqlite) and the api transport (which scores roots
 * fetched over HTTP), so matching behaves identically in both modes.
 */
export function rankRoots(roots: Root[], input: RootMatchInput = {}): RootMatchResult[] {
  const absPath = input.path ? resolve(input.path) : undefined;
  const tags = new Set(input.tags ?? []);
  return roots
    .map((root) => {
      let score = 0;
      const reasons: string[] = [];
      if (absPath && (absPath === root.base_path || absPath.startsWith(`${root.base_path}/`))) {
        score += 1000 + root.base_path.length;
        reasons.push("path-prefix");
      }
      if (input.kind && root.default_kind === input.kind) {
        score += 50;
        reasons.push("kind");
      }
      if (input.github_org && root.github_org === input.github_org) {
        score += 40;
        reasons.push("github-org");
      }
      const tagMatches = root.tags.filter((tag) => tags.has(tag));
      if (tagMatches.length > 0) {
        score += tagMatches.length * 10;
        reasons.push(`tags:${tagMatches.join(",")}`);
      }
      return { root, score, reasons };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.root.slug.localeCompare(b.root.slug));
}

export function scoreRoots(input: RootMatchInput = {}, db?: Database): RootMatchResult[] {
  const absPath = input.path ? resolve(input.path) : undefined;
  const tags = new Set(input.tags ?? []);
  return listRoots(db)
    .map((root) => {
      let score = 0;
      const reasons: string[] = [];
      if (absPath && (absPath === root.base_path || absPath.startsWith(`${root.base_path}/`))) {
        score += 1000 + root.base_path.length;
        reasons.push("path-prefix");
      }
      if (input.kind && root.default_kind === input.kind) {
        score += 50;
        reasons.push("kind");
      }
      if (input.github_org && root.github_org === input.github_org) {
        score += 40;
        reasons.push("github-org");
      }
      const tagMatches = root.tags.filter((tag) => tags.has(tag));
      if (tagMatches.length > 0) {
        score += tagMatches.length * 10;
        reasons.push(`tags:${tagMatches.join(",")}`);
      }
      return { root, score, reasons };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.root.slug.localeCompare(b.root.slug));
}

export function matchRoot(input: RootMatchInput, db?: Database): Root | null {
  return scoreRoots(input, db)[0]?.root ?? null;
}

export function matchRootForPath(path: string, db?: Database): Root | null {
  return matchRoot({ path }, db);
}

export function createAgent(input: CreateAgentInput, db?: Database): Agent {
  const d = db || getDatabase();
  const id = generateAgentId();
  const ts = now();
  const slug = ensureUniqueSlug("agents", input.slug ?? workspaceSlugify(input.name), d);

  d.run(
    `INSERT INTO agents (
      id, slug, name, kind, provider, model, role, permissions, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slug,
      input.name,
      input.kind,
      input.provider ?? null,
      input.model ?? null,
      input.role ?? null,
      json(normalizeList(input.permissions)),
      json(input.metadata ?? {}),
      ts,
      ts,
    ],
  );

  return getAgent(id, d)!;
}

export function getAgent(id: string, db?: Database): Agent | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | null;
  return row ? rowToAgent(row) : null;
}

export function getAgentBySlug(slug: string, db?: Database): Agent | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM agents WHERE slug = ?").get(slug) as AgentRow | null;
  return row ? rowToAgent(row) : null;
}

export function listAgents(db?: Database): Agent[] {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM agents ORDER BY slug ASC").all() as AgentRow[]).map(rowToAgent);
}

export function mergeAgentPermissions(agentId: string, permissions: string[], db?: Database): Agent {
  const d = db || getDatabase();
  const agent = getAgent(agentId, d);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  const merged = normalizeList([...agent.permissions, ...permissions]);
  if (merged.length !== agent.permissions.length) {
    d.run("UPDATE agents SET permissions = ?, updated_at = ? WHERE id = ?", [json(merged), now(), agent.id]);
  }
  return getAgent(agent.id, d)!;
}

export function ensureCliAgent(db?: Database): Agent {
  const d = db || getDatabase();
  const permissions = ["workspace:create", "workspace:update", "workspace:delete", "workspace:import", "github:publish", "tmux:apply", "doctor:fix"];
  const existing = getAgentBySlug("cli", d);
  if (existing) {
    return mergeAgentPermissions(existing.id, permissions, d);
  }
  return createAgent({
    slug: "cli",
    name: "CLI",
    kind: "cli",
    role: "automation",
    permissions,
  }, d);
}

export function assertAgentPermission(agentId: string | undefined, permission: string, db?: Database): void {
  if (!agentId) return;
  const agent = getAgent(agentId, db);
  if (!agent || agent.permissions.length === 0) return;
  if (agent.permissions.includes("*") || agent.permissions.includes(permission)) return;
  throw new Error(`Agent ${agent.slug} does not have permission ${permission}`);
}

function isAllowedReference(allowed: string[], id: string | null | undefined, slug: string | null | undefined): boolean {
  if (allowed.length === 0) return true;
  return Boolean((id && allowed.includes(id)) || (slug && allowed.includes(slug)));
}

function assertRootWorkspacePolicy(root: Root | null, recipe: Recipe | null, agentId: string | undefined, db: Database): void {
  if (!root) return;
  if (!isAllowedReference(root.allowed_recipes, recipe?.id, recipe?.slug)) {
    throw new Error(`Root ${root.slug} does not allow recipe ${recipe?.slug ?? "none"}`);
  }
  if (root.allowed_agents.length > 0) {
    const agent = agentId ? getAgent(agentId, db) : null;
    if (!isAllowedReference(root.allowed_agents, agent?.id, agent?.slug)) {
      throw new Error(`Root ${root.slug} does not allow agent ${agent?.slug ?? agentId ?? "unknown"}`);
    }
  }
}

export function createRecipe(input: CreateRecipeInput, db?: Database): Recipe {
  const d = db || getDatabase();
  const id = generateRecipeId();
  const ts = now();
  const slug = ensureUniqueSlug("recipes", input.slug ?? workspaceSlugify(input.name), d);

  d.run(
    `INSERT INTO recipes (
      id, slug, name, description, kind, version, steps, variables, default_tags,
      default_tmux_profile_id, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slug,
      input.name,
      input.description ?? null,
      input.kind ?? null,
      input.version ?? 1,
      json(input.steps ?? []),
      json(input.variables ?? {}),
      json(normalizeList(input.default_tags)),
      input.default_tmux_profile_id ?? null,
      json(input.metadata ?? {}),
      ts,
      ts,
    ],
  );

  return getRecipe(id, d)!;
}

export function getRecipe(id: string, db?: Database): Recipe | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM recipes WHERE id = ?").get(id) as RecipeRow | null;
  return row ? rowToRecipe(row) : null;
}

export function getRecipeBySlug(slug: string, db?: Database): Recipe | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM recipes WHERE slug = ?").get(slug) as RecipeRow | null;
  return row ? rowToRecipe(row) : null;
}

export function listRecipes(db?: Database): Recipe[] {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM recipes ORDER BY slug ASC").all() as RecipeRow[]).map(rowToRecipe);
}

export function createTmuxProfile(input: CreateTmuxProfileInput, db?: Database): TmuxProfile {
  const d = db || getDatabase();
  const id = generateTmuxProfileId();
  const ts = now();
  const slug = ensureUniqueSlug("tmux_profiles", input.slug ?? workspaceSlugify(input.name), d);

  d.run(
    `INSERT INTO tmux_profiles (
      id, slug, name, description, session_template, attach, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slug,
      input.name,
      input.description ?? null,
      input.session_template ?? "{slug}",
      input.attach ? 1 : 0,
      json(input.metadata ?? {}),
      ts,
      ts,
    ],
  );

  for (const window of input.windows ?? []) {
    addTmuxProfileWindow({ ...window, profile_id: id }, d);
  }

  return getTmuxProfile(id, d)!;
}

export function getTmuxProfile(id: string, db?: Database): TmuxProfile | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM tmux_profiles WHERE id = ?").get(id) as TmuxProfileRow | null;
  return row ? rowToTmuxProfile(row) : null;
}

export function getTmuxProfileBySlug(slug: string, db?: Database): TmuxProfile | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM tmux_profiles WHERE slug = ?").get(slug) as TmuxProfileRow | null;
  return row ? rowToTmuxProfile(row) : null;
}

export function resolveTmuxProfile(idOrSlug: string, db?: Database): TmuxProfile | null {
  const d = db || getDatabase();
  return getTmuxProfile(idOrSlug, d) ?? getTmuxProfileBySlug(idOrSlug, d);
}

export function listTmuxProfiles(db?: Database): TmuxProfile[] {
  const d = db || getDatabase();
  return (d.query("SELECT * FROM tmux_profiles ORDER BY slug ASC").all() as TmuxProfileRow[]).map(rowToTmuxProfile);
}

export function addTmuxProfileWindow(input: CreateTmuxProfileWindowInput & { profile_id: string }, db?: Database): TmuxProfileWindow {
  const d = db || getDatabase();
  const profile = getTmuxProfile(input.profile_id, d);
  if (!profile) throw new Error(`Tmux profile not found: ${input.profile_id}`);
  const id = generateTmuxProfileWindowId();
  d.run(
    `INSERT INTO tmux_profile_windows (
      id, profile_id, window_name_template, path_template, command, window_index,
      detached, env, revive, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id, window_name_template) DO UPDATE SET
      path_template = excluded.path_template,
      command = excluded.command,
      window_index = excluded.window_index,
      detached = excluded.detached,
      env = excluded.env,
      revive = excluded.revive`,
    [
      id,
      input.profile_id,
      input.window_name_template,
      input.path_template ?? null,
      input.command ?? null,
      input.window_index ?? null,
      input.detached === false ? 0 : 1,
      json(input.env ?? {}),
      input.revive === false ? 0 : 1,
      now(),
    ],
  );
  const row = d
    .query("SELECT * FROM tmux_profile_windows WHERE profile_id = ? AND window_name_template = ?")
    .get(input.profile_id, input.window_name_template) as TmuxProfileWindowRow | null;
  if (!row) throw new Error(`Tmux profile window was not written: ${input.window_name_template}`);
  return rowToTmuxProfileWindow(row);
}

export function listTmuxProfileWindows(profileId: string, db?: Database): TmuxProfileWindow[] {
  const d = db || getDatabase();
  return (d
    .query("SELECT * FROM tmux_profile_windows WHERE profile_id = ? ORDER BY COALESCE(window_index, 9999), window_name_template ASC")
    .all(profileId) as TmuxProfileWindowRow[]).map(rowToTmuxProfileWindow);
}

function machineId(): string {
  return process.env["HOSTNAME"] || hostname();
}

function deriveWorkspacePath(input: CreateWorkspaceInput, root: Root | null, slug: string, id: string, kind: WorkspaceKind): string | null {
  if (input.primary_path) return resolve(input.primary_path);
  if (!root && kind !== "remote-only") return projectWorkspaceStorePath(id);
  if (!root) return null;
  const rendered = renderTemplate(root.path_template || root.name_template || "{slug}", {
    slug,
    name: input.name,
    kind,
    root: root.slug,
    org: root.github_org,
  });
  return isAbsolute(rendered) ? resolve(rendered) : resolve(join(root.base_path, rendered));
}

export function createWorkspace(input: CreateWorkspaceInput, db?: Database): Workspace {
  const d = db || getDatabase();
  const id = input.id ? assertProjectWorkspaceId(input.id) : generateWorkspaceId();
  const ts = now();
  const slug = ensureUniqueSlug("workspaces", input.slug ?? workspaceSlugify(input.name), d);
  const root = input.root_id ? getRoot(input.root_id, d) : null;
  if (input.root_id && !root) throw new Error(`Root not found: ${input.root_id}`);
  const recipe = input.recipe_id ? getRecipe(input.recipe_id, d) : null;
  if (input.recipe_id && !recipe) throw new Error(`Recipe not found: ${input.recipe_id}`);
  assertAgentPermission(input.agent_id, "workspace:create", d);
  assertRootWorkspacePolicy(root, recipe, input.agent_id, d);

  const kind = input.kind ?? recipe?.kind ?? root?.default_kind ?? "generic";
  const primaryPath = deriveWorkspacePath(input, root, slug, id, kind);
  const tags = normalizeList([
    ...(root?.tags ?? []),
    ...(recipe?.default_tags ?? []),
    ...(input.tags ?? []),
  ]);

  d.run(
    `INSERT INTO workspaces (
      id, slug, name, description, kind, status, root_id, recipe_id, primary_path,
      git_remote, s3_bucket, s3_prefix, tags, integrations, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slug,
      input.name,
      input.description ?? null,
      kind,
      root?.id ?? null,
      recipe?.id ?? null,
      primaryPath,
      input.git_remote ?? null,
      input.s3_bucket ?? null,
      input.s3_prefix ?? null,
      json(tags),
      json(input.integrations ?? {}),
      json(input.metadata ?? {}),
      ts,
      ts,
    ],
  );

  if (primaryPath) {
    addWorkspaceLocation({
      workspace_id: id,
      path: primaryPath,
      label: "main",
      kind: input.git_remote && !existsSync(primaryPath) ? "remote-intended" : "local",
      is_primary: true,
      metadata: {},
    }, d);
  }

  if (input.agent_id) {
    assignAgentToWorkspace(id, input.agent_id, "creator", input.agent_id, { source: input.source ?? "cli" }, d);
  }

  const workspace = getWorkspace(id, d)!;
  recordWorkspaceEvent({
    workspace_id: id,
    agent_id: input.agent_id,
    event_type: "created",
    source: input.source ?? "cli",
    prompt: input.prompt,
    command: input.command,
    after: workspace as unknown as JsonObject,
    metadata: { root_slug: root?.slug, recipe_slug: recipe?.slug },
  }, d);

  return workspace;
}

export function getWorkspace(id: string, db?: Database): Workspace | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | null;
  return row ? rowToWorkspace(row) : null;
}

export function getWorkspaceBySlug(slug: string, db?: Database): Workspace | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM workspaces WHERE slug = ?").get(slug) as WorkspaceRow | null;
  return row ? rowToWorkspace(row) : null;
}

export function getWorkspaceByPath(path: string, db?: Database): Workspace | null {
  return listWorkspacesByPath(path, db)[0] ?? null;
}

export function listWorkspacesByPath(path: string, db?: Database): Workspace[] {
  const d = db || getDatabase();
  const absPath = resolve(path);
  const rows = d
    .query(`
      SELECT DISTINCT w.*
      FROM workspaces w
      LEFT JOIN workspace_locations loc ON loc.workspace_id = w.id
      WHERE w.primary_path = ? OR loc.path = ?
      ORDER BY
        CASE WHEN w.primary_path = ? THEN 0 ELSE 1 END,
        w.name ASC
    `)
    .all(absPath, absPath, absPath) as WorkspaceRow[];
  return rows.map(rowToWorkspace);
}

export interface WorkspaceFilter {
  status?: WorkspaceStatus;
  kind?: WorkspaceKind;
  root_id?: string;
  query?: string;
  tags?: string[];
  exclude_eval_artifacts?: boolean;
  limit?: number;
  offset?: number;
}

export function listWorkspaces(filter: WorkspaceFilter = {}, db?: Database): Workspace[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.status) { conditions.push("status = ?"); params.push(filter.status); }
  if (filter.kind) { conditions.push("kind = ?"); params.push(filter.kind); }
  if (filter.root_id) { conditions.push("root_id = ?"); params.push(filter.root_id); }
  if (filter.query) {
    const q = `%${filter.query.toLowerCase()}%`;
    conditions.push("(lower(name) LIKE ? OR lower(slug) LIKE ? OR lower(COALESCE(description, '')) LIKE ? OR lower(COALESCE(primary_path, '')) LIKE ? OR lower(COALESCE(tags, '')) LIKE ? OR lower(COALESCE(integrations, '')) LIKE ? OR lower(COALESCE(metadata, '')) LIKE ?)");
    params.push(q, q, q, q, q, q, q);
  }
  if (filter.tags && filter.tags.length > 0) {
    for (const tag of filter.tags) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(workspaces.tags) WHERE json_each.value = ?)");
      params.push(tag);
    }
  }
  if (filter.exclude_eval_artifacts) {
    conditions.push(`NOT (
      slug LIKE 'eval-%'
      OR name LIKE 'Eval %'
      OR EXISTS (
        SELECT 1 FROM json_each(workspaces.tags)
        WHERE json_each.value = 'eval' OR json_each.value LIKE 'eval-%'
      )
      OR COALESCE(json_extract(metadata, '$.eval_fixture'), 0) = 1
      OR COALESCE(json_extract(metadata, '$.agent_eval_fixture'), 0) = 1
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = d
    .query(`SELECT * FROM workspaces ${where} ORDER BY name ASC LIMIT ? OFFSET ?`)
    .all(...params, filter.limit ?? 100, filter.offset ?? 0) as WorkspaceRow[];

  return rows.map(rowToWorkspace);
}

export function resolveWorkspace(idOrSlug: string, db?: Database): Workspace | null {
  const d = db || getDatabase();
  return getWorkspace(idOrSlug, d) ?? getWorkspaceBySlug(idOrSlug, d);
}

export function updateWorkspace(id: string, input: UpdateWorkspaceInput, db?: Database): Workspace {
  const d = db || getDatabase();
  const before = getWorkspace(id, d);
  if (!before) throw new Error(`Workspace not found: ${id}`);
  assertAgentPermission(input.agent_id, input.status === "deleted" ? "workspace:delete" : "workspace:update", d);

  const root = input.root_id === undefined || input.root_id === null ? null : getRoot(input.root_id, d);
  if (input.root_id && !root) throw new Error(`Root not found: ${input.root_id}`);
  const recipe = input.recipe_id === undefined || input.recipe_id === null ? null : getRecipe(input.recipe_id, d);
  if (input.recipe_id && !recipe) throw new Error(`Recipe not found: ${input.recipe_id}`);

  const updates: string[] = [];
  const params: SQLQueryBindings[] = [];
  const set = (column: string, value: SQLQueryBindings) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  if (input.name !== undefined) set("name", input.name);
  if (input.slug !== undefined) set("slug", ensureUniqueSlug("workspaces", workspaceSlugify(input.slug), d, id));
  if (input.description !== undefined) set("description", input.description);
  if (input.kind !== undefined) set("kind", input.kind);
  if (input.status !== undefined) set("status", input.status);
  if (input.root_id !== undefined) set("root_id", input.root_id);
  if (input.recipe_id !== undefined) set("recipe_id", input.recipe_id);
  if (input.primary_path !== undefined) set("primary_path", input.primary_path ? resolve(input.primary_path) : null);
  if (input.git_remote !== undefined) set("git_remote", input.git_remote);
  if (input.s3_bucket !== undefined) set("s3_bucket", input.s3_bucket);
  if (input.s3_prefix !== undefined) set("s3_prefix", input.s3_prefix);
  if (input.tags !== undefined) set("tags", json(normalizeList(input.tags)));
  if (input.integrations !== undefined) set("integrations", json(input.integrations));
  if (input.metadata !== undefined) set("metadata", json(input.metadata));

  if (updates.length > 0) {
    updates.push("updated_at = ?");
    params.push(now());
    params.push(id);
    d.run(`UPDATE workspaces SET ${updates.join(", ")} WHERE id = ?`, params);
  }

  const after = getWorkspace(id, d)!;
  if (input.primary_path !== undefined && input.primary_path) {
    addWorkspaceLocation({
      workspace_id: id,
      path: input.primary_path,
      label: "main",
      kind: after.git_remote && !existsSync(resolve(input.primary_path)) ? "remote-intended" : "local",
      is_primary: true,
      metadata: {},
    }, d);
  }

  recordWorkspaceEvent({
    workspace_id: id,
    agent_id: input.agent_id,
    event_type: "updated",
    source: input.source ?? "cli",
    prompt: input.prompt,
    command: input.command,
    before: before as unknown as JsonObject,
    after: after as unknown as JsonObject,
  }, d);
  return after;
}

export function linkWorkspaceIntegrations(
  id: string,
  integrations: WorkspaceIntegrations,
  input: Pick<UpdateWorkspaceInput, "agent_id" | "source" | "prompt" | "command"> = {},
  db?: Database,
): Workspace {
  const d = db || getDatabase();
  const workspace = getWorkspace(id, d);
  if (!workspace) throw new Error(`Workspace not found: ${id}`);
  const merged: WorkspaceIntegrations = { ...workspace.integrations };
  for (const [key, value] of Object.entries(integrations)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) merged[key] = trimmed;
  }
  return updateWorkspace(id, {
    integrations: merged,
    agent_id: input.agent_id,
    source: input.source,
    prompt: input.prompt,
    command: input.command,
  }, d);
}

export function archiveWorkspace(id: string, input: Omit<UpdateWorkspaceInput, "status"> = {}, db?: Database): Workspace {
  return updateWorkspace(id, { ...input, status: "archived" }, db);
}

export function unarchiveWorkspace(id: string, input: Omit<UpdateWorkspaceInput, "status"> = {}, db?: Database): Workspace {
  return updateWorkspace(id, { ...input, status: "active" }, db);
}

export function deleteWorkspace(
  id: string,
  input: Omit<UpdateWorkspaceInput, "status"> & { hard?: boolean } = {},
  db?: Database,
): { workspace: Workspace; hard: boolean } {
  const d = db || getDatabase();
  const before = getWorkspace(id, d);
  if (!before) throw new Error(`Workspace not found: ${id}`);

  if (!input.hard) {
    const workspace = updateWorkspace(id, { ...input, status: "deleted" }, d);
    return { workspace, hard: false };
  }

  recordWorkspaceEvent({
    workspace_id: id,
    agent_id: input.agent_id,
    event_type: "deleted",
    source: input.source ?? "cli",
    prompt: input.prompt,
    command: input.command,
    before: before as unknown as JsonObject,
    metadata: { hard: true },
  }, d);
  d.run("DELETE FROM workspaces WHERE id = ?", [id]);
  return { workspace: before, hard: true };
}

export interface AddWorkspaceLocationInput {
  workspace_id: string;
  path: string;
  label?: string;
  kind?: string;
  is_primary?: boolean;
  metadata?: JsonObject;
  agent_id?: string;
  source?: EventSource;
  prompt?: string;
  command?: string;
}

export function addWorkspaceLocation(input: AddWorkspaceLocationInput, db?: Database): WorkspaceLocation {
  const d = db || getDatabase();
  const workspace = getWorkspace(input.workspace_id, d);
  if (!workspace) throw new Error(`Workspace not found: ${input.workspace_id}`);

  if (input.is_primary) {
    d.run("UPDATE workspace_locations SET is_primary = 0 WHERE workspace_id = ?", [input.workspace_id]);
  }

  const id = generateLocationId();
  const path = resolve(input.path);
  const ts = now();
  d.run(
    `INSERT INTO workspace_locations (
      id, workspace_id, path, machine_id, label, kind, is_primary, exists_at_create, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, path, machine_id) DO UPDATE SET
      label = excluded.label,
      kind = excluded.kind,
      is_primary = excluded.is_primary,
      metadata = excluded.metadata`,
    [
      id,
      input.workspace_id,
      path,
      machineId(),
      input.label ?? "main",
      input.kind ?? "local",
      input.is_primary ? 1 : 0,
      existsSync(path) ? 1 : 0,
      json(input.metadata ?? {}),
      ts,
    ],
  );

  if (input.is_primary) {
    d.run("UPDATE workspaces SET primary_path = ?, updated_at = ? WHERE id = ?", [path, now(), input.workspace_id]);
  }

  const row = d
    .query("SELECT * FROM workspace_locations WHERE workspace_id = ? AND path = ? AND machine_id = ?")
    .get(input.workspace_id, path, machineId()) as WorkspaceLocationRow | null;
  if (!row) throw new Error(`Workspace location was not written: ${path}`);
  const location = rowToLocation(row);
  if (input.source || input.agent_id || input.prompt || input.command) {
    recordWorkspaceEvent({
      workspace_id: input.workspace_id,
      agent_id: input.agent_id,
      event_type: "location_added",
      source: input.source ?? "system",
      prompt: input.prompt,
      command: input.command,
      after: location as unknown as JsonObject,
      metadata: { primary: location.is_primary },
    }, d);
  }
  return location;
}

export function listWorkspaceLocations(workspaceId: string, db?: Database): WorkspaceLocation[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM workspace_locations WHERE workspace_id = ? ORDER BY is_primary DESC, created_at ASC")
    .all(workspaceId) as WorkspaceLocationRow[];
  return rows.map(rowToLocation);
}

export function getWorkspaceLocationByPath(path: string, db?: Database): WorkspaceLocation | null {
  const d = db || getDatabase();
  const absPath = resolve(path);
  const row = d
    .query("SELECT * FROM workspace_locations WHERE path = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1")
    .get(absPath) as WorkspaceLocationRow | null;
  return row ? rowToLocation(row) : null;
}

export function assignAgentToWorkspace(
  workspaceId: string,
  agentId: string,
  role = "contributor",
  assignedBy?: string,
  metadata?: JsonObject,
  db?: Database,
): WorkspaceAgentAssignment {
  const d = db || getDatabase();
  if (!getWorkspace(workspaceId, d)) throw new Error(`Workspace not found: ${workspaceId}`);
  if (!getAgent(agentId, d)) throw new Error(`Agent not found: ${agentId}`);
  d.run(
    `INSERT INTO workspace_agents (id, workspace_id, agent_id, role, assigned_by, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, agent_id, role) DO NOTHING`,
    [uuid(), workspaceId, agentId, role, assignedBy ?? null, json(metadata ?? {}), now()],
  );
  const row = d
    .query("SELECT * FROM workspace_agents WHERE workspace_id = ? AND agent_id = ? AND role = ?")
    .get(workspaceId, agentId, role) as WorkspaceAgentAssignmentRow | null;
  if (!row) throw new Error(`Workspace agent assignment was not written: ${workspaceId}/${agentId}/${role}`);
  return rowToWorkspaceAgentAssignment(row, d);
}

export function listWorkspaceAgents(workspaceId: string, db?: Database): WorkspaceAgentAssignment[] {
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM workspace_agents WHERE workspace_id = ? ORDER BY role ASC, created_at ASC")
    .all(workspaceId) as WorkspaceAgentAssignmentRow[];
  return rows.map((row) => rowToWorkspaceAgentAssignment(row, d));
}

export function recordWorkspaceEvent(input: RecordWorkspaceEventInput, db?: Database): WorkspaceEvent {
  const d = db || getDatabase();
  const id = generateWorkspaceEventId();
  d.run(
    `INSERT INTO workspace_events (
      id, workspace_id, agent_id, event_type, source, prompt, command,
      before_json, after_json, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspace_id ?? null,
      input.agent_id ?? null,
      input.event_type,
      input.source,
      input.prompt ?? null,
      input.command ?? null,
      input.before === undefined ? null : json(input.before),
      input.after === undefined ? null : json(input.after),
      json(input.metadata ?? {}),
      now(),
    ],
  );
  const row = d.query("SELECT * FROM workspace_events WHERE id = ?").get(id) as WorkspaceEventRow;
  return rowToEvent(row);
}

export function listWorkspaceEvents(workspaceId: string, db?: Database): WorkspaceEvent[] {
  const d = db || getDatabase();
  return (d
    .query("SELECT * FROM workspace_events WHERE workspace_id = ? ORDER BY created_at ASC")
    .all(workspaceId) as WorkspaceEventRow[]).map(rowToEvent);
}

/**
 * The on-box agent-run ledger (agent_runs) FK-references the LOCAL workspaces
 * table. In api/cloud mode the referenced project lives only in the cloud
 * registry, so a cloud id would violate the FK. The ledger is a machine-local
 * record of a run that happened here; keep the workspace_id only when the row
 * exists on this box, otherwise store null (the run is still fully recorded).
 */
function localWorkspaceIdOrNull(d: Database, workspaceId: string | undefined | null): string | null {
  if (!workspaceId) return null;
  const row = d.query("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
  return row ? workspaceId : null;
}

export function startAgentRun(
  input: { agent_id?: string; workspace_id?: string; provider?: string; model?: string; prompt: string; plan?: JsonObject; metadata?: JsonObject },
  db?: Database,
): AgentRun {
  const d = db || getDatabase();
  const id = generateAgentRunId();
  d.run(
    `INSERT INTO agent_runs (
      id, agent_id, workspace_id, provider, model, prompt, status,
      plan_json, tool_calls_json, metadata, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, '[]', ?, ?)`,
    [
      id,
      input.agent_id ?? null,
      localWorkspaceIdOrNull(d, input.workspace_id),
      input.provider ?? null,
      input.model ?? null,
      input.prompt,
      input.plan ? json(input.plan) : null,
      json(input.metadata ?? {}),
      now(),
    ],
  );
  const row = d.query("SELECT * FROM agent_runs WHERE id = ?").get(id) as AgentRunRow;
  return rowToAgentRun(row);
}

export function completeAgentRun(
  runId: string,
  input: { status?: "completed" | "failed"; workspace_id?: string; result?: JsonObject; error?: string; tool_calls?: JsonObject[] },
  db?: Database,
): AgentRun {
  const d = db || getDatabase();
  const status = input.status ?? (input.error ? "failed" : "completed");
  d.run(
    `UPDATE agent_runs SET
      status = ?,
      workspace_id = COALESCE(?, workspace_id),
      result_json = ?,
      error = ?,
      tool_calls_json = ?,
      completed_at = ?
    WHERE id = ?`,
    [
      status,
      localWorkspaceIdOrNull(d, input.workspace_id),
      input.result ? json(input.result) : null,
      input.error ?? null,
      json(input.tool_calls ?? []),
      now(),
      runId,
    ],
  );
  const row = d.query("SELECT * FROM agent_runs WHERE id = ?").get(runId) as AgentRunRow | null;
  if (!row) throw new Error(`Agent run not found: ${runId}`);
  return rowToAgentRun(row);
}

export function listAgentRuns(filter: { workspace_id?: string; agent_id?: string; status?: AgentRun["status"]; limit?: number } = {}, db?: Database): AgentRun[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.workspace_id) { conditions.push("workspace_id = ?"); params.push(filter.workspace_id); }
  if (filter.agent_id) { conditions.push("agent_id = ?"); params.push(filter.agent_id); }
  if (filter.status) { conditions.push("status = ?"); params.push(filter.status); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return (d
    .query(`SELECT * FROM agent_runs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, filter.limit ?? 100) as AgentRunRow[]).map(rowToAgentRun);
}

function clearExpiredLocks(db: Database): void {
  db.run("DELETE FROM workspace_locks WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')");
}

export function acquireWorkspaceLock(
  input: { lock_key: string; workspace_id?: string; agent_id?: string; reason?: string; ttl_seconds?: number },
  db?: Database,
): WorkspaceLock {
  const d = db || getDatabase();
  clearExpiredLocks(d);
  const existing = d.query("SELECT * FROM workspace_locks WHERE lock_key = ?").get(input.lock_key) as WorkspaceLockRow | null;
  if (existing) {
    throw new Error(`Workspace lock already held: ${input.lock_key}`);
  }
  const id = generateWorkspaceLockId();
  const expiresAt = input.ttl_seconds
    ? new Date(Date.now() + input.ttl_seconds * 1000).toISOString().replace("T", " ").replace("Z", "")
    : null;
  d.run(
    `INSERT INTO workspace_locks (id, lock_key, workspace_id, agent_id, reason, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.lock_key, input.workspace_id ?? null, input.agent_id ?? null, input.reason ?? null, now(), expiresAt],
  );
  const row = d.query("SELECT * FROM workspace_locks WHERE id = ?").get(id) as WorkspaceLockRow;
  return rowToWorkspaceLock(row);
}

export function releaseWorkspaceLock(lockKey: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM workspace_locks WHERE lock_key = ?", [lockKey]);
  return result.changes > 0;
}

export function listWorkspaceLocks(db?: Database): WorkspaceLock[] {
  const d = db || getDatabase();
  clearExpiredLocks(d);
  return (d.query("SELECT * FROM workspace_locks ORDER BY created_at ASC").all() as WorkspaceLockRow[]).map(rowToWorkspaceLock);
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | null;
  return Boolean(row);
}

export function inferWorkspaceKind(slug: string, path: string, tags: string[] = []): WorkspaceKind {
  const text = `${slug} ${path} ${tags.join(" ")}`.toLowerCase();
  if (tags.includes("remote-only")) return "remote-only";
  if (text.includes("/companywebsite/") || slug.startsWith("cweb-")) return "company-website";
  if (text.includes("/internalapp/") || slug.startsWith("iapp-")) return "internal-app";
  if (text.includes("/platform/") || slug.startsWith("platform-")) return "platform";
  if (text.includes("/scaffold/") || slug.startsWith("scaffold-")) return "scaffold";
  if (text.includes("/community/") || slug.startsWith("community-")) return "community";
  if (slug.startsWith("open-") || text.includes("/opensource/")) return "open-source";
  if (slug.startsWith("project-") || text.includes("/project/")) return "project";
  return "generic";
}

function inferRootForLegacyPath(path: string, kind: WorkspaceKind, db: Database): Root {
  const absPath = resolve(path);
  const candidates = [
    { slug: "hasna-open-dev", base: "/home/hasna/workspace/hasna/opensource/opensourcedev", name: "Hasna Open Source Dev", template: "open-{slug}", tag: "open-source" },
    { slug: "hasna-open", base: "/home/hasna/workspace/hasna/opensource", name: "Hasna Open Source", template: "{slug}", tag: "open-source" },
    { slug: "hasnaxyz-projects", base: "/home/hasna/workspace/hasnaxyz/project", name: "Hasna XYZ Projects", template: "project-{slug}", tag: "project" },
    { slug: "hasnaxyz-internal", base: "/home/hasna/workspace/hasnaxyz/internalapp", name: "Hasna XYZ Internal Apps", template: "iapp-{slug}", tag: "internal" },
    { slug: "hasnaxyz-companywebsites", base: "/home/hasna/workspace/hasnaxyz/companywebsite", name: "Hasna XYZ Company Websites", template: "cweb-{slug}", tag: "companywebsite" },
    { slug: "hasnatools-platform", base: "/home/hasna/workspace/hasnatools/platform", name: "Hasna Tools Platform", template: "platform-{slug}", tag: "platform" },
    { slug: "hasnastudio-platform", base: "/home/hasna/workspace/hasnastudio/platform", name: "Hasna Studio Platform", template: "platform-{slug}", tag: "platform" },
    { slug: "hasna-scaffold", base: "/home/hasna/workspace/hasna/scaffold", name: "Hasna Scaffolds", template: "scaffold-{slug}", tag: "scaffold" },
    { slug: "hasna-community", base: "/home/hasna/workspace/hasna/community", name: "Hasna Community", template: "community-{slug}", tag: "community" },
  ];
  const matched = candidates.find((candidate) => absPath.startsWith(`${candidate.base}/`) || absPath === candidate.base);
  if (matched) {
    const existing = getRootBySlug(matched.slug, db);
    if (existing) return existing;
    return createRoot({
      slug: matched.slug,
      name: matched.name,
      base_path: matched.base,
      tags: [matched.tag],
      default_kind: kind,
      path_template: matched.template,
    }, db);
  }

  const base = dirname(absPath);
  const slug = `root-${workspaceSlugify(base.replace(/^\/+/, ""))}`;
  const existing = getRootBySlug(slug, db);
  if (existing) return existing;
  return createRoot({
    slug,
    name: base.split("/").filter(Boolean).slice(-2).join(" / ") || base,
    base_path: base,
    default_kind: kind,
    path_template: "{slug}",
  }, db);
}

export interface MigrationResult {
  migrated: number;
  skipped: number;
  roots_created_or_reused: number;
  workdirs_migrated: number;
  workdirs_skipped: number;
  before: MigrationCounts;
  after: MigrationCounts;
  validation: MigrationValidation;
  samples: MigrationSample[];
}

export interface MigrationCounts {
  legacy_projects: number;
  legacy_workdirs: number;
  migration_map: number;
  workspaces: number;
  workspace_locations: number;
}

export interface MigrationValidation {
  valid: boolean;
  expected_legacy_projects: number;
  accounted_projects: number;
  missing_projects: number;
  workdir_source_count: number;
  workdir_migrated: number;
  workdir_skipped: number;
  expected_migration_map_rows: number;
  actual_migration_map_rows: number;
  missing_migration_map_rows: number;
  expected_workspace_locations_at_least: number;
  actual_workspace_locations: number;
}

export interface MigrationSample {
  old_project_id: string;
  workspace_id: string;
  old_slug: string;
  workspace_slug: string;
  old_path: string;
  workspace_path: string | null;
}

interface LegacyProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  path: string;
  s3_bucket: string | null;
  s3_prefix: string | null;
  git_remote: string | null;
  tags: string | null;
  integrations: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  last_opened_at?: string | null;
}

interface LegacyWorkdirRow {
  id?: string | null;
  project_id: string;
  path: string;
  machine_id?: string | null;
  label: string | null;
  is_primary: number | null;
  claude_md_generated?: number | null;
  agents_md_generated?: number | null;
  created_at: string | null;
}

function tableCount(db: Database, table: string): number {
  if (!tableExists(db, table)) return 0;
  return (db.query(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
}

function migrationCounts(db: Database): MigrationCounts {
  return {
    legacy_projects: tableCount(db, "projects"),
    legacy_workdirs: tableCount(db, "project_workdirs"),
    migration_map: tableCount(db, "workspace_migration_map"),
    workspaces: tableCount(db, "workspaces"),
    workspace_locations: tableCount(db, "workspace_locations"),
  };
}

function listLegacyProjects(db: Database): LegacyProjectRow[] {
  if (!tableExists(db, "projects")) return [];
  return db.query("SELECT * FROM projects ORDER BY created_at ASC").all() as LegacyProjectRow[];
}

function listLegacyWorkdirs(db: Database): LegacyWorkdirRow[] {
  if (!tableExists(db, "project_workdirs")) return [];
  return db.query("SELECT * FROM project_workdirs ORDER BY created_at ASC").all() as LegacyWorkdirRow[];
}

function migrateLegacyWorkdirs(db: Database): { migrated: number; skipped: number } {
  let migrated = 0;
  let skipped = 0;
  for (const workdir of listLegacyWorkdirs(db)) {
    const mapped = db.query("SELECT workspace_id FROM workspace_migration_map WHERE old_project_id = ?").get(workdir.project_id) as { workspace_id: string } | null;
    if (!mapped) {
      skipped++;
      continue;
    }
    const workspace = getWorkspace(mapped.workspace_id, db);
    if (!workspace) {
      skipped++;
      continue;
    }
    const path = resolve(workdir.path);
    const machine = workdir.machine_id || machineId();
    const existing = db.query(
      "SELECT id FROM workspace_locations WHERE workspace_id = ? AND path = ? AND machine_id = ?",
    ).get(mapped.workspace_id, path, machine) as { id: string } | null;
    const isPrimary = Boolean(workdir.is_primary);
    if (isPrimary) {
      db.run("UPDATE workspace_locations SET is_primary = 0 WHERE workspace_id = ?", [mapped.workspace_id]);
    }
    const metadata = json({
      migrated_from_project_workdir: true,
      migrated_from_workdir_id: workdir.id ?? null,
      old_project_id: workdir.project_id,
      claude_md_generated: Boolean(workdir.claude_md_generated),
      agents_md_generated: Boolean(workdir.agents_md_generated),
    });
    if (existing) {
      db.run(
        `UPDATE workspace_locations
         SET label = ?, kind = ?, is_primary = ?, exists_at_create = ?, metadata = ?
         WHERE id = ?`,
        [workdir.label || "main", "local", isPrimary ? 1 : 0, existsSync(path) ? 1 : 0, metadata, existing.id],
      );
      skipped++;
    } else {
      db.run(
        `INSERT INTO workspace_locations (
          id, workspace_id, path, machine_id, label, kind, is_primary, exists_at_create, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateLocationId(),
          mapped.workspace_id,
          path,
          machine,
          workdir.label || "main",
          "local",
          isPrimary ? 1 : 0,
          existsSync(path) ? 1 : 0,
          metadata,
          workdir.created_at ?? now(),
        ],
      );
      migrated++;
    }
    if (isPrimary || !workspace.primary_path) {
      db.run("UPDATE workspaces SET primary_path = ?, updated_at = ? WHERE id = ?", [path, now(), mapped.workspace_id]);
    }
  }
  return { migrated, skipped };
}

function migrationSamples(db: Database, limit = 5): MigrationSample[] {
  if (!tableExists(db, "projects")) return [];
  return db.query(`
    SELECT
      p.id as old_project_id,
      m.workspace_id as workspace_id,
      p.slug as old_slug,
      w.slug as workspace_slug,
      p.path as old_path,
      w.primary_path as workspace_path
    FROM workspace_migration_map m
    JOIN projects p ON p.id = m.old_project_id
    JOIN workspaces w ON w.id = m.workspace_id
    ORDER BY p.created_at ASC
    LIMIT ?
  `).all(limit) as MigrationSample[];
}

function migrationValidation(before: MigrationCounts, after: MigrationCounts, workdirs = { migrated: 0, skipped: 0 }): MigrationValidation {
  const expectedMapRows = before.legacy_projects;
  const actualMapRows = after.migration_map;
  const expectedLocations = before.legacy_projects + before.legacy_workdirs;
  const accountedProjects = actualMapRows;
  const missingProjects = Math.max(0, before.legacy_projects - accountedProjects);
  const accountedWorkdirs = workdirs.migrated + workdirs.skipped;
  return {
    valid: missingProjects === 0 && accountedWorkdirs >= before.legacy_workdirs && after.workspace_locations >= before.workspace_locations,
    expected_legacy_projects: before.legacy_projects,
    accounted_projects: accountedProjects,
    missing_projects: missingProjects,
    workdir_source_count: before.legacy_workdirs,
    workdir_migrated: workdirs.migrated,
    workdir_skipped: workdirs.skipped,
    expected_migration_map_rows: expectedMapRows,
    actual_migration_map_rows: actualMapRows,
    missing_migration_map_rows: Math.max(0, expectedMapRows - actualMapRows),
    expected_workspace_locations_at_least: expectedLocations,
    actual_workspace_locations: after.workspace_locations,
  };
}

export function migrateLegacyProjectsToWorkspaces(db?: Database): MigrationResult {
  const d = db || getDatabase();
  const before = migrationCounts(d);
  if (!tableExists(d, "projects")) {
    const after = migrationCounts(d);
    return {
      migrated: 0,
      skipped: 0,
      roots_created_or_reused: 0,
      workdirs_migrated: 0,
      workdirs_skipped: 0,
      before,
      after,
      validation: migrationValidation(before, after),
      samples: [],
    };
  }

  const rows = listLegacyProjects(d);

  let migrated = 0;
  let skipped = 0;
  const roots = new Set<string>();
  const migrationAgent = getAgentBySlug("migration", d) ?? createAgent({ slug: "migration", name: "Migration", kind: "service", role: "migration" }, d);

  for (const row of rows) {
    const existing = d.query("SELECT workspace_id FROM workspace_migration_map WHERE old_project_id = ?").get(row.id) as { workspace_id: string } | null;
    if (existing) {
      skipped++;
      continue;
    }

    const tags = parseJson<string[]>(row.tags, []);
    const kind = inferWorkspaceKind(row.slug, row.path, tags);
    const root = inferRootForLegacyPath(row.path, kind, d);
    roots.add(root.id);

    const workspace = createWorkspace({
      name: row.name,
      slug: row.slug,
      description: row.description ?? undefined,
      kind,
      root_id: root.id,
      primary_path: row.path,
      git_remote: row.git_remote ?? undefined,
      s3_bucket: row.s3_bucket ?? undefined,
      s3_prefix: row.s3_prefix ?? undefined,
      tags,
      integrations: parseJson<WorkspaceIntegrations>(row.integrations, {}),
      metadata: {
        migrated_from_project_id: row.id,
        migration_inference: {
          kind,
          root_id: root.id,
          root_slug: root.slug,
          confidence: root.base_path && resolve(row.path).startsWith(root.base_path) ? 1 : 0.7,
        },
      },
      agent_id: migrationAgent.id,
      source: "migration",
      command: "migrateLegacyProjectsToWorkspaces",
    }, d);

    d.run("UPDATE workspaces SET status = ?, created_at = ?, updated_at = ?, synced_at = ?, last_opened_at = ? WHERE id = ?", [
      row.status === "archived" ? "archived" : "active",
      row.created_at,
      row.updated_at,
      row.synced_at ?? null,
      row.last_opened_at ?? null,
      workspace.id,
    ]);
    d.run("INSERT INTO workspace_migration_map (old_project_id, workspace_id, metadata) VALUES (?, ?, ?)", [
      row.id,
      workspace.id,
      json({ old_slug: row.slug, old_path: row.path }),
    ]);
    migrated++;
  }
  const workdirs = migrateLegacyWorkdirs(d);
  const after = migrationCounts(d);

  return {
    migrated,
    skipped,
    roots_created_or_reused: roots.size,
    workdirs_migrated: workdirs.migrated,
    workdirs_skipped: workdirs.skipped,
    before,
    after,
    validation: migrationValidation(before, after, workdirs),
    samples: migrationSamples(d),
  };
}
