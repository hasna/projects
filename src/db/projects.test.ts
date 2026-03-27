import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "./schema.js";
import {
  createProject,
  getProject,
  getProjectBySlug,
  getProjectByPath,
  listProjects,
  updateProject,
  archiveProject,
  unarchiveProject,
  resolveProject,
  setIntegrations,
  startSyncLog,
  completeSyncLog,
  listSyncLogs,
} from "./projects.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "open-projects-test-"));
}

describe("createProject", () => {
  test("creates a project with prj_ id", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "My App", path: dir }, db);
    expect(p.id).toMatch(/^prj_[a-z0-9]{12}$/);
    expect(p.name).toBe("My App");
    expect(p.slug).toBe("my-app");
    expect(p.status).toBe("active");
    expect(p.tags).toEqual([]);
    expect(p.integrations).toEqual({});
    rmSync(dir, { recursive: true });
  });

  test("auto-deduplicates slug on conflict", () => {
    const db = makeDb();
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    const p1 = createProject({ name: "App", path: dir1, git_init: false }, db);
    const p2 = createProject({ name: "App", path: dir2, git_init: false }, db);
    expect(p1.slug).toBe("app");
    expect(p2.slug).toBe("app-2");
    rmSync(dir1, { recursive: true });
    rmSync(dir2, { recursive: true });
  });

  test("throws on duplicate path", () => {
    const db = makeDb();
    const dir = tmpDir();
    createProject({ name: "A", path: dir, git_init: false }, db);
    expect(() => createProject({ name: "B", path: dir, git_init: false }, db)).toThrow("already registered");
    rmSync(dir, { recursive: true });
  });

  test("accepts custom slug", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "My App", path: dir, slug: "custom", git_init: false }, db);
    expect(p.slug).toBe("custom");
    rmSync(dir, { recursive: true });
  });

  test("stores tags as array", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "A", path: dir, tags: ["foo", "bar"], git_init: false }, db);
    expect(p.tags).toEqual(["foo", "bar"]);
    rmSync(dir, { recursive: true });
  });
});

describe("getProject / getProjectBySlug / getProjectByPath", () => {
  test("returns null for missing project", () => {
    const db = makeDb();
    expect(getProject("prj_doesnotexist", db)).toBeNull();
    expect(getProjectBySlug("no-such-slug", db)).toBeNull();
    expect(getProjectByPath("/no/such/path", db)).toBeNull();
  });

  test("retrieves by ID, slug, and path", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "Finder", path: dir, git_init: false }, db);
    expect(getProject(p.id, db)?.id).toBe(p.id);
    expect(getProjectBySlug(p.slug, db)?.id).toBe(p.id);
    expect(getProjectByPath(dir, db)?.id).toBe(p.id);
    rmSync(dir, { recursive: true });
  });
});

describe("listProjects", () => {
  test("returns all active projects by default", () => {
    const db = makeDb();
    const dirs = [tmpDir(), tmpDir(), tmpDir()];
    for (const dir of dirs) createProject({ name: dir, path: dir, git_init: false }, db);
    const list = listProjects({}, db);
    expect(list.length).toBe(3);
    rmSync(dirs[0]!, { recursive: true });
    rmSync(dirs[1]!, { recursive: true });
    rmSync(dirs[2]!, { recursive: true });
  });

  test("filters by status", () => {
    const db = makeDb();
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    const p1 = createProject({ name: "A", path: dir1, git_init: false }, db);
    createProject({ name: "B", path: dir2, git_init: false }, db);
    archiveProject(p1.id, db);
    expect(listProjects({ status: "active" }, db).length).toBe(1);
    expect(listProjects({ status: "archived" }, db).length).toBe(1);
    rmSync(dir1, { recursive: true });
    rmSync(dir2, { recursive: true });
  });
});

describe("updateProject", () => {
  test("updates name and description", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "Old", path: dir, git_init: false }, db);
    const updated = updateProject(p.id, { name: "New", description: "desc" }, db);
    expect(updated.name).toBe("New");
    expect(updated.description).toBe("desc");
    rmSync(dir, { recursive: true });
  });

  test("returns unchanged project if no fields given", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "Same", path: dir, git_init: false }, db);
    const updated = updateProject(p.id, {}, db);
    expect(updated.name).toBe("Same");
    rmSync(dir, { recursive: true });
  });
});

describe("archiveProject / unarchiveProject", () => {
  test("toggles status", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "Tog", path: dir, git_init: false }, db);
    expect(archiveProject(p.id, db).status).toBe("archived");
    expect(unarchiveProject(p.id, db).status).toBe("active");
    rmSync(dir, { recursive: true });
  });
});

describe("resolveProject", () => {
  test("resolves by ID, slug, and partial ID", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "Resolve Me", path: dir, git_init: false }, db);
    expect(resolveProject(p.id, db)?.id).toBe(p.id);
    expect(resolveProject(p.slug, db)?.id).toBe(p.id);
    expect(resolveProject(p.id.slice(0, 8), db)?.id).toBe(p.id);
    rmSync(dir, { recursive: true });
  });

  test("returns null for unknown", () => {
    const db = makeDb();
    expect(resolveProject("zzz-unknown", db)).toBeNull();
  });
});

describe("setIntegrations", () => {
  test("merges integrations non-destructively", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "Int", path: dir, git_init: false }, db);
    setIntegrations(p.id, { todos_project_id: "abc123" }, db);
    setIntegrations(p.id, { mementos_project_id: "def456" }, db);
    const updated = getProject(p.id, db)!;
    expect(updated.integrations.todos_project_id).toBe("abc123");
    expect(updated.integrations.mementos_project_id).toBe("def456");
    rmSync(dir, { recursive: true });
  });
});

describe("sync log", () => {
  test("creates and completes a sync log entry", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "Sync", path: dir, git_init: false }, db);
    const entry = startSyncLog(p.id, "push", db);
    expect(entry.status).toBe("running");
    const done = completeSyncLog(entry.id, { files_synced: 5, bytes: 1024 }, db);
    expect(done.status).toBe("completed");
    expect(done.files_synced).toBe(5);
    expect(done.bytes).toBe(1024);
    const logs = listSyncLogs(p.id, 10, db);
    expect(logs.length).toBe(1);
    rmSync(dir, { recursive: true });
  });

  test("marks sync log as failed on error", () => {
    const db = makeDb();
    const dir = tmpDir();
    const p = createProject({ name: "Fail", path: dir, git_init: false }, db);
    const entry = startSyncLog(p.id, "pull", db);
    const done = completeSyncLog(entry.id, { error: "connection refused" }, db);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("connection refused");
    rmSync(dir, { recursive: true });
  });
});
