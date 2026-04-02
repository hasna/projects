import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

function runMcpCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/mcp/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("project-mcp CLI flags", () => {
  test("prints help and exits successfully", () => {
    const result = runMcpCli(["--help"]);
    const stdout = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Usage: project-mcp [options]");
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
