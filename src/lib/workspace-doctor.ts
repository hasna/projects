import { existsSync, readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";
import {
  addWorkspaceLocation,
  getRecipe,
  getRoot,
  listAgentRuns,
  listWorkspaceLocations,
  type WorkspaceFilter,
  listWorkspaces,
} from "../db/workspaces.js";
import { workspaceMarkerPath, writeWorkspaceMarker } from "./workspace-runtime.js";
import type { Workspace } from "../types/workspace.js";

export type WorkspaceCheckStatus = "ok" | "warn" | "error";

export interface WorkspaceDoctorCheck {
  code: string;
  name: string;
  status: WorkspaceCheckStatus;
  message: string;
  fixable?: boolean;
}

export interface WorkspaceDoctorFix {
  code: string;
  message: string;
  changed: boolean;
  dryRun: boolean;
}

export interface WorkspaceDoctorResult {
  workspace: Workspace;
  checks: WorkspaceDoctorCheck[];
  fixes: WorkspaceDoctorFix[];
  ok: boolean;
}

function checkPath(workspace: Workspace): WorkspaceDoctorCheck {
  if (!workspace.primary_path) {
    return { code: "WORKSPACE_PATH_MISSING", name: "path", status: "warn", message: "no primary path", fixable: false };
  }
  if (existsSync(workspace.primary_path)) {
    return { code: "WORKSPACE_PATH_OK", name: "path", status: "ok", message: workspace.primary_path };
  }
  return { code: "WORKSPACE_PATH_NOT_FOUND", name: "path", status: "error", message: workspace.primary_path, fixable: true };
}

function checkMarker(workspace: Workspace): WorkspaceDoctorCheck {
  if (!workspace.primary_path || !existsSync(workspace.primary_path)) {
    return { code: "WORKSPACE_MARKER_SKIPPED", name: "marker", status: "warn", message: "skipped because path is missing" };
  }
  const markerPath = workspaceMarkerPath(workspace);
  if (!existsSync(markerPath)) {
    return { code: "WORKSPACE_MARKER_MISSING", name: "marker", status: "warn", message: markerPath, fixable: true };
  }
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { id?: string; slug?: string };
    if (marker.id !== workspace.id || marker.slug !== workspace.slug) {
      return { code: "WORKSPACE_MARKER_MISMATCH", name: "marker", status: "warn", message: markerPath, fixable: true };
    }
    return { code: "WORKSPACE_MARKER_OK", name: "marker", status: "ok", message: markerPath };
  } catch {
    return { code: "WORKSPACE_MARKER_MALFORMED", name: "marker", status: "warn", message: markerPath, fixable: true };
  }
}

function checkReferences(workspace: Workspace, db?: Database): WorkspaceDoctorCheck[] {
  const checks: WorkspaceDoctorCheck[] = [];
  if (workspace.root_id && !getRoot(workspace.root_id, db)) {
    checks.push({ code: "WORKSPACE_ROOT_MISSING", name: "root", status: "error", message: workspace.root_id });
  } else {
    checks.push({ code: "WORKSPACE_ROOT_OK", name: "root", status: "ok", message: workspace.root_id ?? "none" });
  }
  if (workspace.recipe_id && !getRecipe(workspace.recipe_id, db)) {
    checks.push({ code: "WORKSPACE_RECIPE_MISSING", name: "recipe", status: "error", message: workspace.recipe_id });
  } else {
    checks.push({ code: "WORKSPACE_RECIPE_OK", name: "recipe", status: "ok", message: workspace.recipe_id ?? "none" });
  }
  return checks;
}

function checkLocations(workspace: Workspace, db?: Database): WorkspaceDoctorCheck {
  const locations = listWorkspaceLocations(workspace.id, db);
  if (!locations.length) {
    return { code: "WORKSPACE_LOCATIONS_MISSING", name: "locations", status: "warn", message: "no locations registered", fixable: Boolean(workspace.primary_path) };
  }
  const stale = locations.filter((location) => location.kind === "local" && !existsSync(location.path));
  if (stale.length) {
    return { code: "WORKSPACE_LOCATIONS_STALE", name: "locations", status: "warn", message: `${stale.length} stale location(s)` };
  }
  return { code: "WORKSPACE_LOCATIONS_OK", name: "locations", status: "ok", message: `${locations.length} location(s)` };
}

