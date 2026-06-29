import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import { isLoopbackDashboardHost, projectDashboardHtml, serveProjectDashboard } from "./project-dashboard-server.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("project dashboard server html", () => {
  test("contains React Flow imports and no chat surface", () => {
    const html = projectDashboardHtml({ projectSlug: "swiss-bank-account" });
    expect(html).toContain("@xyflow/react");
    expect(html).toContain("/api/snapshot");
    expect(html).toContain("/api/session");
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
});
