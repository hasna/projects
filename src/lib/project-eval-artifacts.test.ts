import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../db/schema.js";
import { createAgent, createRecipe, createRoot, createTmuxProfile, createWorkspace, listAgents, listRecipes, listRoots, listTmuxProfiles, listWorkspaces } from "../db/workspaces.js";
import { cleanupProjectEvalArtifacts, filterProjectEvalArtifacts, isProjectEvalArtifact } from "./project-eval-artifacts.js";

describe("project eval artifacts", () => {
  test("detects, hides, previews, and removes eval fixture records", () => {
    const root = mkdtempSync(join(tmpdir(), "project-eval-artifacts-"));
    const db = new Database(":memory:");
    runMigrations(db);

    createRoot({ name: "Eval Root", slug: "eval-root-test", base_path: join(root, "root") }, db);
    createRecipe({ name: "Eval Recipe", slug: "eval-recipe-test" }, db);
    createAgent({ name: "Eval Agent", slug: "eval-agent-test", kind: "human" }, db);
    createTmuxProfile({ name: "Eval Profile", slug: "eval-profile-test" }, db);
    const evalProject = createWorkspace({
      name: "Eval Old",
      slug: "eval-old",
      kind: "generic",
      tags: ["eval-old"],
      primary_path: join(root, "eval-old"),
    }, db);
    const normalProject = createWorkspace({
      name: "Normal Project",
      slug: "normal-project",
      kind: "generic",
      primary_path: join(root, "normal-project"),
    }, db);

    expect(isProjectEvalArtifact(evalProject)).toBe(true);
    expect(isProjectEvalArtifact(normalProject)).toBe(false);
    expect(filterProjectEvalArtifacts(listWorkspaces({ limit: 100 }, db)).map((project) => project.slug)).toEqual(["normal-project"]);

    const preview = cleanupProjectEvalArtifacts({ dryRun: true, db });
    expect(preview.dry_run).toBe(true);
    expect(preview.projects.map((project) => project.slug)).toEqual(["eval-old"]);
    expect(preview.supporting.roots.map((item) => item.slug)).toEqual(["eval-root-test"]);
    expect(preview.deleted.projects).toBe(0);

    const cleanup = cleanupProjectEvalArtifacts({ db });
    expect(cleanup.dry_run).toBe(false);
    expect(cleanup.deleted.projects).toBe(1);
    expect(cleanup.deleted.roots).toBe(1);
    expect(cleanup.deleted.recipes).toBe(1);
    expect(cleanup.deleted.agents).toBe(1);
    expect(cleanup.deleted.tmux_profiles).toBe(1);
    expect(listWorkspaces({ limit: 100 }, db).map((project) => project.slug)).toEqual(["normal-project"]);
    expect(listRoots(db).map((item) => item.slug)).toEqual([]);
    expect(listRecipes(db).map((item) => item.slug)).toEqual([]);
    expect(listAgents(db).map((item) => item.slug)).toEqual([]);
    expect(listTmuxProfiles(db).map((item) => item.slug)).toEqual([]);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
