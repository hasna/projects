// Unified projects registry Store seam.
//
// ONE interface (`ProjectStore`) with two transports behind it:
//   - LocalProjectStore  -> on-box sqlite (src/db/workspaces.ts)
//   - ApiProjectStore    -> HTTP `<API_URL>/v1` + bearer key (src/http/client.ts)
//
// `resolveProjectStore()` picks the transport from the environment: presence of
// HASNA_PROJECTS_API_URL + HASNA_PROJECTS_API_KEY (and/or
// HASNA_PROJECTS_STORAGE_MODE) => api transport; else local. `self_hosted` and
// `cloud` BOTH resolve to the ApiProjectStore (identical client code; only the
// URL/key differ — that distinction is server-side tenancy, not the client).
//
// This eliminates the per-command `if (cloud) {...} else {...local...}`
// split-brain branching: every registry command/tool/method calls the same
// Store methods. Machine-local runtime side effects (tmux, git, directory
// creation, rendering) are NOT shared state and stay local by design; callers
// gate those on `store.mode === "local"`.
//
// SAFETY: the api transport carries a bearer key ONLY (never a DB DSN). The key
// value is never logged or embedded in output.

import {
  acquireWorkspaceLock,
  archiveWorkspace as dbArchiveWorkspace,
  createWorkspace as dbCreateWorkspace,
  deleteWorkspace as dbDeleteWorkspace,
  listWorkspaceEvents as dbListWorkspaceEvents,
  listWorkspaces as dbListWorkspaces,
  releaseWorkspaceLock,
  resolveWorkspace as dbResolveWorkspace,
  unarchiveWorkspace as dbUnarchiveWorkspace,
  updateWorkspace as dbUpdateWorkspace,
  type WorkspaceFilter,
} from "../db/workspaces.js";
import {
  resolveStorageClient,
  type Env,
  type StorageClient,
  type QueryParams,
} from "../http/client.js";
import type {
  CreateWorkspaceInput,
  EventSource,
  UpdateWorkspaceInput,
  Workspace,
  WorkspaceEvent,
} from "../types/workspace.js";

const APP = "projects";
const RESOURCE = "projects";

export type ProjectStoreMode = "local" | "api";

/** Mutation provenance carried on every write (agent + audit trail). */
export interface MutationContext {
  agentId?: string;
  source?: EventSource;
  command?: string;
  prompt?: string;
  reason?: string;
}

export interface DeleteProjectResult {
  /** The deleted project row when the transport can return it (always local). */
  workspace: Workspace | null;
  hard: boolean;
  /** Stable identifier for the deleted project (id or slug). */
  id: string;
}

export interface ProjectStore {
  readonly mode: ProjectStoreMode;
  /** Base `<url>/v1` for api mode; null for local. Never contains the key. */
  readonly baseUrl: string | null;
  listProjects(filter?: WorkspaceFilter): Promise<Workspace[]>;
  getProject(idOrSlug: string): Promise<Workspace | null>;
  createProject(input: CreateWorkspaceInput): Promise<Workspace>;
  updateProject(id: string, patch: UpdateWorkspaceInput): Promise<Workspace>;
  archiveProject(id: string, ctx?: MutationContext): Promise<Workspace>;
  unarchiveProject(id: string, ctx?: MutationContext): Promise<Workspace>;
  deleteProject(id: string, opts: { hard?: boolean }, ctx?: MutationContext): Promise<DeleteProjectResult>;
  listEvents(idOrSlug: string, limit?: number): Promise<WorkspaceEvent[]>;
}

// --------------------------------------------------------------------------
// Local transport (on-box sqlite)
// --------------------------------------------------------------------------

