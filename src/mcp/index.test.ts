import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../db/schema.js";
import { createWorkspace } from "../db/workspaces.js";

const LOCAL_PROJECTS_ENV = { HASNA_PROJECTS_STORAGE_MODE: "local" } as const;

function runMcpCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/mcp/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...LOCAL_PROJECTS_ENV },
  });
}

describe("projects-mcp CLI flags", () => {
  test("prints help and exits successfully", () => {
    const result = runMcpCli(["--help"]);
    const stdout = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Usage: projects-mcp [options]");
    expect(stdout).toContain("--help");
    expect(stdout).toContain("--version");
  });

  test("prints package version and exits successfully", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };
    const result = runMcpCli(["--version"]);
    const stdout = Buffer.from(result.stdout).toString("utf-8").trim();

    expect(result.exitCode).toBe(0);
    expect(stdout).toBe(pkg.version);
  });

  test("calls render and GitHub root scan/sync MCP tools over stdio", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-mcp-render-call-"));
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "project-mcp-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "projects_render_list", arguments: {} } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "projects_render_roots", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "projects_render_recipes", arguments: {} } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "projects_scan_roots", arguments: {} } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "projects_sync_roots", arguments: { dry_run: true } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "projects_sync_roots", arguments: {} } },
    ];
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/mcp/index.ts"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...LOCAL_PROJECTS_ENV, HASNA_PROJECTS_DB_PATH: join(root, "projects.db") },
    });
    child.stdin.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    child.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    rmSync(root, { recursive: true, force: true });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      id?: number;
      result?: { content?: Array<{ type: string; text: string }> };
    }>;
    for (const id of [2, 3, 4]) {
      const payload = JSON.parse(responses.find((response) => response.id === id)?.result?.content?.[0]?.text ?? "{}");
      expect(payload.root).toBe("root");
      expect(payload.elements.root).toBeTruthy();
    }
    expect((JSON.parse(responses.find((response) => response.id === 5)?.result?.content?.[0]?.text ?? "{}") as { dry_run?: boolean }).dry_run).toBe(true);
    expect((JSON.parse(responses.find((response) => response.id === 6)?.result?.content?.[0]?.text ?? "{}") as { dry_run?: boolean }).dry_run).toBe(true);
    expect((JSON.parse(responses.find((response) => response.id === 7)?.result?.content?.[0]?.text ?? "{}") as { dry_run?: boolean }).dry_run).toBe(false);
  });

});

