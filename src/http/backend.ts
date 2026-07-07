// Projects (workspace registry) storage backend resolver.
//
// Single seam for routing the projects registry dataset (the /v1/projects
// workspaces) to the cloud HTTP API when the client-flip env resolves to cloud
// (HASNA_PROJECTS_STORAGE_MODE=self_hosted + HASNA_PROJECTS_API_URL +
// HASNA_PROJECTS_API_KEY). Otherwise callers keep using the local sqlite store.
//
// Only the portable registry CRUD is routed here: list / get / create / update /
// delete / archive / unarchive / events — exactly what the cloud app exposes.
// Machine-local operations (tmux, clone/import, path resolution, locks) stay
// local by design and are not part of this seam.

import type { Workspace, WorkspaceEvent } from "../types/workspace.js";
import { resolveStorageClient, type StorageClient, type QueryParams } from "./client.js";

const APP = "projects";
const RESOURCE = "projects";

export interface WorkspaceListFilter {
  kind?: string;
  status?: string;
  query?: string;
  root_id?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface ProjectsBackend {
  readonly mode: "local" | "cloud-http";
  readonly baseUrl: string | null;
  listWorkspaces(filter?: WorkspaceListFilter): Promise<Workspace[]>;
  getWorkspace(idOrSlug: string): Promise<Workspace | null>;
  createWorkspace(input: unknown): Promise<Workspace>;
  updateWorkspace(idOrSlug: string, patch: unknown): Promise<Workspace>;
  deleteWorkspace(idOrSlug: string, opts?: { hard?: boolean }): Promise<{ deleted: boolean; hard: boolean; id: string }>;
  archiveWorkspace(idOrSlug: string): Promise<Workspace>;
  unarchiveWorkspace(idOrSlug: string): Promise<Workspace>;
  listWorkspaceEvents(idOrSlug: string, limit?: number): Promise<WorkspaceEvent[]>;
}

function listQuery(filter?: WorkspaceListFilter): QueryParams {
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

function cloudBackend(client: StorageClient): ProjectsBackend {
  const t = client.transport;
  const enc = (id: string) => encodeURIComponent(id);
  return {
    mode: "cloud-http",
    baseUrl: client.baseUrl,
    async listWorkspaces(filter) {
      const raw = await t.get<{ workspaces?: Workspace[] }>("/projects", { query: listQuery(filter) });
      return raw.workspaces ?? [];
    },
    async getWorkspace(idOrSlug) {
      return client.get<Workspace>(RESOURCE, idOrSlug);
    },
    async createWorkspace(input) {
      return client.create<Workspace>(RESOURCE, input);
    },
    async updateWorkspace(idOrSlug, patch) {
      return client.update<Workspace>(RESOURCE, idOrSlug, patch);
    },
    async deleteWorkspace(idOrSlug, opts) {
      const q = opts?.hard ? "?hard=true" : "";
      const res = await t.del<{ deleted?: boolean; hard?: boolean; id?: string }>(`/projects/${enc(idOrSlug)}${q}`);
      return { deleted: res?.deleted !== false, hard: Boolean(res?.hard), id: res?.id ?? idOrSlug };
    },
    async archiveWorkspace(idOrSlug) {
      return t.post<Workspace>(`/projects/${enc(idOrSlug)}/archive`);
    },
    async unarchiveWorkspace(idOrSlug) {
      return t.post<Workspace>(`/projects/${enc(idOrSlug)}/unarchive`);
    },
    async listWorkspaceEvents(idOrSlug, limit) {
      const raw = await t.get<{ events?: WorkspaceEvent[] }>(`/projects/${enc(idOrSlug)}/events`, { query: limit ? { limit } : {} });
      return raw.events ?? [];
    },
  };
}

let cached: ProjectsBackend | null = null;

// Resolve the active projects registry backend from the environment. Returns a
// cloud-http backend when the flip resolves to cloud, else null (caller uses the
// local store). Throws if cloud requested but misconfigured.
export function resolveProjectsBackend(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ProjectsBackend | null {
  if (env === process.env && cached) return cached;
  const resolved = resolveStorageClient(APP, env);
  const backend = resolved.transport === "cloud-http" ? cloudBackend(resolved.client) : null;
  if (env === process.env) cached = backend;
  return backend;
}

export function __resetProjectsBackend(): void {
  cached = null;
}
