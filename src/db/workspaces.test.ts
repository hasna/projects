import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "./schema.js";
import {
  acquireWorkspaceLock,
  addWorkspaceLocation,
  addTmuxProfileWindow,
  archiveWorkspace,
  assignAgentToWorkspace,
  completeAgentRun,
  createAgent,
  createRecipe,
  createRoot,
  createTmuxProfile,
  deleteRoot,
  createWorkspace,
  deleteWorkspace,
  getWorkspaceByPath,
  getWorkspaceBySlug,
  inferWorkspaceKind,
  listAgentRuns,
  listRoots,
  listTmuxProfileWindows,
  listWorkspaceLocks,
  listWorkspaceEvents,
  listWorkspaceAgents,
  listWorkspaceLocations,
  listWorkspacesByPath,
  listWorkspaces,
  matchRootForPath,
  migrateLegacyProjectsToWorkspaces,
  releaseWorkspaceLock,
  resolveTmuxProfile,
  renderTemplate,
  scoreRoots,
  startAgentRun,
  unarchiveWorkspace,
  updateRoot,
  updateWorkspace,
} from "./workspaces.js";
import { doctorWorkspace } from "../lib/workspace-doctor.js";
import { builtInWorkspaceRecipes, ensureBuiltInWorkspaceRecipes } from "../lib/workspace-defaults.js";
import { importRegisteredRoots, importWorkspace, planWorkspaceImport } from "../lib/workspace-import.js";
import { cleanupWorkspaceCreation, executeWorkspaceCreation, planWorkspaceCreation } from "../lib/workspace-plan.js";
import { applyWorkspaceTmuxProfile, prepareWorkspaceDirectory, tmuxProfileToSpec, workspaceMarkerPath } from "../lib/workspace-runtime.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "workspace-domain-"));
}

describe("workspace schema", () => {
  test("creates generic workspace tables", () => {
    const db = makeDb();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('roots', 'workspaces', 'agents', 'recipes', 'workspace_events', 'agent_runs')")
      .all() as { name: string }[];
    expect(tables.map((table) => table.name).sort()).toEqual([
      "agent_runs",
      "agents",
      "recipes",
      "roots",
      "workspace_events",
      "workspaces",
    ]);
    db.close();
  });
});

