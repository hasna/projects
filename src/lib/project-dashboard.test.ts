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
import {
  projectsJsonRenderCatalog,
  validateProjectsRenderSpec,
} from "./project-render.js";

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
    const mailery = DEFAULT_PROJECT_DASHBOARD_PROVIDERS.find(
      (item) => item.id === "mailery",
    );

    expect(mailery?.command).toBe("mailery");
    expect(mailery?.args).toEqual([
      "project-panel",
      "--project",
      "{project}",
      "--limit",
      "20",
      "--json",
      "--contract",
    ]);
  });

  test("omits workspace-wide Mailery data until project email mapping exists", async () => {
    const db = makeDb();
    createWorkspace(
      {
        id: "wks_mailery",
        name: "Mailery Privacy",
        slug: "mailery-privacy",
        kind: "project",
        primary_path: "/tmp/mailery-privacy",
      },
      db,
    );
    const mailery = DEFAULT_PROJECT_DASHBOARD_PROVIDERS.find(
      (item) => item.id === "mailery",
    )!;
    let invoked = false;
    const snapshot = await buildProjectDashboardSnapshot("mailery-privacy", {
      providers: [mailery],
      generatedAt: "2026-06-29T00:00:00.000Z",
      cwd: "/tmp/mailery-privacy",
      db,
      runner: async () => {
        invoked = true;
        return {
          ok: true,
          stdout: "{}",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const panel = snapshot.panels.find((item) => item.kind === "mailery");
    expect(invoked).toBe(false);
    expect(panel).toMatchObject({
      state: "empty",
      summary:
        "Project-email mapping is not configured, so workspace-wide Mailery metadata is intentionally omitted.",
      items: [],
    });
    expect(JSON.stringify(panel)).not.toContain("from_address");
    expect(JSON.stringify(panel)).not.toContain("subject");
    expect(JSON.stringify(panel)).not.toContain("message_id");
    db.close();
  });

  test("uses the custom datasets project-panel provider command", () => {
    const datasets = DEFAULT_PROJECT_DASHBOARD_PROVIDERS.find(
      (item) => item.id === "datasets",
    );

    expect(datasets?.command).toBe("datasets");
    expect(datasets?.kind).toBe("custom");
    expect(datasets?.panelKind).toBe("custom");
    expect(datasets?.args).toEqual([
      "project-panel",
      "--project",
      "{project}",
      "--json",
      "--contract",
    ]);
    expect(datasets?.warning).toContain("@hasna/datasets");
  });

  test("builds a contract-valid snapshot from provider panels", async () => {
    const db = makeDb();
    createWorkspace(
      {
        id: "wks_dashboard",
        name: "Dashboard Project",
        slug: "dashboard-project",
        kind: "project",
        primary_path: "/tmp/dashboard-project",
      },
      db,
    );
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
    expect(snapshot.panels.map((panel) => panel.kind)).toEqual(
      expect.arrayContaining(["overview", "tasks", "actions"]),
    );
    expect(snapshot.panels.find((panel) => panel.kind === "tasks")?.state).toBe(
      "ready",
    );
    db.close();
  });

  test("collects the custom datasets provider panel", async () => {
    const db = makeDb();
    createWorkspace(
      {
        id: "wks_datasets_dashboard",
        name: "Datasets Dashboard",
        slug: "datasets-dashboard",
        kind: "project",
        primary_path: "/tmp/datasets-dashboard",
      },
      db,
    );
    const datasetsProvider = DEFAULT_PROJECT_DASHBOARD_PROVIDERS.find(
      (item) => item.id === "datasets",
    )!;

    const snapshot = await buildProjectDashboardSnapshot("datasets-dashboard", {
      providers: [datasetsProvider],
      generatedAt: "2026-06-29T00:00:00.000Z",
      cwd: "/tmp/datasets-dashboard",
      db,
      runner: async ({ command, args }) => {
        expect(command).toBe("datasets");
        expect(args).toEqual([
          "project-panel",
          "--project",
          "datasets-dashboard",
          "--json",
          "--contract",
        ]);
        return {
          ok: true,
          stdout: JSON.stringify({
            schema: SCHEMA_IDS.projectPanel,
            id: "datasets_panel_datasets-dashboard",
            createdAt: "2026-06-29T00:00:00.000Z",
            projectId: "datasets-dashboard",
            provider: {
              kind: "custom",
              id: "datasets_datasets-dashboard",
              name: "Datasets",
              sourcePackage: "@hasna/datasets",
            },
            kind: "custom",
            title: "Datasets",
            state: "ready",
            summary: "1 dataset with 2 rows.",
            generatedAt: "2026-06-29T00:00:00.000Z",
            metrics: [{ id: "datasets", label: "Datasets", value: 1 }],
            items: [{ id: "dset_1", title: "Bank shortlist" }],
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(ProjectSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("@hasna/datasets")]),
    );
    expect(
      snapshot.panels.find(
        (panel) => panel.id === "datasets_panel_datasets-dashboard",
      )?.provider.sourcePackage,
    ).toBe("@hasna/datasets");
    db.close();
  });

  test("does not label dashboard writes as read-only actions", async () => {
    const db = makeDb();
    createWorkspace(
      {
        id: "wks_action_dashboard",
        name: "Action Dashboard",
        slug: "action-dashboard",
        kind: "project",
        primary_path: "/tmp/action-dashboard",
      },
      db,
    );

    const snapshot = await buildProjectDashboardSnapshot("action-dashboard", {
      providers: [],
      generatedAt: "2026-06-29T00:00:00.000Z",
      db,
    });
    const actions = snapshot.panels.find((panel) => panel.kind === "actions");
    const refreshItem = actions?.items.find(
      (item) => item.id === "refresh-snapshot",
    );
    const refreshAction = actions?.actions.find(
      (action) => action.id === "projects.dashboard.snapshot",
    );

    expect(refreshItem?.summary).toContain("--write");
    expect(refreshItem?.status).toBe("write/server-issued");
    expect(refreshItem?.resourceRefs[0]?.tags).toEqual(
      expect.arrayContaining(["write", "server-issued"]),
    );
    expect(refreshItem?.resourceRefs[0]?.tags).not.toContain("read-only");
    expect(refreshAction?.tags).toEqual(
      expect.arrayContaining(["write", "server-issued"]),
    );
    expect(refreshAction?.tags).not.toContain("read-only");
    db.close();
  });

  test("snapshot collection is read-only unless initialization is requested", async () => {
    const db = makeDb();
    const root = mkdtempSync(join(tmpdir(), "projects-dashboard-readonly-"));
    const projectPath = join(root, "readonly-project");
    createWorkspace(
      {
        id: "wks_readonly_dashboard",
        name: "Readonly Dashboard",
        slug: "readonly-dashboard",
        kind: "project",
        primary_path: projectPath,
      },
      db,
    );

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
    const project = createWorkspace(
      {
        name: "Render Dashboard",
        slug: "render-dashboard",
        kind: "project",
        primary_path: "/tmp/render-dashboard",
      },
      db,
    );
    const snapshot = ProjectSnapshotSchema.parse({
      schema: SCHEMA_IDS.projectSnapshot,
      id: "snapshot",
      createdAt: "2026-06-29T00:00:00.000Z",
      projectId: "render-dashboard",
      generatedAt: "2026-06-29T00:00:00.000Z",
      status: "succeeded",
      manifestRef: {
        kind: "project",
        id: "render-dashboard",
        uri: "project://render-dashboard",
        tags: [],
      },
      panels: [
        {
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
        },
      ],
    });
    const spec = buildProjectDashboardRender(project, snapshot);
    const validated = validateProjectsRenderSpec(spec);
    expect(validated.elements.root?.type).toBe("Canvas");
    const nodes = validated.elements.root?.props.nodes as Array<{
      id: string;
      data?: { component?: string; size?: string };
    }>;
    const projectCanvasCard = projectsJsonRenderCatalog.data.components
      .ProjectCanvasCard.props as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.find((node) => node.id === "overview")?.data).toMatchObject({
      id: "overview",
      component: "ProjectCanvasCard",
      size: "XL",
    });
    expect(
      nodes.find((node) => node.id === "overview:render-dashboard")?.data,
    ).toMatchObject({ component: "ProjectCanvasCard", size: "XL" });
    for (const node of nodes) {
      expect(projectCanvasCard.safeParse(node.data).success).toBe(true);
    }
    expect(validated.elements.source_panel?.type).toBe("SourcePanel");
    expect(validated.elements.file_preview_dialog?.type).toBe(
      "FilePreviewDialog",
    );
    db.close();
  });

  test("lays out generated dashboard cards without overlap", async () => {
    const db = makeDb();
    const project = createWorkspace(
      {
        name: "Large Dashboard",
        slug: "large-dashboard",
        kind: "project",
        primary_path: "/tmp/large-dashboard",
      },
      db,
    );
    const panelKinds = [
      "overview",
      "tasks",
      "files",
      "mailery",
      "conversations",
      "knowledge",
      "mementos",
      "reports",
      "custom",
      "actions",
    ] as const;
    const snapshot = ProjectSnapshotSchema.parse({
      schema: SCHEMA_IDS.projectSnapshot,
      id: "snapshot",
      createdAt: "2026-06-29T00:00:00.000Z",
      projectId: "large-dashboard",
      generatedAt: "2026-06-29T00:00:00.000Z",
      status: "succeeded",
      manifestRef: {
        kind: "project",
        id: "large-dashboard",
        uri: "project://large-dashboard",
        tags: [],
      },
      panels: panelKinds.map((kind, index) => ({
        schema: SCHEMA_IDS.projectPanel,
        id: `panel-${index}`,
        createdAt: "2026-06-29T00:00:00.000Z",
        projectId: "large-dashboard",
        provider: {
          kind:
            kind === "overview"
              ? "render"
              : kind === "tasks"
                ? "todos"
                : kind === "custom"
                  ? "custom"
                  : kind,
          id: `provider-${index}`,
        },
        kind,
        title: `Panel ${index}`,
        state: "ready",
        generatedAt: "2026-06-29T00:00:00.000Z",
        metrics: [{ id: "status", label: "Status", value: "ready" }],
        items: [{ id: `item-${index}`, title: "Item" }],
      })),
    });

    const spec = validateProjectsRenderSpec(
      buildProjectDashboardRender(project, snapshot),
    );
    const nodes = spec.elements.root?.props.nodes as Array<{
      id: string;
      position: { x: number; y: number };
      data?: { size?: "M" | "XL" | "XXL" | "4XL" };
    }>;

    expect(findOverlappingNodePair(nodes)).toBeNull();
    db.close();
  });

  test("rejects dashboard imports that escape the render directory", () => {
    expect(() =>
      resolveDashboardImports("/tmp/project/.hasna/project/dashboard", [
        { id: "bad", path: "../secret.json" },
      ]),
    ).toThrow("escapes render directory");
  });
});

function findOverlappingNodePair(
  nodes: Array<{
    id: string;
    position: { x: number; y: number };
    data?: { size?: "M" | "XL" | "XXL" | "4XL" };
  }>,
): string | null {
  for (let a = 0; a < nodes.length; a += 1) {
    for (let b = a + 1; b < nodes.length; b += 1) {
      if (boxesOverlap(nodeBox(nodes[a]!), nodeBox(nodes[b]!))) {
        return `${nodes[a]!.id}:${nodes[b]!.id}`;
      }
    }
  }
  return null;
}

function nodeBox(node: {
  id: string;
  position: { x: number; y: number };
  data?: { size?: "M" | "XL" | "XXL" | "4XL" };
}): { x: number; y: number; width: number; height: number } {
  const size = node.data?.size;
  if (size === "4XL")
    return { ...node.position, width: 960, height: 520 };
  if (size === "XXL")
    return { ...node.position, width: 760, height: 420 };
  if (size === "XL")
    return { ...node.position, width: 560, height: 320 };
  return { ...node.position, width: 320, height: 220 };
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const gap = 28;
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}