describe("projects-mcp project-first surface", () => {
  test("registers project-first MCP tools and removes workspace aliases", () => {
    const source = readFileSync("src/mcp/index.ts", "utf-8");
    const legacyAliasEnv = "PROJECTS_ENABLE_" + "WORKSPACE_MCP_ALIASES";
    const legacyCreateTool = ["projects", "workspaces_create"].join("_");

    expect(source).toContain("\"projects_create\"");
    expect(source).toContain("\"projects_list\"");
    expect(source).toContain("\"projects_update\"");
    expect(source).toContain("\"projects_tag\"");
    expect(source).toContain("\"projects_untag\"");
    expect(source).toContain("\"projects_unlink\"");
    expect(source).toContain("\"projects_archive\"");
    expect(source).toContain("\"projects_start\"");
    expect(source).toContain("\"projects_tmux_status\"");
    expect(source).toContain("\"projects_cleanup_create\"");
    expect(source).toContain("\"projects_agents_assign\"");
    expect(source).toContain("\"projects_locations_list\"");
    expect(source).toContain("\"projects_locations_add\"");
    expect(source).not.toContain("\"projects_sync\"");
    expect(source).not.toContain(legacyAliasEnv);
    expect(source).not.toContain(`"${legacyCreateTool}"`);
    expect(source).toContain("\"projects_agent_eval\"");
    expect(source).toContain("\"projects_agent_prompt\"");
    expect(source).toContain("\"projects_scan_local_roots\"");
    expect(source).toContain("\"projects_sync_roots\"");
    expect(source).toContain("\"projects_scan_roots\"");
    expect(source).toContain("\"projects_render_recipes\"");
    expect(source).toContain("\"projects_render_roots\"");
    expect(source).toContain("\"projects_render_sessions\"");
    expect(source).toContain("\"projects_render_status\"");
    expect(source).toContain("\"projects_render_start\"");
    expect(source).toContain("\"projects_render_show\"");
    expect(source).toContain("\"projects_render_list\"");
    expect(source).toContain("\"projects_store_inspect\"");
    expect(source).toContain("\"projects_context_bundle\"");
    expect(source).toContain("\"projects_canvases_list\"");
    expect(source).toContain("\"projects_canvases_create\"");
    expect(source).toContain("\"projects_canvases_upsert\"");
    expect(source).toContain("\"projects_canvases_compose\"");
    expect(source).toContain("\"projects_render_canvas\"");
    expect(source).toContain("\"projects_loops_link\"");
    expect(source).toContain("\"projects_loops_list\"");
  });

  test("lists project tools over stdio JSON-RPC", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-mcp-smoke-"));
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "project-mcp-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ];
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/mcp/index.ts"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...LOCAL_PROJECTS_ENV,
        HASNA_PROJECTS_DB_PATH: join(root, "projects.db"),
      },
    });

    child.stdin.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    child.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    rmSync(root, { recursive: true, force: true });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      id?: number;
      result?: { tools?: Array<{ name: string }> };
    }>;
    const tools = responses.find((response) => response.id === 2)?.result?.tools?.map((tool) => tool.name) ?? [];
    const legacyCreateTool = ["projects", "workspaces_create"].join("_");
    expect(tools).toContain("projects_create");
    expect(tools).toContain("projects_list");
    expect(tools).toContain("projects_tag");
    expect(tools).toContain("projects_untag");
    expect(tools).toContain("projects_unlink");
    expect(tools).toContain("projects_start");
    expect(tools).toContain("projects_tmux_status");
    expect(tools).toContain("projects_cleanup_create");
    expect(tools).toContain("projects_agents_assign");
    expect(tools).toContain("projects_locations_list");
    expect(tools).toContain("projects_locations_add");
    expect(tools).toContain("projects_events_list");
    expect(tools).toContain("projects_agent_eval");
    expect(tools).toContain("projects_agent_prompt");
    expect(tools).toContain("projects_scan_local_roots");
    expect(tools).toContain("projects_sync_roots");
    expect(tools).toContain("projects_scan_roots");
    expect(tools).toContain("projects_render_recipes");
    expect(tools).toContain("projects_render_roots");
    expect(tools).toContain("projects_render_sessions");
    expect(tools).toContain("projects_render_status");
    expect(tools).toContain("projects_render_start");
    expect(tools).toContain("projects_render_show");
    expect(tools).toContain("projects_render_list");
    expect(tools).toContain("projects_store_inspect");
    expect(tools).toContain("projects_context_bundle");
    expect(tools).toContain("projects_canvases_list");
    expect(tools).toContain("projects_canvases_create");
    expect(tools).toContain("projects_canvases_upsert");
    expect(tools).toContain("projects_canvases_compose");
    expect(tools).toContain("projects_render_canvas");
    expect(tools).toContain("projects_loops_link");
    expect(tools).toContain("projects_loops_list");
    expect(tools).not.toContain(legacyCreateTool);
    expect(tools).not.toContain("projects_sync");
  });

  test("returns a strict context bundle over an invoked MCP tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-mcp-context-bundle-"));
    const dbPath = join(root, "projects.db");
    const projectPath = join(root, "project");
    mkdirSync(projectPath, { recursive: true });
    const database = new Database(dbPath);
    database.run("PRAGMA foreign_keys=ON");
    runMigrations(database);
    const project = createWorkspace({
      name: "MCP Context Bundle",
      slug: "mcp-context-bundle",
      kind: "project",
      primary_path: projectPath,
      integrations: {
        todos_project_id: "todo-project",
        todos_task_list_id: "todo-list",
        conversations_channel: "project-channel",
        mementos_project_id: "memory-project",
        mementos_scope: "project",
      },
    }, database);
    database.close();

    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "project-mcp-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "projects_context_bundle",
          arguments: { project: project.id },
        },
      },
    ];
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/mcp/index.ts"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...LOCAL_PROJECTS_ENV,
        HASNA_PROJECTS_HOME: join(root, "home"),
        HASNA_PROJECTS_DB_PATH: dbPath,
      },
    });
    child.stdin.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    child.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    try {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        id?: number;
        result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
      }>;
      const response = responses.find((item) => item.id === 2)?.result;
      expect(response?.isError).not.toBe(true);
      const body = JSON.parse(response?.content?.[0]?.text ?? "null") as unknown;
      const { parseProjectContextBundle } = await import("../lib/project-context-bundle.js");
      const bundle = parseProjectContextBundle(body);
      expect(bundle.project.id).toBe(project.id);
      expect(bundle.links.todos).toEqual({ state: "linked", project_id: "todo-project", task_list_id: "todo-list" });
      expect(Buffer.byteLength(JSON.stringify(bundle), "utf-8")).toBeLessThanOrEqual(8 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns structured stable errors from target-taking MCP tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-mcp-context-error-"));
    writeFileSync(join(root, ".project.json"), "{", "utf-8");
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "project-mcp-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "projects_context_bundle", arguments: { project: root } },
      },
    ];
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/mcp/index.ts"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...LOCAL_PROJECTS_ENV,
        HASNA_PROJECTS_DB_PATH: join(root, "projects.db"),
      },
    });
    child.stdin.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    try {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        id?: number;
        result?: { content?: Array<{ text: string }>; isError?: boolean };
      }>;
      const result = responses.find((item) => item.id === 2)?.result;
      expect(result?.isError).toBe(true);
      expect(JSON.parse(result?.content?.[0]?.text ?? "{}")).toMatchObject({
        error: { code: "PROJECT_MARKER_INVALID", status: 400 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("projects_render_list reads the selected remote Store", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-mcp-render-api-"));
    const calls: Array<{ method: string; pathname: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        calls.push({ method: request.method, pathname: url.pathname });
        if (request.method === "GET" && url.pathname === "/v1/projects") {
          return Response.json({
            workspaces: [{
              id: "wks_remote_render",
              slug: "remote-render",
              name: "Remote Render",
              description: null,
              kind: "project",
              status: "active",
              root_id: null,
              recipe_id: null,
              primary_path: null,
              git_remote: null,
              tags: [],
              integrations: {},
              metadata: {},
              created_at: "2026-07-22 00:00:00",
              updated_at: "2026-07-22 00:00:00",
            }],
            count: 1,
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "project-mcp-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "projects_render_list", arguments: {} } },
    ];
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/mcp/index.ts"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HASNA_PROJECTS_STORAGE_MODE: "cloud",
        HASNA_PROJECTS_API_URL: `http://127.0.0.1:${server.port}`,
        HASNA_PROJECTS_API_KEY: "test-key",
        HASNA_PROJECTS_DB_PATH: join(root, "locator.db"),
      },
    });
    child.stdin.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    child.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    try {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
        id?: number;
        result?: { content?: Array<{ text: string }>; isError?: boolean };
      }>;
      const result = responses.find((item) => item.id === 2)?.result;
      expect(result?.isError).not.toBe(true);
      expect(result?.content?.[0]?.text).toContain("remote-render");
      expect(calls).toEqual([{ method: "GET", pathname: "/v1/projects" }]);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("calls canvas compose and upsert MCP tools over stdio", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-mcp-canvas-call-"));
    const dbPath = join(root, "projects.db");
    const db = new Database(dbPath);
    db.run("PRAGMA foreign_keys=ON");
    runMigrations(db);
    createWorkspace({
      name: "MCP Canvas",
      slug: "mcp-canvas",
      kind: "project",
      primary_path: join(root, "mcp-canvas"),
    }, db);
    db.close();

    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "project-mcp-test", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "projects_canvases_compose",
          arguments: {
            project: "mcp-canvas",
            slug: "mcp-blocks",
            blocks: [
              { id: "summary", title: "Summary" },
              { id: "table", title: "Table", kind: "table", columns: ["name"], rows: [{ name: "Ada" }] },
            ],
            links: [{ source: "summary", target: "table", label: "feeds" }],
            layout: { columns: 2, columnGap: 320 },
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "projects_canvases_upsert",
          arguments: {
            project: "mcp-canvas",
            slug: "raw-canvas",
            name: "Raw Canvas",
            nodes: [
              { id: "raw", type: "projectPanel", position: { x: 0, y: 0 }, data: { title: "Raw" } },
            ],
            edges: [],
            data: { source: "mcp-test" },
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "projects_canvases_compose",
          arguments: {
            project: "mcp-canvas",
            slug: "invalid-layout",
            blocks: [{ id: "broken", title: "Broken" }],
            layout: { columnGap: "wide" },
            dry_run: true,
          },
        },
      },
    ];
    const child = Bun.spawn({
      cmd: ["bun", "run", "src/mcp/index.ts"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...LOCAL_PROJECTS_ENV,
        HASNA_PROJECTS_HOME: join(root, "home"),
        HASNA_PROJECTS_DB_PATH: dbPath,
      },
    });

    child.stdin.write(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    child.stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    rmSync(root, { recursive: true, force: true });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      id?: number;
      result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    }>;
    const composed = JSON.parse(responses.find((response) => response.id === 2)?.result?.content?.[0]?.text ?? "{}") as {
      canvas?: { slug: string; nodes: Array<{ id: string; position: { x: number; y: number } }>; data: { block_schema?: string } };
    };
    const upserted = JSON.parse(responses.find((response) => response.id === 3)?.result?.content?.[0]?.text ?? "{}") as {
      canvas?: { slug: string; data?: { source?: string } };
    };
    const invalid = responses.find((response) => response.id === 4)?.result;

    expect(composed.canvas?.slug).toBe("mcp-blocks");
    expect(composed.canvas?.data.block_schema).toBe("hasna.projects_canvas_blocks.v1");
    expect(composed.canvas?.nodes.map((node) => node.position)).toEqual([{ x: 0, y: 0 }, { x: 320, y: 0 }]);
    expect(upserted.canvas?.slug).toBe("raw-canvas");
    expect(upserted.canvas?.data?.source).toBe("mcp-test");
    expect(invalid?.isError).toBe(true);
    expect(invalid?.content?.[0]?.text).toContain("layout.columnGap must be a finite number");
  });
});
