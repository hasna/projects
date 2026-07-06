// Postgres-backed store for projects-serve (Amendment A1 pure-remote).
//
// This is the cloud data-access layer the HTTP API wraps. It mirrors the domain
// semantics of src/db/workspaces.ts (the local SQLite core) — id/slug rules,
// tag merging, JSON-encoded columns, event journaling — but executes async SQL
// against cloud Postgres through the vendored storage kit's TypedQueryClient.
// There is NO sync engine and NO local cache here (pure remote): every call
// hits the database.

import { nanoid } from "nanoid";
import type { TypedQueryClient } from "../generated/storage-kit/query.js";
import type {
  Agent,
  AgentRow,
  CreateAgentInput,
  CreateRecipeInput,
  CreateRootInput,
  CreateWorkspaceInput,
  EventSource,
  JsonObject,
  Recipe,
  RecipeRow,
  RecordWorkspaceEventInput,
  Root,
  RootRow,
  UpdateRootInput,
  UpdateWorkspaceInput,
  Workspace,
  WorkspaceEvent,
  WorkspaceEventRow,
  WorkspaceIntegrations,
  WorkspaceKind,
  WorkspaceRow,
  WorkspaceStatus,
} from "../types/workspace.js";

// ---------------------------------------------------------------------------
// Pure helpers (mirrors of the SQLite core, kept dependency-light)
// ---------------------------------------------------------------------------

