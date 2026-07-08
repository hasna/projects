import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  inferWorkspaceKind,
  workspaceSlugify,
} from "../db/workspaces.js";
import type { ProjectStore } from "../store/project-store.js";
import type { EventSource, JsonObject, Root, Workspace, WorkspaceKind, WorkspaceLock } from "../types/workspace.js";
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

// Import reservation locks are machine-local coordination; in api mode the
// Store cannot hold local locks (cloud enforces uniqueness), so they are
// skipped rather than written to invisible local sqlite (split-brain).
async function acquireImportLocks(store: ProjectStore, specs: Array<{ key: string; reason: string }>, agentId?: string): Promise<WorkspaceLock[]> {
  if (store.mode !== "local") return [];
  const acquired: WorkspaceLock[] = [];
  try {
    for (const spec of specs) {
      acquired.push(await store.acquireLock({ key: spec.key, agentId, reason: spec.reason, ttlSeconds: 600 }));
    }
  } catch (err) {
    await releaseImportLocks(store, acquired);
    throw err;
  }
  return acquired;
}

async function releaseImportLocks(store: ProjectStore, locks: WorkspaceLock[]): Promise<void> {
  for (const lock of locks.slice().reverse()) await store.releaseLock(lock.lock_key);
}

export async function planWorkspaceImport(store: ProjectStore, path: string, options: ImportWorkspaceOptions = {}): Promise<WorkspaceImportPreview> {
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
  const rootMatches = await store.matchRoots({ path: absPath });
  const root = rootMatches[0]?.root ?? null;
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

export async function importWorkspace(store: ProjectStore, path: string, options: ImportWorkspaceOptions = {}): Promise<ImportWorkspaceResult> {
  try {
    const preview = await planWorkspaceImport(store, path, options);
    const targetPath = resolve(preview.path);
    const existing = (await store.listProjects({ limit: 10000 }))
      .find((w) => w.primary_path && resolve(w.primary_path) === targetPath);
    if (existing) {
      return { skipped: "already-registered", preview };
    }
    if (options.dryRun) {
      return { skipped: "dry-run", preview };
    }
    const locks = await acquireImportLocks(store, importLocks(preview), options.agent_id);
    try {
      const workspace = await store.createProject({
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
      });
      return { workspace, preview };
    } finally {
      await releaseImportLocks(store, locks);
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function importWorkspaceBulk(store: ProjectStore, path: string, options: ImportWorkspaceOptions = {}): Promise<ImportWorkspaceBulkResult> {
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
    const imported = await importWorkspace(store, child, options);
    if (imported.workspace) result.imported.push(imported.workspace);
    if (imported.preview) result.previews.push(imported.preview);
    if (imported.skipped) result.skipped.push({ path: child, reason: imported.skipped });
    if (imported.error) result.errors.push({ path: child, error: imported.error });
  }
  return result;
}

export async function importRegisteredRoots(store: ProjectStore, options: ImportWorkspaceOptions = {}): Promise<ImportRegisteredRootsResult> {
  const result: ImportRegisteredRootsResult = {
    dry_run: options.dryRun !== false,
    roots: [],
    imported: [],
    previews: [],
    skipped: [],
    errors: [],
  };
  for (const root of await store.listRoots()) {
    if (!existsSync(root.base_path)) {
      result.errors.push({ path: root.base_path, error: "Root path does not exist" });
      continue;
    }
    const rootResult = await importWorkspaceBulk(store, root.base_path, {
      ...options,
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
