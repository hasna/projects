import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
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

describe("project CLI not-found hints", () => {
  test("suggests close matches when project is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "project-not-found-hints-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const one = join(root, "alpha");
    const two = join(root, "beta");
    mkdirSync(one);
    mkdirSync(two);

    expect(runProject(["create", "--name", "Alpha Agent", "--path", one, "--no-git-init"], env).exitCode).toBe(0);
    expect(runProject(["create", "--name", "Beta Tooling", "--path", two, "--no-git-init"], env).exitCode).toBe(0);

    const missing = runProject(["get", "gamma"], env);
    expect(missing.exitCode).toBe(1);
    const stderr = Buffer.from(missing.stderr).toString("utf-8");
    expect(stderr).toContain("Project not found: gamma");
    expect(stderr).toContain("Hint: run `project list --limit 20` to see available project IDs/slugs.");
  });
});
