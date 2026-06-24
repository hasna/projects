import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot, createWorkspace, getWorkspaceBySlug, listWorkspaceEvents } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import {
  linkWorkspaceExternalIntegrations,
  normalizeWorkspaceIntegrations,
  parseGitHubRepo,
  importWorkspaceFromGitHub,
  planWorkspaceGitHubImport,
  planWorkspaceGitHubPublish,
  syncWorkspaceGitHubRoots,
} from "./workspace-github.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

function git(path: string, args: string[]): string {
  return execFileSync("git", args, { cwd: path, encoding: "utf-8", stdio: "pipe" }).trim();
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
    expect(local.commands[0]).toContain("gh repo clone https://github.com/hasna/example.git");

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
  test("plans GitHub root sync with repository prefix filters", async () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-sync-"));
    const root = createRoot({
      name: "Project Root",
      slug: "project-root",
      base_path: rootPath,
      default_kind: "project",
      github_org: "hasnaxyz",
      path_template: "{slug}",
    }, db);

    const result = await syncWorkspaceGitHubRoots({
      root: root.slug,
      repoPrefix: "project-",
      clone: true,
      dryRun: true,
      tags: ["hasnaxyz", "project"],
      repoNamesByOrg: {
        hasnaxyz: ["project-one", "notes", "project-two"],
      },
      db,
    });

    expect(result.dry_run).toBe(true);
    expect(result.planned.map((item) => item.repo_name)).toEqual(["project-one", "project-two"]);
    expect(result.planned[0]?.path).toBe(join(rootPath, "project-one"));
    expect(result.planned[0]?.commands[0]).toContain("gh repo clone https://github.com/hasnaxyz/project-one.git");
    expect(result.planned[0]?.tags).toEqual(["github", "hasnaxyz", "project"]);
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("sync roots applies by default and can dry-run explicitly", async () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-sync-default-"));
    const root = createRoot({
      name: "Default Sync Root",
      slug: "default-sync-root",
      base_path: rootPath,
      default_kind: "project",
      github_org: "hasnaxyz",
      path_template: "{slug}",
    }, db);

    const dryRun = await syncWorkspaceGitHubRoots({
      root: root.slug,
      repoPrefix: "project-",
      dryRun: true,
      repoNamesByOrg: { hasnaxyz: ["project-dry"] },
      db,
    });
    expect(dryRun.dry_run).toBe(true);
    expect(dryRun.planned).toHaveLength(1);

    const applied = await syncWorkspaceGitHubRoots({
      root: root.slug,
      repoPrefix: "project-",
      clone: false,
      repoNamesByOrg: { hasnaxyz: ["project-applied"] },
      db,
    });
    expect(applied.dry_run).toBe(false);
    expect(applied.imported[0]?.workspace?.slug).toBe("project-applied");
    expect(applied.imported[0]?.path).toBe(join(rootPath, "project-applied"));
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("plans clone commands with requested remote protocol", () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-protocol-"));
    const root = createRoot({ name: "Protocol Root", slug: "protocol-root", base_path: rootPath, github_org: "hasna" }, db);
    const ssh = planWorkspaceGitHubImport("hasna/example", { root: root.id, clone: true, remoteProtocol: "ssh", db });
    expect(ssh.remote).toBe("git@github.com:hasna/example.git");
    expect(ssh.commands[0]).toContain("gh repo clone git@github.com:hasna/example.git");
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("quotes metacharacters in planned GitHub command strings", () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-command-quote-") + "a;b-");
    const root = createRoot({ name: "Quoted Root", slug: "quoted-root", base_path: rootPath, github_org: "hasna" }, db);
    const plan = planWorkspaceGitHubImport("hasna/example", { root: root.id, clone: true, db });

    expect(plan.commands[0]).toContain(`'${rootPath}/example'`);
    expect(plan.commands[0]).not.toContain(` ${rootPath}/example`);
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("sync roots is idempotent by GitHub identity and avoids duplicate slugs", async () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-idempotent-"));
    const root = createRoot({ name: "Idempotent Root", slug: "idempotent-root", base_path: rootPath, default_kind: "project", github_org: "hasnaxyz", path_template: "{slug}" }, db);
    const existing = createWorkspace({
      name: "Existing Project One",
      slug: "custom-project-one",
      kind: "project",
      git_remote: "https://github.com/hasnaxyz/project-one.git",
      integrations: { github_repo: "hasnaxyz/project-one" },
    }, db);

    const result = await syncWorkspaceGitHubRoots({ root: root.slug, repoPrefix: "project-", clone: false, repoNamesByOrg: { hasnaxyz: ["project-one"] }, db });

    expect(result.imported).toEqual([]);
    expect(result.skipped[0]?.skipped).toBe("github-already-registered");
    expect(result.skipped[0]?.workspace?.id).toBe(existing.id);
    expect(getWorkspaceBySlug("project-one", db)).toBeNull();
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("GitHub import does not reconcile an unrelated same-slug project", async () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-same-slug-"));
    const root = createRoot({ name: "Same Slug Root", slug: "same-slug-root", base_path: rootPath, default_kind: "project", github_org: "hasnaxyz", path_template: "{slug}" }, db);
    const existing = createWorkspace({
      name: "Project One",
      slug: "project-one",
      kind: "project",
      primary_path: join(rootPath, "other-project-one"),
      git_remote: "https://github.com/example/unrelated.git",
      integrations: { github_repo: "example/unrelated" },
    }, db);

    const result = await importWorkspaceFromGitHub("hasnaxyz/project-one", { root: root.slug, clone: false, db });

    expect(result.status).toBe("skipped");
    expect(result.skipped).toBe("slug-already-registered");
    expect(result.workspace?.id).toBe(existing.id);
    expect(getWorkspaceBySlug("project-one", db)?.integrations.github_repo).toBe("example/unrelated");
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("GitHub import skips existing git clone targets with a different origin", async () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-origin-mismatch-"));
    const root = createRoot({ name: "Origin Root", slug: "origin-root", base_path: rootPath, default_kind: "project", github_org: "hasnaxyz", path_template: "{slug}" }, db);
    const targetPath = join(rootPath, "project-existing");
    mkdirSync(targetPath);
    git(targetPath, ["init", "-b", "main"]);
    git(targetPath, ["remote", "add", "origin", "https://github.com/example/other.git"]);

    const result = await importWorkspaceFromGitHub("hasnaxyz/project-existing", { root: root.slug, clone: true, db });

    expect(result.status).toBe("skipped");
    expect(result.skipped).toBe("path-exists-git-remote-mismatch");
    expect(result.workspace).toBeUndefined();
    expect(getWorkspaceBySlug("project-existing", db)).toBeNull();
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("GitHub import skips existing non-git clone target without claiming cloned success", async () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-nongit-"));
    const root = createRoot({ name: "Non Git Root", slug: "non-git-root", base_path: rootPath, default_kind: "project", github_org: "hasnaxyz", path_template: "{slug}" }, db);
    mkdirSync(join(rootPath, "project-existing"));

    const result = await importWorkspaceFromGitHub("hasnaxyz/project-existing", { root: root.slug, clone: true, db });

    expect(result.status).toBe("skipped");
    expect(result.skipped).toBe("path-exists-not-git");
    expect(result.workspace).toBeUndefined();
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

  test("documented project root template lands project-* repos without duplicated prefix", () => {
    const db = makeDb();
    const rootPath = mkdtempSync(join(tmpdir(), "workspace-github-project-template-"));
    const root = createRoot({ name: "Hasnaxyz Projects", slug: "hasnaxyz-projects", base_path: rootPath, default_kind: "project", github_org: "hasnaxyz", path_template: "{slug}" }, db);
    const plan = planWorkspaceGitHubImport("hasnaxyz/project-one", { root: root.slug, clone: true, db });
    expect(plan.path).toBe(join(rootPath, "project-one"));
    expect(plan.path).not.toContain("project-project-one");
    rmSync(rootPath, { recursive: true, force: true });
    db.close();
  });

});
