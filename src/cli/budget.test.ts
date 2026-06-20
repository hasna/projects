import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runProjects(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf-8");
}

describe("project budget CLI", () => {
  test("sets, queries, and enforces an exhausted project budget", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-budget-cli-"));
    try {
      const env = {
        HASNA_PROJECTS_DB_PATH: join(root, "projects.db"),
        WORKSPACES_AGENT_MOCK: "1",
      };
      const create = runProjects(["create", "--name", "Budget CLI App", "--path", join(root, "app"), "--json"], env);
      expect(create.exitCode).toBe(0);
      const project = (JSON.parse(text(create.stdout)) as { project: { slug: string } }).project;

      const set = runProjects([
        "budgets",
        "set",
        "--project",
        project.slug,
        "--max-total-tokens",
        "1",
        "--max-usd",
        "0.01",
        "--json",
      ], env);
      expect(set.exitCode).toBe(0);
      const budget = JSON.parse(text(set.stdout)) as { budget: { scope_type: string; max_total_tokens: number } };
      expect(budget.budget.scope_type).toBe("project");
      expect(budget.budget.max_total_tokens).toBe(1);

      const spend = runProjects([
        "budgets",
        "spend",
        "--project",
        project.slug,
        "--run-id",
        "run_cli_seed",
        "--input-tokens",
        "1",
        "--output-tokens",
        "0",
        "--usd",
        "0.000001",
        "--json",
      ], env);
      expect(spend.exitCode).toBe(0);

      const remaining = runProjects(["budgets", "remaining", "--project", project.slug, "--json"], env);
      expect(remaining.exitCode).toBe(0);
      const statuses = JSON.parse(text(remaining.stdout)) as Array<{ remaining: { total_tokens: number } }>;
      expect(statuses[0]?.remaining.total_tokens).toBe(0);

      const blocked = runProjects([
        "--budget-project",
        project.slug,
        "--json",
        "create a project named Budget Should Block",
      ], env);
      expect(blocked.exitCode).toBe(1);
      expect(text(blocked.stderr)).toContain("Project budget exceeded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
