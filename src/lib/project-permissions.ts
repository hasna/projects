import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getDbPath } from "../db/database.js";
import { listWorkspaces } from "../db/workspaces.js";
import { getProjectsHome } from "./project-store-paths.js";

export type ProjectPermissionRepairReason =
  | "projects-home"
  | "registry-db"
  | "registry-sidecar"
  | "backup"
  | "workspace-store"
  | "data-store"
  | "project-report-artifact"
  | "project-dashboard-artifact";

export interface ProjectPermissionRepairAction {
  path: string;
  kind: "file" | "directory" | "other" | "missing" | "symlink";
  reason: ProjectPermissionRepairReason;
  before_mode: string | null;
  target_mode: string | null;
  status: "ok" | "planned" | "changed" | "skipped" | "missing" | "error";
  error?: string;
}

export interface ProjectPermissionRepairResult {
  dry_run: boolean;
  applied: boolean;
  projects_home: string;
  db_path: string;
  scanned: number;
  changed: number;
  planned: number;
  skipped: number;
  missing: number;
  errors: number;
  actions: ProjectPermissionRepairAction[];
}

export interface ProjectPermissionRepairOptions {
  apply?: boolean;
  projectsHome?: string;
  dbPath?: string;
  includeProjectArtifacts?: boolean;
  db?: Database;
}

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_PROJECT_ARTIFACTS = 10_000;

export function repairProjectPermissions(options: ProjectPermissionRepairOptions = {}): ProjectPermissionRepairResult {
  const apply = Boolean(options.apply);
  const projectsHome = resolve(options.projectsHome ?? getProjectsHome());
  const dbPath = resolve(options.dbPath ?? getDbPath());
  const actions: ProjectPermissionRepairAction[] = [];
  const visited = new Set<string>();

  const scan = (path: string, reason: ProjectPermissionRepairReason, recursive = true): void => {
    const resolved = resolve(path);
    if (visited.has(resolved)) return;
    visited.add(resolved);

    if (!existsSync(resolved)) {
      actions.push({
        path: resolved,
        kind: "missing",
        reason,
        before_mode: null,
        target_mode: null,
        status: "missing",
      });
      return;
    }

    let stat;
    try {
      stat = lstatSync(resolved);
    } catch (error) {
      actions.push(errorAction(resolved, "other", reason, null, error));
      return;
    }

    if (stat.isSymbolicLink()) {
      actions.push({
        path: resolved,
        kind: "symlink",
        reason,
        before_mode: modeString(stat.mode),
        target_mode: null,
        status: "skipped",
      });
      return;
    }

    const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    const targetMode = kind === "directory"
      ? DIRECTORY_MODE
      : kind === "file"
        ? targetFileMode(stat.mode, reason)
        : null;
    const beforeMode = modeString(stat.mode);
    const needsRepair = targetMode !== null && (stat.mode & 0o777) !== targetMode;
    let status: ProjectPermissionRepairAction["status"] = needsRepair ? (apply ? "changed" : "planned") : "ok";
    let errorMessage: string | undefined;

    if (needsRepair && apply && targetMode !== null) {
      try {
        chmodSync(resolved, targetMode);
      } catch (error) {
        status = "error";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    actions.push({
      path: resolved,
      kind,
      reason,
      before_mode: beforeMode,
      target_mode: targetMode === null ? null : modeString(targetMode),
      status,
      ...(errorMessage ? { error: errorMessage } : {}),
    });

    if (!recursive || kind !== "directory") return;
    let entries;
    try {
      entries = readdirSync(resolved, { withFileTypes: true });
    } catch (error) {
      actions.push(errorAction(resolved, "directory", reason, beforeMode, error));
      return;
    }
    for (const entry of entries) {
      scan(join(resolved, entry.name), reason, true);
    }
  };

  scan(projectsHome, "projects-home", false);
  scan(dbPath, "registry-db", false);
  scan(`${dbPath}-wal`, "registry-sidecar", false);
  scan(`${dbPath}-shm`, "registry-sidecar", false);
  scan(dirname(dbPath), "registry-db", false);

  for (const child of ["backups", "backup", "workspaces", "data", "reports"]) {
    scan(join(projectsHome, child), child === "backups" || child === "backup" ? "backup" : child === "data" ? "data-store" : child === "workspaces" ? "workspace-store" : "project-report-artifact", true);
  }

  for (const backup of safeListBackupFiles(dirname(dbPath))) {
    scan(backup, "backup", false);
  }

  if (options.includeProjectArtifacts !== false) {
    for (const project of safeListProjects(options.db)) {
      if (!project.primary_path) continue;
      if (actions.length > MAX_PROJECT_ARTIFACTS) break;
      scan(join(project.primary_path, "reports"), "project-report-artifact", true);
      scan(join(project.primary_path, ".hasna", "project", "dashboard"), "project-dashboard-artifact", true);
    }
  }

  return {
    dry_run: !apply,
    applied: apply,
    projects_home: projectsHome,
    db_path: dbPath,
    scanned: actions.length,
    changed: actions.filter((action) => action.status === "changed").length,
    planned: actions.filter((action) => action.status === "planned").length,
    skipped: actions.filter((action) => action.status === "skipped").length,
    missing: actions.filter((action) => action.status === "missing").length,
    errors: actions.filter((action) => action.status === "error").length,
    actions,
  };
}

function safeListProjects(db?: Database) {
  try {
    return listWorkspaces({ limit: 10_000 }, db);
  } catch {
    return [];
  }
}

function safeListBackupFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.db.*\.bak/.test(entry.name))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function targetFileMode(mode: number, reason: ProjectPermissionRepairReason): number {
  if (
    reason === "workspace-store"
    || reason === "project-report-artifact"
    || reason === "project-dashboard-artifact"
  ) {
    if ((mode & 0o111) !== 0) return 0o700;
  }
  return FILE_MODE;
}

function errorAction(
  path: string,
  kind: ProjectPermissionRepairAction["kind"],
  reason: ProjectPermissionRepairReason,
  beforeMode: string | null,
  error: unknown,
): ProjectPermissionRepairAction {
  return {
    path,
    kind,
    reason,
    before_mode: beforeMode,
    target_mode: null,
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
}

function modeString(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}
