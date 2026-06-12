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
