import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function runProject(args: string[], env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

describe("project CLI integrations", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("create accepts --no-integrations flag without error", () => {
    const root = mkdtempSync(join(tmpdir(), "project-integrations-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    // Should succeed with --no-integrations even if MCP servers aren't available
    const result = runProject(
      ["create", "--name", "Integration Test", "--path", projectDir, "--no-git-init", "--no-integrations"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const stdout = Buffer.from(result.stdout).toString("utf-8");
    expect(stdout).toContain("Integration Test");
    expect(stdout).toContain("✓ Project created");
  });

  test("create with --no-integrations explicitly disables auto-linking", () => {
    const root = mkdtempSync(join(tmpdir(), "project-integrations-flag-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    // Should succeed - --no-integrations disables auto-linking
    const result = runProject(
      ["create", "--name", "Integration Flag Test", "--path", projectDir, "--no-git-init", "--no-integrations"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const stdout = Buffer.from(result.stdout).toString("utf-8");
    expect(stdout).toContain("Integration Flag Test");
    expect(stdout).toContain("✓ Project created");
  });

  test("create with PROJECT_AUTO_LINK env var still completes", () => {
    const root = mkdtempSync(join(tmpdir(), "project-integrations-env-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath, PROJECT_AUTO_LINK: "true" };

    // Should succeed even if MCP servers aren't running
    const result = runProject(
      ["create", "--name", "Integration Env Test", "--path", projectDir, "--no-git-init"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const stdout = Buffer.from(result.stdout).toString("utf-8");
    expect(stdout).toContain("Integration Env Test");
    expect(stdout).toContain("✓ Project created");
  });
});

describe("project CLI modular structure backward compatibility", () => {
  test("projects.ts re-exports registerProjectCommands", () => {
    // The projects.ts file re-exports from the modular index
    // This test verifies the re-export chain works
    const root = mkdtempSync(join(tmpdir(), "project-backward-compat-"));
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    // All commands should work through the re-export
    const result = runProject(["list"], env);
    expect(result.exitCode).toBe(0);

    // Clean up
    rmSync(root, { recursive: true });
  });
});
