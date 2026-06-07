import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase } from "../db/database.js";
import { listWorkspaces } from "../db/workspaces.js";
import { runWorkspaceLegacyMigration, type WorkspaceMigrationReport } from "./workspace-migration.js";

function seedLegacyProjectDb(dbPath: string, path: string): void {
  const db = getDatabase(dbPath);
  db.run(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      path TEXT UNIQUE NOT NULL,
      s3_bucket TEXT,
      s3_prefix TEXT,
      git_remote TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      integrations TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT,
      last_opened_at TEXT
    )
  `);
  db.run(
    `INSERT INTO projects (id, slug, name, description, status, path, s3_bucket, s3_prefix, git_remote, tags, integrations, created_at, updated_at, synced_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "prj_report_1",
      "report-legacy",
      "Report Legacy",
      null,
      "active",
      path,
      null,
      null,
      null,
      JSON.stringify(["legacy"]),
      "{}",
      "2026-01-01 00:00:00.000",
      "2026-01-01 00:00:00.000",
      null,
      null,
    ],
  );
  db.close();
}

describe("workspace legacy migration reports", () => {
  test("runs dry-run migration on a copied database and writes report JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-migration-report-"));
    const dbPath = join(root, "workspaces.db");
    const reportPath = join(root, "migration-report.json");
    seedLegacyProjectDb(dbPath, join(root, "legacy-project"));

    const report = runWorkspaceLegacyMigration({ dbPath, dryRun: true, reportPath });
    expect(report.dry_run).toBe(true);
    expect(report.execution_db_path).not.toBe(dbPath);
    expect(report.result.migrated).toBe(1);
    expect(report.result.validation.valid).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    const written = JSON.parse(readFileSync(reportPath, "utf-8")) as WorkspaceMigrationReport;
    expect(written.release_checklist.some((item) => item.key === "migration_counts")).toBe(true);

    const sourceDb = getDatabase(dbPath);
    expect(listWorkspaces({}, sourceDb)).toHaveLength(0);
    sourceDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("creates a backup before mutating the source database", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-migration-backup-"));
    const dbPath = join(root, "workspaces.db");
    const backupDir = join(root, "backups");
    seedLegacyProjectDb(dbPath, join(root, "legacy-project"));

    const report = runWorkspaceLegacyMigration({ dbPath, backupDir });
    expect(report.dry_run).toBe(false);
    expect(report.backup_path).toBeTruthy();
    expect(existsSync(report.backup_path!)).toBe(true);
    expect(report.result.migrated).toBe(1);
    expect(report.release_checklist.find((item) => item.key === "backup")?.status).toBe("done");

    const sourceDb = getDatabase(dbPath);
    expect(listWorkspaces({}, sourceDb)).toHaveLength(1);
    sourceDb.close();
    rmSync(root, { recursive: true, force: true });
  });
});