function checkAgentRuns(workspace: Workspace, db?: Database): WorkspaceDoctorCheck {
  const failed = listAgentRuns({ workspace_id: workspace.id, status: "failed", limit: 20 }, db);
  if (failed.length) {
    return { code: "WORKSPACE_AGENT_RUNS_FAILED", name: "agent_runs", status: "warn", message: `${failed.length} failed run(s)` };
  }
  return { code: "WORKSPACE_AGENT_RUNS_OK", name: "agent_runs", status: "ok", message: "no recent failed runs" };
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | null;
  return Boolean(row);
}

function checkMigrationMap(workspace: Workspace, db?: Database): WorkspaceDoctorCheck {
  const migratedFrom = workspace.metadata["migrated_from_project_id"];
  if (typeof migratedFrom !== "string" || migratedFrom.length === 0) {
    return { code: "WORKSPACE_MIGRATION_NOT_APPLICABLE", name: "migration", status: "ok", message: "not migrated" };
  }
  const d = db || getDatabase();
  if (!tableExists(d, "workspace_migration_map")) {
    return { code: "WORKSPACE_MIGRATION_MAP_MISSING", name: "migration", status: "error", message: "workspace_migration_map table missing" };
  }
  const row = d
    .query("SELECT workspace_id FROM workspace_migration_map WHERE old_project_id = ?")
    .get(migratedFrom) as { workspace_id: string } | null;
  if (!row) {
    return { code: "WORKSPACE_MIGRATION_MAP_ROW_MISSING", name: "migration", status: "error", message: migratedFrom };
  }
  if (row.workspace_id !== workspace.id) {
    return { code: "WORKSPACE_MIGRATION_MAP_MISMATCH", name: "migration", status: "error", message: `${migratedFrom} maps to ${row.workspace_id}` };
  }
  return { code: "WORKSPACE_MIGRATION_MAP_OK", name: "migration", status: "ok", message: migratedFrom };
}

export function doctorWorkspace(workspace: Workspace, options: { fix?: boolean; dryRun?: boolean } = {}, db?: Database): WorkspaceDoctorResult {
  const checks = [
    checkPath(workspace),
    checkMarker(workspace),
    ...checkReferences(workspace, db),
    checkLocations(workspace, db),
    checkAgentRuns(workspace, db),
    checkMigrationMap(workspace, db),
  ];
  const fixes: WorkspaceDoctorFix[] = [];
  const dryRun = options.dryRun === true;

  if (options.fix) {
    const markerCheck = checks.find((check) => check.code.startsWith("WORKSPACE_MARKER_") && check.fixable);
    if (markerCheck && workspace.primary_path && existsSync(workspace.primary_path)) {
      if (!dryRun) writeWorkspaceMarker(workspace, { source: "cli", command: "projects doctor --fix" });
      fixes.push({ code: "FIX_WORKSPACE_MARKER", message: `${dryRun ? "Would write" : "Wrote"} ${workspaceMarkerPath(workspace)}`, changed: !dryRun, dryRun });
    }
    const locationCheck = checks.find((check) => check.code === "WORKSPACE_LOCATIONS_MISSING" && check.fixable);
    if (locationCheck && workspace.primary_path) {
      if (!dryRun) addWorkspaceLocation({ workspace_id: workspace.id, path: workspace.primary_path, label: "main", is_primary: true }, db);
      fixes.push({ code: "FIX_WORKSPACE_LOCATION", message: `${dryRun ? "Would add" : "Added"} primary location ${workspace.primary_path}`, changed: !dryRun, dryRun });
    }
  }

  return { workspace, checks, fixes, ok: checks.every((check) => check.status !== "error") };
}

export function doctorWorkspaces(filter: WorkspaceFilter = {}, options: { fix?: boolean; dryRun?: boolean } = {}, db?: Database): WorkspaceDoctorResult[] {
  return listWorkspaces({ ...filter, limit: filter.limit ?? 500 }, db).map((workspace) => doctorWorkspace(workspace, options, db));
}
