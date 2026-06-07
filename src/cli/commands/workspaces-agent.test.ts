import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runProjects(args: string[], env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}

describe("workspace agent CLI", () => {
  test("runs a quoted prompt through the mock agent and creates a workspace when approved", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-agent-cli-"));
    const dbPath = join(root, "workspaces.db");
    const targetPath = join(root, "agent-smoke");
    const env = {
      HASNA_WORKSPACES_DB_PATH: dbPath,
      WORKSPACES_AGENT_MOCK: "1",
    };

    const res = runProjects(["--yes", "--json", `create "Agent Smoke" in ${targetPath}`], env);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(text(res.stdout)) as {
      mode: string;
      approved: boolean;
      workspaces: Array<{ slug: string; name: string; primary_path: string }>;
      tool_calls: Array<{ name?: string }>;
    };

    expect(payload.mode).toBe("mock");
    expect(payload.approved).toBe(true);
    expect(payload.workspaces).toHaveLength(1);
    expect(payload.workspaces[0]!.name).toBe("Agent Smoke");
    expect(payload.workspaces[0]!.primary_path).toBe(targetPath);
    expect(payload.tool_calls.some((call) => call.name === "workspace_create")).toBe(true);

    const show = runProjects(["workspaces", "show", payload.workspaces[0]!.slug, "--json"], env);
    expect(show.exitCode).toBe(0);
    const shown = JSON.parse(text(show.stdout)) as {
      workspace: { primary_path: string };
      events: Array<{ source: string; event_type: string; prompt: string | null }>;
    };
    expect(shown.workspace.primary_path).toBe(targetPath);
    expect(shown.events.some((event) => event.source === "agent" && event.event_type === "created")).toBe(true);
  });

  test("plans a prompt without --yes and does not create the target directory", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-agent-plan-"));
    const dbPath = join(root, "workspaces.db");
    const targetPath = join(root, "planned-only");
    const env = {
      HASNA_WORKSPACES_DB_PATH: dbPath,
      WORKSPACES_AGENT_MOCK: "1",
    };

    const res = runProjects(["--json", `create "Planned Only" in ${targetPath}`], env);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(text(res.stdout)) as { approved: boolean; workspaces: unknown[]; text: string };
    expect(payload.approved).toBe(false);
    expect(payload.workspaces).toHaveLength(0);
    expect(payload.text).toContain("Run with --yes");
    expect(existsSync(targetPath)).toBe(false);
  });

  test("prompt flags constrain root, recipe, actor agent, and tmux planning", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-agent-flags-"));
    const dbPath = join(root, "workspaces.db");
    const rootPath = join(root, "registered-root");
    mkdirSync(rootPath);
    const env = {
      HASNA_WORKSPACES_DB_PATH: dbPath,
      WORKSPACES_AGENT_MOCK: "1",
    };

    expect(runProjects([
      "roots",
      "add",
      "--name",
      "Prompt Root",
      "--slug",
      "prompt-root",
      "--path",
      rootPath,
      "--kind",
      "docs",
      "--path-template",
      "docs-{slug}",
      "--json",
    ], env).exitCode).toBe(0);
    expect(runProjects([
      "recipes",
      "add",
      "--name",
      "Docs Recipe",
      "--slug",
      "docs-recipe",
      "--kind",
      "docs",
      "--tags",
      "docs,recipe",
      "--json",
    ], env).exitCode).toBe(0);
    const agentResult = runProjects([
      "agents",
      "add",
      "--name",
      "Human Reviewer",
      "--slug",
      "human-reviewer",
      "--kind",
      "human",
      "--role",
      "reviewer",
      "--json",
    ], env);
    expect(agentResult.exitCode).toBe(0);
    const actor = JSON.parse(text(agentResult.stdout)) as { id: string };

    const res = runProjects([
      "--yes",
      "--json",
      "--agent",
      "human-reviewer",
      "--root",
      "prompt-root",
      "--recipe",
      "docs-recipe",
      "--no-tmux",
      "create",
      "\"Flagged Workspace\"",
      "with",
      "tmux",
    ], env);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(text(res.stdout)) as {
      actor_agent_id: string;
      workspaces: Array<{
        slug: string;
        primary_path: string;
        kind: string;
        tags: string[];
        root_id: string;
        recipe_id: string;
      }>;
      tool_calls: Array<{ output?: { plan?: { tmux: unknown; workspace: { primary_path: string; kind: string; tags: string[] } } } }>;
    };

    expect(payload.actor_agent_id).toBe(actor.id);
    expect(payload.workspaces).toHaveLength(1);
    expect(payload.workspaces[0]!.primary_path).toBe(join(rootPath, "docs-flagged-workspace"));
    expect(payload.workspaces[0]!.kind).toBe("docs");
    expect(payload.workspaces[0]!.tags.sort()).toEqual(["agent-created", "docs", "recipe"].sort());
    expect(payload.tool_calls[0]!.output?.plan?.tmux).toBeNull();
    expect(payload.tool_calls[0]!.output?.plan?.workspace.primary_path).toBe(join(rootPath, "docs-flagged-workspace"));

    const show = runProjects(["workspaces", "show", payload.workspaces[0]!.slug, "--json"], env);
    expect(show.exitCode).toBe(0);
    const shown = JSON.parse(text(show.stdout)) as { events: Array<{ agent_id: string | null; command: string | null }> };
    expect(shown.events.some((event) => event.agent_id === actor.id && event.command?.includes("--no-tmux"))).toBe(true);
  });

  test("prompt mode validates loop limits and records provider failures", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-agent-policy-"));
    const dbPath = join(root, "workspaces.db");
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    const invalidSteps = runProjects(["--max-steps", "0", "create a workspace"], env);
    expect(invalidSteps.exitCode).toBe(1);
    expect(text(invalidSteps.stderr)).toContain("--max-steps must be a positive integer");

    const missingKey = runProjects(["--json", "create a workspace named Missing Key"], {
      ...env,
      OPENROUTER_API_KEY: "",
      WORKSPACES_OPENROUTER_API_KEY: "",
      WORKSPACES_USE_SECRETS: "false",
    });
    expect(missingKey.exitCode).toBe(1);
    expect(text(missingKey.stderr)).toContain("Missing OpenRouter API key");

    const db = new Database(dbPath);
    const run = db.query("SELECT status, error FROM agent_runs ORDER BY started_at DESC LIMIT 1").get() as { status: string; error: string } | null;
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("Missing OpenRouter API key");
    db.close();
  });

  test("workspaces create exposes runtime dry-run for directories and tmux windows", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-runtime-cli-"));
    const dbPath = join(root, "workspaces.db");
    const targetPath = join(root, "runtime-app");
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    const windows = JSON.stringify([
      { name: "editor" },
      { name: "server", command: "bun run dev" },
    ]);
    const res = runProjects([
      "workspaces",
      "create",
      "--name",
      "Runtime App",
      "--path",
      targetPath,
      "--mkdir",
      "--git-init",
      "--tmux-session",
      "runtime-app",
      "--tmux-windows-json",
      windows,
      "--dry-run-runtime",
      "--json",
    ], env);

    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(text(res.stdout)) as {
      workspace: { primary_path: string };
      prepare: Array<{ type: string; status: string; target: string }>;
      tmux: { dry_run: boolean; windows: Array<{ target: string; status: string }> };
    };
    expect(payload.workspace.primary_path).toBe(targetPath);
    expect(payload.prepare.map((action) => action.type)).toEqual(["mkdir", "git_init"]);
    expect(payload.prepare.every((action) => action.status === "planned")).toBe(true);
    expect(payload.tmux.dry_run).toBe(true);
    expect(payload.tmux.windows.map((window) => window.target)).toEqual(["runtime-app:editor", "runtime-app:server"]);
    expect(existsSync(targetPath)).toBe(false);
  });

  test("workspaces create --dry-run returns a no-write deterministic plan", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-create-plan-cli-"));
    const dbPath = join(root, "workspaces.db");
    const targetPath = join(root, "planned-create-app");
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    const res = runProjects([
      "workspaces",
      "create",
      "--name",
      "Planned Create App",
      "--path",
      targetPath,
      "--mkdir",
      "--marker",
      "--dry-run",
      "--json",
    ], env);

    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(text(res.stdout)) as {
      dry_run: boolean;
      workspace: null;
      plan: {
        workspace: { slug: string; primary_path: string };
        db_writes: Array<{ target: string }>;
        runtime_actions: Array<{ type: string; status: string }>;
        rollback_actions: Array<{ action: string }>;
      };
    };
    expect(payload.dry_run).toBe(true);
    expect(payload.workspace).toBeNull();
    expect(payload.plan.workspace.primary_path).toBe(targetPath);
    expect(payload.plan.db_writes.map((write) => write.target)).toContain("workspaces");
    expect(payload.plan.runtime_actions.map((action) => action.type)).toEqual(["mkdir", "workspace_marker"]);
    expect(payload.plan.runtime_actions.every((action) => action.status === "planned")).toBe(true);
    expect(payload.plan.rollback_actions.some((action) => action.action === "remove_file")).toBe(true);
    expect(existsSync(targetPath)).toBe(false);

    const list = runProjects(["workspaces", "list", "--json"], env);
    expect(JSON.parse(text(list.stdout))).toHaveLength(0);
  });

  test("workspaces migrate-legacy --dry-run emits a full report", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-migrate-cli-"));
    const dbPath = join(root, "workspaces.db");
    const reportPath = join(root, "migration-report.json");
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    const res = runProjects([
      "workspaces",
      "migrate-legacy",
      "--dry-run",
      "--report",
      reportPath,
      "--json",
    ], env);

    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(text(res.stdout)) as {
      dry_run: boolean;
      execution_db_path: string;
      report_path: string;
      result: { migrated: number; validation: { valid: boolean } };
      release_checklist: Array<{ key: string }>;
    };
    expect(payload.dry_run).toBe(true);
    expect(payload.execution_db_path).not.toBe(dbPath);
    expect(payload.result.migrated).toBe(0);
    expect(payload.result.validation.valid).toBe(true);
    expect(payload.release_checklist.map((item) => item.key)).toContain("migration_counts");
    expect(existsSync(reportPath)).toBe(true);
    expect((JSON.parse(readFileSync(reportPath, "utf-8")) as { dry_run: boolean }).dry_run).toBe(true);
  });

  test("workspaces create can write marker and doctor validates it", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-marker-cli-"));
    const dbPath = join(root, "workspaces.db");
    const targetPath = join(root, "marker-app");
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    const create = runProjects([
      "workspaces",
      "create",
      "--name",
      "Marker App",
      "--path",
      targetPath,
      "--mkdir",
      "--marker",
      "--json",
    ], env);
    expect(create.exitCode).toBe(0);
    const payload = JSON.parse(text(create.stdout)) as { workspace: { slug: string; id: string } };
    const markerPath = join(targetPath, ".workspace.json");
    expect(existsSync(markerPath)).toBe(true);

    const doctor = runProjects(["workspaces", "doctor", payload.workspace.slug, "--json"], env);
    expect(doctor.exitCode).toBe(0);
    const rows = JSON.parse(text(doctor.stdout)) as Array<{ checks: Array<{ code: string }> }>;
    expect(rows[0]!.checks.some((check) => check.code === "WORKSPACE_MARKER_OK")).toBe(true);
  });

  test("workspaces cleanup-create previews and applies rollback records", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-cleanup-cli-"));
    const dbPath = join(root, "workspaces.db");
    const targetPath = join(root, "cleanup-app");
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    const create = runProjects([
      "workspaces",
      "create",
      "--name",
      "Cleanup App",
      "--path",
      targetPath,
      "--mkdir",
      "--marker",
      "--json",
    ], env);
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(text(create.stdout)) as { workspace: { slug: string } };
    expect(existsSync(join(targetPath, ".workspace.json"))).toBe(true);

    const preview = runProjects(["workspaces", "cleanup-create", created.workspace.slug, "--dry-run", "--json"], env);
    expect(preview.exitCode).toBe(0);
    const previewPayload = JSON.parse(text(preview.stdout)) as { dry_run: boolean; actions: Array<{ status: string }> };
    expect(previewPayload.dry_run).toBe(true);
    expect(previewPayload.actions.some((action) => action.status === "planned")).toBe(true);
    expect(existsSync(targetPath)).toBe(true);

    const cleanup = runProjects(["workspaces", "cleanup-create", created.workspace.slug, "--json"], env);
    expect(cleanup.exitCode).toBe(0);
    const cleanupPayload = JSON.parse(text(cleanup.stdout)) as { success: boolean; actions: Array<{ action: string; status: string }> };
    expect(cleanupPayload.success).toBe(true);
    expect(cleanupPayload.actions.some((action) => action.action === "remove_empty_directory" && action.status === "completed")).toBe(true);
    expect(existsSync(targetPath)).toBe(false);

    const list = runProjects(["workspaces", "list", "--json"], env);
    expect(JSON.parse(text(list.stdout))).toHaveLength(0);
  });

  test("workspaces update, archive, unarchive, delete, and query list replace project metadata flows", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-metadata-cli-"));
    const dbPath = join(root, "workspaces.db");
    const targetPath = join(root, "metadata-app");
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    const create = runProjects([
      "workspaces",
      "create",
      "--name",
      "Metadata App",
      "--path",
      targetPath,
      "--json",
    ], env);
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(text(create.stdout)) as { workspace: { slug: string } };

    const update = runProjects([
      "workspaces",
      "update",
      created.workspace.slug,
      "--name",
      "Metadata App Renamed",
      "--description",
      "queryable workspace replacement",
      "--tags",
      "workspace,replacement",
      "--metadata-json",
      "{\"owner\":\"cli-test\"}",
      "--json",
    ], env);
    expect(update.exitCode).toBe(0);
    const updated = JSON.parse(text(update.stdout)) as { name: string; tags: string[]; metadata: Record<string, string> };
    expect(updated.name).toBe("Metadata App Renamed");
    expect(updated.tags).toEqual(["workspace", "replacement"]);
    expect(updated.metadata.owner).toBe("cli-test");

    const search = runProjects(["workspaces", "list", "--query", "queryable", "--json"], env);
    expect(search.exitCode).toBe(0);
    expect(JSON.parse(text(search.stdout))).toHaveLength(1);

    const archive = runProjects(["workspaces", "archive", created.workspace.slug, "--json"], env);
    expect(JSON.parse(text(archive.stdout)).status).toBe("archived");

    const unarchive = runProjects(["workspaces", "unarchive", created.workspace.slug, "--json"], env);
    expect(JSON.parse(text(unarchive.stdout)).status).toBe("active");

    const del = runProjects(["workspaces", "delete", created.workspace.slug, "--json"], env);
    expect(del.exitCode).toBe(0);
    const deleted = JSON.parse(text(del.stdout)) as { hard: boolean; workspace: { status: string } };
    expect(deleted.hard).toBe(false);
    expect(deleted.workspace.status).toBe("deleted");
  });

  test("workspaces import, locks, and tmux profile apply support JSON dry-run flows", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-extra-cli-"));
    const dbPath = join(root, "workspaces.db");
    const importDir = join(root, "existing-app");
    mkdirSync(importDir);
    writeFileSync(join(importDir, "package.json"), JSON.stringify({ name: "existing-app" }));
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    const dryImport = runProjects(["workspaces", "import", importDir, "--dry-run", "--json"], env);
    expect(dryImport.exitCode).toBe(0);
    const dryPayload = JSON.parse(text(dryImport.stdout)) as { skipped: string; preview: { slug: string } };
    expect(dryPayload.skipped).toBe("dry-run");
    expect(dryPayload.preview.slug).toBe("existing-app");

    const imported = runProjects(["workspaces", "import", importDir, "--json"], env);
    expect(imported.exitCode).toBe(0);
    const importedPayload = JSON.parse(text(imported.stdout)) as { workspace: { slug: string; id: string } };
    expect(importedPayload.workspace.slug).toBe("existing-app");

    const profile = runProjects([
      "tmux-profiles",
      "add",
      "--name",
      "Two Window",
      "--slug",
      "two-window",
      "--session-template",
      "{slug}-dev",
      "--windows-json",
      JSON.stringify([{ name: "editor" }, { name: "server", command: "bun run dev" }]),
      "--json",
    ], env);
    expect(profile.exitCode).toBe(0);

    const apply = runProjects(["tmux-profiles", "apply", "two-window", "existing-app", "--dry-run", "--json"], env);
    expect(apply.exitCode).toBe(0);
    const applyPayload = JSON.parse(text(apply.stdout)) as { session_name: string; windows: Array<{ target: string }> };
    expect(applyPayload.session_name).toBe("existing-app-dev");
    expect(applyPayload.windows.map((window) => window.target)).toEqual(["existing-app-dev:editor", "existing-app-dev:server"]);

    const lock = runProjects(["workspaces", "lock", "existing-app", "--key", "test-lock", "--json"], env);
    expect(lock.exitCode).toBe(0);
    const locks = runProjects(["workspaces", "locks", "--json"], env);
    expect(JSON.parse(text(locks.stdout))).toHaveLength(1);
    const unlock = runProjects(["workspaces", "unlock", "test-lock", "--json"], env);
    expect(unlock.exitCode).toBe(0);
    expect(JSON.parse(text(unlock.stdout)).released).toBe(true);

    const mutationLock = runProjects(["workspaces", "lock", "existing-app", "--json"], env);
    expect(mutationLock.exitCode).toBe(0);
    const locked = JSON.parse(text(mutationLock.stdout)) as { lock_key: string };
    const blockedUpdate = runProjects(["workspaces", "update", "existing-app", "--description", "blocked", "--json"], env);
    expect(blockedUpdate.exitCode).toBe(1);
    expect(text(blockedUpdate.stderr)).toContain("Workspace lock already held");
    const releaseMutation = runProjects(["workspaces", "unlock", locked.lock_key, "--json"], env);
    expect(JSON.parse(text(releaseMutation.stdout)).released).toBe(true);
  });

  test("workspaces GitHub dry-runs and integration links use workspace metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-github-cli-"));
    const dbPath = join(root, "workspaces.db");
    const rootPath = join(root, "registered-root");
    mkdirSync(rootPath);
    const env = { HASNA_WORKSPACES_DB_PATH: dbPath };

    expect(runProjects([
      "roots",
      "add",
      "--name",
      "GitHub Root",
      "--slug",
      "github-root",
      "--path",
      rootPath,
      "--kind",
      "open-source",
      "--github-org",
      "hasna",
      "--visibility",
      "public",
      "--path-template",
      "open-{slug}",
      "--json",
    ], env).exitCode).toBe(0);

    const created = runProjects([
      "workspaces",
      "create",
      "--name",
      "GitHub App",
      "--root",
      "github-root",
      "--json",
    ], env);
    expect(created.exitCode).toBe(0);
    const workspace = (JSON.parse(text(created.stdout)) as { workspace: { slug: string } }).workspace;

    const publish = runProjects(["workspaces", "publish", workspace.slug, "--dry-run", "--json"], env);
    expect(publish.exitCode).toBe(0);
    const publishPayload = JSON.parse(text(publish.stdout)) as { full_name: string; visibility: string; dry_run: boolean };
    expect(publishPayload.dry_run).toBe(true);
    expect(publishPayload.full_name).toBe("hasna/github-app");
    expect(publishPayload.visibility).toBe("public");

    const githubImport = runProjects(["workspaces", "import-github", "hasna/example", "--root", "github-root", "--clone", "--dry-run", "--json"], env);
    expect(githubImport.exitCode).toBe(0);
    const importPayload = JSON.parse(text(githubImport.stdout)) as { path: string; commands: string[] };
    expect(importPayload.path).toBe(join(rootPath, "open-example"));
    expect(importPayload.commands[0]).toContain("gh repo clone hasna/example");

    const link = runProjects([
      "workspaces",
      "link",
      workspace.slug,
      "--github-url",
      "https://github.com/hasna/github-app",
      "--todos-project-id",
      "todo_123",
      "--json",
    ], env);
    expect(link.exitCode).toBe(0);
    const linked = JSON.parse(text(link.stdout)) as { integrations: Record<string, string> };
    expect(linked.integrations.github_url).toBe("https://github.com/hasna/github-app");
    expect(linked.integrations.todos_project_id).toBe("todo_123");
  });

  test("workspaces agent-eval scores prompt cases in mock mode", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-agent-eval-cli-"));
    const dbPath = join(root, "workspaces.db");
    const env = {
      HASNA_WORKSPACES_DB_PATH: dbPath,
      WORKSPACES_AGENT_MOCK: "1",
    };

    const res = runProjects(["workspaces", "agent-eval", "--mock", "--json"], env);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(text(res.stdout)) as {
      mode: string;
      summary: { executed: number; passed: number; failed: number; skipped: number; success_rate: number; confidence: number };
      cases: Array<{ id: string; skipped: boolean; passed: boolean; checks: Array<{ passed: boolean }> }>;
    };
    expect(payload.mode).toBe("mock");
    expect(payload.summary.executed).toBe(2);
    expect(payload.summary.passed).toBe(2);
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.skipped).toBeGreaterThan(0);
    expect(payload.summary.success_rate).toBe(1);
    expect(payload.summary.confidence).toBe(1);
    const constrained = payload.cases.find((item) => item.id === "create-root-recipe-no-tmux");
    expect(constrained?.passed).toBe(true);
    expect(constrained?.checks.every((item) => item.passed)).toBe(true);
  });
});
