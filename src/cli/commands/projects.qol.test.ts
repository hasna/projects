import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../");
const CLI_ENTRY = join(PROJECT_ROOT, "src/cli/index.ts");

function runProject(args: string[], env: Record<string, string>) {
  return Bun.spawnSync({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

function stdout(result: { stdout: Uint8Array }): string {
  return Buffer.from(result.stdout).toString("utf-8");
}

describe("project QoL commands", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  function setupProject(name: string) {
    const root = join(tmpdir(), `project-qol-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(root, { recursive: true });
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const env = { HASNA_PROJECTS_DB_PATH: join(root, "projects.db") };
    const createRes = runProject(["create", "--name", name, "--path", projectDir, "--no-git-init", "--no-integrations", "--json"], env);
    expect(createRes.exitCode).toBe(0);
    const created = JSON.parse(stdout(createRes)) as { slug: string; path: string };
    return { root, projectDir, env, created };
  }

  test("context and where expose machine-aware project locations", () => {
    const { env, created } = setupProject("Context Test");

    const contextRes = runProject(["context", created.slug, "--json"], env);
    expect(contextRes.exitCode).toBe(0);
    const context = JSON.parse(stdout(contextRes)) as {
      project: { slug: string };
      locations: Array<{ path: string; exists: boolean; currentMachine: boolean }>;
      nextCommands: string[];
    };
    expect(context.project.slug).toBe(created.slug);
    expect(context.locations.some((location) => location.path === created.path && location.exists)).toBe(true);
    expect(context.nextCommands.some((command) => command.includes("projects doctor"))).toBe(true);

    const whereRes = runProject(["where", created.slug, "--json"], env);
    expect(whereRes.exitCode).toBe(0);
    const where = JSON.parse(stdout(whereRes)) as {
      locations: Array<{ path: string; exists: boolean; currentMachine: boolean }>;
    };
    expect(where.locations.some((location) => location.currentMachine && location.exists)).toBe(true);
  });

  test("setup-machine reports command and directory checks as JSON", () => {
    const { env } = setupProject("Setup Machine Test");

    const result = runProject(["setup-machine", "--json"], env);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(stdout(result)) as { machine: { hostname: string }; checks: Array<{ code: string }> };
    expect(report.machine.hostname).toBeTruthy();
    expect(report.checks.some((check) => check.code === "COMMAND_BUN")).toBe(true);
    expect(report.checks.some((check) => check.code === "PROJECTS_DATA_DIR")).toBe(true);
  });

  test("doctor --fix --dry-run reports repair codes without writing", () => {
    const { env, created } = setupProject("Doctor Dry Run Test");

    const result = runProject(["doctor", created.slug, "--fix", "--dry-run", "--json"], env);
    expect(result.exitCode).toBe(0);
    const rows = JSON.parse(stdout(result)) as Array<{ checks: Array<{ code: string; fixable?: boolean }>; fixes: Array<{ code: string; dryRun: boolean }> }>;
    expect(rows[0]!.checks.some((check) => check.code === "PROJECT_JSON_MISSING" && check.fixable)).toBe(true);
    expect(rows[0]!.fixes.some((fix) => fix.code === "FIX_PROJECT_JSON" && fix.dryRun)).toBe(true);
    expect(existsSync(join(created.path, ".project.json"))).toBe(false);
  });

  test("stale and cleanup dry-run find missing local workdirs safely", () => {
    const { env, created } = setupProject("Stale Test");
    rmSync(created.path, { recursive: true });

    const staleRes = runProject(["stale", created.slug, "--json"], env);
    expect(staleRes.exitCode).not.toBe(0);
    const issues = JSON.parse(stdout(staleRes)) as Array<{ code: string; fixable: boolean }>;
    expect(issues.some((issue) => issue.code === "PROJECT_PATH_MISSING")).toBe(true);
    expect(issues.some((issue) => issue.code === "WORKDIR_PATH_MISSING" && issue.fixable)).toBe(true);

    const cleanupRes = runProject(["cleanup", "--dry-run", "--json"], env);
    expect(cleanupRes.exitCode).toBe(0);
    const cleanup = JSON.parse(stdout(cleanupRes)) as { dryRun: boolean; actions: Array<{ code: string; changed: boolean }> };
    expect(cleanup.dryRun).toBe(true);
    expect(cleanup.actions.some((action) => action.code === "REMOVE_STALE_WORKDIR" && !action.changed)).toBe(true);
  });
});