describe("workspace domain services", () => {
  test("creates roots, recipes, agents, workspaces, locations, and events", () => {
    const db = makeDb();
    const rootPath = tmpDir();
    const root = createRoot({
      slug: "test-root",
      name: "Test Root",
      base_path: rootPath,
      tags: ["test", "root"],
      default_kind: "open-source",
      path_template: "open-{slug}",
      github_org: "hasna",
      repo_visibility: "public",
    }, db);
    const recipe = createRecipe({
      slug: "open-source-ts",
      name: "Open Source TypeScript",
      kind: "open-source",
      default_tags: ["typescript"],
      steps: [{ type: "mkdir", path: "{path}/src" }],
    }, db);
    const agent = createAgent({
      slug: "codex",
      name: "Codex",
      kind: "ai",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      role: "creator",
      permissions: ["workspace:create"],
    }, db);

    const workspace = createWorkspace({
      name: "Open Logs",
      root_id: root.id,
      recipe_id: recipe.id,
      agent_id: agent.id,
      source: "agent",
      prompt: "create an open source logging project",
      tags: ["logs"],
    }, db);

    expect(workspace.id).toMatch(/^wks_/);
    expect(workspace.kind).toBe("open-source");
    expect(workspace.primary_path).toBe(join(rootPath, "open-open-logs"));
    expect(workspace.tags.sort()).toEqual(["logs", "root", "test", "typescript"].sort());
    expect(getWorkspaceByPath(workspace.primary_path!, db)?.id).toBe(workspace.id);
    expect(listWorkspaceLocations(workspace.id, db)).toHaveLength(1);
    expect(listWorkspaceEvents(workspace.id, db).map((event) => event.event_type)).toContain("created");
    const creatorAssignments = listWorkspaceAgents(workspace.id, db);
    expect(creatorAssignments).toHaveLength(1);
    expect(creatorAssignments[0]?.role).toBe("creator");
    expect(creatorAssignments[0]?.agent?.slug).toBe("codex");
    expect(listRoots(db)).toHaveLength(1);
    expect(listWorkspaces({ tags: ["typescript"] }, db)).toHaveLength(1);

    const secondaryPath = tmpDir();
    const secondary = addWorkspaceLocation({
      workspace_id: workspace.id,
      path: secondaryPath,
      label: "secondary",
      metadata: { purpose: "alternate folder" },
      agent_id: agent.id,
      source: "cli",
      command: "projects locations add",
    }, db);
    expect(secondary.path).toBe(secondaryPath);
    expect(secondary.is_primary).toBe(false);
    expect(getWorkspaceByPath(secondaryPath, db)?.id).toBe(workspace.id);
    expect(listWorkspacesByPath(secondaryPath, db).map((item) => item.id)).toEqual([workspace.id]);
    expect(listWorkspaceEvents(workspace.id, db).map((event) => event.event_type)).toContain("location_added");

    const owner = createAgent({ name: "Owner", slug: "owner", kind: "human" }, db);
    const assignment = assignAgentToWorkspace(workspace.id, owner.id, "owner", agent.id, { scope: "project" }, db);
    expect(assignment.role).toBe("owner");
    expect(assignment.agent?.slug).toBe("owner");
    expect(assignment.metadata.scope).toBe("project");
    expect(listWorkspaceAgents(workspace.id, db).map((item) => item.role).sort()).toEqual(["creator", "owner"]);

    rmSync(rootPath, { recursive: true });
    rmSync(secondaryPath, { recursive: true });
    db.close();
  });

  test("records agent runs", () => {
    const db = makeDb();
    const agent = createAgent({ name: "Prompt Agent", slug: "prompt-agent", kind: "ai", provider: "openrouter", model: "test/model" }, db);
    const run = startAgentRun({ agent_id: agent.id, provider: "openrouter", model: "test/model", prompt: "create a thing", plan: { steps: 1 } }, db);
    expect(run.status).toBe("running");
    const completed = completeAgentRun(run.id, { result: { ok: true }, tool_calls: [{ name: "workspace_create" }] }, db);
    expect(completed.status).toBe("completed");
    expect(completed.result_json?.["ok"]).toBe(true);
    expect(completed.tool_calls_json[0]?.["name"]).toBe("workspace_create");
    expect(listAgentRuns({ agent_id: agent.id }, db)).toHaveLength(1);
    db.close();
  });

  test("seeds built-in workspace recipes idempotently", () => {
    const db = makeDb();
    expect(builtInWorkspaceRecipes().map((recipe) => recipe.slug)).toContain("open-source-typescript-cli");
    const first = ensureBuiltInWorkspaceRecipes(db);
    expect(first.created).toHaveLength(10);
    const second = ensureBuiltInWorkspaceRecipes(db);
    expect(second.created).toHaveLength(0);
    expect(second.existing).toHaveLength(10);
    db.close();
  });

  test("updates, matches, and deletes roots with workspace detach safety", () => {
    const db = makeDb();
    const rootDir = tmpDir();
    const root = createRoot({
      name: "Policy Root",
      slug: "policy-root",
      base_path: rootDir,
      default_kind: "open-source",
      tags: ["open", "policy"],
      github_org: "hasna",
      repo_visibility: "public",
    }, db);
    const updated = updateRoot(root.id, {
      github_org: "hasnatools",
      tags: ["platform"],
      path_template: "platform-{slug}",
    }, db);
    expect(updated.github_org).toBe("hasnatools");
    expect(updated.path_template).toBe("platform-{slug}");
    expect(scoreRoots({ path: join(rootDir, "child"), kind: "open-source", github_org: "hasnatools" }, db)[0]?.root.id).toBe(root.id);

    const workspace = createWorkspace({ name: "Rooted", root_id: root.id, kind: "open-source" }, db);
    expect(() => deleteRoot(root.id, {}, db)).toThrow(/used by 1 workspace/);
    const deleted = deleteRoot(root.id, { detachWorkspaces: true }, db);
    expect(deleted.detached_workspaces).toBe(1);
    expect(updateWorkspace(workspace.id, { name: "Detached Rooted" }, db).root_id).toBeNull();
    rmSync(rootDir, { recursive: true });
    db.close();
  });

  test("enforces root allowed agents, allowed recipes, and agent permissions", () => {
    const db = makeDb();
    const rootDir = tmpDir();
    const allowedAgent = createAgent({ name: "Allowed", slug: "allowed", kind: "human", permissions: ["workspace:create"] }, db);
    const blockedAgent = createAgent({ name: "Blocked", slug: "blocked", kind: "human", permissions: ["workspace:update"] }, db);
    const recipe = createRecipe({ name: "Allowed Recipe", slug: "allowed-recipe", kind: "docs" }, db);
    const root = createRoot({
      name: "Policy Root",
      slug: "policy-enforced-root",
      base_path: rootDir,
      allowed_agents: [allowedAgent.slug],
      allowed_recipes: [recipe.slug],
      path_template: "{slug}",
    }, db);

    expect(() => createWorkspace({ name: "Blocked Agent", root_id: root.id, recipe_id: recipe.id, agent_id: blockedAgent.id }, db)).toThrow(/permission workspace:create|does not allow agent/);
    expect(() => createWorkspace({ name: "Blocked Recipe", root_id: root.id, agent_id: allowedAgent.id }, db)).toThrow(/does not allow recipe/);
    const workspace = createWorkspace({ name: "Allowed Workspace", root_id: root.id, recipe_id: recipe.id, agent_id: allowedAgent.id }, db);
    expect(workspace.root_id).toBe(root.id);
    rmSync(rootDir, { recursive: true });
    db.close();
  });

  test("manages tmux profiles and renders workspace profile specs", () => {
    const db = makeDb();
    const dir = tmpDir();
    const workspace = createWorkspace({ name: "Profile App", primary_path: dir, kind: "generic" }, db);
    const profile = createTmuxProfile({
      name: "Dev Profile",
      slug: "dev-profile",
      session_template: "{slug}-dev",
      windows: [{ window_name_template: "editor", path_template: "{path}", window_index: 0 }],
    }, db);
    addTmuxProfileWindow({ profile_id: profile.id, window_name_template: "server", command: "bun run dev", window_index: 1 }, db);

    const windows = listTmuxProfileWindows(profile.id, db);
    expect(resolveTmuxProfile("dev-profile", db)?.id).toBe(profile.id);
    expect(windows).toHaveLength(2);
    const spec = tmuxProfileToSpec(workspace, profile, windows);
    expect(spec.session).toBe("profile-app-dev");
    expect(spec.windows.map((window) => window.name)).toEqual(["editor", "server"]);
    const dryRun = applyWorkspaceTmuxProfile(workspace, profile, windows, { dryRun: true });
    expect(dryRun.session_action).toBe("planned");
    expect(dryRun.windows).toHaveLength(2);
    rmSync(dir, { recursive: true });
    db.close();
  });

  test("plans and executes workspace creation with locks and rollback records", () => {
    const db = makeDb();
    const rootDir = tmpDir();
    const root = createRoot({ name: "Plan Root", slug: "plan-root", base_path: rootDir, path_template: "{slug}" }, db);
    const profile = createTmuxProfile({
      name: "Plan Profile",
      slug: "plan-profile",
      session_template: "{slug}-dev",
      windows: [{ window_name_template: "editor" }],
    }, db);

    const plan = planWorkspaceCreation({
      name: "Planned App",
      root_id: root.id,
      createDirectory: true,
      gitInit: true,
      writeMarker: true,
      tmux_profile: profile.slug,
      source: "cli",
    }, { db });

    expect(plan.workspace.slug).toBe("planned-app");
    expect(plan.workspace.primary_path).toBe(join(rootDir, "planned-app"));
    expect(plan.db_writes.map((write) => write.target)).toContain("workspaces");
    expect(plan.runtime_actions.map((action) => action.type)).toEqual(["mkdir", "git_init", "workspace_marker"]);
    expect(plan.tmux?.session_name).toBe("planned-app-dev");
    expect(plan.locks.map((lock) => lock.key)).toContain(`workspace-path:${join(rootDir, "planned-app")}`);
    expect(plan.rollback_actions.some((action) => action.action === "remove_file")).toBe(true);

    const dryRun = executeWorkspaceCreation({
      name: "Dry Planned App",
      root_id: root.id,
      createDirectory: true,
      writeMarker: true,
    }, { db, dryRun: true });
    expect(dryRun.dry_run).toBe(true);
    expect(listWorkspaces({}, db)).toHaveLength(0);

    const executed = executeWorkspaceCreation({
      name: "Planned App",
      root_id: root.id,
      createDirectory: true,
      writeMarker: true,
      tmux_profile: profile.slug,
    }, { db, runtimeDryRun: true });
    expect(executed.success).toBe(true);
    expect(executed.workspace?.primary_path).toBe(join(rootDir, "planned-app"));
    expect(executed.prepare.every((action) => action.status === "planned")).toBe(true);
    expect(listWorkspaceLocks(db)).toHaveLength(0);
    expect(listWorkspaceEvents(executed.workspace!.id, db).some((event) => event.event_type === "creation_runtime_planned")).toBe(true);

    rmSync(rootDir, { recursive: true });
    db.close();
  });

  test("cleans up workspace creation artifacts from rollback records", () => {
    const db = makeDb();
    const rootDir = tmpDir();
    const root = createRoot({ name: "Cleanup Root", slug: "cleanup-root", base_path: rootDir, path_template: "{slug}" }, db);

    const executed = executeWorkspaceCreation({
      name: "Cleanup App",
      root_id: root.id,
      createDirectory: true,
      writeMarker: true,
    }, { db });
    const workspace = executed.workspace!;
    const markerPath = join(workspace.primary_path!, ".project.json");
    expect(existsSync(workspace.primary_path!)).toBe(true);
    expect(existsSync(markerPath)).toBe(true);

    const preview = cleanupWorkspaceCreation(executed.plan, { db, dryRun: true });
    expect(preview.dry_run).toBe(true);
    expect(preview.actions.every((action) => action.status === "planned" || action.status === "skipped")).toBe(true);
    expect(getWorkspaceBySlug(workspace.slug, db)?.id).toBe(workspace.id);

    const cleanup = cleanupWorkspaceCreation(executed.plan, { db });
    expect(cleanup.success).toBe(true);
    expect(getWorkspaceBySlug(workspace.slug, db)).toBeNull();
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(workspace.primary_path!)).toBe(false);
    expect(cleanup.actions.some((action) => action.action === "remove_empty_directory" && action.status === "completed")).toBe(true);

    rmSync(rootDir, { recursive: true, force: true });
    db.close();
  });

  test("updates, archives, searches, and deletes workspaces with events", () => {
    const db = makeDb();
    const dir = tmpDir();
    const workspace = createWorkspace({
      name: "Mutable Workspace",
      slug: "mutable-workspace",
      primary_path: dir,
      kind: "generic",
      tags: ["before"],
    }, db);

    const updated = updateWorkspace(workspace.id, {
      name: "Renamed Workspace",
      description: "searchable replacement workspace",
      tags: ["after", "replacement"],
      metadata: { owner: "tests" },
      source: "cli",
      command: "workspaces update",
    }, db);
    expect(updated.name).toBe("Renamed Workspace");
    expect(updated.tags.sort()).toEqual(["after", "replacement"]);
    expect(listWorkspaces({ query: "searchable" }, db).map((item) => item.id)).toContain(workspace.id);

    expect(archiveWorkspace(workspace.id, { source: "cli", command: "workspaces archive" }, db).status).toBe("archived");
    expect(unarchiveWorkspace(workspace.id, { source: "cli", command: "workspaces unarchive" }, db).status).toBe("active");
    const deleted = deleteWorkspace(workspace.id, { source: "cli", command: "workspaces delete" }, db);
    expect(deleted.hard).toBe(false);
    expect(deleted.workspace.status).toBe("deleted");
    expect(listWorkspaceEvents(workspace.id, db).map((event) => event.event_type)).toEqual([
      "created",
      "updated",
      "updated",
      "updated",
      "updated",
    ]);

    rmSync(dir, { recursive: true });
    db.close();
  });

  test("writes markers, diagnoses workspaces, imports folders, matches roots, and manages locks", async () => {
    const db = makeDb();
    const rootDir = tmpDir();
    const childDir = join(rootDir, "tooling");
    mkdirSync(childDir);
    writeFileSync(join(childDir, "package.json"), JSON.stringify({ name: "tooling-kit" }));
    mkdirSync(join(childDir, "docs"));
    writeFileSync(join(childDir, ".project.json"), JSON.stringify({ name: "Legacy Tooling" }));
    const root = createRoot({ name: "Import Root", slug: "import-root", base_path: rootDir, path_template: "{slug}" }, db);

    const preview = planWorkspaceImport(childDir, { db, tags: ["imported"], metadata: { domain: "tools" } });
    expect(preview.name).toBe("Legacy Tooling");
    expect(preview.root_id).toBe(root.id);
    expect(preview.metadata.domain).toBe("tools");
    expect(preview.signals).toContain("project-marker");
    expect(preview.signals).toContain("scaffold-dir:docs");
    expect(matchRootForPath(childDir, db)?.id).toBe(root.id);

    const scan = await importRegisteredRoots({ db, dryRun: true, tags: ["scan"] });
    expect(scan.dry_run).toBe(true);
    expect(scan.previews.some((item) => item.path === childDir && item.tags.includes("scan"))).toBe(true);

    const pathLock = acquireWorkspaceLock({ lock_key: `workspace-path:${childDir}`, reason: "import conflict" }, db);
    const blockedImport = await importWorkspace(childDir, { db, tags: ["imported"] });
    expect(blockedImport.error).toMatch(/Workspace lock already held/);
    expect(listWorkspaceLocks(db).map((item) => item.lock_key)).not.toContain("workspace-slug:legacy-tooling");
    expect(releaseWorkspaceLock(pathLock.lock_key, db)).toBe(true);

    const imported = await importWorkspace(childDir, { db, tags: ["imported"], metadata: { domain: "tools" } });
    expect(imported.workspace?.slug).toBe("legacy-tooling");
    const workspace = imported.workspace!;
    expect(workspace.metadata.domain).toBe("tools");
    expect(workspace.metadata.import_signals).toContain("project-marker");
    const beforeFix = doctorWorkspace(workspace, {}, db);
    expect(beforeFix.checks.some((check) => check.code === "WORKSPACE_MARKER_MISMATCH")).toBe(true);
    const dryRunFix = doctorWorkspace(workspace, { fix: true, dryRun: true }, db);
    expect(dryRunFix.fixes.some((fix) => fix.code === "FIX_WORKSPACE_MARKER" && fix.dryRun)).toBe(true);
    prepareWorkspaceDirectory(workspace, { writeMarker: true, recordEvents: false });
    expect(workspaceMarkerPath(workspace)).toBe(join(childDir, ".project.json"));
    expect(doctorWorkspace(workspace, {}, db).checks.some((check) => check.code === "WORKSPACE_MARKER_OK")).toBe(true);

    const lock = acquireWorkspaceLock({ lock_key: "workspace:test", workspace_id: workspace.id, reason: "test" }, db);
    expect(lock.lock_key).toBe("workspace:test");
    expect(listWorkspaceLocks(db)).toHaveLength(1);
    expect(releaseWorkspaceLock("workspace:test", db)).toBe(true);
    expect(listWorkspaceLocks(db)).toHaveLength(0);

    rmSync(rootDir, { recursive: true });
    db.close();
  });

  test("renders templates and infers kinds from existing conventions", () => {
    expect(renderTemplate("{kind}/{slug}", { kind: "open-source", slug: "open-logs" })).toBe("open-source/open-logs");
    expect(inferWorkspaceKind("open-logs", "/home/hasna/workspace/hasna/opensource/open-logs")).toBe("open-source");
    expect(inferWorkspaceKind("iapp-news", "/home/hasna/workspace/hasnaxyz/internalapp/iapp-news")).toBe("internal-app");
    expect(inferWorkspaceKind("platform-mcps", "/home/hasna/workspace/hasnatools/platform/platform-mcps")).toBe("platform");
    expect(inferWorkspaceKind("cweb-hasna", "/home/hasna/workspace/hasnaxyz/companywebsite/cweb-hasna")).toBe("company-website");
    expect(inferWorkspaceKind("community-kit", "/home/hasna/workspace/hasna/community/community-kit")).toBe("community");
    expect(inferWorkspaceKind("anything", "/future/path", ["remote-only"])).toBe("remote-only");
  });
});

