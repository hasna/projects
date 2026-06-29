import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectSnapshotSchema, SCHEMA_IDS } from "@hasna/contracts/schemas";
import { createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import {
  DEFAULT_PROJECT_DASHBOARD_PROVIDERS,
  buildProjectDashboardRender,
  buildProjectDashboardSnapshot,
  resolveDashboardImports,
  type ProjectDashboardProvider,
} from "./project-dashboard.js";
import { validateProjectsRenderSpec } from "./project-render.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

const provider: ProjectDashboardProvider = {
  id: "todos",
  kind: "todos",
  panelKind: "tasks",
  title: "Tasks",
  command: "todos",
  args: ["project-panel", "--project", "{project}", "--json", "--contract"],
};

describe("project dashboard", () => {
  test("uses the published Mailery project-panel provider command", () => {
    const mailery = DEFAULT_PROJECT_DASHBOARD_PROVIDERS.find((item) => item.id === "mailery");

    expect(mailery?.command).toBe("mailery");
    expect(mailery?.args).toEqual(["project-panel", "--project", "{project}", "--limit", "20", "--json", "--contract"]);
  });

  test("builds a contract-valid snapshot from provider panels", async () => {
    const db = makeDb();
    createWorkspace({
      id: "wks_dashboard",
      name: "Dashboard Project",
      slug: "dashboard-project",
      kind: "project",
      primary_path: "/tmp/dashboard-project",
    }, db);
    const snapshot = await buildProjectDashboardSnapshot("dashboard-project", {
      providers: [provider],
      generatedAt: "2026-06-29T00:00:00.000Z",
      cwd: "/tmp/dashboard-project",
      db,
      runner: async () => ({
        ok: true,
        stdout: JSON.stringify({
          schema: SCHEMA_IDS.projectPanel,
          id: "todos:dashboard-project",
          createdAt: "2026-06-29T00:00:00.000Z",
          projectId: "dashboard-project",
          provider: { kind: "todos", id: "todos" },
          kind: "tasks",
          title: "Tasks",
          state: "ready",
          generatedAt: "2026-06-29T00:00:00.000Z",
          metrics: [{ id: "open", label: "Open", value: 2 }],
          items: [{ id: "task-1", title: "Build dashboard" }],
        }),
        stderr: "",
        exitCode: 0,
      }),
    });

    expect(ProjectSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.panels.map((panel) => panel.kind)).toEqual(expect.arrayContaining(["overview", "tasks", "actions"]));
    expect(snapshot.panels.find((panel) => panel.kind === "tasks")?.state).toBe("ready");
    db.close();
  });

  test("does not label dashboard writes as read-only actions", async () => {
    const db = makeDb();
    createWorkspace({
      id: "wks_action_dashboard",
      name: "Action Dashboard",
      slug: "action-dashboard",
      kind: "project",
      primary_path: "/tmp/action-dashboard",
    }, db);

    const snapshot = await buildProjectDashboardSnapshot("action-dashboard", {
      providers: [],
      generatedAt: "2026-06-29T00:00:00.000Z",
      db,
    });
    const actions = snapshot.panels.find((panel) => panel.kind === "actions");
    const refreshItem = actions?.items.find((item) => item.id === "refresh-snapshot");
    const refreshAction = actions?.actions.find((action) => action.id === "projects.dashboard.snapshot");

    expect(refreshItem?.summary).toContain("--write");
    expect(refreshItem?.status).toBe("write/server-issued");
    expect(refreshItem?.resourceRefs[0]?.tags).toEqual(expect.arrayContaining(["write", "server-issued"]));
    expect(refreshItem?.resourceRefs[0]?.tags).not.toContain("read-only");
    expect(refreshAction?.tags).toEqual(expect.arrayContaining(["write", "server-issued"]));
    expect(refreshAction?.tags).not.toContain("read-only");
    db.close();
  });

  test("snapshot collection is read-only unless initialization is requested", async () => {
    const db = makeDb();
    const root = mkdtempSync(join(tmpdir(), "projects-dashboard-readonly-"));
    const projectPath = join(root, "readonly-project");
    createWorkspace({
      id: "wks_readonly_dashboard",
      name: "Readonly Dashboard",
      slug: "readonly-dashboard",
      kind: "project",
      primary_path: projectPath,
    }, db);

    try {
      await buildProjectDashboardSnapshot("readonly-dashboard", {
        providers: [],
        generatedAt: "2026-06-29T00:00:00.000Z",
        db,
      });
      expect(existsSync(join(projectPath, ".hasna/project"))).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renders a React Flow Canvas spec from a snapshot", async () => {
    const db = makeDb();
    const project = createWorkspace({
      name: "Render Dashboard",
      slug: "render-dashboard",
      kind: "project",
      primary_path: "/tmp/render-dashboard",
    }, db);
    const snapshot = ProjectSnapshotSchema.parse({
      schema: SCHEMA_IDS.projectSnapshot,
      id: "snapshot",
      createdAt: "2026-06-29T00:00:00.000Z",
      projectId: "render-dashboard",
      generatedAt: "2026-06-29T00:00:00.000Z",
      status: "succeeded",
      manifestRef: { kind: "project", id: "render-dashboard", uri: "project://render-dashboard", tags: [] },
      panels: [{
        schema: SCHEMA_IDS.projectPanel,
        id: "overview:render-dashboard",
        createdAt: "2026-06-29T00:00:00.000Z",
        projectId: "render-dashboard",
        provider: { kind: "render", id: "open-projects" },
        kind: "overview",
        title: "Overview",
        state: "ready",
        generatedAt: "2026-06-29T00:00:00.000Z",
        metrics: [{ id: "status", label: "Status", value: "active" }],
      }],
    });
    const spec = buildProjectDashboardRender(project, snapshot);
    const validated = validateProjectsRenderSpec(spec);
    expect(validated.elements.root?.type).toBe("Canvas");
    expect((validated.elements.root?.props.nodes as unknown[]).length).toBeGreaterThan(1);
    db.close();
  });

  test("rejects dashboard imports that escape the render directory", () => {
    expect(() => resolveDashboardImports("/tmp/project/.hasna/project/dashboard", [{ id: "bad", path: "../secret.json" }]))
      .toThrow("escapes render directory");
  });
});
