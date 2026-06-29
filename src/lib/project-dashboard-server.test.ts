import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import { createProjectCanvas } from "../db/project-store.js";
import { isLoopbackDashboardHost, projectDashboardHtml, serveProjectDashboard } from "./project-dashboard-server.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("project dashboard server html", () => {
  test("contains React Flow imports and no chat surface", () => {
    const html = projectDashboardHtml({ projectSlug: "swiss-bank-account", canvasRef: "dashboard" });
    expect(html).toContain("@xyflow/react");
    expect(html).toContain("react/jsx-runtime");
    expect(html).toContain("bootstrap");
    expect(html).toContain("session");
    expect(html).toContain("canvasRef");
    expect(html.toLowerCase()).not.toContain("chat");
  });

  test("requires explicit auth for non-loopback serving", async () => {
    expect(isLoopbackDashboardHost("127.0.0.1")).toBe(true);
    expect(isLoopbackDashboardHost("0.0.0.0")).toBe(false);
    await expect(serveProjectDashboard({ host: "0.0.0.0", port: 0, target: "missing" }))
      .rejects
      .toThrow("requires --token");
  });

  test("non-loopback token mode does not self-issue cookies", async () => {
    const db = makeDb();
    createWorkspace({
      id: "wks_secure_dashboard",
      name: "Secure Dashboard",
      slug: "secure-dashboard",
      kind: "project",
      primary_path: "/tmp/secure-dashboard",
    }, db);
    const served = await serveProjectDashboard({
      db,
      host: "0.0.0.0",
      port: 0,
      target: "secure-dashboard",
      providers: [],
      token: "test-dashboard-token",
    });

    try {
      const dashboard = await fetch(`http://127.0.0.1:${served.port}/dashboard`);
      expect(dashboard.status).toBe(200);
      expect(dashboard.headers.get("set-cookie")).toBeNull();

      const denied = await fetch(`http://127.0.0.1:${served.port}/api/snapshot`);
      expect(denied.status).toBe(401);

      const session = await fetch(`http://127.0.0.1:${served.port}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "test-dashboard-token" }),
      });
      expect(session.status).toBe(200);
      expect(session.headers.get("set-cookie")).toContain("projects_dashboard=");
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
    const project = createWorkspace({
      id: "wks_canvas_dashboard",
      name: "Canvas Dashboard",
      slug: "canvas-dashboard",
      kind: "project",
      primary_path: join(root, "canvas-dashboard"),
    }, db);
    createProjectCanvas(project, {
      name: "Research Board",
      slug: "research",
      nodes: [
        {
          id: "research-summary",
          type: "project.research",
          position: { x: 20, y: 30 },
          data: { title: "Research", description: "Stored canvas node" },
        },
      ],
      edges: [],
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
      const rootRedirect = await fetch(`http://127.0.0.1:${served.port}/`, { redirect: "manual" });
      expect(rootRedirect.status).toBe(302);
      expect(rootRedirect.headers.get("location")).toContain("/canvas-dashboard/dashboard/");

      const legacyRedirect = await fetch(`http://127.0.0.1:${served.port}/dashboard`, { redirect: "manual" });
      expect(legacyRedirect.status).toBe(302);
      expect(legacyRedirect.headers.get("location")).toContain("/canvas-dashboard/dashboard/");

      const page = await fetch(`http://127.0.0.1:${served.port}/canvas-dashboard/research/`);
      expect(page.status).toBe(200);
      const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie).toContain("projects_dashboard=");

      const bootstrap = await fetch(`http://127.0.0.1:${served.port}/canvas-dashboard/research/api/bootstrap`, {
        headers: { cookie },
      });
      expect(bootstrap.status).toBe(200);
      const payload = await bootstrap.json() as {
        canvas: { routeId: string; kind: string };
        canvases: Array<{ routeId: string }>;
        render: { root: string; elements: Record<string, { props?: { nodes?: unknown[] } }> };
      };
      expect(payload.canvas).toMatchObject({ routeId: "research", kind: "project-canvas" });
      expect(payload.canvases.map((canvas) => canvas.routeId)).toContain("dashboard");
      expect(payload.canvases.map((canvas) => canvas.routeId)).toContain("research");
      expect(payload.render.elements[payload.render.root]?.props?.nodes?.length).toBe(1);
    } finally {
      served.server.stop(true);
      db.close();
      if (previousHome === undefined) delete process.env["HASNA_PROJECTS_HOME"];
      else process.env["HASNA_PROJECTS_HOME"] = previousHome;
    }
  });
});
