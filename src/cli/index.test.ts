import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function runProjects(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}

describe("workspace-only CLI surface", () => {
  test("does not register legacy project commands", () => {
    const source = readFileSync("src/cli/index.ts", "utf-8");

    expect(source).not.toContain("registerProjectCommands");
    expect(source).toContain("registerWorkspaceCommands");
  });

  test("help exposes workspace command groups", () => {
    const result = runProjects(["--help"]);
    const stdout = text(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Generic workspace orchestration CLI");
    expect(stdout).toContain("workspaces");
    expect(stdout).toContain("roots");
    expect(stdout).toContain("tmux-profiles");
  });

  test("completion emits workspace commands instead of legacy project commands", () => {
    const result = runProjects(["completion"]);
    const stdout = text(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("projects workspaces list");
    expect(stdout).toContain("workspace>");
    expect(stdout).not.toContain("projects open");
    expect(stdout).not.toContain("projects sync");
  });
});
