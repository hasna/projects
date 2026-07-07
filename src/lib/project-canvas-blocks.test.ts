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

  test("rejects malformed layout numbers before generating node positions", () => {
    const base = {
      blocks: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
    };

    expect(() =>
      composeProjectCanvasBlocks({
        ...base,
        layout: { columns: "2" } as never,
      }),
    ).toThrow("layout.columns must be a finite number");

    expect(() =>
      composeProjectCanvasBlocks({
        ...base,
        layout: { columnGap: Number.NaN } as never,
      }),
    ).toThrow("layout.columnGap must be a finite number");

    expect(() =>
      composeProjectCanvasBlocks({
        ...base,
        layout: { rowGap: "wide" } as never,
      }),
    ).toThrow("layout.rowGap must be a finite number");

    expect(() =>
      composeProjectCanvasBlocks({
        ...base,
        layout: { origin: { x: null, y: 0 } } as never,
      }),
    ).toThrow("layout.origin must include finite numeric x and y");
  });

  test("rejects malformed block dimensions and explicit positions", () => {
    expect(() =>
      composeProjectCanvasBlocks({
        blocks: [{ id: "a", title: "A", position: { x: "left", y: 0 } as never }],
      }),
    ).toThrow("blocks[0].position must include finite numeric x and y");

    expect(() =>
      composeProjectCanvasBlocks({
        blocks: [{ id: "a", title: "A", width: "wide" as never }],
      }),
    ).toThrow("blocks[0].width must be a finite number");

    expect(() =>
      composeProjectCanvasBlocks({
        blocks: [{ id: "a", title: "A", height: 0 }],
      }),
    ).toThrow("blocks[0].height must be greater than 0");
  });

  test("rejects malformed viewport numbers", () => {
    expect(() =>
      composeProjectCanvasBlocks({
        viewport: { x: 0, y: 0, zoom: "close" } as never,
        blocks: [{ id: "a", title: "A" }],
      }),
    ).toThrow("viewport.zoom must be a finite number");
  });
});