describe("legacy project migration", () => {
  test("migrates existing project rows into workspaces once", () => {
    const db = makeDb();
    const dir = tmpDir();
    const workdirPath = join(dir, "legacy-workdir");
    mkdirSync(workdirPath, { recursive: true });
    const project = {
      id: "prj_legacy",
      slug: "open-legacy",
      path: dir,
    };
    db.run(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        path TEXT UNIQUE NOT NULL,
        s3_bucket TEXT,
        s3_prefix TEXT,
        git_remote TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        integrations TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synced_at TEXT,
        last_opened_at TEXT
      )
    `);
    db.run(
      `INSERT INTO projects (id, slug, name, description, status, path, s3_bucket, s3_prefix, git_remote, tags, integrations, created_at, updated_at, synced_at, last_opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        project.id,
        project.slug,
        "Legacy Open",
        null,
        "active",
        project.path,
        null,
        null,
        null,
        JSON.stringify(["legacy"]),
        "{}",
        "2026-01-01 00:00:00.000",
        "2026-01-01 00:00:00.000",
        null,
        null,
      ],
    );
    db.run(`
      CREATE TABLE project_workdirs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        label TEXT,
        is_primary INTEGER,
        claude_md_generated INTEGER,
        agents_md_generated INTEGER,
        created_at TEXT
      )
    `);
    db.run(
      `INSERT INTO project_workdirs (id, project_id, path, machine_id, label, is_primary, claude_md_generated, agents_md_generated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy_workdir_1",
        project.id,
        workdirPath,
        "legacy-machine",
        "laptop",
        1,
        1,
        0,
        "2026-01-02 00:00:00.000",
      ],
    );

    const first = migrateLegacyProjectsToWorkspaces(db);
    expect(first.migrated).toBe(1);
    expect(first.skipped).toBe(0);
    expect(first.workdirs_migrated).toBe(1);
    expect(first.validation.valid).toBe(true);
    expect(first.validation.workdir_source_count).toBe(1);
    expect(first.samples[0]?.old_project_id).toBe(project.id);
    const workspace = getWorkspaceByPath(workdirPath, db);
    expect(workspace?.slug).toBe("open-legacy");
    expect(workspace?.metadata["migrated_from_project_id"]).toBe(project.id);
    const locations = listWorkspaceLocations(workspace!.id, db);
    const migratedWorkdir = locations.find((location) => location.machine_id === "legacy-machine");
    expect(migratedWorkdir?.path).toBe(workdirPath);
    expect(migratedWorkdir?.is_primary).toBe(true);
    expect(migratedWorkdir?.metadata["migrated_from_workdir_id"]).toBe("legacy_workdir_1");
    expect(doctorWorkspace(workspace!, {}, db).checks.some((check) => check.code === "WORKSPACE_MIGRATION_MAP_OK")).toBe(true);
    expect(listWorkspaceEvents(workspace!.id, db).some((event) => event.source === "migration")).toBe(true);

    const second = migrateLegacyProjectsToWorkspaces(db);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.workdirs_skipped).toBe(1);
    expect(second.validation.valid).toBe(true);

    rmSync(dir, { recursive: true });
    db.close();
  });
});
