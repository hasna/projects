import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceLocation, createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import { resolveRegisteredProjectTarget } from "./project-resolver.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("project resolver", () => {
  test("resolves projects by name, secondary location, and marker", () => {
    const db = makeDb();
    const primary = mkdtempSync(join(tmpdir(), "project-resolver-primary-"));
    const secondary = mkdtempSync(join(tmpdir(), "project-resolver-secondary-"));
    const marked = mkdtempSync(join(tmpdir(), "project-resolver-marker-"));
    const project = createWorkspace({
      name: "Resolver Project",
      slug: "resolver-project",
      kind: "project",
      primary_path: primary,
    }, db);
    addWorkspaceLocation({ workspace_id: project.id, path: secondary, label: "secondary" }, db);
    writeFileSync(join(marked, ".project.json"), JSON.stringify({ id: project.id, slug: project.slug }), "utf-8");

    expect(resolveRegisteredProjectTarget("Resolver Project", { db })?.source).toBe("name");
    expect(resolveRegisteredProjectTarget(secondary, { db })?.project.id).toBe(project.id);
    expect(resolveRegisteredProjectTarget(secondary, { db })?.source).toBe("path");
    expect(resolveRegisteredProjectTarget(marked, { db })?.source).toBe("marker");
    expect(resolveRegisteredProjectTarget(marked, { db })?.project.id).toBe(project.id);

    rmSync(primary, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
    rmSync(marked, { recursive: true, force: true });
    db.close();
  });

  test("reports ambiguous exact project names", () => {
    const db = makeDb();
    createWorkspace({ name: "Same Name", slug: "same-name-one", kind: "project" }, db);
    createWorkspace({ name: "Same Name", slug: "same-name-two", kind: "project" }, db);

    expect(() => resolveRegisteredProjectTarget("Same Name", { db })).toThrow("Project name is ambiguous");

    db.close();
  });

  test("uses the nearest trusted marker for a nested project path", () => {
    const db = makeDb();
    const marked = mkdtempSync(join(tmpdir(), "project-resolver-nearest-marker-"));
    const child = join(marked, "packages");
    const nested = join(child, "app");
    mkdirSync(nested, { recursive: true });
    try {
      const ancestorProject = createWorkspace({
        name: "Ancestor Marker Project",
        slug: "ancestor-marker-project",
        kind: "project",
      }, db);
      const nearestProject = createWorkspace({
        name: "Nearest Marker Project",
        slug: "nearest-marker-project",
        kind: "project",
      }, db);
      writeFileSync(
        join(marked, ".project.json"),
        JSON.stringify({ id: ancestorProject.id, slug: ancestorProject.slug }),
        "utf-8",
      );
      writeFileSync(
        join(child, ".project.json"),
        JSON.stringify({ id: nearestProject.id, slug: nearestProject.slug }),
        "utf-8",
      );

      const resolution = resolveRegisteredProjectTarget(nested, { db });
      expect(resolution?.source).toBe("marker");
      expect(resolution?.project.id).toBe(nearestProject.id);
      expect(resolution?.marker?.path).toBe(join(child, ".project.json"));
    } finally {
      rmSync(marked, { recursive: true, force: true });
      db.close();
    }
  });

  test("fails closed when a registered path and marker identify different projects", () => {
    const db = makeDb();
    const bound = mkdtempSync(join(tmpdir(), "project-resolver-conflict-bound-"));
    try {
      createWorkspace({
        name: "Location Project",
        slug: "location-project",
        kind: "project",
        primary_path: bound,
      }, db);
      const markerProject = createWorkspace({
        name: "Marker Project",
        slug: "marker-project",
        kind: "project",
      }, db);
      writeFileSync(join(bound, ".project.json"), JSON.stringify({ id: markerProject.id, slug: markerProject.slug }), "utf-8");

      expect(() => resolveRegisteredProjectTarget(bound, { db })).toThrow(/PROJECT_IDENTITY_CONFLICT/);
    } finally {
      rmSync(bound, { recursive: true, force: true });
      db.close();
    }
  });

  test("returns stable fail-closed marker errors", () => {
    const db = makeDb();
    const malformed = mkdtempSync(join(tmpdir(), "project-resolver-malformed-"));
    const orphaned = mkdtempSync(join(tmpdir(), "project-resolver-orphaned-"));
    const symlinked = mkdtempSync(join(tmpdir(), "project-resolver-symlinked-"));
    const oversized = mkdtempSync(join(tmpdir(), "project-resolver-oversized-"));
    const markerTarget = join(symlinked, "marker-target.json");
    try {
      writeFileSync(join(malformed, ".project.json"), "{not-json", "utf-8");
      writeFileSync(join(orphaned, ".project.json"), JSON.stringify({ id: "wks_missing" }), "utf-8");
      const project = createWorkspace({ name: "Symlink Marker", slug: "symlink-marker", kind: "project" }, db);
      writeFileSync(markerTarget, JSON.stringify({ id: project.id }), "utf-8");
      symlinkSync(markerTarget, join(symlinked, ".project.json"));
      writeFileSync(join(oversized, ".project.json"), JSON.stringify({ id: project.id, padding: "x".repeat(70_000) }), "utf-8");

      expect(() => resolveRegisteredProjectTarget(malformed, { db })).toThrow(/PROJECT_MARKER_INVALID/);
      expect(() => resolveRegisteredProjectTarget(orphaned, { db })).toThrow(/PROJECT_MARKER_ORPHANED/);
      expect(() => resolveRegisteredProjectTarget(symlinked, { db })).toThrow(/PROJECT_MARKER_INVALID/);
      expect(() => resolveRegisteredProjectTarget(oversized, { db })).toThrow(/PROJECT_MARKER_INVALID/);
    } finally {
      rmSync(malformed, { recursive: true, force: true });
      rmSync(orphaned, { recursive: true, force: true });
      rmSync(symlinked, { recursive: true, force: true });
      rmSync(oversized, { recursive: true, force: true });
      db.close();
    }
  });

  test("does not treat a symlink to a regular file as a project directory", () => {
    const database = makeDb();
    const root = mkdtempSync(join(tmpdir(), "project-resolver-file-link-"));
    const file = join(root, "not-a-directory.txt");
    const link = join(root, "linked-file");
    try {
      const project = createWorkspace({ name: "Ancestor", slug: "ancestor", kind: "project" }, database);
      writeFileSync(join(root, ".project.json"), JSON.stringify({ id: project.id }), "utf-8");
      writeFileSync(file, "plain file", "utf-8");
      symlinkSync(file, link, "file");

      expect(() => resolveRegisteredProjectTarget(link, { db: database })).toThrow(/PROJECT_PATH_INVALID/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      database.close();
    }
  });

  test("falls back to a valid marker slug when its stale id is absent", () => {
    const database = makeDb();
    const root = mkdtempSync(join(tmpdir(), "project-resolver-marker-fallback-"));
    try {
      const project = createWorkspace({ name: "Marker Fallback", slug: "marker-fallback", kind: "project" }, database);
      writeFileSync(join(root, ".project.json"), JSON.stringify({ id: "wks_stale", slug: project.slug }), "utf-8");

      expect(resolveRegisteredProjectTarget(root, { db: database })?.project.id).toBe(project.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
      database.close();
    }
  });
});
