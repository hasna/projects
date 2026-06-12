import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
