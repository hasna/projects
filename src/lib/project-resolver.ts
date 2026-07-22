import type { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import {
  canonicalProjectLocationPath,
  getWorkspaceIdentityBinding,
  listWorkspaces,
  listWorkspacesByPathForMachine,
  resolveWorkspace,
} from "../db/workspaces.js";
import type { Workspace } from "../types/workspace.js";
import { ProjectContextError, isProjectContextError } from "./project-context-errors.js";
import { LEGACY_WORKSPACE_MARKER_FILENAME, PROJECT_MARKER_FILENAME } from "./workspace-runtime.js";

const MAX_PROJECT_MARKER_BYTES = 64 * 1024;

export type ProjectResolverSource = "id-or-slug" | "name" | "path" | "marker";

export interface ProjectMarkerReference {
  id?: string;
  slug?: string;
  path?: string;
  legacy?: boolean;
}

export interface ProjectTargetResolution {
  target: string;
  source: ProjectResolverSource;
  registered: true;
  project: Workspace;
  path?: string;
  realpath?: string;
  marker?: ProjectMarkerReference;
  create_allowed?: false;
}

export interface ProjectResolverOptions {
  db?: Database;
  includeDeleted?: boolean;
  allowPath?: boolean;
  allowMarker?: boolean;
  machineId?: string;
  intent?: "read" | "mutate";
}

export interface CanonicalProjectAuthority {
  readonly mode: "local" | "api";
  readonly owner: string;
  readonly storage: "sqlite" | "cloud" | "self-hosted";
  getProject(idOrSlug: string): Promise<Workspace | null>;
  listProjects?(query: string): Promise<Workspace[]>;
}

export interface CanonicalProjectResolverOptions extends ProjectResolverOptions {
  authority: CanonicalProjectAuthority;
}

export interface CanonicalProjectTargetResolution extends ProjectTargetResolution {
  create_allowed: false;
  authority: {
    owner: string;
    mode: "local" | "api";
    storage: "sqlite" | "cloud" | "self-hosted";
    availability: "available";
  };
}

export function normalizeProjectPath(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  return resolve(target);
}

export function isProjectDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isProjectPathLike(target: string): boolean {
  return target === "."
    || target === ".."
    || target === "~"
    || target.startsWith("~/")
    || target.startsWith("/")
    || target.startsWith("./")
    || target.startsWith("../")
    || target.includes("/")
    || /^[A-Za-z]:[\\/]/.test(target);
}

function markerError(message: string, path: string, cause?: unknown): ProjectContextError {
  return new ProjectContextError("PROJECT_MARKER_INVALID", message, {
    status: 400,
    details: { marker_path: path },
    cause,
  });
}

function readMarkerFile(markerPath: string, legacy: boolean): ProjectMarkerReference {
  let descriptor: number | undefined;
  let contents: string;
  try {
    descriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw markerError("Project marker must be a regular file", markerPath);
    }
    if (stat.size > MAX_PROJECT_MARKER_BYTES) {
      throw markerError(`Project marker exceeds ${MAX_PROJECT_MARKER_BYTES} bytes`, markerPath);
    }
    contents = readFileSync(descriptor, "utf-8");
    if (Buffer.byteLength(contents, "utf-8") > MAX_PROJECT_MARKER_BYTES) {
      throw markerError(`Project marker exceeds ${MAX_PROJECT_MARKER_BYTES} bytes`, markerPath);
    }
  } catch (error) {
    if (isProjectContextError(error)) throw error;
    throw markerError("Project marker could not be inspected", markerPath, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw markerError("Project marker is malformed JSON", markerPath, error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw markerError("Project marker must be a JSON object", markerPath);
  }
  const record = parsed as Record<string, unknown>;
  const id = typeof record["id"] === "string" && record["id"].trim()
    ? record["id"].trim()
    : undefined;
  const slug = typeof record["slug"] === "string" && record["slug"].trim()
    ? record["slug"].trim()
    : undefined;
  if (!id && !slug) {
    throw markerError("Project marker must contain a non-empty id or slug", markerPath);
  }
  if ((id?.length ?? 0) > 256 || (slug?.length ?? 0) > 256) {
    throw markerError("Project marker locator is too long", markerPath);
  }
  return { id, slug, path: markerPath, legacy };
}

/** Read a trusted marker in exactly one directory. */
export function readProjectMarker(path: string): ProjectMarkerReference | null {
  for (const [filename, legacy] of [
    [PROJECT_MARKER_FILENAME, false],
    [LEGACY_WORKSPACE_MARKER_FILENAME, true],
  ] as const) {
    const markerPath = join(path, filename);
    try {
      lstatSync(markerPath);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw markerError("Project marker could not be inspected", markerPath, error);
    }
    return readMarkerFile(markerPath, legacy);
  }
  return null;
}

/** Walk from the real target directory upward and return the nearest marker. */
export function findNearestProjectMarker(path: string): ProjectMarkerReference | null {
  let current = canonicalProjectLocationPath(path);
  const root = parse(current).root;
  for (;;) {
    const marker = readProjectMarker(current);
    if (marker) return marker;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isResolvableProject(workspace: Workspace, options: ProjectResolverOptions): boolean {
  return options.includeDeleted === true || workspace.status !== "deleted";
}

function exactNameMatches(target: string, options: ProjectResolverOptions): Workspace[] {
  const lower = target.toLowerCase();
  return listWorkspaces({ query: target, limit: 200 }, options.db)
    .filter((workspace) => isResolvableProject(workspace, options))
    .filter((workspace) => workspace.name.toLowerCase() === lower);
}

function localMarkerProject(
  marker: ProjectMarkerReference,
  options: ProjectResolverOptions,
): Workspace {
  const project = (marker.id ? resolveWorkspace(marker.id, options.db) : null)
    ?? (marker.slug ? resolveWorkspace(marker.slug, options.db) : null);
  if (!project) {
    throw new ProjectContextError("PROJECT_MARKER_ORPHANED", "Project marker references an unknown project", {
      status: 409,
      details: { marker_path: marker.path, id: marker.id, slug: marker.slug },
    });
  }
  if (project.status === "deleted" && options.includeDeleted !== true) {
    throw new ProjectContextError("PROJECT_DELETED", "Project marker references a deleted project", {
      status: 409,
      project,
      details: { marker_path: marker.path },
    });
  }
  return project;
}

function localPathResolution(
  normalizedTarget: string,
  path: string,
  options: ProjectResolverOptions,
): ProjectTargetResolution | null {
  const realpath = canonicalProjectLocationPath(path);
  const marker = options.allowMarker === false ? null : findNearestProjectMarker(realpath);
  const markerProject = marker ? localMarkerProject(marker, options) : null;
  const pathMatches = listWorkspacesByPathForMachine(
    realpath,
    { machineId: options.machineId },
    options.db,
  ).filter((workspace) => isResolvableProject(workspace, options));
  if (pathMatches.length > 1) {
    throw new ProjectContextError("PROJECT_IDENTITY_CONFLICT", "Project realpath has multiple canonical bindings", {
      status: 409,
      details: { realpath, project_ids: pathMatches.map((workspace) => workspace.id).sort() },
    });
  }
  const pathProject = pathMatches[0] ?? null;
  if (markerProject && pathProject && markerProject.id !== pathProject.id) {
    throw new ProjectContextError("PROJECT_IDENTITY_CONFLICT", "Project marker and machine realpath binding disagree", {
      status: 409,
      details: {
        marker_project_id: markerProject.id,
        binding_project_id: pathProject.id,
        marker_path: marker?.path,
        realpath,
      },
    });
  }
  const project = markerProject ?? pathProject;
  if (!project) return null;
  return {
    target: normalizedTarget,
    source: markerProject ? "marker" : "path",
    registered: true,
    project,
    path,
    realpath,
    marker: marker ?? undefined,
    create_allowed: false,
  };
}

export function resolveRegisteredProjectTarget(
  target: string | undefined,
  options: ProjectResolverOptions = {},
): ProjectTargetResolution | null {
  const normalizedTarget = target?.trim() || ".";
  const byIdOrSlug = resolveWorkspace(normalizedTarget, options.db);
  if (byIdOrSlug && isResolvableProject(byIdOrSlug, options)) {
    return {
      target: normalizedTarget,
      source: "id-or-slug",
      registered: true,
      project: byIdOrSlug,
      create_allowed: false,
    };
  }

  const matches = exactNameMatches(normalizedTarget, options);
  if (matches.length === 1) {
    return {
      target: normalizedTarget,
      source: "name",
      registered: true,
      project: matches[0]!,
      create_allowed: false,
    };
  }
  if (matches.length > 1) {
    throw new ProjectContextError("PROJECT_IDENTITY_CONFLICT", `Project name is ambiguous: ${normalizedTarget}`, {
      status: 409,
      details: { project_ids: matches.map((project) => project.id).sort() },
    });
  }
  if (options.allowPath === false) return null;

  const path = normalizeProjectPath(normalizedTarget);
  if (!isProjectPathLike(normalizedTarget) && !isProjectDirectory(path)) return null;
  if (!isProjectDirectory(path)) {
    if (!existsSync(path)) {
      throw new ProjectContextError("PROJECT_NOT_FOUND", `Project path has no identity locator: ${path}`, {
        status: 404,
        details: { path },
      });
    }
    throw new ProjectContextError("PROJECT_PATH_INVALID", `Project path is not a directory: ${path}`, {
      status: 400,
      details: { path },
    });
  }
  return localPathResolution(normalizedTarget, path, options);
}

export function resolveRegisteredProjectTargetOrThrow(
  target: string | undefined,
  options: ProjectResolverOptions = {},
): ProjectTargetResolution {
  const resolution = resolveRegisteredProjectTarget(target, options);
  if (!resolution) {
    throw new ProjectContextError("PROJECT_NOT_FOUND", `Project not found: ${target?.trim() || "."}`, { status: 404 });
  }
  return resolution;
}

async function authorityGet(
  authority: CanonicalProjectAuthority,
  idOrSlug: string,
): Promise<Workspace | null> {
  try {
    return await authority.getProject(idOrSlug);
  } catch (error) {
    if (isProjectContextError(error)) throw error;
    throw new ProjectContextError("PROJECT_AUTHORITY_UNAVAILABLE", "Canonical Projects authority is unavailable", {
      status: 503,
      details: { authority_owner: authority.owner, authority_mode: authority.mode },
      cause: error,
    });
  }
}

function assertMutable(project: Workspace, intent: "read" | "mutate"): void {
  if (intent !== "mutate") return;
  if (project.status === "archived") {
    throw new ProjectContextError("PROJECT_ARCHIVED", "Project is archived", { status: 409, project });
  }
  if (project.status === "deleted") {
    throw new ProjectContextError("PROJECT_DELETED", "Project is deleted", { status: 409, project });
  }
}

function canonicalResult(
  normalizedTarget: string,
  project: Workspace,
  source: ProjectResolverSource,
  options: CanonicalProjectResolverOptions,
  path?: string,
  realpath?: string,
  marker?: ProjectMarkerReference,
): CanonicalProjectTargetResolution {
  assertMutable(project, options.intent ?? "read");
  return {
    target: normalizedTarget,
    source,
    registered: true,
    project,
    path,
    realpath,
    marker,
    create_allowed: false,
    authority: {
      owner: options.authority.owner,
      mode: options.authority.mode,
      storage: options.authority.storage,
      availability: "available",
    },
  };
}

/**
 * Resolve local marker/realpath evidence to a canonical project. Local SQLite
 * contributes only locator IDs; every project field comes from the selected
 * authority, including in API mode.
 */
export async function resolveCanonicalProjectTarget(
  target: string | undefined,
  options: CanonicalProjectResolverOptions,
): Promise<CanonicalProjectTargetResolution> {
  const normalizedTarget = target?.trim() || ".";
  const path = normalizeProjectPath(normalizedTarget);
  const pathTarget = options.allowPath !== false
    && (isProjectPathLike(normalizedTarget) || isProjectDirectory(path));

  if (!pathTarget) {
    let project = await authorityGet(options.authority, normalizedTarget);
    let source: ProjectResolverSource = "id-or-slug";
    if (!project && options.authority.listProjects) {
      let candidates: Workspace[];
      try {
        candidates = await options.authority.listProjects(normalizedTarget);
      } catch (error) {
        if (isProjectContextError(error)) throw error;
        throw new ProjectContextError("PROJECT_AUTHORITY_UNAVAILABLE", "Canonical Projects authority is unavailable", {
          status: 503,
          details: { authority_owner: options.authority.owner, authority_mode: options.authority.mode },
          cause: error,
        });
      }
      const exact = candidates.filter((candidate) => candidate.name.toLowerCase() === normalizedTarget.toLowerCase());
      if (exact.length > 1) {
        throw new ProjectContextError("PROJECT_IDENTITY_CONFLICT", `Project name is ambiguous: ${normalizedTarget}`, {
          status: 409,
          details: { project_ids: exact.map((candidate) => candidate.id).sort() },
        });
      }
      project = exact[0] ?? null;
      source = "name";
    }
    if (!project) {
      throw new ProjectContextError("PROJECT_NOT_FOUND", `Project not found: ${normalizedTarget}`, { status: 404 });
    }
    return canonicalResult(normalizedTarget, project, source, options);
  }

  const realpath = canonicalProjectLocationPath(path);
  // Canonical resolution must never open a process-default local registry as a
  // side effect. Callers that intentionally use machine bindings provide the
  // selected DB explicitly; marker-only resolution remains filesystem-local.
  const bindingId = options.db
    ? getWorkspaceIdentityBinding(realpath, { machineId: options.machineId }, options.db)?.workspace_id
    : undefined;
  if (!isProjectDirectory(path)) {
    if (bindingId) {
      const bindingProject = await authorityGet(options.authority, bindingId);
      if (!bindingProject) {
        throw new ProjectContextError("PROJECT_IDENTITY_CONFLICT", "Machine path binding is absent from the selected authority", {
          status: 409,
          details: { binding_project_id: bindingId, realpath },
        });
      }
      return canonicalResult(normalizedTarget, bindingProject, "path", options, path, realpath);
    }
    if (!existsSync(path)) {
      throw new ProjectContextError("PROJECT_NOT_FOUND", `Project path has no identity locator: ${path}`, {
        status: 404,
        details: { path },
      });
    }
    throw new ProjectContextError("PROJECT_PATH_INVALID", `Project path is not a directory: ${path}`, {
      status: 400,
      details: { path },
    });
  }
  const marker = options.allowMarker === false ? null : findNearestProjectMarker(realpath);
  const markerTarget = marker?.id ?? marker?.slug;
  if (!markerTarget && !bindingId) {
    throw new ProjectContextError("PROJECT_NOT_FOUND", `Project not found: ${normalizedTarget}`, { status: 404 });
  }

  let markerProject = markerTarget ? await authorityGet(options.authority, markerTarget) : null;
  if (!markerProject && marker?.id && marker.slug && markerTarget === marker.id) {
    markerProject = await authorityGet(options.authority, marker.slug);
  }
  if (markerTarget && !markerProject) {
    throw new ProjectContextError("PROJECT_MARKER_ORPHANED", "Project marker is not present in the selected authority", {
      status: 409,
      details: { marker_path: marker?.path, id: marker?.id, slug: marker?.slug },
    });
  }
  const bindingProject = bindingId
    ? markerProject?.id === bindingId
      ? markerProject
      : await authorityGet(options.authority, bindingId)
    : null;
  if (bindingId && !bindingProject) {
    throw new ProjectContextError("PROJECT_IDENTITY_CONFLICT", "Machine realpath binding is absent from the selected authority", {
      status: 409,
      details: { binding_project_id: bindingId, realpath },
    });
  }
  if (markerProject && bindingProject && markerProject.id !== bindingProject.id) {
    throw new ProjectContextError("PROJECT_IDENTITY_CONFLICT", "Project marker and machine realpath binding disagree", {
      status: 409,
      details: {
        marker_project_id: markerProject.id,
        binding_project_id: bindingProject.id,
        marker_path: marker?.path,
        realpath,
      },
    });
  }
  const project = markerProject ?? bindingProject;
  if (!project) {
    throw new ProjectContextError("PROJECT_NOT_FOUND", `Project not found: ${normalizedTarget}`, { status: 404 });
  }
  return canonicalResult(
    normalizedTarget,
    project,
    markerProject ? "marker" : "path",
    options,
    path,
    realpath,
    marker ?? undefined,
  );
}
