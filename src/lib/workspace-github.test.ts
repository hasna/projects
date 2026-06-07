import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot, createWorkspace, listWorkspaceEvents } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import {
  linkWorkspaceExternalIntegrations,
  normalizeWorkspaceIntegrations,
  parseGitHubRepo,
  planWorkspaceGitHubImport,
  planWorkspaceGitHubPublish,
} from "./workspace-github.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("workspace GitHub services", () => {
  test("plans publish with root GitHub defaults and open-source visibility", () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-root-"));
    const root = createRoot({
      name: "Open Root",
      slug: "open-root",
      base_path: rootPath,
      default_kind: "open-source",
      github_org: "hasna",
      repo_visibility: "public",
    }, db);
    const workspace = createWorkspace({
      name: "Publish Me",
      slug: "publish-me",
      kind: "open-source",
      root_id: root.id,
      primary_path: join(rootPath, "publish-me"),
    }, db);

    const plan = planWorkspaceGitHubPublish(workspace, { db });
    expect(plan.full_name).toBe("hasna/publish-me");
    expect(plan.visibility).toBe("public");
    expect(plan.remote).toBe("https://github.com/hasna/publish-me.git");
    expect(plan.commands[0]).toContain("gh repo create hasna/publish-me --public");
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("plans GitHub import as remote-only or root-derived local workspace", () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-import-"));
    const root = createRoot({
      name: "GitHub Root",
      slug: "github-root",
      base_path: rootPath,
      default_kind: "open-source",
      path_template: "open-{slug}",
    }, db);

    const remoteOnly = planWorkspaceGitHubImport("https://github.com/hasna/example.git", { db });
    expect(remoteOnly.remote_only).toBe(true);
    expect(remoteOnly.path).toBeNull();
    expect(remoteOnly.kind).toBe("remote-only");

    const local = planWorkspaceGitHubImport("hasna/example", { root: root.id, clone: true, db });
    expect(local.remote_only).toBe(false);
    expect(local.path).toBe(join(rootPath, "open-example"));
    expect(local.commands[0]).toContain("gh repo clone hasna/example");

    const localRootWins = planWorkspaceGitHubImport("hasna/example-two", { root: root.id, remoteOnly: true, db });
    expect(localRootWins.remote_only).toBe(false);
    expect(localRootWins.path).toBe(join(rootPath, "open-example-two"));
    expect(localRootWins.commands).toEqual([]);
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("links integrations by merging instead of replacing existing keys", () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-link-"));
    const workspace = createWorkspace({
      name: "Link Me",
      primary_path: rootPath,
      integrations: { github_repo: "hasna/link-me" },
    }, db);

    const updated = linkWorkspaceExternalIntegrations(workspace, {
      todos_project_id: "todo_123",
      github_url: "https://github.com/hasna/link-me",
    }, { source: "cli", command: "test", db });
    expect(updated.integrations.github_repo).toBe("hasna/link-me");
    expect(updated.integrations.github_url).toBe("https://github.com/hasna/link-me");
    expect(updated.integrations.todos_project_id).toBe("todo_123");
    expect(listWorkspaceEvents(workspace.id, db).some((event) => event.event_type === "updated")).toBe(true);
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("parses supported GitHub repository inputs", () => {
    expect(parseGitHubRepo("hasna/example").fullName).toBe("hasna/example");
    expect(parseGitHubRepo("git@github.com:hasna/example.git").fullName).toBe("hasna/example");
    expect(parseGitHubRepo("https://github.com/hasna/example.git").fullName).toBe("hasna/example");
    expect(normalizeWorkspaceIntegrations({ todos: "todo_123" }).todos_project_id).toBe("todo_123");
  });
});
