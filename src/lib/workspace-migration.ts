import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getDatabase, getDbPath } from "../db/database.js";
import { migrateLegacyProjectsToWorkspaces, type MigrationResult } from "../db/workspaces.js";

export interface WorkspaceMigrationOptions {
  dbPath?: string;
  dryRun?: boolean;
  backup?: boolean;
  backupDir?: string;
  backupPath?: string;
  reportPath?: string;
}

export interface WorkspaceMigrationChecklistItem {
  key: string;
  status: "done" | "pending" | "skipped" | "needs_attention" | "not_applicable";
  detail: string;
}

export interface WorkspaceMigrationReport {
  db_path: string;
  dry_run: boolean;
  execution_db_path: string;
  backup_path: string | null;
  backup_sidecars: string[];
  report_path: string | null;
  result: MigrationResult;
  release_checklist: WorkspaceMigrationChecklistItem[];
}

function isFileDb(path: string): boolean {
  return path !== ":memory:";
}

function timestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureParent(path: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

function copyIfExists(source: string, target: string): boolean {
  if (!existsSync(source)) return false;
  ensureParent(target);
  copyFileSync(source, target);
  return true;
}

function snapshotDatabaseFiles(sourcePath: string, targetPath: string): string[] {
  if (!isFileDb(sourcePath)) return [];
  const copied: string[] = [];
  if (copyIfExists(sourcePath, targetPath)) copied.push(targetPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sourceSidecar = `${sourcePath}${suffix}`;
    const targetSidecar = `${targetPath}${suffix}`;
    if (copyIfExists(sourceSidecar, targetSidecar)) copied.push(targetSidecar);
  }
  return copied;
}

function defaultBackupPath(dbPath: string, backupDir?: string): string {
  const dir = backupDir ? resolve(backupDir) : dirname(resolve(dbPath));
  return join(dir, `${basename(dbPath)}.${timestampForPath()}.bak`);
}

function buildReleaseChecklist(report: Omit<WorkspaceMigrationReport, "release_checklist">): WorkspaceMigrationChecklistItem[] {
  const validationStatus = report.result.validation.valid ? "done" : "needs_attention";
  const backupStatus = report.dry_run
    ? "not_applicable"
    : report.backup_path
      ? "done"
      : "skipped";
  return [
    {
      key: "backup",
      status: backupStatus,
      detail: report.backup_path ? `Backup snapshot written to ${report.backup_path}` : "No backup snapshot was written for this run.",
    },
    {
      key: "migration_counts",
      status: validationStatus,
      detail: `${report.result.validation.accounted_projects}/${report.result.validation.expected_legacy_projects} legacy projects accounted for; ${report.result.validation.workdir_migrated} workdir rows migrated and ${report.result.validation.workdir_skipped} skipped.`,
    },
    {
      key: "mcp_config_review",
      status: "pending",
      detail: "Review MCP client configs for the project-first projects-mcp tool surface.",
    },
    {
      key: "build_test_publish",
      status: "pending",
      detail: "Run typecheck, tests, build, then publish/update local installs after migration validation is clean.",
    },
    {
      key: "rollback",
      status: report.backup_path ? "done" : "pending",
      detail: report.backup_path ? `Restore ${report.backup_path} if rollback is required.` : "Create or identify a rollback snapshot before production migration.",
    },
  ];
}

export function runWorkspaceLegacyMigration(options: WorkspaceMigrationOptions = {}): WorkspaceMigrationReport {
  const dbPath = options.dbPath ?? getDbPath();
  const dryRun = Boolean(options.dryRun);
  const backupEnabled = options.backup !== false;
  if (options.backupDir && options.backupPath) {
    throw new Error("Use either --backup-dir or --backup-path, not both");
  }

  let executionDbPath = dbPath;
  let backupPath: string | null = null;
  let backupSidecars: string[] = [];

  if (dryRun && isFileDb(dbPath)) {
    const dryRunDir = mkdtempForMigration();
    executionDbPath = join(dryRunDir, basename(dbPath) || "workspaces.db");
    snapshotDatabaseFiles(dbPath, executionDbPath);
  } else if (!dryRun && backupEnabled && isFileDb(dbPath) && existsSync(dbPath)) {
    backupPath = resolve(options.backupPath ?? defaultBackupPath(dbPath, options.backupDir));
    backupSidecars = snapshotDatabaseFiles(dbPath, backupPath);
    if (backupSidecars.length === 0) backupPath = null;
  }

  const db = getDatabase(executionDbPath);
  try {
    const result = migrateLegacyProjectsToWorkspaces(db);
    const reportWithoutChecklist: Omit<WorkspaceMigrationReport, "release_checklist"> = {
      db_path: dbPath,
      dry_run: dryRun,
      execution_db_path: executionDbPath,
      backup_path: backupPath,
      backup_sidecars: backupSidecars,
      report_path: options.reportPath ? resolve(options.reportPath) : null,
      result,
    };
    const report: WorkspaceMigrationReport = {
      ...reportWithoutChecklist,
      release_checklist: buildReleaseChecklist(reportWithoutChecklist),
    };
    if (report.report_path) {
      ensureParent(report.report_path);
      writeFileSync(report.report_path, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    }
    return report;
  } finally {
    db.close();
  }
}

function mkdtempForMigration(): string {
  return mkdtempSync(join(tmpdir(), "workspaces-migration-dry-run-"));
}
