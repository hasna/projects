import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import { defaultProjectCanvasInput } from "../db/project-store.js";
import {
  buildProjectCanvasPayload,
  buildProjectListRender,
  buildProjectStatusRender,
  projectsJsonRenderCatalog,
  validateProjectsRenderSpec,
} from "./project-render.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("Projects JSON Render specs", () => {
  test("builds validated specs from project surfaces", () => {
    const db = makeDb();
    const project = createWorkspace(
      {
        name: "Render Project",
        slug: "render-project",
        kind: "project",
        primary_path: "/tmp/render-project",
        tags: ["render"],
      },
      db,
    );

    const spec = buildProjectListRender([project]);
    const validated = validateProjectsRenderSpec(spec);

    expect(projectsJsonRenderCatalog.componentNames).toEqual(
      expect.arrayContaining([
        "Card",
        "Table",
        "Stat",
        "Badge",
        "Tabs",
        "Timeline",
        "Actions",
        "Canvas",
        "ProjectCanvasCard",
        "SourcePanel",
        "FilePreviewDialog",
      ]),
    );
    expect(validated.root).toBe("root");
    expect(validated.elements.root?.type).toBe("Card");
    expect(projectsJsonRenderCatalog.validate(spec).success).toBe(true);
    db.close();
  });

  test("rejects component props that do not match the selected component", () => {
    const invalid = {
      root: "root",
      elements: {
        root: {
          type: "Card",
          props: { columns: ["a"], rows: [] },
          children: [],
        },
      },
      metadata: { kind: "projects.invalid" },
    };

    expect(() => validateProjectsRenderSpec(invalid)).toThrow("Invalid props");
  });

  test("quotes dynamic command arguments in render actions", () => {
    const db = makeDb();
    const project = createWorkspace(
      {
        name: "Odd Project",
        slug: "odd-project",
        kind: "project",
        primary_path: "/tmp/odd-project",
      },
      db,
    );
    const spec = validateProjectsRenderSpec(
      buildProjectStatusRender({
        project: { ...project, slug: "odd project's" },
        sessionName: "odd session",
        exists: false,
        tmuxAvailable: true,
        expectedWindows: [],
        currentWindows: [],
        errors: [],
      }),
    );
    const actions = spec.elements.actions?.props.actions as Array<{
      command: string;
    }>;

    expect(actions[0]?.command).toBe("projects start 'odd project'\\''s'");
    db.close();
  });

  test("builds a React Flow canvas render payload", () => {
    const db = makeDb();
    const project = createWorkspace(
      {
        name: "Canvas Project",
        slug: "canvas-project",
        kind: "project",
        primary_path: "/tmp/canvas-project",
      },
      db,
    );
    const canvas = {
      id: "pcv_test",
      slug: "dashboard",
      name: "Dashboard",
      description: "Default dashboard",
      status: "active" as const,
      layout_engine: "react-flow",
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: defaultProjectCanvasInput(project).nodes!,
      edges: defaultProjectCanvasInput(project).edges!,
      data: { surface: "project-dashboard" },
      metadata: {},
      created_at: "2026-06-26T00:00:00.000Z",
      updated_at: "2026-06-26T00:00:00.000Z",
    };

    const payload = buildProjectCanvasPayload({ project, canvas });
    const spec = validateProjectsRenderSpec(payload.render);
    expect(spec.elements.root?.type).toBe("Canvas");
    expect(spec.elements.root?.props.ui_contract).toMatchObject({
      styling: "tailwind",
      components: "shadcn",
      component_package: "@json-render/shadcn",
      component_package_min_version: "0.19.1",
      canvas: "react-flow",
      optional_connections: true,
      persistent_node_positions: true,
    });
    expect(spec.elements.root?.props.defaultShowConnections).toBe(false);
    expect(spec.elements.root?.props.edges).toHaveLength(0);
    const rootData = spec.elements.root?.props.data as {
      availableEdges?: unknown[];
      ui?: Record<string, unknown>;
    };
    expect(rootData.availableEdges).toHaveLength(canvas.edges.length);
    expect(rootData.ui).toMatchObject({
      show_connections: false,
    });
    expect(spec.elements.root?.props.capabilities).toMatchObject({
      infinite_canvas: true,
      multiple_canvases_per_project: true,
      node_component: "ProjectCanvasCard",
    });
    expect(spec.elements.source_panel?.type).toBe("SourcePanel");
    expect(spec.elements.file_preview_dialog?.type).toBe("FilePreviewDialog");
    db.close();
  });

  test("redacts unsafe FilePreviewDialog preview metadata", () => {
    const db = makeDb();
    const project = createWorkspace(
      {
        name: "Preview Project",
        slug: "preview-project",
        kind: "project",
        primary_path: "/tmp/preview-project",
      },
      db,
    );
    const canvas = {
      id: "pcv_preview",
      slug: "dashboard",
      name: "Dashboard",
      description: "Default dashboard",
      status: "active" as const,
      layout_engine: "react-flow",
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: defaultProjectCanvasInput(project).nodes!,
      edges: [],
      data: {
        snapshot: {
          panels: [
            {
              id: "files",
              title: "Files",
              kind: "files",
              provider: { kind: "files", id: "files" },
              items: [
                {
                  id: "file-1",
                  title: "Contract",
                  summary: "Redacted contract preview",
                  resourceRefs: [{ kind: "file", id: "file-1" }],
                  metadata: {
                    src: "https://files.example.test/doc.pdf?signature=abc",
                    referenceLabel: "/home/hasna/private/doc.pdf",
                    previewText: "Redacted contract preview",
                  },
                },
              ],
            },
          ],
        },
      },
      metadata: {},
      created_at: "2026-06-26T00:00:00.000Z",
      updated_at: "2026-06-26T00:00:00.000Z",
    };

    const payload = buildProjectCanvasPayload({ project, canvas });
    const props = validateProjectsRenderSpec(payload.render).elements
      .file_preview_dialog?.props as {
      src?: string | null;
      file?: { referenceLabel?: string | null; uri?: string | null };
    };
    expect(props.src).toBeNull();
    expect(props.file?.uri).toBeNull();
    expect(props.file?.referenceLabel).toBe("redacted reference");
    db.close();
  });
});
