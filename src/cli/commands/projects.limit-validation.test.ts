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

describe("project CLI limit validation", () => {
  test("rejects invalid list --limit", () => {
    const root = mkdtempSync(join(tmpdir(), "project-limit-list-"));
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    const result = runProject(["list", "--limit", "NaN"], env);
    expect(result.exitCode).toBe(1);
    const stderr = Buffer.from(result.stderr).toString("utf-8");
    expect(stderr).toContain("Invalid value for --limit");
  });

  test("rejects invalid recent and sync-log limits", () => {
    const root = mkdtempSync(join(tmpdir(), "project-limit-sync-log-"));
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };

    const createRes = runProject(["create", "--name", "Limit Test", "--path", projectDir, "--no-git-init", "--json"], env);
    expect(createRes.exitCode).toBe(0);
    const created = JSON.parse(Buffer.from(createRes.stdout).toString("utf-8")) as { slug: string };

    const recentRes = runProject(["recent", "--limit", "0"], env);
    expect(recentRes.exitCode).toBe(1);
    expect(Buffer.from(recentRes.stderr).toString("utf-8")).toContain("Invalid value for --limit");

    const syncLogRes = runProject(["sync-log", created.slug, "--limit", "-1"], env);
    expect(syncLogRes.exitCode).toBe(1);
    expect(Buffer.from(syncLogRes.stderr).toString("utf-8")).toContain("Invalid value for --limit");
  });
});
