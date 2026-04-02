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

describe("project CLI JSON output", () => {
  test("create and rename support --json", () => {
    const root = mkdtempSync(join(tmpdir(), "project-json-create-"));
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    const createRes = runProject(["create", "--name", "JSON Test", "--path", projectDir, "--no-git-init", "--json"], env);
    expect(createRes.exitCode).toBe(0);
    const created = JSON.parse(Buffer.from(createRes.stdout).toString("utf-8")) as { slug: string; name: string; path: string };
    expect(created.name).toBe("JSON Test");
    expect(created.path).toBe(projectDir);

    const renameRes = runProject(["rename", created.slug, "JSON Test Renamed", "--json"], env);
    expect(renameRes.exitCode).toBe(0);
    const renamed = JSON.parse(Buffer.from(renameRes.stdout).toString("utf-8")) as { name: string; slug: string };
    expect(renamed.name).toBe("JSON Test Renamed");
    expect(renamed.slug).toContain("json-test-renamed");
  });

  test("workdir list and sync-log support --json", () => {
    const root = mkdtempSync(join(tmpdir(), "project-json-list-"));
    const projectDir = join(root, "repo");
    const workdirDir = join(root, "workdir");
    mkdirSync(projectDir);
    mkdirSync(workdirDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    const createRes = runProject(["create", "--name", "Workdir JSON", "--path", projectDir, "--no-git-init", "--json"], env);
    expect(createRes.exitCode).toBe(0);
    const created = JSON.parse(Buffer.from(createRes.stdout).toString("utf-8")) as { slug: string };

    const addRes = runProject(["workdir", "add", created.slug, workdirDir, "--label", "alt"], env);
    expect(addRes.exitCode).toBe(0);

    const listRes = runProject(["workdir", "list", created.slug, "--json"], env);
    expect(listRes.exitCode).toBe(0);
    const workdirs = JSON.parse(Buffer.from(listRes.stdout).toString("utf-8")) as Array<{ path: string }>;
    expect(workdirs.some((w) => w.path === workdirDir)).toBe(true);

    const syncLogRes = runProject(["sync-log", created.slug, "--json"], env);
    expect(syncLogRes.exitCode).toBe(0);
    const logs = JSON.parse(Buffer.from(syncLogRes.stdout).toString("utf-8")) as unknown[];
    expect(Array.isArray(logs)).toBe(true);
  });
});
