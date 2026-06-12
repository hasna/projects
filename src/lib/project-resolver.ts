import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  listWorkspaces,
  listWorkspacesByPath,
  resolveWorkspace,
} from "../db/workspaces.js";
import type { Workspace } from "../types/workspace.js";
import { LEGACY_WORKSPACE_MARKER_FILENAME, PROJECT_MARKER_FILENAME } from "./workspace-runtime.js";

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
  marker?: ProjectMarkerReference;
}

export interface ProjectResolverOptions {
  db?: Database;
  includeDeleted?: boolean;
  allowPath?: boolean;
  allowMarker?: boolean;
}

export function normalizeProjectPath(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  return resolve(target);
}

export function isProjectDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
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
    || target.includes("/");
}

export function readProjectMarker(path: string): ProjectMarkerReference | null {
  const markerPath = [join(path, PROJECT_MARKER_FILENAME), join(path, LEGACY_WORKSPACE_MARKER_FILENAME)]
    .find((candidate) => existsSync(candidate));
  if (!markerPath) return null;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { id?: unknown; slug?: unknown };
    return {
      id: typeof marker.id === "string" && marker.id.trim() ? marker.id.trim() : undefined,
      slug: typeof marker.slug === "string" && marker.slug.trim() ? marker.slug.trim() : undefined,
      path: markerPath,
      legacy: markerPath.endsWith(LEGACY_WORKSPACE_MARKER_FILENAME),
    };
  } catch (err) {
    throw new Error(`Project marker is malformed: ${markerPath}: ${err instanceof Error ? err.message : String(err)}`);
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

function workspaceFromMarker(path: string, options: ProjectResolverOptions): { project: Workspace; marker: ProjectMarkerReference } | null {
  const marker = readProjectMarker(path);
  if (!marker) return null;
  for (const idOrSlug of [marker.id, marker.slug]) {
    if (!idOrSlug) continue;
    const workspace = resolveWorkspace(idOrSlug, options.db);
    if (workspace && isResolvableProject(workspace, options)) return { project: workspace, marker };
  }
  throw new Error(`Project marker references an unknown project: ${marker.path ?? join(path, PROJECT_MARKER_FILENAME)}`);
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
    };
  }

  const matches = exactNameMatches(normalizedTarget, options);
  if (matches.length === 1) {
    return {
      target: normalizedTarget,
      source: "name",
      registered: true,
      project: matches[0]!,
    };
  }
  if (matches.length > 1) {
    throw new Error(`Project name is ambiguous: ${normalizedTarget}`);
  }

  if (options.allowPath === false) return null;
  const path = normalizeProjectPath(normalizedTarget);
  if (!isProjectPathLike(normalizedTarget) && !isProjectDirectory(path)) return null;
  if (!isProjectDirectory(path)) throw new Error(`Project path does not exist or is not a directory: ${path}`);

  const pathMatches = listWorkspacesByPath(path, options.db).filter((workspace) => isResolvableProject(workspace, options));
  if (pathMatches.length > 1) {
    throw new Error(`Project path is ambiguous: ${path} matches ${pathMatches.map((workspace) => workspace.slug).join(", ")}`);
  }
  if (pathMatches[0]) {
    return {
      target: normalizedTarget,
      source: "path",
      registered: true,
      project: pathMatches[0],
      path,
    };
  }

  if (options.allowMarker === false) return null;
  const markerMatch = workspaceFromMarker(path, options);
  if (markerMatch) {
    return {
      target: normalizedTarget,
      source: "marker",
      registered: true,
      project: markerMatch.project,
      path,
      marker: markerMatch.marker,
    };
  }

  return null;
}

export function resolveRegisteredProjectTargetOrThrow(
  target: string | undefined,
  options: ProjectResolverOptions = {},
): ProjectTargetResolution {
  const resolution = resolveRegisteredProjectTarget(target, options);
  if (!resolution) throw new Error(`Project not found: ${target?.trim() || "."}`);
  return resolution;
}
