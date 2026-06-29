import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import { createProjectCanvas, getProjectCanvas } from "../db/project-store.js";
import {
  isLoopbackDashboardHost,
  projectDashboardHtml,
  serveProjectDashboard,
} from "./project-dashboard-server.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("project dashboard server html", () => {
  test("contains React Flow imports and no chat surface", () => {
    const html = projectDashboardHtml({
      projectSlug: "swiss-bank-account",
      canvasRef: "dashboard",
    });
    expect(html).toContain("@xyflow/react");
    expect(html).toContain("react/jsx-runtime");
    expect(html).toContain("bootstrap");
    expect(html).toContain("session");
    expect(html).toContain('apiPath("layout")');
    expect(html).toContain("applyNodeChanges");
    expect(html).toContain("Connections");
    expect(html).toContain("data.showConnections === true");
    expect(html).toContain("nodesConnectable: showConnections");
    expect(html).toContain("hideAttribution: true");
    expect(html).toContain(".react-flow__attribution { display: none; }");
    expect(html).toContain("nodeSizeStyle(data.size)");
    expect(html).toContain("PreviewModal");
    expect(html).toContain("safePreviewSrc");
    expect(html).toContain("side-item");
    expect(html).toContain("onMoveEnd");
    expect(html).toContain("canvasRef");
    expect(html.toLowerCase()).not.toContain("chat");
  });

  test("requires explicit auth for non-loopback serving", async () => {
    expect(isLoopbackDashboardHost("127.0.0.1")).toBe(true);
    expect(isLoopbackDashboardHost("0.0.0.0")).toBe(false);
    await expect(
      serveProjectDashboard({ host: "0.0.0.0", port: 0, target: "missing" }),
    ).rejects.toThrow("requires --token");
  });

  test("non-loopback token mode does not self-issue cookies", async () => {
    const db = makeDb();
    createWorkspace(
      {
        id: "wks_secure_dashboard",
        name: "Secure Dashboard",
        slug: "secure-dashboard",
        kind: "project",
        primary_path: "/tmp/secure-dashboard",
      },
      db,
    );
    const served = await serveProjectDashboard({
      db,
      host: "0.0.0.0",
      port: 0,
      target: "secure-dashboard",
      providers: [],
      token: "test-dashboard-token",
    });

    try {
      const dashboard = await fetch(
        `http://127.0.0.1:${served.port}/dashboard`,
      );
      expect(dashboard.status).toBe(200);
      expect(dashboard.headers.get("set-cookie")).toBeNull();

      const denied = await fetch(
        `http://127.0.0.1:${served.port}/api/snapshot`,
      );
      expect(denied.status).toBe(401);

      const session = await fetch(
        `http://127.0.0.1:${served.port}/api/session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "test-dashboard-token" }),
        },
      );
      expect(session.status).toBe(200);
      expect(session.headers.get("set-cookie")).toContain(
        "projects_dashboard=",
      );
    } finally {
      served.server.stop(true);
      db.close();
    }
  });

  test("serves canonical project canvas routes and scoped APIs", async () => {
    const previousHome = process.env["HASNA_PROJECTS_HOME"];
    const root = mkdtempSync(join(tmpdir(), "projects-dashboard-routes-"));
    process.env["HASNA_PROJECTS_HOME"] = join(root, "home");
    const db = makeDb();
    const project = createWorkspace(
      {
        id: "wks_canvas_dashboard",
        name: "Canvas Dashboard",
        slug: "canvas-dashboard",
        kind: "project",
        primary_path: join(root, "canvas-dashboard"),
      },
      db,
    );
    createProjectCanvas(project, {
      name: "Research Board",
      slug: "research",
      nodes: [
        {
          id: "research-summary",
          type: "project.research",
          position: { x: 20, y: 30 },
          data: {
            title: "Research",
            description: "Stored canvas node",
            size: "XL",
          },
        },
        {
          id: "research-files",
          type: "project.files",
          position: { x: 24, y: 34 },
          data: {
            title: "Files",
            description: "Overlapping source position",
            size: "XL",
          },
        },
      ],
      edges: [
        {
          id: "research-to-files",
          source: "research-summary",
          target: "research-files",
        },
      ],
    });
    const served = await serveProjectDashboard({
      db,
      host: "127.0.0.1",
      port: 0,
      target: "canvas-dashboard",
      providers: [],
    });

    try {
      expect(served.url).toEndWith("/canvas-dashboard/dashboard/");
      const rootRedirect = await fetch(`http://127.0.0.1:${served.port}/`, {
        redirect: "manual",
      });
      expect(rootRedirect.status).toBe(302);
      expect(rootRedirect.headers.get("location")).toContain(
        "/canvas-dashboard/dashboard/",
      );

      const legacyRedirect = await fetch(
        `http://127.0.0.1:${served.port}/dashboard`,
        { redirect: "manual" },
      );
      expect(legacyRedirect.status).toBe(302);
      expect(legacyRedirect.headers.get("location")).toContain(
        "/canvas-dashboard/dashboard/",
      );

      const page = await fetch(
        `http://127.0.0.1:${served.port}/canvas-dashboard/research/`,
      );
      expect(page.status).toBe(200);
      const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie).toContain("projects_dashboard=");

      const bootstrap = await fetch(
        `http://127.0.0.1:${served.port}/canvas-dashboard/research/api/bootstrap`,
        {
          headers: { cookie },
        },
      );
      expect(bootstrap.status).toBe(200);
      const payload = (await bootstrap.json()) as {
        canvas: { routeId: string; kind: string };
        canvases: Array<{ routeId: string }>;
        render: {
          root: string;
          elements: Record<
            string,
            {
              props?: {
                nodes?: Array<{
                  id: string;
                  position: { x: number; y: number };
                }>;
                edges?: unknown[];
                viewport?: unknown;
                data?: {
                  availableEdges?: unknown[];
                  layout?: { showConnections?: boolean };
                };
                ui_contract?: Record<string, unknown>;
              };
            }
          >;
        };
      };
      expect(payload.canvas).toMatchObject({
        routeId: "research",
        kind: "project-canvas",
      });
      expect(payload.canvases.map((canvas) => canvas.routeId)).toContain(
        "dashboard",
      );
      expect(payload.canvases.map((canvas) => canvas.routeId)).toContain(
        "research",
      );
      const rootProps = payload.render.elements[payload.render.root]?.props;
      expect(rootProps?.nodes?.length).toBe(2);
      expect(rootProps?.edges?.length).toBe(0);
      expect(rootProps?.data?.availableEdges?.length).toBe(1);
      expect(rootProps?.data?.layout?.showConnections).toBe(false);
      expect(rootProps?.ui_contract).toMatchObject({
        connections_optional: true,
        persistent_node_positions: true,
        non_overlapping_nodes: true,
      });
      expect(rootProps?.nodes?.[1]?.position.y).toBeGreaterThan(120);

      const layoutPatch = await fetch(
        `http://127.0.0.1:${served.port}/canvas-dashboard/research/api/layout`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            showConnections: true,
            viewport: { x: 7, y: 8, zoom: 1.25 },
            nodes: [
              {
                id: "research-summary",
                type: "project.research",
                position: { x: 100, y: 100 },
                data: { size: "XL" },
              },
              {
                id: "research-files",
                type: "project.files",
                position: { x: 100, y: 100 },
                data: { size: "XL" },
              },
            ],
          }),
        },
      );
      expect(layoutPatch.status).toBe(200);
      const layoutPayload = (await layoutPatch.json()) as {
        layout: {
          showConnections: boolean;
          viewport: { x: number; y: number; zoom: number };
          nodes: Array<{ id: string; position: { x: number; y: number } }>;
        };
      };
      expect(layoutPayload.layout.showConnections).toBe(true);
      expect(layoutPayload.layout.viewport).toEqual({ x: 7, y: 8, zoom: 1.25 });
      const savedPositions = Object.fromEntries(
        layoutPayload.layout.nodes.map((node) => [node.id, node.position]),
      );
      expect(savedPositions["research-summary"]).toEqual({ x: 100, y: 100 });
      expect(savedPositions["research-files"]?.y).toBeGreaterThan(440);

      const refreshed = await fetch(
        `http://127.0.0.1:${served.port}/canvas-dashboard/research/api/bootstrap`,
        {
          headers: { cookie },
        },
      );
      const refreshedPayload = (await refreshed.json()) as typeof payload;
      const refreshedProps =
        refreshedPayload.render.elements[refreshedPayload.render.root]?.props;
      expect(refreshedProps?.edges?.length).toBe(1);
      expect(refreshedProps?.viewport).toEqual({ x: 7, y: 8, zoom: 1.25 });
      expect(
        refreshedProps?.nodes?.find((node) => node.id === "research-files")
          ?.position.y,
      ).toBe(savedPositions["research-files"]?.y);
      expect(getProjectCanvas(project, "research")?.data.ui).toMatchObject({
        show_connections: true,
      });
    } finally {
      served.server.stop(true);
      db.close();
      if (previousHome === undefined) delete process.env["HASNA_PROJECTS_HOME"];
      else process.env["HASNA_PROJECTS_HOME"] = previousHome;
    }
  });
});
