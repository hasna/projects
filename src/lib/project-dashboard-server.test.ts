import { describe, expect, test } from "bun:test";
import { projectDashboardHtml } from "./project-dashboard-server.js";

describe("project dashboard server html", () => {
  test("contains React Flow imports and no chat surface", () => {
    const html = projectDashboardHtml({ projectSlug: "swiss-bank-account" });
    expect(html).toContain("@xyflow/react");
    expect(html).toContain("/api/snapshot");
    expect(html.toLowerCase()).not.toContain("chat");
  });
});
