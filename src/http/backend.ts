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
import { resolveProjectStore, type ProjectStore } from "../store/project-store.js";

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

function cloudBackend(store: ProjectStore): ProjectsBackend {
  return {
    mode: "cloud-http",
    baseUrl: store.baseUrl,
    async listWorkspaces(filter) {
      return store.listProjects(filter as never);
    },
    async getWorkspace(idOrSlug) {
      return store.getProject(idOrSlug);
    },
    async createWorkspace(input) {
      return store.createProject(input as never);
    },
    async updateWorkspace(idOrSlug, patch) {
      const project = await store.resolveTarget(idOrSlug, { intent: "mutate" });
      return store.updateProject(project.id, patch as never);
    },
    async deleteWorkspace(idOrSlug, opts) {
      const project = await store.resolveTarget(idOrSlug, { intent: "mutate" });
      const result = await store.deleteProject(project.id, { hard: opts?.hard });
      return { deleted: true, hard: result.hard, id: result.id };
    },
    async archiveWorkspace(idOrSlug) {
      const project = await store.resolveTarget(idOrSlug, { intent: "mutate" });
      return store.archiveProject(project.id);
    },
    async unarchiveWorkspace(idOrSlug) {
      const project = await store.resolveTarget(idOrSlug, { intent: "read" });
      return store.unarchiveProject(project.id);
    },
    async listWorkspaceEvents(idOrSlug, limit) {
      const project = await store.resolveTarget(idOrSlug, { intent: "read" });
      return store.listEvents(project.id, limit);
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
  const store = resolveProjectStore(env);
  const backend = store.mode === "api" ? cloudBackend(store) : null;
  if (env === process.env) cached = backend;
  return backend;
}

export function __resetProjectsBackend(): void {
  cached = null;
}
