import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { closeDatabase, getDatabase, getDbPath, resolvePartialId, now, uuid } from "./database.js";
import { runMigrations } from "./schema.js";
import { createWorkspace } from "./workspaces.js";

describe("database", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["HASNA_WORKSPACES_DB_PATH"];
    delete process.env["HASNA_PROJECTS_DB_PATH"];
  });

  describe("getDatabase", () => {
    test("creates in-memory database", () => {
      const db = new Database(":memory:");
      runMigrations(db);
      expect(db).toBeDefined();
      db.close();
    });

    test("creates database at custom path with auto-created directory", () => {
      const tmp = mkdtempSync(join(tmpdir(), "db-test-"));
      const dbPath = join(tmp, "nested", "dir", "test.db");
      expect(existsSync(join(tmp, "nested"))).toBe(false);

      const db = getDatabase(dbPath);
      expect(db).toBeDefined();
      expect(existsSync(dbPath)).toBe(true);

      db.close();
      rmSync(tmp, { recursive: true });
    });

    test("reopens the cached default database when HASNA_PROJECTS_DB_PATH changes", () => {
      const tmp = mkdtempSync(join(tmpdir(), "db-switch-"));
      const firstPath = join(tmp, "first.db");
      const secondPath = join(tmp, "second.db");

      process.env["HASNA_PROJECTS_DB_PATH"] = firstPath;
      const first = getDatabase();
      createWorkspace({ name: "First", slug: "first", kind: "generic" });

      process.env["HASNA_PROJECTS_DB_PATH"] = secondPath;
      const second = getDatabase();
      createWorkspace({ name: "Second", slug: "second", kind: "generic" });

      expect(first).not.toBe(second);
      expect(resolvePartialId("second")).toBeTruthy();
      expect(existsSync(firstPath)).toBe(true);
      expect(existsSync(secondPath)).toBe(true);

      rmSync(tmp, { recursive: true, force: true });
    });

    test("audits historical identity collisions instead of guessing during migration", () => {
      const database = new Database(":memory:");
      const realPath = mkdtempSync(join(tmpdir(), "projects-identity-migration-"));
      try {
        database.run("PRAGMA foreign_keys=ON");
        database.run(`
          CREATE TABLE _migrations (
            id INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO _migrations (id) VALUES (1), (2), (3), (4), (5), (6);
          CREATE TABLE workspaces (
            id TEXT PRIMARY KEY,
            slug TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            primary_path TEXT
          );
          CREATE TABLE workspace_locations (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id),
            path TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT 'main',
            kind TEXT NOT NULL DEFAULT 'local',
            is_primary INTEGER NOT NULL DEFAULT 0,
            exists_at_create INTEGER NOT NULL DEFAULT 0,
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(workspace_id, path, machine_id)
          );
          INSERT INTO workspaces (id, slug, primary_path) VALUES
            ('wks_a', 'a', NULL),
            ('wks_b', 'b', NULL),
            ('wks_unattested', 'unattested', '/historical/unattested');
        `);
        database.run(
          "INSERT INTO workspace_locations (id, workspace_id, path, machine_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
          ["loc_a", "wks_a", realPath, "station-1", "loc_b", "wks_b", realPath, "station-1"],
        );

        runMigrations(database);

        const audit = database.query(
          "SELECT reason, location_owner_id, real_path, workspace_ids FROM project_identity_migration_audit WHERE reason = 'historical_identity_collision'",
        ).get() as { reason: string; location_owner_id: string; real_path: string; workspace_ids: string };
        expect(audit.reason).toBe("historical_identity_collision");
        expect(audit.location_owner_id).toBe("station-1");
        expect(audit.real_path).toBe(realPath);
        expect(JSON.parse(audit.workspace_ids)).toEqual(["wks_a", "wks_b"]);
        expect((database.query("SELECT COUNT(*) AS count FROM workspace_identity_bindings").get() as { count: number }).count).toBe(0);
        const unattested = database.query(
          "SELECT reason, location_owner_id, workspace_ids FROM project_identity_migration_audit WHERE reason = 'historical_primary_path_unattested'",
        ).get() as { reason: string; location_owner_id: string; workspace_ids: string };
        expect(unattested.reason).toBe("historical_primary_path_unattested");
        expect(unattested.location_owner_id).toBe("unknown");
        expect(JSON.parse(unattested.workspace_ids)).toEqual(["wks_unattested"]);

        database.run(
          "INSERT INTO workspace_identity_bindings (workspace_id, location_owner_id, real_path) VALUES (?, ?, ?)",
          ["wks_a", "station-1", realPath],
        );
        expect(() => database.run(
          "INSERT INTO workspace_identity_bindings (workspace_id, location_owner_id, real_path) VALUES (?, ?, ?)",
          ["wks_b", "station-1", realPath],
        )).toThrow();
      } finally {
        database.close();
        rmSync(realPath, { recursive: true, force: true });
      }
    });

    test("runs the identity backfill only while applying migration 7", () => {
      const database = new Database(":memory:");
      const realPath = mkdtempSync(join(tmpdir(), "projects-identity-once-"));
      try {
        database.run("PRAGMA foreign_keys=ON");
        runMigrations(database);
        createWorkspace({ name: "One Time", slug: "one-time", kind: "project", primary_path: realPath }, database);
        database.run(
          "UPDATE workspace_identity_bindings SET updated_at = '2000-01-01 00:00:00' WHERE real_path = ?",
          [realPath],
        );

        runMigrations(database);

        const binding = database.query(
          "SELECT updated_at FROM workspace_identity_bindings WHERE real_path = ?",
        ).get(realPath) as { updated_at: string };
        expect(binding.updated_at).toBe("2000-01-01 00:00:00");
      } finally {
        database.close();
        rmSync(realPath, { recursive: true, force: true });
      }
    });
  });

  describe("getDbPath", () => {
    test("uses HASNA_PROJECTS_DB_PATH env var", () => {
      process.env["HASNA_PROJECTS_DB_PATH"] = "/custom/env.db";
      expect(getDbPath()).toBe("/custom/env.db");
      delete process.env["HASNA_PROJECTS_DB_PATH"];
    });

    test("keeps HASNA_WORKSPACES_DB_PATH as a legacy fallback", () => {
      process.env["HASNA_WORKSPACES_DB_PATH"] = "/custom/legacy.db";
      expect(getDbPath()).toBe("/custom/legacy.db");
      process.env["HASNA_PROJECTS_DB_PATH"] = "/custom/project.db";
      expect(getDbPath()).toBe("/custom/project.db");
    });

    test("returns default path when no env vars", () => {
      const path = getDbPath();
      expect(path).toContain(".hasna");
      expect(path).toContain("projects.db");
    });
  });

  describe("now and uuid", () => {
    test("now returns ISO-like timestamp", () => {
      const t = now();
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+$/);
    });

    test("uuid returns a valid UUID", () => {
      const id = uuid();
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    });
  });

  describe("resolvePartialId", () => {
    test("returns null for short partial ids", () => {
      const db = getDatabase(":memory:");
      expect(resolvePartialId("abc", db)).toBeNull();
      expect(resolvePartialId("ab", db)).toBeNull();
    });

    test("returns null when no workspace exists", () => {
      const db = getDatabase(":memory:");
      expect(resolvePartialId("wks_1234", db)).toBeNull();
    });

    test("matches partial id prefix", () => {
      const db = getDatabase(":memory:");
      const dir = mkdtempSync(join(tmpdir(), "db-partial-"));
      const workspace = createWorkspace({ name: "Partial", primary_path: dir, kind: "generic" }, db);
      const partial = workspace.id.slice(0, 8);
      const result = resolvePartialId(partial, db);
      expect(result).toBe(workspace.id);
      rmSync(dir, { recursive: true });
      db.close();
    });
  });
});
