import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe("projects storage CLI", () => {
  test("help advertises storage sync", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("storage");
  });

  test("storage status reports local mode as JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "open-projects-storage-cli-"));
    try {
      const result = runCli(["storage", "status", "--json"], {
        HOME: home,
        HASNA_PROJECTS_DB_PATH: join(home, "projects.db"),
        HASNA_PROJECTS_DATABASE_URL: "",
        PROJECTS_DATABASE_URL: "",
        HASNA_PROJECTS_STORAGE_MODE: "",
        PROJECTS_STORAGE_MODE: "",
      });

      expect(result.status).toBe(0);
      const status = JSON.parse(result.stdout) as {
        configured: boolean;
        mode: string;
        activeEnv: string | null;
        canonical: {
          cluster: string;
          database: string;
          runtimeSecretPath: string;
          env: string;
          fallbackEnv: string;
        };
        service: string;
        tables: string[];
        readiness: {
          cloudBackedRuntimeReady: boolean;
          surfaces: Array<{
            surface: string;
            local: { backend: string; active: boolean; path?: string; tables?: string[] };
            remote: { backend: string; active: boolean; requiredApproval?: boolean; blocker?: string };
          }>;
        };
      };
      expect(status.configured).toBe(false);
      expect(status.mode).toBe("local");
      expect(status.activeEnv).toBe(null);
      expect(status.canonical).toEqual({
        cluster: "hasna-xyz-infra-apps-prod-postgres",
        database: "projects",
        runtimeSecretPath: "hasna/xyz/opensource/projects/prod/rds",
        env: "HASNA_PROJECTS_DATABASE_URL",
        fallbackEnv: "PROJECTS_DATABASE_URL",
      });
      expect(status.service).toBe("projects");
      expect(status.tables).toContain("workspaces");
      expect(status.readiness.cloudBackedRuntimeReady).toBe(false);
      const appStore = status.readiness.surfaces.find((surface) => surface.surface === "project_app_store");
      expect(appStore?.local.backend).toBe("sqlite");
      expect(appStore?.local.active).toBe(true);
      expect(appStore?.local.path).toBe("$HASNA_PROJECTS_HOME/data/<workspace_id>/project.db");
      expect(appStore?.local.tables).toContain("project_canvases");
      expect(appStore?.remote.backend).toBe("postgres");
      expect(appStore?.remote.active).toBe(false);
      expect(appStore?.remote.requiredApproval).toBe(true);
      expect(appStore?.remote.blocker).toContain("project.db cloud backing is not implemented");
      expect(result.stdout).not.toContain("postgres://");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