function withLock<T>(workspaceId: string, ctx: MutationContext | undefined, reason: string, fn: () => T): T {
  const key = `workspace:${workspaceId}`;
  try {
    acquireWorkspaceLock({ lock_key: key, workspace_id: workspaceId, agent_id: ctx?.agentId, reason, ttl_seconds: 600 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Workspace lock already held:")) {
      throw new Error(message.replace("Workspace lock", "Project lock"));
    }
    throw err;
  }
  try {
    return fn();
  } finally {
    releaseWorkspaceLock(key);
  }
}

function mutationFields(ctx?: MutationContext): Pick<UpdateWorkspaceInput, "agent_id" | "source" | "command" | "prompt"> {
  return {
    agent_id: ctx?.agentId,
    source: ctx?.source ?? "cli",
    command: ctx?.command,
    prompt: ctx?.prompt,
  };
}

class LocalProjectStore implements ProjectStore {
  readonly mode = "local" as const;
  readonly baseUrl = null;

  async listProjects(filter?: WorkspaceFilter): Promise<Workspace[]> {
    return dbListWorkspaces(filter ?? {});
  }

  async getProject(idOrSlug: string): Promise<Workspace | null> {
    return dbResolveWorkspace(idOrSlug);
  }

  async createProject(input: CreateWorkspaceInput): Promise<Workspace> {
    return dbCreateWorkspace(input);
  }

  async updateProject(id: string, patch: UpdateWorkspaceInput): Promise<Workspace> {
    return withLock(id, { agentId: patch.agent_id, source: patch.source, command: patch.command }, "project update", () =>
      dbUpdateWorkspace(id, patch),
    );
  }

  async archiveProject(id: string, ctx?: MutationContext): Promise<Workspace> {
    return withLock(id, ctx, "project archive", () => dbArchiveWorkspace(id, mutationFields(ctx)));
  }

  async unarchiveProject(id: string, ctx?: MutationContext): Promise<Workspace> {
    return withLock(id, ctx, "project unarchive", () => dbUnarchiveWorkspace(id, mutationFields(ctx)));
  }

  async deleteProject(id: string, opts: { hard?: boolean }, ctx?: MutationContext): Promise<DeleteProjectResult> {
    const res = withLock(id, ctx, "project delete", () => dbDeleteWorkspace(id, { ...mutationFields(ctx), hard: opts.hard }));
    return { workspace: res.workspace, hard: res.hard, id: res.workspace.id };
  }

  async listEvents(idOrSlug: string, _limit?: number): Promise<WorkspaceEvent[]> {
    const project = dbResolveWorkspace(idOrSlug);
    if (!project) throw new Error(`Project not found: ${idOrSlug}`);
    return dbListWorkspaceEvents(project.id);
  }
}

// --------------------------------------------------------------------------
// Api transport (HTTP /v1 + bearer key)
// --------------------------------------------------------------------------

function listQuery(filter?: WorkspaceFilter): QueryParams {
  if (!filter) return {};
  return {
    kind: filter.kind,
    status: filter.status,
    query: filter.query,
    root_id: filter.root_id,
    tag: filter.tags && filter.tags.length > 0 ? filter.tags[0] : undefined,
    limit: filter.limit,
    offset: filter.offset,
  };
}

class ApiProjectStore implements ProjectStore {
  readonly mode = "api" as const;
  readonly baseUrl: string;
  private readonly client: StorageClient;

  constructor(client: StorageClient) {
    this.client = client;
    this.baseUrl = client.baseUrl;
  }

  async listProjects(filter?: WorkspaceFilter): Promise<Workspace[]> {
    const raw = await this.client.transport.get<{ workspaces?: Workspace[]; projects?: Workspace[] }>("/projects", {
      query: listQuery(filter),
    });
    return raw.workspaces ?? raw.projects ?? [];
  }

  async getProject(idOrSlug: string): Promise<Workspace | null> {
    return this.client.get<Workspace>(RESOURCE, idOrSlug);
  }

  async createProject(input: CreateWorkspaceInput): Promise<Workspace> {
    return this.client.create<Workspace>(RESOURCE, input);
  }

  async updateProject(id: string, patch: UpdateWorkspaceInput): Promise<Workspace> {
    return this.client.update<Workspace>(RESOURCE, id, patch);
  }

  async archiveProject(id: string): Promise<Workspace> {
    return this.client.transport.post<Workspace>(`/projects/${encodeURIComponent(id)}/archive`);
  }

  async unarchiveProject(id: string): Promise<Workspace> {
    return this.client.transport.post<Workspace>(`/projects/${encodeURIComponent(id)}/unarchive`);
  }

  async deleteProject(id: string, opts: { hard?: boolean }): Promise<DeleteProjectResult> {
    const q = opts.hard ? "?hard=true" : "";
    const res = await this.client.transport.del<{
      workspace?: Workspace;
      project?: Workspace;
      hard?: boolean;
      id?: string;
    }>(`/projects/${encodeURIComponent(id)}${q}`);
    const workspace = (res?.workspace ?? res?.project) ?? null;
    return { workspace, hard: Boolean(res?.hard), id: res?.id ?? workspace?.id ?? id };
  }

  async listEvents(idOrSlug: string, limit?: number): Promise<WorkspaceEvent[]> {
    const raw = await this.client.transport.get<{ events?: WorkspaceEvent[] }>(
      `/projects/${encodeURIComponent(idOrSlug)}/events`,
      { query: limit ? { limit } : {} },
    );
    return raw.events ?? [];
  }
}

// --------------------------------------------------------------------------
// Resolver
// --------------------------------------------------------------------------

let cached: ProjectStore | null = null;

/**
 * Resolve the active projects Store from the environment. Returns an
 * ApiProjectStore when the flip resolves to cloud (mode=self_hosted/cloud +
 * API_URL + API_KEY), else a LocalProjectStore. Throws if cloud was requested
 * but is misconfigured (so callers never silently read the wrong dataset).
 */
export function resolveProjectStore(env: Env = process.env): ProjectStore {
  if (env === process.env && cached) return cached;
  const resolved = resolveStorageClient(APP, env);
  const store: ProjectStore =
    resolved.transport === "cloud-http" ? new ApiProjectStore(resolved.client) : new LocalProjectStore();
  if (env === process.env) cached = store;
  return store;
}

/** Test/di seam: clear the process-env cached store. */
export function __resetProjectStore(): void {
  cached = null;
}