export function generateWorkspaceId(): string {
  return `wks_${nanoid()}`;
}
export function generateRootId(): string {
  return `root_${nanoid()}`;
}
export function generateRecipeId(): string {
  return `rcp_${nanoid()}`;
}
export function generateAgentId(): string {
  return `agt_${nanoid()}`;
}
export function generateEventId(): string {
  return `evt_${nanoid()}`;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
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
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Row mappers (Postgres rows share the SQLite TEXT/JSON column shape)
// ---------------------------------------------------------------------------

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

function rowToEvent(row: WorkspaceEventRow): WorkspaceEvent {
  return {
    ...row,
    source: row.source as EventSource,
    before_json: parseJson<JsonObject | null>(row.before_json, null),
    after_json: parseJson<JsonObject | null>(row.after_json, null),
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

/** Not-found error carrying an HTTP status hint for the router. */
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Client/validation error (bad input) carrying a 400 hint. */
export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface WorkspaceFilter {
  status?: WorkspaceStatus;
  kind?: WorkspaceKind;
  root_id?: string;
  query?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export class ProjectsPgStore {
  constructor(private readonly db: TypedQueryClient) {}

  // --- slug uniqueness --------------------------------------------------
  private async ensureUniqueSlug(table: string, base: string, excludeId?: string): Promise<string> {
    const safeBase = base || "workspace";
    let candidate = safeBase;
    let suffix = 1;
    // Table name is a fixed internal literal, never user input.
    for (;;) {
      const row = await this.db.get<{ id: string }>(`SELECT id FROM ${table} WHERE slug = $1`, [candidate]);
      if (!row || row.id === excludeId) return candidate;
      suffix++;
      candidate = `${safeBase}-${suffix}`;
    }
  }

  // --- roots ------------------------------------------------------------
  async listRoots(): Promise<Root[]> {
    const rows = await this.db.many<RootRow>("SELECT * FROM roots ORDER BY slug ASC");
    return rows.map(rowToRoot);
  }

  async getRoot(idOrSlug: string): Promise<Root | null> {
    const row = await this.db.get<RootRow>("SELECT * FROM roots WHERE id = $1 OR slug = $1", [idOrSlug]);
    return row ? rowToRoot(row) : null;
  }

  async createRoot(input: CreateRootInput): Promise<Root> {
    if (!input.name?.trim()) throw new ValidationError("root name is required");
    if (!input.base_path?.trim()) throw new ValidationError("root base_path is required");
    const id = generateRootId();
    const ts = nowIso();
    const slug = await this.ensureUniqueSlug("roots", input.slug ?? slugify(input.name));
    await this.db.execute(
      `INSERT INTO roots (
        id, slug, name, base_path, tags, default_kind, default_recipe_id,
        default_tmux_profile_id, github_org, repo_visibility, path_template,
        name_template, allowed_recipes, allowed_agents, metadata, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        slug,
        input.name,
        input.base_path,
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
    return (await this.getRoot(id))!;
  }

  async updateRoot(idOrSlug: string, input: UpdateRootInput): Promise<Root> {
    const before = await this.getRoot(idOrSlug);
    if (!before) throw new NotFoundError(`Root not found: ${idOrSlug}`);
    const updates: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {
      params.push(val);
      updates.push(`${col} = $${params.length}`);
    };
    if (input.slug !== undefined) set("slug", await this.ensureUniqueSlug("roots", slugify(input.slug), before.id));
    if (input.name !== undefined) set("name", input.name);
    if (input.base_path !== undefined) set("base_path", input.base_path);
    if (input.tags !== undefined) set("tags", json(normalizeList(input.tags)));
    if (input.default_kind !== undefined) set("default_kind", input.default_kind);
    if (input.github_org !== undefined) set("github_org", input.github_org);
    if (input.repo_visibility !== undefined) set("repo_visibility", input.repo_visibility);
    if (input.path_template !== undefined) set("path_template", input.path_template);
    if (input.name_template !== undefined) set("name_template", input.name_template);
    if (input.allowed_recipes !== undefined) set("allowed_recipes", json(normalizeList(input.allowed_recipes)));
    if (input.allowed_agents !== undefined) set("allowed_agents", json(normalizeList(input.allowed_agents)));
    if (input.metadata !== undefined) set("metadata", json(input.metadata));
    if (!updates.length) return before;
    set("updated_at", nowIso());
    params.push(before.id);
    await this.db.execute(`UPDATE roots SET ${updates.join(", ")} WHERE id = $${params.length}`, params);
    return (await this.getRoot(before.id))!;
  }

  async deleteRoot(idOrSlug: string, detachWorkspaces = false): Promise<{ root: Root; detached_workspaces: number }> {
    const root = await this.getRoot(idOrSlug);
    if (!root) throw new NotFoundError(`Root not found: ${idOrSlug}`);
    const countRow = await this.db.get<{ n: string }>(
      "SELECT COUNT(*)::int AS n FROM workspaces WHERE root_id = $1",
      [root.id],
    );
    const count = Number(countRow?.n ?? 0);
    if (count > 0 && !detachWorkspaces) {
      throw new ValidationError(
        `Root ${root.slug} is used by ${count} workspace(s); pass detach=true to clear those references before deletion.`,
      );
    }
    if (count > 0) {
      await this.db.execute("UPDATE workspaces SET root_id = NULL, updated_at = $1 WHERE root_id = $2", [
        nowIso(),
        root.id,
      ]);
    }
    await this.db.execute("DELETE FROM roots WHERE id = $1", [root.id]);
    return { root, detached_workspaces: count };
  }

  // --- agents -----------------------------------------------------------
  async listAgents(): Promise<Agent[]> {
    const rows = await this.db.many<AgentRow>("SELECT * FROM agents ORDER BY slug ASC");
    return rows.map(rowToAgent);
  }

  async getAgent(idOrSlug: string): Promise<Agent | null> {
    const row = await this.db.get<AgentRow>("SELECT * FROM agents WHERE id = $1 OR slug = $1", [idOrSlug]);
    return row ? rowToAgent(row) : null;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    if (!input.name?.trim()) throw new ValidationError("agent name is required");
    const kind = input.kind ?? "ai";
    if (!["human", "ai", "service", "cli"].includes(kind)) {
      throw new ValidationError(`invalid agent kind: ${kind}`);
    }
    const id = generateAgentId();
    const ts = nowIso();
    const slug = await this.ensureUniqueSlug("agents", input.slug ?? slugify(input.name));
    await this.db.execute(
      `INSERT INTO agents (id, slug, name, kind, provider, model, role, permissions, metadata, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        slug,
        input.name,
        kind,
        input.provider ?? null,
        input.model ?? null,
        input.role ?? null,
        json(normalizeList(input.permissions)),
        json(input.metadata ?? {}),
        ts,
        ts,
      ],
    );
    return (await this.getAgent(id))!;
  }

  // --- recipes ----------------------------------------------------------
  async listRecipes(): Promise<Recipe[]> {
    const rows = await this.db.many<RecipeRow>("SELECT * FROM recipes ORDER BY slug ASC");
    return rows.map(rowToRecipe);
  }

  async getRecipe(idOrSlug: string): Promise<Recipe | null> {
    const row = await this.db.get<RecipeRow>("SELECT * FROM recipes WHERE id = $1 OR slug = $1", [idOrSlug]);
    return row ? rowToRecipe(row) : null;
  }

  async createRecipe(input: CreateRecipeInput): Promise<Recipe> {
    if (!input.name?.trim()) throw new ValidationError("recipe name is required");
    const id = generateRecipeId();
    const ts = nowIso();
    const slug = await this.ensureUniqueSlug("recipes", input.slug ?? slugify(input.name));
    await this.db.execute(
      `INSERT INTO recipes (id, slug, name, description, kind, version, steps, variables, default_tags, default_tmux_profile_id, metadata, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
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
    return (await this.getRecipe(id))!;
  }

  // --- workspaces (projects) -------------------------------------------
  async listWorkspaces(filter: WorkspaceFilter = {}): Promise<Workspace[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (clause: (idx: number) => string, value: unknown) => {
      params.push(value);
      conditions.push(clause(params.length));
    };
    if (filter.status) push((i) => `status = $${i}`, filter.status);
    if (filter.kind) push((i) => `kind = $${i}`, filter.kind);
    if (filter.root_id) push((i) => `root_id = $${i}`, filter.root_id);
    if (filter.query) {
      params.push(`%${filter.query.toLowerCase()}%`);
      const i = params.length;
      conditions.push(
        `(lower(name) LIKE $${i} OR lower(slug) LIKE $${i} OR lower(COALESCE(description,'')) LIKE $${i} OR lower(COALESCE(primary_path,'')) LIKE $${i} OR lower(COALESCE(tags,'')) LIKE $${i} OR lower(COALESCE(metadata,'')) LIKE $${i})`,
      );
    }
    if (filter.tags && filter.tags.length > 0) {
      for (const tag of filter.tags) {
        params.push(tag);
        conditions.push(`(tags::jsonb ? $${params.length})`);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
    const limitIdx = params.length;
    params.push(Math.max(filter.offset ?? 0, 0));
    const offsetIdx = params.length;
    const rows = await this.db.many<WorkspaceRow>(
      `SELECT * FROM workspaces ${where} ORDER BY name ASC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );
    return rows.map(rowToWorkspace);
  }

  async getWorkspace(idOrSlug: string): Promise<Workspace | null> {
    const row = await this.db.get<WorkspaceRow>("SELECT * FROM workspaces WHERE id = $1 OR slug = $1", [idOrSlug]);
    return row ? rowToWorkspace(row) : null;
  }

  async requireWorkspace(idOrSlug: string): Promise<Workspace> {
    const ws = await this.getWorkspace(idOrSlug);
    if (!ws) throw new NotFoundError(`Workspace not found: ${idOrSlug}`);
    return ws;
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    if (!input.name?.trim()) throw new ValidationError("workspace name is required");
    const id = input.id ?? generateWorkspaceId();
    const ts = nowIso();
    const slug = await this.ensureUniqueSlug("workspaces", input.slug ?? slugify(input.name));

    const root = input.root_id ? await this.getRoot(input.root_id) : null;
    if (input.root_id && !root) throw new ValidationError(`Root not found: ${input.root_id}`);
    const recipe = input.recipe_id ? await this.getRecipe(input.recipe_id) : null;
    if (input.recipe_id && !recipe) throw new ValidationError(`Recipe not found: ${input.recipe_id}`);

    const kind = input.kind ?? recipe?.kind ?? root?.default_kind ?? "generic";
    const tags = normalizeList([...(root?.tags ?? []), ...(recipe?.default_tags ?? []), ...(input.tags ?? [])]);
    const primaryPath = input.primary_path ?? null;

    try {
      await this.db.execute(
        `INSERT INTO workspaces (
          id, slug, name, description, kind, status, root_id, recipe_id, primary_path,
          git_remote, s3_bucket, s3_prefix, tags, integrations, metadata, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate key|unique/i.test(msg)) throw new ValidationError(`workspace conflict: ${msg}`);
      throw err;
    }

    const workspace = (await this.getWorkspace(id))!;
    await this.recordEvent({
      workspace_id: id,
      agent_id: input.agent_id,
      event_type: "created",
      source: input.source ?? "mcp",
      prompt: input.prompt,
      command: input.command,
      after: workspace as unknown as JsonObject,
      metadata: { root_slug: root?.slug, recipe_slug: recipe?.slug },
    });
    return workspace;
  }

  async updateWorkspace(idOrSlug: string, input: UpdateWorkspaceInput): Promise<Workspace> {
    const before = await this.requireWorkspace(idOrSlug);
    const root = input.root_id ? await this.getRoot(input.root_id) : null;
    if (input.root_id && !root) throw new ValidationError(`Root not found: ${input.root_id}`);
    const recipe = input.recipe_id ? await this.getRecipe(input.recipe_id) : null;
    if (input.recipe_id && !recipe) throw new ValidationError(`Recipe not found: ${input.recipe_id}`);

    const updates: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {
      params.push(val);
      updates.push(`${col} = $${params.length}`);
    };
    if (input.name !== undefined) set("name", input.name);
    if (input.slug !== undefined) set("slug", await this.ensureUniqueSlug("workspaces", slugify(input.slug), before.id));
    if (input.description !== undefined) set("description", input.description);
    if (input.kind !== undefined) set("kind", input.kind);
    if (input.status !== undefined) set("status", input.status);
    if (input.root_id !== undefined) set("root_id", input.root_id ? root!.id : null);
    if (input.recipe_id !== undefined) set("recipe_id", input.recipe_id ? recipe!.id : null);
    if (input.primary_path !== undefined) set("primary_path", input.primary_path ?? null);
    if (input.git_remote !== undefined) set("git_remote", input.git_remote);
    if (input.s3_bucket !== undefined) set("s3_bucket", input.s3_bucket);
    if (input.s3_prefix !== undefined) set("s3_prefix", input.s3_prefix);
    if (input.tags !== undefined) set("tags", json(normalizeList(input.tags)));
    if (input.integrations !== undefined) set("integrations", json(input.integrations));
    if (input.metadata !== undefined) set("metadata", json(input.metadata));

    if (updates.length > 0) {
      set("updated_at", nowIso());
      params.push(before.id);
      await this.db.execute(`UPDATE workspaces SET ${updates.join(", ")} WHERE id = $${params.length}`, params);
    }
    const after = (await this.getWorkspace(before.id))!;
    await this.recordEvent({
      workspace_id: before.id,
      agent_id: input.agent_id,
      event_type: input.status === "deleted" ? "deleted" : "updated",
      source: input.source ?? "mcp",
      prompt: input.prompt,
      command: input.command,
      before: before as unknown as JsonObject,
      after: after as unknown as JsonObject,
    });
    return after;
  }

  async archiveWorkspace(idOrSlug: string, input: Omit<UpdateWorkspaceInput, "status"> = {}): Promise<Workspace> {
    return this.updateWorkspace(idOrSlug, { ...input, status: "archived" });
  }

  async unarchiveWorkspace(idOrSlug: string, input: Omit<UpdateWorkspaceInput, "status"> = {}): Promise<Workspace> {
    return this.updateWorkspace(idOrSlug, { ...input, status: "active" });
  }

  async deleteWorkspace(
    idOrSlug: string,
    input: Omit<UpdateWorkspaceInput, "status"> & { hard?: boolean } = {},
  ): Promise<{ workspace: Workspace; hard: boolean }> {
    const before = await this.requireWorkspace(idOrSlug);
    if (!input.hard) {
      const workspace = await this.updateWorkspace(before.id, { ...input, status: "deleted" });
      return { workspace, hard: false };
    }
    await this.recordEvent({
      workspace_id: before.id,
      agent_id: input.agent_id,
      event_type: "deleted",
      source: input.source ?? "mcp",
      prompt: input.prompt,
      command: input.command,
      before: before as unknown as JsonObject,
      metadata: { hard: true },
    });
    await this.db.execute("DELETE FROM workspaces WHERE id = $1", [before.id]);
    return { workspace: before, hard: true };
  }

  // --- events -----------------------------------------------------------
  async listWorkspaceEvents(workspaceId: string, limit = 200): Promise<WorkspaceEvent[]> {
    const rows = await this.db.many<WorkspaceEventRow>(
      "SELECT * FROM workspace_events WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2",
      [workspaceId, Math.min(Math.max(limit, 1), 1000)],
    );
    return rows.map(rowToEvent);
  }

  async recordEvent(input: RecordWorkspaceEventInput): Promise<WorkspaceEvent> {
    const id = generateEventId();
    await this.db.execute(
      `INSERT INTO workspace_events (
        id, workspace_id, agent_id, event_type, source, prompt, command,
        before_json, after_json, metadata, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
        nowIso(),
      ],
    );
    const row = await this.db.get<WorkspaceEventRow>("SELECT * FROM workspace_events WHERE id = $1", [id]);
    return rowToEvent(row!);
  }

  // --- health -----------------------------------------------------------
  async ping(): Promise<boolean> {
    const row = await this.db.get<{ ok: number }>("SELECT 1 AS ok");
    return row?.ok === 1;
  }
}
