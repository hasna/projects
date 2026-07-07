import { describe, expect, test } from "bun:test";
import {
  PROJECT_CANVAS_BLOCK_SCHEMA,
  composeProjectCanvasBlocks,
  projectCanvasInputFromBlocks,
} from "./project-canvas-blocks.js";

describe("project canvas blocks", () => {
  test("composes generic blocks and links into React Flow nodes and edges", () => {
    const result = composeProjectCanvasBlocks({
      schema: PROJECT_CANVAS_BLOCK_SCHEMA,
      layout: { direction: "grid", columns: 2, origin: { x: 40, y: 80 }, columnGap: 500, rowGap: 260 },
      blocks: [
        {
          id: "leadership",
          title: "Leadership",
          kind: "group",
          summary: "Current owners",
          metrics: [{ id: "owners", label: "Owners", value: 2, tone: "info" }],
        },
        {
          id: "directory",
          title: "Directory",
          kind: "table",
          columns: ["name", "role", "status"],
          rows: [
            { name: "Ada", role: "Maintainer", status: "active" },
            { name: "Lin", role: "Contributor", status: "active" },
          ],
        },
        {
          id: "handoff",
          title: "Handoff",
          kind: "checklist",
          items: [{ id: "release", title: "Release", status: "ready" }],
        },
      ],
      links: [
        { source: "leadership", target: "directory", label: "owns" },
        { source: "directory", target: "handoff", label: "feeds" },
      ],
    });

    expect(result.nodes.map((node) => node.id)).toEqual(["leadership", "directory", "handoff"]);
    expect(result.nodes[0]?.position).toEqual({ x: 40, y: 80 });
    expect(result.nodes[1]?.position).toEqual({ x: 540, y: 80 });
    expect(result.nodes[2]?.position).toEqual({ x: 40, y: 340 });
    expect(result.nodes[1]?.data.items).toHaveLength(2);
    expect(result.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["leadership", "directory"],
      ["directory", "handoff"],
    ]);
    expect(result.metadata).toMatchObject({
      composed_from: "project-canvas-blocks",
      block_count: 3,
      link_count: 2,
    });
  });

  test("returns a canvas creation input from block specs", () => {
    const input = projectCanvasInputFromBlocks({
      slug: "agent-directory",
      blocks: [
        { id: "summary", title: "Summary" },
      ],
    });

    expect(input.name).toBe("Agent Directory");
    expect(input.slug).toBe("agent-directory");
    expect(input.nodes?.[0]?.type).toBe("projectPanel");
    expect(input.edges).toEqual([]);
    expect(input.data?.block_schema).toBe(PROJECT_CANVAS_BLOCK_SCHEMA);
  });

  test("rejects links to missing block ids", () => {
    expect(() =>
      composeProjectCanvasBlocks({
        blocks: [{ id: "a", title: "A" }],
        links: [{ source: "a", target: "missing" }],
      }),
    ).toThrow("target does not match");
  });
});
