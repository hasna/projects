import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../db/schema.js";
import { createWorkspace } from "../db/workspaces.js";
import { repairProjectPermissions } from "./project-permissions.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("project permission repair", () => {
  test("dry-runs and applies private modes to scoped Projects artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-permissions-"));
    const home = join(root, "projects-home");
    const dbPath = join(home, "projects.db");
    const backupPath = join(home, "projects.db.20260706.bak");
    const dataDb = join(home, "data", "wks_permrepair", "project.db");
    const workspaceFile = join(home, "workspaces", "wks_permrepair", "notes.txt");
    const workspaceScript = join(home, "workspaces", "wks_permrepair", "run.sh");
    const projectPath = join(root, "registered-project");
    const reportFile = join(projectPath, "reports", "2026-07-06", "report.md");
    const dashboardFile = join(projectPath, ".hasna", "project", "dashboard", "render.json");
    const db = makeDb();

    try {
      for (const dir of [
        home,
        join(home, "data", "wks_permrepair"),
        join(home, "workspaces", "wks_permrepair"),
        join(projectPath, "reports", "2026-07-06"),
        join(projectPath, ".hasna", "project", "dashboard"),
      ]) {
        mkdirSync(dir, { recursive: true, mode: 0o755 });
        chmodSync(dir, 0o755);
      }
      for (const file of [
        dbPath,
        `${dbPath}-wal`,
        `${dbPath}-shm`,
        backupPath,
        dataDb,
        workspaceFile,
        reportFile,
        dashboardFile,
      ]) {
        writeFileSync(file, "test");
        chmodSync(file, 0o644);
      }
      writeFileSync(workspaceScript, "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(workspaceScript, 0o755);

      createWorkspace({
        id: "wks_permrepair",
        name: "Permission Repair",
        slug: "permission-repair",
        kind: "project",
        primary_path: projectPath,
      }, db);

      const dryRun = repairProjectPermissions({ projectsHome: home, dbPath, db });
      expect(dryRun.dry_run).toBe(true);
      expect(dryRun.planned).toBeGreaterThan(0);
      expect(mode(dbPath)).toBe(0o644);
      expect(mode(join(home, "data"))).toBe(0o755);

      const applied = repairProjectPermissions({ projectsHome: home, dbPath, db, apply: true });
      expect(applied.applied).toBe(true);
      expect(applied.errors).toBe(0);
      expect(mode(home)).toBe(0o700);
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(`${dbPath}-wal`)).toBe(0o600);
      expect(mode(`${dbPath}-shm`)).toBe(0o600);
      expect(mode(backupPath)).toBe(0o600);
      expect(mode(dataDb)).toBe(0o600);
      expect(mode(workspaceFile)).toBe(0o600);
      expect(mode(workspaceScript)).toBe(0o700);
      expect(mode(reportFile)).toBe(0o600);
      expect(mode(dashboardFile)).toBe(0o600);
      expect(mode(join(projectPath, "reports"))).toBe(0o700);
      expect(mode(join(projectPath, ".hasna", "project", "dashboard"))).toBe(0o700);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
