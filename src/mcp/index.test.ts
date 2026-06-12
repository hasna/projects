import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runMcpCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/mcp/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
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
    expect(tools).not.toContain(legacyCreateTool);
    expect(tools).not.toContain("projects_sync");
  });
});
