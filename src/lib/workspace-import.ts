import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  acquireWorkspaceLock,
  createWorkspace,
  getWorkspaceByPath,
  inferWorkspaceKind,
  listRoots,
  matchRootForPath,
  releaseWorkspaceLock,
  workspaceSlugify,
} from "../db/workspaces.js";
import type { EventSource, JsonObject, Root, Workspace, WorkspaceKind, WorkspaceLock } from "../types/workspace.js";
import { isProjectContextError } from "./project-context-errors.js";
import { resolveProjectStoreForTarget, type ProjectStore } from "../store/project-store.js";
import { LEGACY_WORKSPACE_MARKER_FILENAME, PROJECT_MARKER_FILENAME } from "./workspace-runtime.js";

export interface WorkspaceImportPreview {
  name: string;
  slug: string;
  path: string;
  kind: WorkspaceKind;
  root_id?: string;
  tags: string[];
  metadata: JsonObject;
  git_remote?: string;
  confidence: number;
  signals: string[];
}

export interface ImportWorkspaceOptions {
  dryRun?: boolean;
  tags?: string[];
  metadata?: JsonObject;
  agent_id?: string;
  source?: EventSource;
  prompt?: string;
  command?: string;
  db?: Database;
  store?: ProjectStore;
}

export interface ImportWorkspaceResult {
  workspace?: Workspace;
  preview?: WorkspaceImportPreview;
  skipped?: string;
  error?: string;
}

export interface ImportWorkspaceBulkResult {
  imported: Workspace[];
  previews: WorkspaceImportPreview[];
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; error: string }>;
}

export interface ImportRegisteredRootsResult {
  dry_run: boolean;
  roots: Array<{ root: Root; result: ImportWorkspaceBulkResult }>;
  imported: Workspace[];
  previews: WorkspaceImportPreview[];
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; error: string }>;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageName(path: string): string | null {
  const pkg = readJson(join(path, "package.json"));
  return typeof pkg?.["name"] === "string" ? pkg["name"] : null;
}

function markerName(path: string): string | null {
  const project = readJson(join(path, PROJECT_MARKER_FILENAME));
  if (typeof project?.["name"] === "string") return project["name"];
  const workspace = readJson(join(path, LEGACY_WORKSPACE_MARKER_FILENAME));
  if (typeof workspace?.["name"] === "string") return workspace["name"];
  return null;
}

function gitRemote(path: string): string | null {
  if (!existsSync(join(path, ".git"))) return null;
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd: path, encoding: "utf-8", stdio: "pipe" }).trim() || null;
  } catch {
    return null;
  }
}

function importLocks(preview: WorkspaceImportPreview): Array<{ key: string; reason: string }> {
  const locks = [
    { key: `workspace-slug:${preview.slug}`, reason: `Reserve imported workspace slug ${preview.slug}` },
    { key: `workspace-path:${preview.path}`, reason: `Reserve imported workspace path ${preview.path}` },
  ];
  if (preview.root_id) locks.push({ key: `root-path:${preview.root_id}:${preview.slug}`, reason: `Reserve imported root segment ${preview.slug}` });
  return locks;
}

function releaseLocks(locks: WorkspaceLock[], db?: Database): void {
  for (const lock of locks.slice().reverse()) releaseWorkspaceLock(lock.lock_key, db);
}

export function planWorkspaceImport(path: string, options: ImportWorkspaceOptions = {}): WorkspaceImportPreview {
  const absPath = resolve(path);
  if (!existsSync(absPath)) throw new Error(`Path does not exist: ${absPath}`);
  if (!statSync(absPath).isDirectory()) throw new Error(`Path is not a directory: ${absPath}`);

  const signals: string[] = [];
  const name = markerName(absPath) ?? packageName(absPath) ?? basename(absPath);
  if (existsSync(join(absPath, PROJECT_MARKER_FILENAME))) signals.push("project-marker");
  if (existsSync(join(absPath, LEGACY_WORKSPACE_MARKER_FILENAME))) signals.push("legacy-workspace-marker");
  if (existsSync(join(absPath, "package.json"))) signals.push("package-json");
  if (existsSync(join(absPath, ".git"))) signals.push("git");
  for (const dir of ["data", "scripts", "assets", "docs"]) {
    if (existsSync(join(absPath, dir))) signals.push(`scaffold-dir:${dir}`);
  }

  const tags = [...new Set(options.tags ?? [])];
  const slug = workspaceSlugify(name);
  const kind = inferWorkspaceKind(slug, absPath, tags);
  const root = options.store?.mode === "api" ? null : matchRootForPath(absPath, options.db);
  if (root) signals.push(`root:${root.slug}`);
  const remote = gitRemote(absPath) ?? undefined;
  if (remote) signals.push("git-remote");

  return {
    name,
    slug,
    path: absPath,
    kind,
    root_id: root?.id,
    tags,
    metadata: { ...(options.metadata ?? {}) },
    git_remote: remote,
    confidence: Math.min(1, 0.45 + signals.length * 0.12),
    signals,
  };
}

