import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWorkspaceLock, completeAgentRun, createRoot, createWorkspace, startAgentRun } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";

const CLI_PATH = join(process.cwd(), "src/cli/index.ts");

function runProjects(args: string[], env: Record<string, string> = {}, cwd = process.cwd()) {
  return Bun.spawnSync({
    cmd: ["bun", "run", CLI_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    cwd,
  });
}

async function readStreamChunk(stream: ReadableStream<Uint8Array> | null, timeoutMs = 3_000): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const timeout = setTimeout(() => undefined, timeoutMs);
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs)),
    ]);
    return result.value ? Buffer.from(result.value).toString("utf-8") : "";
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}

describe("project-first CLI surface", () => {
  test("registers project-first commands on the main CLI", () => {
    const source = readFileSync("src/cli/index.ts", "utf-8");

    expect(source).toContain("registerWorkspaceCommands");
  });

  test("help exposes project commands and hides the legacy workspace group", () => {
    const eventsDir = mkdtempSync(join(tmpdir(), "projects-events-"));
    try {
      const result = runProjects(["--help"], { HASNA_EVENTS_DIR: eventsDir });
      const stdout = text(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(stdout).toContain("High-level project management and launcher CLI");
      expect(stdout).toContain("start");
      expect(stdout).toContain("create");
      expect(stdout).toContain("list");
      expect(stdout).toContain("show");
      expect(stdout).toContain("sessions");
      expect(stdout).not.toContain("workspaces");
      expect(stdout).toContain("store");
      expect(stdout).toContain("labels");
      expect(stdout).toContain("oss");
      expect(stdout).toContain("roots");
      expect(stdout).toContain("tmux-profiles");
      expect(stdout).toContain("hasna-events");
      expect(stdout).toContain("webhooks");
      expect(stdout).toContain("reports");
    } finally {
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  test("dashboard validate emits structured JSON errors for malformed input", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-dashboard-invalid-"));
    const invalidFile = join(root, "invalid.json");
    try {
      writeFileSync(invalidFile, "{");
      const result = runProjects(["dashboard", "validate", invalidFile, "--json"]);
      const stdout = text(result.stdout);
      const stderr = text(result.stderr);
      const payload = JSON.parse(stdout) as { ok: boolean; error?: { name: string; message: string } };

      expect(result.exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(payload.ok).toBe(false);
      expect(payload.error?.message).toContain("JSON");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dashboard JSON output is not truncated when captured through a pipe", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-dashboard-large-json-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const projectPath = join(root, "large-dashboard");
    const snapshotFile = join(root, "large.snapshot.json");
    const generatedAt = "2026-06-29T00:00:00.000Z";
    const largeItems = Array.from({ length: 900 }, (_, index) => ({
      id: `item-${index}`,
      title: `Dashboard item ${index}`,
      summary: `Large dashboard payload segment ${index} ${"x".repeat(120)}`,
    }));

    try {
      expect(runProjects(["create", "--name", "Large Dashboard", "--slug", "large-dashboard", "--path", projectPath, "--mkdir", "--json"], env).exitCode).toBe(0);
      writeFileSync(snapshotFile, `${JSON.stringify({
        schema: "hasna.project_snapshot.v1",
        id: "snapshot-large-dashboard",
        createdAt: generatedAt,
        projectId: "large-dashboard",
        generatedAt,
        status: "succeeded",
        manifestRef: { kind: "project", id: "large-dashboard", uri: "project://large-dashboard", tags: [] },
        panels: [{
          schema: "hasna.project_panel.v1",
          id: "panel-large-dashboard",
          createdAt: generatedAt,
          projectId: "large-dashboard",
          provider: { kind: "todos", id: "test-provider" },
          kind: "tasks",
          title: "Large Tasks",
          state: "ready",
          generatedAt,
          freshness: "fresh",
          items: largeItems,
        }],
      }, null, 2)}\n`);

      const validate = runProjects(["dashboard", "validate", snapshotFile, "--json"], env);
      const validateStdout = text(validate.stdout);
      expect(validate.exitCode).toBe(0);
      expect(Buffer.byteLength(validateStdout)).toBeGreaterThan(65_536);
      expect(JSON.parse(validateStdout).snapshot.panels[0].items).toHaveLength(900);

      const render = runProjects(["dashboard", "render", "large-dashboard", "--snapshot", snapshotFile, "--json"], env);
      const renderStdout = text(render.stdout);
      expect(render.exitCode).toBe(0);
      expect(Buffer.byteLength(renderStdout)).toBeGreaterThan(65_536);
      expect(JSON.parse(renderStdout).root).toBe("root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dashboard serve keeps the CLI process alive until terminated", async () => {
    const root = mkdtempSync(join(tmpdir(), "projects-dashboard-serve-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const projectPath = join(root, "served-dashboard");
    const port = 41_000 + Math.floor(Math.random() * 1_000);
    try {
      expect(runProjects(["create", "--name", "Served Dashboard", "--slug", "served-dashboard", "--path", projectPath, "--mkdir", "--json"], env).exitCode).toBe(0);
      const proc = Bun.spawn({
        cmd: ["bun", "run", CLI_PATH, "dashboard", "serve", "served-dashboard", "--host", "127.0.0.1", "--port", String(port), "--json"],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      });
      try {
        const stdout = await readStreamChunk(proc.stdout);
        expect(stdout).toContain("\"ok\": true");
        await Bun.sleep(500);
        expect(proc.exitCode).toBeNull();
      } finally {
        proc.kill("SIGTERM");
        await proc.exited;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports serve defaults to network bind and keeps existing project registry semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "projects-reports-serve-"));
    const env = {
      HASNA_PROJECTS_DB_PATH: join(root, "projects.db"),
      HASNA_PROJECTS_HOME: join(root, "projects-home"),
    };
    const projectPath = join(root, "fleet-reports");
    const reportsDir = join(projectPath, "reports", "2026-07-04");
    const port = 42_000 + Math.floor(Math.random() * 1_000);
    try {
      expect(runProjects(["create", "--name", "Fleet Reports", "--slug", "fleet-reports", "--path", projectPath, "--mkdir", "--json"], env).exitCode).toBe(0);
      mkdirSync(reportsDir, { recursive: true });
      writeFileSync(join(reportsDir, "daily.md"), "# Fleet daily\n");

      const proc = Bun.spawn({
        cmd: ["bun", "run", CLI_PATH, "reports", "serve", "--port", String(port), "--json"],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      });
      try {
        const stdout = await readStreamChunk(proc.stdout);
        const payload = JSON.parse(stdout) as {
          ok: boolean;
          mode: string;
          host: string;
          port: number;
          url: string;
        };
        expect(payload).toMatchObject({
          ok: true,
          mode: "reports",
          host: "0.0.0.0",
          port,
          url: `http://127.0.0.1:${port}/`,
        });
        await Bun.sleep(500);
        expect(proc.exitCode).toBeNull();

        const rootPage = await fetch(`http://127.0.0.1:${port}/`);
        expect(rootPage.status).toBe(200);
        expect(await rootPage.text()).toContain("Fleet Reports");
      } finally {
        proc.kill("SIGTERM");
        await proc.exited;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("completion emits project commands", () => {
    const result = runProjects(["completion"]);
    const stdout = text(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("local commands=\"start status sessions create cleanup-create cleanup-evals import import-github scan-roots sync-roots list show events update tag untag labels label link unlink publish unpublish archive unarchive delete lock locks unlock doctor agent-eval context next why handoff runs oss store canvases loops locations");
    expect(stdout).toContain("storage reports completion");
    expect(stdout).toContain("projects list");
    expect(stdout).toContain("project>");
    expect(stdout).not.toContain(["projects", "workspaces", "list"].join(" "));
    expect(stdout).not.toContain("workspace>");

    const zsh = runProjects(["completion", "--shell", "zsh"]);
    const zshStdout = text(zsh.stdout);
    expect(zsh.exitCode).toBe(0);
    expect(zshStdout).toContain("'scan-roots:Dry-run import plans for configured GitHub roots'");
    expect(zshStdout).toContain("'sync-roots:Import repositories from configured GitHub roots'");
    expect(zshStdout).toContain("'context:Emit an agent-priming bundle for a project'");
    expect(zshStdout).toContain("'runs:Inspect prompt-agent run ledger entries'");
    expect(zshStdout).toContain("'oss:Open-source workspace routing helpers'");
    expect(zshStdout).toContain("'store:Inspect, ensure, and migrate canonical project stores'");
    expect(zshStdout).toContain("'canvases:Manage per-project React Flow canvases'");
    expect(zshStdout).toContain("'loops:Link projects to OpenLoops SDK loops'");
    expect(zshStdout).toContain("'labels:Manage project labels'");
    expect(zshStdout).toContain("'reports:Serve registered project report files'");
  });

  test("oss matrix CLI emits capped JSON without optional external refs", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-oss-matrix-"));
    mkdirSync(join(root, "open-alpha"));
    mkdirSync(join(root, "open-beta"));
    mkdirSync(join(root, "not-open"));
    writeFileSync(join(root, "open-alpha", "package.json"), JSON.stringify({
      name: "@hasna/open-alpha",
      version: "0.0.1",
      bin: { "open-alpha": "dist/cli.js" },
    }));

    try {
      const result = runProjects([
        "oss",
        "matrix",
        "--root",
        root,
        "--prefix",
        "open-",
        "--limit",
        "1",
        "--no-tasks",
        "--no-prs",
        "--no-tmux",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(text(result.stdout)) as {
        kind: string;
        total_candidates: number;
        returned: number;
        truncated: boolean;
        rows: Array<{ name: string; package: { name: string; bins: string[] } | null; task_refs: unknown[]; pr_refs: unknown[]; tmux: unknown }>;
      };
      expect(payload.kind).toBe("projects.oss_matrix");
      expect(payload.total_candidates).toBe(2);
      expect(payload.returned).toBe(1);
      expect(payload.truncated).toBe(true);
      expect(payload.rows[0]?.name).toBe("open-alpha");
      expect(payload.rows[0]?.package?.name).toBe("@hasna/open-alpha");
      expect(payload.rows[0]?.package?.bins).toEqual(["open-alpha"]);
      expect(payload.rows[0]?.task_refs).toEqual([]);
      expect(payload.rows[0]?.pr_refs).toEqual([]);
      expect(payload.rows[0]?.tmux).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("oss matrix CLI rejects malformed positive integer options", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-oss-matrix-invalid-"));
    try {
      const result = runProjects([
        "oss",
        "matrix",
        "--root",
        root,
        "--limit",
        "1abc",
        "--no-tasks",
        "--no-prs",
        "--no-tmux",
        "--json",
      ]);

      expect(result.exitCode).toBe(1);
      expect(text(result.stderr)).toContain("--limit must be a positive integer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("package publishes Cursor goal hook files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { files: string[] };
    expect(pkg.files).toContain(".cursor/hooks.json");
    expect(pkg.files).toContain(".cursor/hooks/goal-continue.sh");
  });

  test("agent-assist CLI commands emit JSON, agent text, and run detail by default", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-agent-assist-"));
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };
    const db = new Database(dbPath);
    db.run("PRAGMA foreign_keys=ON");
    runMigrations(db);
    const project = createWorkspace({
      name: "Agent Assist",
      slug: "agent-assist",
      kind: "project",
      primary_path: join(root, "agent-assist"),
    }, db);
    const run = startAgentRun({ workspace_id: project.id, prompt: "inspect state", model: "test-model" }, db);
    completeAgentRun(run.id, { status: "completed", tool_calls: [{ name: "projects_show" }] }, db);
    db.close();

    const context = runProjects(["context", "agent-assist", "--json"], env);
    expect(context.exitCode).toBe(0);
    expect((JSON.parse(text(context.stdout)) as { kind: string; target: { resolved: boolean } }).kind).toBe("projects.agent_context");

    const next = runProjects(["next", "agent-assist", "--json"], env);
    expect(next.exitCode).toBe(0);
    expect((JSON.parse(text(next.stdout)) as { kind: string; actions: unknown[] }).kind).toBe("projects.next");

    const why = runProjects(["why", "agent-assist", "--for-agent"], env);
    expect(why.exitCode).toBe(0);
    expect(text(why.stdout)).toContain("Resolution");

    const handoff = runProjects(["handoff", "agent-assist", "--json"], env);
    expect(handoff.exitCode).toBe(0);
    expect((JSON.parse(text(handoff.stdout)) as { kind: string }).kind).toBe("projects.handoff");

    const runs = runProjects(["runs", "list", "agent-assist", "--json"], env);
    expect(runs.exitCode).toBe(0);
    expect((JSON.parse(text(runs.stdout)) as { kind: string; runs: unknown[] }).kind).toBe("projects.runs");

    const showDefault = runProjects(["runs", "show", run.id, "agent-assist"], env);
    expect(showDefault.exitCode).toBe(0);
    const showText = text(showDefault.stdout);
    expect(showText).toContain(`# Run ${run.id} [completed]`);
    expect(showText).toContain("tool calls (1):");
  });

  test("top-level create, list, and show use project-first JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-surface-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const targetPath = join(root, "surface-app");

    const create = runProjects([
      "create",
      "--name",
      "Surface App",
      "--path",
      targetPath,
      "--json",
    ], env);
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(text(create.stdout)) as {
      project?: { slug: string; primary_path: string };
      workspace?: unknown;
    };
    expect(created.project?.slug).toBe("surface-app");
    expect(created.project?.primary_path).toBe(targetPath);
    expect(created.workspace).toBeUndefined();

    const list = runProjects(["list", "--json"], env);
    expect(list.exitCode).toBe(0);
    const rows = JSON.parse(text(list.stdout)) as Array<{ slug: string }>;
    expect(rows.some((row) => row.slug === "surface-app")).toBe(true);

    const show = runProjects(["show", "surface-app", "--json"], env);
    expect(show.exitCode).toBe(0);
    const shown = JSON.parse(text(show.stdout)) as {
      project?: { slug: string; primary_path: string };
      workspace?: unknown;
    };
    expect(shown.project?.slug).toBe("surface-app");
    expect(shown.project?.primary_path).toBe(targetPath);
    expect(shown.workspace).toBeUndefined();
    expect((shown as { schema_version?: number; kind?: string; render?: unknown }).schema_version).toBeUndefined();
    expect((shown as { schema_version?: number; kind?: string; render?: unknown }).kind).toBeUndefined();
    expect((shown as { schema_version?: number; kind?: string; render?: unknown }).render).toBeUndefined();

    const get = runProjects(["get", "surface-app", "--json"], env);
    expect(get.exitCode).toBe(0);
    expect((JSON.parse(text(get.stdout)) as { project?: { slug: string } }).project?.slug).toBe("surface-app");
  });

  test("workspace store, app store, canvases, loops, and labels use temp home", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-store-"));
    const env = {
      HASNA_PROJECTS_HOME: join(root, "home"),
      HASNA_PROJECTS_DB_PATH: join(root, "projects.db"),
    };

    const create = runProjects([
      "create",
      "--name",
      "Store Work",
      "--kind",
      "project",
      "--mkdir",
      "--marker",
      "--json",
    ], env);
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(text(create.stdout)) as { project: { id: string; slug: string; primary_path: string } };
    expect(created.project.primary_path).toBe(join(env.HASNA_PROJECTS_HOME, "workspaces", created.project.id));

    const inspect = runProjects(["store", "inspect", "store-work", "--json"], env);
    expect(inspect.exitCode).toBe(0);
    const inspected = JSON.parse(text(inspect.stdout)) as {
      primary_is_canonical: boolean;
      paths: { data_path: string };
      app_store: { paths: { db_path: string }; counts: { canvases: number } };
    };
    expect(inspected.primary_is_canonical).toBe(true);
    expect(inspected.paths.data_path).toBe(join(env.HASNA_PROJECTS_HOME, "data", created.project.id));
    expect(inspected.app_store.paths.db_path).toBe(join(env.HASNA_PROJECTS_HOME, "data", created.project.id, "project.db"));
    expect(inspected.app_store.counts.canvases).toBe(0);

    const migratePlan = runProjects(["store", "migrate", "store-work", "--json"], env);
    expect(migratePlan.exitCode).toBe(0);
    const planned = JSON.parse(text(migratePlan.stdout)) as { dry_run: boolean; no_op: boolean; target_path: string };
    expect(planned.dry_run).toBe(true);
    expect(planned.no_op).toBe(true);
    expect(planned.target_path).toBe(created.project.primary_path);

    const canvases = runProjects(["canvases", "list", "store-work", "--ensure-default", "--json"], env);
    expect(canvases.exitCode).toBe(0);
    const listed = JSON.parse(text(canvases.stdout)) as { canvases: Array<{ slug: string; layout_engine: string }> };
    expect(listed.canvases[0]?.slug).toBe("dashboard");
    expect(listed.canvases[0]?.layout_engine).toBe("react-flow");

    const render = runProjects(["canvases", "show", "store-work", "dashboard", "--render-spec"], env);
    expect(render.exitCode).toBe(0);
    const spec = JSON.parse(text(render.stdout)) as { elements: { root?: { type?: string; props?: { ui_contract?: { canvas?: string } } } } };
    expect(spec.elements.root?.type).toBe("Canvas");
    expect(spec.elements.root?.props?.ui_contract?.canvas).toBe("react-flow");

    const link = runProjects(["loops", "link", "store-work", "loop_123", "--name", "Daily Check", "--json"], env);
    expect(link.exitCode).toBe(0);
    expect((JSON.parse(text(link.stdout)) as { link: { loop_id: string } }).link.loop_id).toBe("loop_123");

    const loops = runProjects(["loops", "list", "store-work", "--json"], env);
    expect(loops.exitCode).toBe(0);
    expect((JSON.parse(text(loops.stdout)) as { loops: Array<{ status: string }> }).loops[0]?.status).toBe("unavailable");

    const labelsAdd = runProjects(["labels", "add", "store-work", "org:hasnaxyz", "kind:work-project", "client:foo", "--json"], env);
    expect(labelsAdd.exitCode).toBe(0);
    const labelsPayload = JSON.parse(text(labelsAdd.stdout)) as { labels: string[] };
    expect(labelsPayload.labels).toContain("kind:work-project");

    const filtered = runProjects(["list", "--label", "kind:work-project", "--json"], env);
    expect(filtered.exitCode).toBe(0);
    expect((JSON.parse(text(filtered.stdout)) as Array<{ slug: string }>).map((project) => project.slug)).toEqual(["store-work"]);

    const started = runProjects(["start", "--label", "kind:work-project", "--dry-run", "--json"], env);
    expect(started.exitCode).toBe(0);
    const startPayload = JSON.parse(text(started.stdout)) as { project: { slug: string; primary_path: string }; tmux: { windows: Array<{ metadata?: { path?: string } }> } };
    expect(startPayload.project.slug).toBe("store-work");
    expect(startPayload.project.primary_path).toBe(created.project.primary_path);
    expect(startPayload.tmux.windows[0]?.metadata?.path).toBe(created.project.primary_path);

    rmSync(root, { recursive: true, force: true });
  }, 10000);

  test("top-level list hides eval fixtures by default and cleanup-evals removes them", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-eval-cleanup-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    expect(runProjects(["create", "--name", "Normal Project", "--slug", "normal-project", "--path", join(root, "normal"), "--json"], env).exitCode).toBe(0);
    expect(runProjects(["create", "--name", "Eval Hidden", "--slug", "eval-hidden", "--path", join(root, "eval-hidden"), "--json"], env).exitCode).toBe(0);

    const visible = runProjects(["list", "--json"], env);
    expect(visible.exitCode).toBe(0);
    expect((JSON.parse(text(visible.stdout)) as Array<{ slug: string }>).map((item) => item.slug)).toEqual(["normal-project"]);

    const all = runProjects(["list", "--include-evals", "--json"], env);
    expect(all.exitCode).toBe(0);
    expect((JSON.parse(text(all.stdout)) as Array<{ slug: string }>).map((item) => item.slug).sort()).toEqual(["eval-hidden", "normal-project"]);

    const preview = runProjects(["cleanup-evals", "--dry-run", "--json"], env);
    expect(preview.exitCode).toBe(0);
    expect((JSON.parse(text(preview.stdout)) as { dry_run: boolean; projects: Array<{ slug: string }> }).projects.map((item) => item.slug)).toEqual(["eval-hidden"]);

    const cleanup = runProjects(["cleanup-evals", "--apply", "--json"], env);
    expect(cleanup.exitCode).toBe(0);
    expect((JSON.parse(text(cleanup.stdout)) as { deleted: { projects: number } }).deleted.projects).toBe(1);

    const after = runProjects(["list", "--include-evals", "--json"], env);
    expect((JSON.parse(text(after.stdout)) as Array<{ slug: string }>).map((item) => item.slug)).toEqual(["normal-project"]);
  });

  test("top-level list is compact by default and JSON remains detailed", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-compact-list-"));
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };
    const db = new Database(dbPath);
    db.run("PRAGMA foreign_keys=ON");
    runMigrations(db);

    for (let i = 0; i < 30; i += 1) {
      const suffix = String(i).padStart(2, "0");
      createWorkspace({
        name: `Compact ${suffix}`,
        slug: `compact-${suffix}`,
        kind: "project",
        primary_path: join(root, `compact-${suffix}`),
        metadata: { notes: "x".repeat(500) },
      }, db);
    }
    db.close();

    const compact = runProjects(["list"], env);
    expect(compact.exitCode).toBe(0);
    const compactText = text(compact.stdout);
    expect(compactText).toContain("compact-00");
    expect(compactText).toContain("Showing 25 of more than 25 matching projects");
    expect(compactText).toContain("Use --limit <n>, --verbose, --json, or 'projects show <slug>' for details.");
    expect(compactText).not.toContain("compact-29");
    expect(compactText).not.toContain("x".repeat(120));

    const expanded = runProjects(["list", "--limit", "30"], env);
    expect(expanded.exitCode).toBe(0);
    expect(text(expanded.stdout)).toContain("compact-29");

    const json = runProjects(["list", "--json"], env);
    expect(json.exitCode).toBe(0);
    const rows = JSON.parse(text(json.stdout)) as Array<{ slug: string; metadata: Record<string, string> }>;
    expect(rows).toHaveLength(30);
    expect(rows.find((row) => row.slug === "compact-29")?.metadata.notes).toHaveLength(500);
  }, 10000);

  test("top-level list JSON output is not truncated above 64 KiB", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-large-list-json-"));
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };
    const db = new Database(dbPath);
    let dbClosed = false;
    db.run("PRAGMA foreign_keys=ON");
    runMigrations(db);

    try {
      for (let i = 0; i < 120; i += 1) {
        const suffix = String(i).padStart(3, "0");
        createWorkspace({
          name: `Large List ${suffix}`,
          slug: `large-list-${suffix}`,
          kind: "project",
          primary_path: join(root, `large-list-${suffix}`),
          metadata: { notes: `large-json-output-${suffix}-${"x".repeat(1_000)}` },
        }, db);
      }
      db.close();
      dbClosed = true;

      const result = runProjects(["list", "--limit", "120", "--json"], env);
      const stdout = text(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(Buffer.byteLength(stdout)).toBeGreaterThan(65_536);
      const rows = JSON.parse(stdout) as Array<{ slug: string; metadata: Record<string, string> }>;
      expect(rows).toHaveLength(120);
      expect(rows.find((row) => row.slug === "large-list-119")?.metadata.notes).toContain("large-json-output-119");
    } finally {
      if (!dbClosed) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

  test("top-level create, list, show, and update expose project management fields", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-management-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const targetPath = join(root, "managed-app");
    const briefPath = join(root, "brief.md");
    writeFileSync(briefPath, "# Managed App Brief\n");

    const create = runProjects([
      "create",
      "--name",
      "Managed App",
      "--path",
      targetPath,
      "--stage",
      "active",
      "--priority",
      "high",
      "--owner",
      "hasna",
      "--launch-profile",
      "dev",
      "--start-agent",
      "claude",
      "--start-command",
      "claude --resume",
      "--start-session-policy",
      "error-if-running",
      "--start-windows-json",
      "[{\"name\":\"notes\",\"command\":\"vim NOTES.md\"}]",
      "--todos-project-id",
      "todo_123",
      "--todos-task-list-id",
      "list_456",
      "--brief-id",
      "brief_123",
      "--brief-path",
      briefPath,
      "--json",
    ], env);
    expect(create.exitCode).toBe(0);
    const created = JSON.parse(text(create.stdout)) as {
      project?: {
        metadata: Record<string, unknown>;
        integrations: Record<string, string>;
      };
    };
    expect(created.project?.metadata.stage).toBe("active");
    expect(created.project?.metadata.priority).toBe("high");
    expect(created.project?.metadata.owner).toBe("hasna");
    expect(created.project?.metadata.launch_profile).toBe("dev");
    expect(created.project?.metadata.start_agent).toBe("claude");
    expect(created.project?.metadata.start_command).toBe("claude --resume");
    expect(created.project?.metadata.start_session_policy).toBe("error-if-running");
    expect(created.project?.metadata.start_windows).toEqual([{ name: "notes", command: "vim NOTES.md" }]);
    expect(created.project?.integrations.todos_project_id).toBe("todo_123");
    expect(created.project?.integrations.todos_task_list_id).toBe("list_456");
    expect(created.project?.integrations.brief_id).toBe("brief_123");
    expect(created.project?.integrations.brief_path).toBe(briefPath);

    const list = runProjects(["list", "--verbose"], env);
    expect(list.exitCode).toBe(0);
    const listText = text(list.stdout);
    expect(listText).toContain("managed-app");
    expect(listText).toContain("active");
    expect(listText).toContain("high");
    expect(listText).toContain("hasna");
    expect(listText).toContain("missing");
    expect(listText).toContain("todo_123");
    expect(listText).toContain("brief_123");

    const show = runProjects(["show", "managed-app", "--json"], env);
    expect(show.exitCode).toBe(0);
    const shown = JSON.parse(text(show.stdout)) as {
      management?: {
        stage: string | null;
        priority: string | null;
        owner: string | null;
        launch_profile: string | null;
        start_agent: string | null;
        start_command: string | null;
        start_session_policy: string | null;
        start_windows: Array<{ name: string; command?: string }>;
        todos_project_id: string | null;
        todos_task_list_id: string | null;
        brief_id: string | null;
        brief_path: string | null;
      };
      external_links?: {
        todos: { linked: boolean; status: string; project_id: string | null; task_list_id: string | null };
        brief: { linked: boolean; status: string; id: string | null; path: string | null; path_exists: boolean | null };
      };
      dashboard?: { path_health?: { status: string; path: string | null; exists: boolean | null }; launch?: { default_session_policy: string | null } };
      project?: { management?: { priority: string | null }; external_links?: unknown };
    };
    expect(shown.management?.stage).toBe("active");
    expect(shown.management?.priority).toBe("high");
    expect(shown.management?.owner).toBe("hasna");
    expect(shown.management?.launch_profile).toBe("dev");
    expect(shown.management?.start_agent).toBe("claude");
    expect(shown.management?.start_command).toBe("claude --resume");
    expect(shown.management?.start_session_policy).toBe("error-if-running");
    expect(shown.management?.start_windows).toEqual([{ name: "notes", command: "vim NOTES.md" }]);
    expect(shown.management?.todos_project_id).toBe("todo_123");
    expect(shown.management?.todos_task_list_id).toBe("list_456");
    expect(shown.management?.brief_id).toBe("brief_123");
    expect(shown.management?.brief_path).toBe(briefPath);
    expect(shown.external_links?.todos).toEqual({ linked: true, status: "linked", project_id: "todo_123", task_list_id: "list_456" });
    expect(shown.external_links?.brief).toEqual({ linked: true, status: "linked", id: "brief_123", path: briefPath, path_exists: true });
    expect(shown.dashboard?.path_health).toEqual({ status: "missing", path: targetPath, exists: false });
    expect(shown.dashboard?.launch?.default_session_policy).toBe("error-if-running");
    expect(shown.project?.management?.priority).toBe("high");
    expect(shown.project?.external_links).toEqual(shown.external_links);

    const humanShow = runProjects(["show", "managed-app"], env);
    expect(humanShow.exitCode).toBe(0);
    const humanShowText = text(humanShow.stdout);
    expect(humanShowText).toContain("path health: missing");
    expect(humanShowText).toContain("recent events:");

    const update = runProjects([
      "update",
      "managed-app",
      "--priority",
      "critical",
      "--clear-owner",
      "--clear-start-command",
      "--clear-start-session-policy",
      "--clear-start-windows",
      "--brief-path",
      briefPath,
      "--json",
    ], env);
    expect(update.exitCode).toBe(0);
    const updated = JSON.parse(text(update.stdout)) as {
      metadata: Record<string, unknown>;
      integrations: Record<string, string>;
    };
    expect(updated.metadata.priority).toBe("critical");
    expect(updated.metadata.owner).toBeUndefined();
    expect(updated.metadata.start_command).toBeUndefined();
    expect(updated.metadata.start_session_policy).toBeUndefined();
    expect(updated.metadata.start_windows).toBeUndefined();
    expect(updated.integrations.brief_path).toBe(briefPath);

    const tagged = runProjects(["tag", "managed-app", "security,cameras", "family", "--json"], env);
    expect(tagged.exitCode).toBe(0);
    expect((JSON.parse(text(tagged.stdout)) as { tags: string[] }).tags).toEqual(["security", "cameras", "family"]);

    const untagged = runProjects(["untag", "managed-app", "cameras", "--json"], env);
    expect(untagged.exitCode).toBe(0);
    expect((JSON.parse(text(untagged.stdout)) as { tags: string[] }).tags).toEqual(["security", "family"]);

    const linked = runProjects([
      "link",
      "managed-app",
      "--todos-task-list-id",
      "list_789",
      "--brief-id",
      "brief_456",
      "--json",
    ], env);
    expect(linked.exitCode).toBe(0);
    expect((JSON.parse(text(linked.stdout)) as { integrations: Record<string, string> }).integrations.todos_task_list_id).toBe("list_789");
    expect((JSON.parse(text(linked.stdout)) as { integrations: Record<string, string> }).integrations.brief_id).toBe("brief_456");

    const unlinked = runProjects(["unlink", "managed-app", "--todos", "--brief", "--json"], env);
    expect(unlinked.exitCode).toBe(0);
    const unlinkedPayload = JSON.parse(text(unlinked.stdout)) as {
      project: {
        integrations: Record<string, string | undefined>;
        external_links: {
          todos: { linked: boolean };
          brief: { linked: boolean };
        };
      };
      unlinked: string[];
    };
    expect(unlinkedPayload.unlinked).toEqual(["todos_project_id", "todos_task_list_id", "brief_id", "brief_path"]);
    expect(unlinkedPayload.project.integrations.todos_project_id).toBeUndefined();
    expect(unlinkedPayload.project.integrations.todos_task_list_id).toBeUndefined();
    expect(unlinkedPayload.project.integrations.brief_id).toBeUndefined();
    expect(unlinkedPayload.project.integrations.brief_path).toBeUndefined();
    expect(unlinkedPayload.project.external_links.todos.linked).toBe(false);
    expect(unlinkedPayload.project.external_links.brief.linked).toBe(false);
  });

  test("top-level events list and record expose project audit events", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-events-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const targetPath = join(root, "evented-app");

    expect(runProjects(["create", "--name", "Evented App", "--path", targetPath, "--json"], env).exitCode).toBe(0);

    const record = runProjects([
      "events",
      "record",
      "evented-app",
      "security_reviewed",
      "--metadata-json",
      "{\"area\":\"home-security\"}",
      "--json",
    ], env);
    expect(record.exitCode).toBe(0);
    const recorded = JSON.parse(text(record.stdout)) as {
      project?: { slug: string };
      event?: { event_type: string; metadata: Record<string, string> };
      workspace?: unknown;
    };
    expect(recorded.project?.slug).toBe("evented-app");
    expect(recorded.event?.event_type).toBe("security_reviewed");
    expect(recorded.event?.metadata.area).toBe("home-security");
    expect(recorded.workspace).toBeUndefined();

    const list = runProjects(["events", "list", "evented-app", "--json"], env);
    expect(list.exitCode).toBe(0);
    const listed = JSON.parse(text(list.stdout)) as {
      project?: { slug: string };
      events: Array<{ event_type: string }>;
      workspace?: unknown;
    };
    expect(listed.project?.slug).toBe("evented-app");
    expect(listed.events.map((event) => event.event_type)).toContain("security_reviewed");
    expect(listed.workspace).toBeUndefined();

    const compact = runProjects(["events", "list", "evented-app", "--limit", "1"], env);
    expect(compact.exitCode).toBe(0);
    const compactText = text(compact.stdout);
    expect(compactText).toContain("security_reviewed");
    expect(compactText).toContain("Showing latest 1 of ");
    expect(compactText).toContain("older hidden. Use --limit <n>, --verbose, or --json for details.");
  });

  test("project agents can be assigned and shown as project metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-agents-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    expect(runProjects([
      "create",
      "--name",
      "Agent Managed",
      "--slug",
      "agent-managed",
      "--path",
      join(root, "agent-managed"),
      "--json",
    ], env).exitCode).toBe(0);
    expect(runProjects([
      "agents",
      "add",
      "--name",
      "Security Owner",
      "--slug",
      "security-owner",
      "--kind",
      "human",
      "--json",
    ], env).exitCode).toBe(0);

    const assigned = runProjects([
      "agents",
      "assign",
      "agent-managed",
      "security-owner",
      "--role",
      "owner",
      "--metadata-json",
      "{\"scope\":\"security\"}",
      "--json",
    ], env);
    expect(assigned.exitCode).toBe(0);
    const assignment = JSON.parse(text(assigned.stdout)) as { role: string; agent?: { slug: string }; metadata: Record<string, string> };
    expect(assignment.role).toBe("owner");
    expect(assignment.agent?.slug).toBe("security-owner");
    expect(assignment.metadata.scope).toBe("security");

    const projectAgents = runProjects(["agents", "list", "--project", "agent-managed", "--json"], env);
    expect(projectAgents.exitCode).toBe(0);
    const assignments = JSON.parse(text(projectAgents.stdout)) as Array<{ role: string; agent?: { slug: string } }>;
    expect(assignments.some((item) => item.role === "owner" && item.agent?.slug === "security-owner")).toBe(true);

    const show = runProjects(["show", "agent-managed", "--json"], env);
    expect(show.exitCode).toBe(0);
    const shown = JSON.parse(text(show.stdout)) as {
      agents: Array<{ role: string; agent?: { slug: string } }>;
      events: Array<{ event_type: string; agent_id: string | null }>;
    };
    expect(shown.agents.some((item) => item.role === "owner" && item.agent?.slug === "security-owner")).toBe(true);
    expect(shown.events.some((event) => event.event_type === "agent_assigned")).toBe(true);
  });

  test("project locations can be registered and used as start targets", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-locations-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const primaryPath = join(root, "primary");
    const secondaryPath = join(root, "secondary");
    mkdirSync(secondaryPath);

    expect(runProjects([
      "create",
      "--name",
      "Located Project",
      "--slug",
      "located-project",
      "--path",
      primaryPath,
      "--mkdir",
      "--json",
    ], env).exitCode).toBe(0);
    expect(runProjects(["create", "--name", "Other Project", "--slug", "other-project", "--path", join(root, "other"), "--mkdir", "--json"], env).exitCode).toBe(0);

    const added = runProjects([
      "locations",
      "add",
      "located-project",
      secondaryPath,
      "--label",
      "docs",
      "--metadata-json",
      "{\"purpose\":\"docs\"}",
      "--json",
    ], env);
    expect(added.exitCode).toBe(0);
    const addPayload = JSON.parse(text(added.stdout)) as {
      project: { slug: string };
      location: { path: string; label: string; metadata: Record<string, string> };
    };
    expect(addPayload.project.slug).toBe("located-project");
    expect(addPayload.location.path).toBe(secondaryPath);
    expect(addPayload.location.label).toBe("docs");
    expect(addPayload.location.metadata.purpose).toBe("docs");

    const listed = runProjects(["locations", "list", "located-project", "--json"], env);
    expect(listed.exitCode).toBe(0);
    const listPayload = JSON.parse(text(listed.stdout)) as {
      locations: Array<{ path: string; label: string }>;
    };
    expect(listPayload.locations.map((location) => location.path).sort()).toEqual([primaryPath, secondaryPath].sort());

    const shownByPath = runProjects(["show", secondaryPath, "--json"], env);
    expect(shownByPath.exitCode).toBe(0);
    expect((JSON.parse(text(shownByPath.stdout)) as { project: { slug: string } }).project.slug).toBe("located-project");

    const updatedByName = runProjects(["update", "Located Project", "--priority", "medium", "--json"], env);
    expect(updatedByName.exitCode).toBe(0);
    expect((JSON.parse(text(updatedByName.stdout)) as { metadata: Record<string, string> }).metadata.priority).toBe("medium");

    const listedByPath = runProjects(["locations", "list", secondaryPath, "--json"], env);
    expect(listedByPath.exitCode).toBe(0);
    expect((JSON.parse(text(listedByPath.stdout)) as { project: { slug: string } }).project.slug).toBe("located-project");

    const started = runProjects(["start", secondaryPath, "--dry-run", "--json"], env);
    expect(started.exitCode).toBe(0);
    const startPayload = JSON.parse(text(started.stdout)) as {
      project: { slug: string };
      resolution: { source: string; registered: boolean };
    };
    expect(startPayload.project.slug).toBe("located-project");
    expect(startPayload.resolution.source).toBe("path");
    expect(startPayload.resolution.registered).toBe(true);
  });

  test("top-level start can plan unknown-folder registration with tags and metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-start-import-metadata-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const target = join(root, "family-security");
    mkdirSync(target);

    const started = runProjects([
      "start",
      target,
      "--dry-run",
      "--tags",
      "family,security",
      "--metadata-json",
      "{\"domain\":\"home-security\"}",
      "--json",
    ], env);

    expect(started.exitCode).toBe(0);
    const payload = JSON.parse(text(started.stdout)) as {
      project: { id: string; tags: string[]; metadata: Record<string, unknown> };
      resolution: { source: string; registered: boolean; preview?: { tags: string[]; metadata: Record<string, unknown> } };
    };
    expect(payload.project.id).toBe("planned");
    expect(payload.project.tags).toEqual(["family", "security"]);
    expect(payload.project.metadata.domain).toBe("home-security");
    expect(payload.resolution.source).toBe("planned-import");
    expect(payload.resolution.registered).toBe(false);
    expect(payload.resolution.preview?.tags).toEqual(["family", "security"]);
    expect(payload.resolution.preview?.metadata.domain).toBe("home-security");
  });

  test("top-level start supports bulk dry-run JSON summaries", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-bulk-start-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const onePath = join(root, "bulk-one");
    const twoPath = join(root, "bulk-two");

    expect(runProjects(["create", "--name", "Bulk One", "--path", onePath, "--json"], env).exitCode).toBe(0);
    expect(runProjects(["create", "--name", "Bulk Two", "--path", twoPath, "--json"], env).exitCode).toBe(0);

    const started = runProjects([
      "start",
      "--bulk",
      "--dry-run",
      "--json",
      "--agent",
      "claude",
      "bulk-one",
      "bulk-two",
    ], env);

    expect(started.exitCode).toBe(0);
    const payload = JSON.parse(text(started.stdout)) as {
      bulk: true;
      total: number;
      started: Array<{
        project?: { slug: string };
        workspace?: unknown;
        agent_tool: string;
        tool_command: string;
        tmux: { dry_run: boolean; session_action: string };
      }>;
      failed: unknown[];
      summary: {
        succeeded: number;
        failed: number;
        planned_sessions: number;
      };
    };

    expect(payload.bulk).toBe(true);
    expect(payload.total).toBe(2);
    expect(payload.failed).toEqual([]);
    expect(payload.summary.succeeded).toBe(2);
    expect(payload.summary.failed).toBe(0);
    expect(payload.summary.planned_sessions).toBe(2);
    expect(payload.started.map((item) => item.project?.slug).sort()).toEqual(["bulk-one", "bulk-two"]);
    expect(payload.started.every((item) => item.workspace === undefined)).toBe(true);
    expect(payload.started.every((item) => item.agent_tool === "claude")).toBe(true);
    expect(payload.started.every((item) => item.tool_command.startsWith("claude --name "))).toBe(true);
    expect(payload.started.every((item) => item.tmux.dry_run)).toBe(true);
    expect(payload.started.every((item) => item.tmux.session_action === "planned")).toBe(true);
  });

  test("top-level start reads bulk targets from JSON files", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-bulk-file-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const targetFile = join(root, "targets.json");

    expect(runProjects(["create", "--name", "File One", "--path", join(root, "file-one"), "--json"], env).exitCode).toBe(0);
    expect(runProjects(["create", "--name", "File Two", "--path", join(root, "file-two"), "--json"], env).exitCode).toBe(0);
    writeFileSync(targetFile, JSON.stringify(["file-one", "file-two"]), "utf-8");

    const started = runProjects(["start", "--bulk-file", targetFile, "--dry-run", "--json"], env);
    expect(started.exitCode).toBe(0);
    const payload = JSON.parse(text(started.stdout)) as {
      bulk: true;
      total: number;
      started: Array<{ project?: { slug: string } }>;
      summary: { succeeded: number; planned_sessions: number };
    };

    expect(payload.bulk).toBe(true);
    expect(payload.total).toBe(2);
    expect(payload.summary.succeeded).toBe(2);
    expect(payload.summary.planned_sessions).toBe(2);
    expect(payload.started.map((item) => item.project?.slug).sort()).toEqual(["file-one", "file-two"]);
  });

  test("top-level start applies saved tmux profiles", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-start-profile-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    expect(runProjects(["create", "--name", "Profile App", "--path", join(root, "profile-app"), "--json"], env).exitCode).toBe(0);
    const profile = runProjects([
      "tmux-profiles",
      "add",
      "--name",
      "Dev",
      "--slug",
      "dev",
      "--session-template",
      "{slug}-dev",
      "--windows-json",
      "[{\"name\":\"server\",\"path_template\":\"{path}\",\"command\":\"bun run dev\"}]",
      "--json",
    ], env);
    expect(profile.exitCode).toBe(0);

    const started = runProjects([
      "start",
      "profile-app",
      "--profile",
      "dev",
      "--agent",
      "claude",
      "--dry-run",
      "--json",
    ], env);

    expect(started.exitCode).toBe(0);
    const payload = JSON.parse(text(started.stdout)) as {
      project?: { slug: string };
      schema_version?: number;
      kind?: string;
      render?: unknown;
      rename_report?: Array<{ status: string }>;
      tmux_profile?: { slug: string };
      tmux: {
        session_name: string;
        windows: Array<{ target: string; metadata?: { command?: string } }>;
      };
    };
    expect(payload.project?.slug).toBe("profile-app");
    expect(payload.tmux_profile?.slug).toBe("dev");
    expect(payload.tmux.session_name).toBe("profile-app-dev");
    expect(payload.tmux.windows.map((window) => window.target)).toEqual([
      "profile-app-dev:01",
      "profile-app-dev:02",
      "profile-app-dev:server",
    ]);
    expect(payload.tmux.windows[0]?.metadata?.command).toBe("claude --name 'Profile App'");
    expect(payload.tmux.windows[2]?.metadata?.command).toBe("bun run dev");
    expect(payload.schema_version).toBe(1);
    expect(payload.kind).toBe("projects.start");
    expect(payload.render).toBeTruthy();
    expect(payload.rename_report?.[0]?.status).toBe("configured");
  });

  test("top-level start and status use saved project launch defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-start-defaults-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    expect(runProjects([
      "tmux-profiles",
      "add",
      "--name",
      "Dev",
      "--slug",
      "dev",
      "--session-template",
      "{slug}-dev",
      "--windows-json",
      "[{\"name\":\"server\",\"command\":\"bun run dev\"}]",
      "--json",
    ], env).exitCode).toBe(0);

    expect(runProjects([
      "create",
      "--name",
      "Default Launch",
      "--slug",
      "default-launch",
      "--path",
      join(root, "default-launch"),
      "--launch-profile",
      "dev",
      "--start-agent",
      "claude",
      "--start-command",
      "claude --resume",
      "--start-session-policy",
      "error-if-running",
      "--start-windows-json",
      "[{\"name\":\"notes\",\"command\":\"vim NOTES.md\"}]",
      "--json",
    ], env).exitCode).toBe(0);

    const started = runProjects(["start", "default-launch", "--dry-run", "--json"], env);
    expect(started.exitCode).toBe(0);
    const startPayload = JSON.parse(text(started.stdout)) as {
      agent_tool: string;
      tool_command: string;
      session_policy: string;
      tmux_profile?: { slug: string };
      launch_defaults: {
        used_agent_tool: boolean;
        used_tool_command: boolean;
        used_tmux_profile: boolean;
        used_session_policy: boolean;
        session_policy: string | null;
        used_windows: boolean;
      };
      tmux: {
        session_name: string;
        windows: Array<{ target: string; metadata?: { command?: string } }>;
      };
    };
    expect(startPayload.agent_tool).toBe("claude");
    expect(startPayload.tool_command).toBe("claude --name 'Default Launch' --resume");
    expect(startPayload.session_policy).toBe("error-if-running");
    expect(startPayload.tmux_profile?.slug).toBe("dev");
    expect(startPayload.launch_defaults.used_agent_tool).toBe(true);
    expect(startPayload.launch_defaults.used_tool_command).toBe(true);
    expect(startPayload.launch_defaults.used_tmux_profile).toBe(true);
    expect(startPayload.launch_defaults.used_session_policy).toBe(true);
    expect(startPayload.launch_defaults.session_policy).toBe("error-if-running");
    expect(startPayload.launch_defaults.used_windows).toBe(true);
    expect(startPayload.tmux.session_name).toBe("default-launch-dev");
    expect(startPayload.tmux.windows.map((window) => window.target)).toEqual([
      "default-launch-dev:01",
      "default-launch-dev:02",
      "default-launch-dev:server",
      "default-launch-dev:notes",
    ]);
    expect(startPayload.tmux.windows[0]?.metadata?.command).toBe("claude --name 'Default Launch' --resume");

    const status = runProjects(["status", "default-launch", "--json"], env);
    expect(status.exitCode).toBe(0);
    const statusPayload = JSON.parse(text(status.stdout)) as {
      expected: { session_name: string; profile?: { slug: string }; windows: Array<{ name: string; command?: string }> };
      launch_defaults: { used_agent_tool: boolean; used_tmux_profile: boolean; used_session_policy: boolean; session_policy: string | null };
    };
    expect(statusPayload.expected.session_name).toBe("default-launch-dev");
    expect(statusPayload.expected.profile?.slug).toBe("dev");
    expect(statusPayload.expected.windows.map((window) => window.name)).toEqual(["01", "02", "server", "notes"]);
    expect(statusPayload.expected.windows[0]?.command).toBe("claude --name 'Default Launch' --resume");
    expect(statusPayload.launch_defaults.used_agent_tool).toBe(true);
    expect(statusPayload.launch_defaults.used_tmux_profile).toBe(true);
    expect(statusPayload.launch_defaults.used_session_policy).toBe(true);
    expect(statusPayload.launch_defaults.session_policy).toBe("error-if-running");
  });

  test("top-level start accepts exact requested tmux windows as JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-start-windows-json-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    expect(runProjects([
      "tmux-profiles",
      "add",
      "--name",
      "Dev",
      "--slug",
      "dev",
      "--session-template",
      "{slug}-dev",
      "--windows-json",
      "[{\"name\":\"server\",\"command\":\"bun run dev\"}]",
      "--json",
    ], env).exitCode).toBe(0);

    expect(runProjects([
      "create",
      "--name",
      "Requested Windows",
      "--slug",
      "requested-windows",
      "--path",
      join(root, "requested-windows"),
      "--launch-profile",
      "dev",
      "--start-agent",
      "claude",
      "--start-windows-json",
      "[{\"name\":\"notes\",\"command\":\"vim NOTES.md\"}]",
      "--json",
    ], env).exitCode).toBe(0);

    const started = runProjects([
      "start",
      "requested-windows",
      "--windows-json",
      "[{\"name\":\"editor\",\"command\":\"code .\"},{\"name\":\"logs\",\"command\":\"tail -f app.log\"}]",
      "--dry-run",
      "--json",
    ], env);

    expect(started.exitCode).toBe(0);
    const payload = JSON.parse(text(started.stdout)) as {
      launch_defaults: { used_windows: boolean };
      tmux: {
        session_name: string;
        windows: Array<{ target: string; metadata?: { command?: string } }>;
      };
    };
    expect(payload.tmux.session_name).toBe("requested-windows-dev");
    expect(payload.launch_defaults.used_windows).toBe(false);
    expect((payload as { rename_report?: Array<{ status: string }> }).rename_report?.[0]?.status).toBe("skipped");
    expect(payload.tmux.windows.map((window) => window.target)).toEqual([
      "requested-windows-dev:editor",
      "requested-windows-dev:logs",
    ]);
    expect(payload.tmux.windows.map((window) => window.metadata?.command)).toEqual([
      "code .",
      "tail -f app.log",
    ]);
  });

  test("top-level status reports expected project tmux session", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-status-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    expect(runProjects(["create", "--name", "Status App", "--path", join(root, "status-app"), "--json"], env).exitCode).toBe(0);
    expect(runProjects([
      "tmux-profiles",
      "add",
      "--name",
      "Dev",
      "--slug",
      "dev",
      "--session-template",
      "{slug}-dev",
      "--windows-json",
      "[{\"name\":\"server\",\"command\":\"bun run dev\"}]",
      "--json",
    ], env).exitCode).toBe(0);

    const status = runProjects(["status", "status-app", "--profile", "dev", "--json"], env);

    expect(status.exitCode).toBe(0);
    const payload = JSON.parse(text(status.stdout)) as {
      project: { slug: string };
      expected: {
        session_name: string;
        profile?: { slug: string };
        windows: Array<{ name: string; command?: string }>;
      };
      exists: boolean;
      windows: unknown[];
    };
    expect(payload.project.slug).toBe("status-app");
    expect(payload.expected.session_name).toBe("status-app-dev");
    expect(payload.expected.profile?.slug).toBe("dev");
    expect(payload.expected.windows.map((window) => window.name)).toEqual(["01", "02", "server"]);
    expect(typeof payload.exists).toBe("boolean");
    expect(Array.isArray(payload.windows)).toBe(true);
  });

  test("top-level start auto-detects the current registered project path", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-start-cwd-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const projectPath = join(root, "cwd-app");
    mkdirSync(projectPath);

    expect(runProjects(["create", "--name", "Cwd App", "--path", projectPath, "--json"], env).exitCode).toBe(0);

    const started = runProjects(["start", "--dry-run", "--json"], env, projectPath);

    expect(started.exitCode).toBe(0);
    const payload = JSON.parse(text(started.stdout)) as {
      project: { slug: string };
      resolution: { source: string; registered: boolean };
      tmux: { windows: Array<{ target: string }> };
    };
    expect(payload.project.slug).toBe("cwd-app");
    expect(payload.resolution.source).toBe("path");
    expect(payload.resolution.registered).toBe(true);
    expect(payload.tmux.windows.map((window) => window.target)).toEqual(["cwd-app:01", "cwd-app:02"]);
  });

  test("top-level sessions reports an empty rename surface without tmux", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-sessions-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    expect(runProjects(["create", "--name", "Session App", "--path", join(root, "session-app"), "--json"], env).exitCode).toBe(0);

    const sessions = runProjects(["sessions", "session-app", "--json"], env);

    expect(sessions.exitCode).toBe(0);
    const payload = JSON.parse(text(sessions.stdout)) as {
      schema_version: number;
      kind: string;
      total: number;
      sessions: unknown[];
      render?: unknown;
    };
    expect(payload.schema_version).toBe(1);
    expect(payload.kind).toBe("projects.sessions");
    expect(payload.total).toBe(0);
    expect(payload.sessions).toEqual([]);
    expect(payload.render).toBeTruthy();
  });

  test("top-level start rejects attach for bulk starts", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-bulk-guard-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    const result = runProjects(["start", "--bulk", "--attach", "one", "two"], env);

    expect(result.exitCode).toBe(1);
    expect(text(result.stderr)).toContain("--attach is only supported for a single project start");
  });
  test("bulk start render-spec reports failure exit status", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-bulk-render-fail-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    const started = runProjects(["start", "--bulk", "missing-one", "missing-two", "--dry-run", "--render-spec"], env);
    expect(started.exitCode).toBe(1);
    const payload = JSON.parse(text(started.stdout)) as {
      root?: string;
      elements?: Record<string, { type?: string; props?: { title?: string; rows?: Array<Record<string, unknown>> } }>;
      metadata?: { kind?: string };
    };
    expect(payload.root).toBe("root");
    expect(payload.metadata?.kind).toBe("projects.start_bulk");
    const tables = Object.values(payload.elements ?? {}).filter((element) => element.type === "Table");
    const summary = tables.find((element) => element.props?.title === "summary")?.props?.rows?.[0] as { failed?: number } | undefined;
    const failures = tables.find((element) => element.props?.title === "failures")?.props?.rows ?? [];
    expect(summary?.failed).toBe(2);
    expect(failures).toHaveLength(2);
    expect(failures.map((failure) => failure.target).sort()).toEqual(["missing-one", "missing-two"]);
    rmSync(root, { recursive: true, force: true });
  });


  test("required commands emit JSON Render specs with --render-spec", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-render-spec-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    expect(runProjects(["roots", "add", "--name", "Render Root", "--slug", "render-root", "--path", join(root, "root"), "--kind", "project", "--github-org", "hasnaxyz", "--path-template", "{slug}", "--json"], env).exitCode).toBe(0);
    expect(runProjects(["recipes", "seed-defaults", "--json"], env).exitCode).toBe(0);
    expect(runProjects(["create", "--name", "Render Spec App", "--path", join(root, "root", "render-spec-app"), "--json"], env).exitCode).toBe(0);

    const commands = [
      ["list", "--render-spec"],
      ["show", "render-spec-app", "--render-spec"],
      ["status", "render-spec-app", "--render-spec"],
      ["start", "render-spec-app", "--dry-run", "--render-spec"],
      ["sessions", "render-spec-app", "--render-spec"],
      ["roots", "list", "--render-spec"],
      ["recipes", "list", "--render-spec"],
    ];
    for (const command of commands) {
      const result = runProjects(command, env);
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(text(result.stdout)) as { root?: string; elements?: Record<string, unknown>; metadata?: { kind?: string } };
      expect(payload.root).toBe("root");
      expect(payload.elements?.root).toBeTruthy();
      expect(payload.metadata?.kind).toStartWith("projects.");
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("sync-roots CLI mutates by default and scan-roots stays dry-run on empty GitHub roots", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-sync-roots-empty-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const scan = runProjects(["scan-roots", "--json"], env);
    expect(scan.exitCode).toBe(0);
    expect((JSON.parse(text(scan.stdout)) as { dry_run: boolean }).dry_run).toBe(true);

    const sync = runProjects(["sync-roots", "--json"], env);
    expect(sync.exitCode).toBe(0);
    expect((JSON.parse(text(sync.stdout)) as { dry_run: boolean }).dry_run).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("sync-roots exits nonzero on partial failures unless explicitly allowed", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-cli-sync-roots-partial-"));
    const dbPath = join(root, "projects.db");
    const rootPath = join(root, "github-root");
    const fakeBin = join(root, "bin");
    mkdirSync(rootPath);
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "gh"), "#!/usr/bin/env bash\nif [[ \"$1 $2 $3\" == \"repo list hasnaxyz\" ]]; then echo project-locked; exit 0; fi\nexit 1\n");
    chmodSync(join(fakeBin, "gh"), 0o755);

    const db = new Database(dbPath);
    db.run("PRAGMA foreign_keys=ON");
    runMigrations(db);
    createRoot({
      name: "GitHub Root",
      slug: "github-root",
      base_path: rootPath,
      default_kind: "project",
      github_org: "hasnaxyz",
      path_template: "{slug}",
    }, db);
    acquireWorkspaceLock({
      lock_key: "workspace-slug:project-locked",
      reason: "test partial failure",
      ttl_seconds: 600,
    }, db);
    db.close();

    const env = {
      HASNA_PROJECTS_DB_PATH: dbPath,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };
    const failed = runProjects(["sync-roots", "--root", "github-root", "--repo-prefix", "project-", "--no-clone", "--json"], env);
    expect(failed.exitCode).toBe(1);
    expect((JSON.parse(text(failed.stdout)) as { errors: unknown[] }).errors).toHaveLength(1);

    const allowed = runProjects(["sync-roots", "--root", "github-root", "--repo-prefix", "project-", "--no-clone", "--allow-partial", "--json"], env);
    expect(allowed.exitCode).toBe(0);
    expect((JSON.parse(text(allowed.stdout)) as { errors: unknown[] }).errors).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

});
