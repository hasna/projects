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
        // Explicitly unset so this test is deterministic even if the ambient
        // environment (e.g. a real deployment host) has these configured. This
        // package ships no default for either (see SECURITY note in db/storage-sync.ts).
        HASNA_PROJECTS_RDS_CLUSTER: "",
        HASNA_PROJECTS_RDS_SECRET_PATH: "",
      });

      expect(result.status).toBe(0);
      const status = JSON.parse(result.stdout) as {
        configured: boolean;
        mode: string;
        activeEnv: string | null;
        canonical: {
          cluster: string | null;
          database: string;
          runtimeSecretPath: string | null;
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
        cluster: null,
        database: "projects",
        runtimeSecretPath: null,
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

  test("storage status does not print configured database URL values", () => {
    const home = mkdtempSync(join(tmpdir(), "open-projects-storage-url-"));
    const fakeUrl = "postgres://user:secret@example.test/projects";
    try {
      const env = {
        HOME: home,
        HASNA_PROJECTS_DB_PATH: join(home, "projects.db"),
        HASNA_PROJECTS_DATABASE_URL: fakeUrl,
        PROJECTS_DATABASE_URL: "",
        HASNA_PROJECTS_STORAGE_MODE: "",
        PROJECTS_STORAGE_MODE: "",
      };
      const jsonResult = runCli(["storage", "status", "--json"], env);
      const textResult = runCli(["storage", "status"], env);

      expect(jsonResult.status).toBe(0);
      expect(textResult.status).toBe(0);
      expect(jsonResult.stdout).not.toContain(fakeUrl);
      expect(jsonResult.stdout).not.toContain("secret@example.test");
      expect(textResult.stdout).not.toContain(fakeUrl);
      expect(textResult.stdout).not.toContain("secret@example.test");

      const status = JSON.parse(jsonResult.stdout) as {
        configured: boolean;
        activeEnv: string | null;
        readiness: {
          surfaces: Array<{
            surface: string;
            remote: { active: boolean; configured: boolean };
          }>;
        };
      };
      expect(status.configured).toBe(true);
      expect(status.activeEnv).toBe("HASNA_PROJECTS_DATABASE_URL");
      const registry = status.readiness.surfaces.find((surface) => surface.surface === "global_registry");
      const appStore = status.readiness.surfaces.find((surface) => surface.surface === "project_app_store");
      expect(registry?.remote.active).toBe(true);
      expect(appStore?.remote.active).toBe(false);
      expect(appStore?.remote.configured).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