export async function importWorkspace(path: string, options: ImportWorkspaceOptions = {}): Promise<ImportWorkspaceResult> {
  try {
    const selectedStore = resolveProjectStoreForTarget(options);
    const store = options.db && selectedStore.mode === "local"
      ? undefined
      : selectedStore;
    let preview = planWorkspaceImport(path, { ...options, store });
    if (store) {
      const root = (await store.matchRoots({ path: preview.path, kind: preview.kind, tags: preview.tags }))[0]?.root;
      if (root) {
        preview = {
          ...preview,
          root_id: root.id,
          signals: [...new Set([...preview.signals, `root:${root.slug}`])],
        };
      }
      try {
        await store.resolveTargetResolution(preview.path, { intent: "read" });
        return { skipped: "already-registered", preview };
      } catch (error) {
        if (!(isProjectContextError(error) && error.code === "PROJECT_NOT_FOUND")) throw error;
      }
    } else if (getWorkspaceByPath(preview.path, options.db)) {
      return { skipped: "already-registered", preview };
    }
    if (options.dryRun) {
      return { skipped: "dry-run", preview };
    }
    const locks: WorkspaceLock[] = [];
    try {
      for (const lock of store?.mode === "api" ? [] : importLocks(preview)) {
        locks.push(acquireWorkspaceLock({
          lock_key: lock.key,
          agent_id: options.agent_id,
          reason: lock.reason,
          ttl_seconds: 600,
        }, options.db));
      }
      const createInput = {
        name: preview.name,
        slug: preview.slug,
        kind: preview.kind,
        root_id: preview.root_id,
        primary_path: preview.path,
        git_remote: preview.git_remote,
        tags: preview.tags,
        metadata: {
          ...preview.metadata,
          import_signals: preview.signals,
          import_confidence: preview.confidence,
        },
        agent_id: options.agent_id,
        source: options.source ?? "cli",
        prompt: options.prompt,
        command: options.command ?? "projects import",
      };
      const workspace = store
        ? await store.createProject(createInput)
        : createWorkspace(createInput, options.db);
      return { workspace, preview };
    } finally {
      releaseLocks(locks, options.db);
    }
  } catch (err) {
    if (isProjectContextError(err)) throw err;
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function importWorkspaceBulk(path: string, options: ImportWorkspaceOptions = {}): Promise<ImportWorkspaceBulkResult> {
  const absPath = resolve(path);
  const result: ImportWorkspaceBulkResult = { imported: [], previews: [], skipped: [], errors: [] };
  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
    result.errors.push({ path: absPath, error: `Path is not a directory: ${absPath}` });
    return result;
  }
  for (const entry of readdirSync(absPath)) {
    if (entry.startsWith(".")) continue;
    const child = join(absPath, entry);
    if (!statSync(child).isDirectory()) continue;
    const imported = await importWorkspace(child, options);
    if (imported.workspace) result.imported.push(imported.workspace);
    if (imported.preview) result.previews.push(imported.preview);
    if (imported.skipped) result.skipped.push({ path: child, reason: imported.skipped });
    if (imported.error) result.errors.push({ path: child, error: imported.error });
  }
  return result;
}

export async function importRegisteredRoots(options: ImportWorkspaceOptions = {}): Promise<ImportRegisteredRootsResult> {
  const result: ImportRegisteredRootsResult = {
    dry_run: options.dryRun !== false,
    roots: [],
    imported: [],
    previews: [],
    skipped: [],
    errors: [],
  };
  const selectedStore = resolveProjectStoreForTarget(options);
  const store = options.db && selectedStore.mode === "local"
    ? undefined
    : selectedStore;
  for (const root of store ? await store.listRoots() : listRoots(options.db)) {
    if (!existsSync(root.base_path)) {
      result.errors.push({ path: root.base_path, error: "Root path does not exist" });
      continue;
    }
    const rootResult = await importWorkspaceBulk(root.base_path, {
      ...options,
      store,
      dryRun: options.dryRun !== false,
      tags: [...new Set([...(options.tags ?? []), ...root.tags])],
    });
    result.roots.push({ root, result: rootResult });
    result.imported.push(...rootResult.imported);
    result.previews.push(...rootResult.previews);
    result.skipped.push(...rootResult.skipped);
    result.errors.push(...rootResult.errors);
  }
  return result;
}
