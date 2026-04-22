import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "./schema.js";
import { createProject } from "./projects.js";
import {
  addWorkdir,
  getWorkdir,
  listWorkdirs,
  removeWorkdir,
  markWorkdirGenerated,
  getWorkdirsForMachine,
} from "./workdirs.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "open-projects-workdir-"));
}

describe("workdirs", () => {
  describe("addWorkdir", () => {
    test("adds a primary workdir", () => {
      const db = makeDb();
      const dir = tmpDir();
      const p = createProject({ name: "WD", path: dir, git_init: false }, db);
      // Use a different path to create a new workdir (not the auto-registered one)
      const dir2 = tmpDir();
      const wd = addWorkdir({ project_id: p.id, path: dir2, label: "secondary", is_primary: true }, db);
      expect(wd.project_id).toBe(p.id);
      expect(wd.path).toBe(dir2);
      expect(wd.is_primary).toBe(true);
      rmSync(dir, { recursive: true });
      rmSync(dir2, { recursive: true });
    });

    test("second workdir is not primary by default", () => {
      const db = makeDb();
      const dir1 = tmpDir();
      const dir2 = tmpDir();
      const p = createProject({ name: "WD2", path: dir1, git_init: false }, db);
      addWorkdir({ project_id: p.id, path: dir1, label: "main", is_primary: true }, db);
      const wd2 = addWorkdir({ project_id: p.id, path: dir2, label: "frontend" }, db);
      expect(wd2.is_primary).toBe(false);
      rmSync(dir1, { recursive: true });
      rmSync(dir2, { recursive: true });
    });
  });

  describe("getWorkdir", () => {
    test("returns null for non-existent workdir", () => {
      const db = makeDb();
      expect(getWorkdir("prj_fake", "/no/path", db)).toBeNull();
    });

    test("returns workdir by project id and path", () => {
      const db = makeDb();
      const dir = tmpDir();
      const p = createProject({ name: "GWD", path: dir, git_init: false }, db);
      addWorkdir({ project_id: p.id, path: dir, label: "test" }, db);
      const wd = getWorkdir(p.id, dir, db);
      expect(wd).not.toBeNull();
      expect(wd!.path).toBe(dir);
      expect(wd!.label).toBe("test");
      rmSync(dir, { recursive: true });
    });
  });

  describe("listWorkdirs", () => {
    test("returns all workdirs for a project", () => {
      const db = makeDb();
      const dir1 = tmpDir();
      const dir2 = tmpDir();
      const p = createProject({ name: "LWD", path: dir1, git_init: false }, db);
      addWorkdir({ project_id: p.id, path: dir1, label: "main" }, db);
      addWorkdir({ project_id: p.id, path: dir2, label: "backend" }, db);
      const wds = listWorkdirs(p.id, db);
      expect(wds.length).toBe(2);
      rmSync(dir1, { recursive: true });
      rmSync(dir2, { recursive: true });
    });
  });

  describe("removeWorkdir", () => {
    test("deletes a workdir", () => {
      const db = makeDb();
      const dir = tmpDir();
      const p = createProject({ name: "RM", path: dir, git_init: false }, db);
      addWorkdir({ project_id: p.id, path: dir }, db);
      expect(getWorkdir(p.id, dir, db)).not.toBeNull();
      removeWorkdir(p.id, dir, db);
      expect(getWorkdir(p.id, dir, db)).toBeNull();
      rmSync(dir, { recursive: true });
    });

    test("does not throw for non-existent workdir", () => {
      const db = makeDb();
      expect(() => removeWorkdir("prj_fake", "/no/path", db)).not.toThrow();
    });
  });

  describe("markWorkdirGenerated", () => {
    test("sets generated flags", () => {
      const db = makeDb();
      const dir = tmpDir();
      const p = createProject({ name: "GEN", path: dir, git_init: false }, db);
      addWorkdir({ project_id: p.id, path: dir }, db);
      markWorkdirGenerated(p.id, dir, db);
      const wd = getWorkdir(p.id, dir, db)!;
      expect(wd.claude_md_generated).toBe(true);
      expect(wd.agents_md_generated).toBe(true);
      rmSync(dir, { recursive: true });
    });
  });

  describe("getWorkdirsForMachine", () => {
    test("returns workdirs for current machine", () => {
      const db = makeDb();
      const dir = tmpDir();
      const p = createProject({ name: "MCH", path: dir, git_init: false }, db);
      addWorkdir({ project_id: p.id, path: dir }, db);
      const wds = getWorkdirsForMachine(db);
      expect(wds.length).toBeGreaterThan(0);
      expect(wds[0]!.path).toBe(dir);
      rmSync(dir, { recursive: true });
    });
  });
});
