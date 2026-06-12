import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "../db/database.js";
import { createWorkspace, listWorkspaces } from "../db/workspaces.js";
import { runWorkspaceAgentEval } from "./workspace-agent-eval.js";

describe("project prompt-agent eval isolation", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["HASNA_PROJECTS_DB_PATH"];
  });

  test("runs eval fixtures in an isolated temp database instead of the active project registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-agent-eval-isolation-"));
    const realDbPath = join(root, "real-projects.db");
    const evalBasePath = join(root, "eval-run");
    process.env["HASNA_PROJECTS_DB_PATH"] = realDbPath;

    createWorkspace({
      name: "Real Project",
      slug: "real-project",
      kind: "generic",
      primary_path: join(root, "real-project"),
    });

    const result = await runWorkspaceAgentEval({
      mock: true,
      caseIds: ["create-explicit-path"],
      basePath: evalBasePath,
    });

    expect(result.db_path).toBe(join(evalBasePath, "eval-projects.db"));
    expect(result.db_path).not.toBe(realDbPath);
    expect(process.env["HASNA_PROJECTS_DB_PATH"]).toBe(realDbPath);

    const realProjects = listWorkspaces({ limit: 100 });
    expect(realProjects.map((project) => project.slug)).toEqual(["real-project"]);
    expect(realProjects.some((project) => project.slug.startsWith("eval-"))).toBe(false);

    const evalDb = getDatabase(result.db_path);
    const evalProjects = listWorkspaces({ query: "eval", limit: 100 }, evalDb);
    expect(evalProjects.length).toBeGreaterThan(0);
    evalDb.close();

    rmSync(root, { recursive: true, force: true });
  });
});
