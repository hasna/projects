import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./index.js";
import { handleMcpRequest, resolveMcpHttpPort, DEFAULT_MCP_HTTP_PORT } from "./http.js";

describe("projects MCP HTTP transport", () => {
  let httpServer: ReturnType<typeof Bun.serve>;
  let port: number;
  let root: string;
  let previousDbPath: string | undefined;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "projects-mcp-http-"));
    previousDbPath = process.env.HASNA_PROJECTS_DB_PATH;
    process.env.HASNA_PROJECTS_DB_PATH = join(root, "projects.db");
    httpServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health" && req.method === "GET") {
          return Response.json({ status: "ok", name: "projects" });
        }
        if (url.pathname === "/mcp") {
          return handleMcpRequest(req, buildServer);
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    port = httpServer.port!;
  });

  afterAll(() => {
    httpServer.stop();
    if (previousDbPath === undefined) {
      delete process.env.HASNA_PROJECTS_DB_PATH;
    } else {
      process.env.HASNA_PROJECTS_DB_PATH = previousDbPath;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("default port is 8871", () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8871);
    expect(resolveMcpHttpPort([])).toBe(8871);
    expect(resolveMcpHttpPort(["--port", "9001"])).toBe(9001);
  });

  test("GET /health returns 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "projects" });
  });

  test("MCP initialize + projects_list over Streamable HTTP", async () => {
    const client = new Client({ name: "projects-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    const created = await client.callTool({
      name: "projects_create",
      arguments: {
        name: "HTTP Compact Project",
        path: join(root, "http-compact-project"),
        metadata: { notes: "x".repeat(500) },
      },
    });
    expect(created.isError).not.toBe(true);

    const result = await client.callTool({ name: "projects_list", arguments: { limit: 1 } });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    expect(content?.[0]?.type).toBe("text");
    const payload = JSON.parse(content?.[0]?.text ?? "{}") as {
      projects?: Array<{ slug: string; metadata?: unknown }>;
      count?: number;
      next_steps?: string;
    };
    expect(payload.projects?.[0]?.slug).toBe("http-compact-project");
    expect(payload.projects?.[0]?.metadata).toBeUndefined();
    expect(payload.count).toBe(1);
    expect(payload.next_steps).toContain("verbose=true");

    const verbose = await client.callTool({ name: "projects_list", arguments: { verbose: true } });
    const verboseContent = verbose.content as Array<{ type: string; text?: string }> | undefined;
    const verbosePayload = JSON.parse(verboseContent?.[0]?.text ?? "[]") as Array<{ slug: string; metadata?: { notes?: string } }>;
    expect(verbosePayload.find((item) => item.slug === "http-compact-project")?.metadata?.notes).toHaveLength(500);
    await client.close();
  });
});

describe("projects buildServer", () => {
  test("registers tools for stdio and HTTP modes", () => {
    expect(buildServer()).toBeDefined();
  });
});
