import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CANONICAL_PROJECTS_RDS_CLUSTER,
  CANONICAL_PROJECTS_RDS_DATABASE,
  CANONICAL_PROJECTS_RDS_SECRET_PATH,
  PROJECTS_STORAGE_ENV,
  PROJECTS_STORAGE_FALLBACK_ENV,
  getProjectsStorageReadiness,
  getCanonicalProjectsRdsConfig,
  getStorageDatabaseEnv,
  getStorageDatabaseUrl,
  getStorageMode,
  getStorageStatus,
  parseStorageTables,
  resolveTables,
  STORAGE_TABLES,
} from "./storage-sync.js";

const envKeys = [
  "HASNA_PROJECTS_DATABASE_URL",
  "PROJECTS_DATABASE_URL",
  "HASNA_PROJECTS_STORAGE_MODE",
  "PROJECTS_STORAGE_MODE",
  "HASNA_PROJECTS_DB_PATH",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of envKeys) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env["HASNA_PROJECTS_DB_PATH"] = ":memory:";
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("projects storage sync config", () => {
  test("exposes the canonical Hasna XYZ RDS descriptor without secret values", () => {
    expect(getCanonicalProjectsRdsConfig()).toEqual({
      cluster: CANONICAL_PROJECTS_RDS_CLUSTER,
      database: CANONICAL_PROJECTS_RDS_DATABASE,
      runtimeSecretPath: CANONICAL_PROJECTS_RDS_SECRET_PATH,
      env: PROJECTS_STORAGE_ENV,
      fallbackEnv: PROJECTS_STORAGE_FALLBACK_ENV,
    });
  });

  test("canonical storage database env wins over fallback env", () => {
    process.env["HASNA_PROJECTS_DATABASE_URL"] = "postgres://new.example/projects";
    process.env["PROJECTS_DATABASE_URL"] = "postgres://fallback.example/projects";

    expect(getStorageDatabaseUrl()).toBe("postgres://new.example/projects");
    expect(getStorageDatabaseEnv()).toEqual({ name: "HASNA_PROJECTS_DATABASE_URL" });
    expect(getStorageMode()).toBe("hybrid");
  });

  test("fallback storage database env is accepted", () => {
    process.env["PROJECTS_DATABASE_URL"] = "postgres://fallback.example/projects";

    expect(getStorageDatabaseUrl()).toBe("postgres://fallback.example/projects");
    expect(getStorageDatabaseEnv()).toEqual({ name: "PROJECTS_DATABASE_URL" });
    expect(getStorageMode()).toBe("hybrid");
  });

  test("canonical storage mode wins over fallback mode", () => {
    process.env["HASNA_PROJECTS_STORAGE_MODE"] = "remote";
    process.env["PROJECTS_STORAGE_MODE"] = "hybrid";

    expect(getStorageMode()).toBe("remote");
  });

  test("resolves storage tables", () => {
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(resolveTables(["workspaces", "workspace_events"])).toEqual(["workspaces", "workspace_events"]);
    expect(parseStorageTables("workspaces, workspace_events")).toEqual(["workspaces", "workspace_events"]);
    expect(() => resolveTables(["missing"])).toThrow("Unknown projects sync table");
  });

  test("status reports local mode and sync table state", () => {
    const status = getStorageStatus();

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
    expect(status.sync).toEqual([]);
    expect(status.readiness.defaultRuntime).toBe("local");
    expect(status.readiness.cloudBackedRuntimeReady).toBe(false);
  });

  test("readiness keeps global registry sync separate from per-project project.db", () => {
    process.env["HASNA_PROJECTS_DATABASE_URL"] = "postgres://new.example/projects";

    const readiness = getProjectsStorageReadiness();
    const registry = readiness.surfaces.find((surface) => surface.surface === "global_registry");
    const appStore = readiness.surfaces.find((surface) => surface.surface === "project_app_store");
    const assets = readiness.surfaces.find((surface) => surface.surface === "project_assets");

    expect(readiness.requestedMode).toBe("hybrid");
    expect(readiness.cloudBackedRuntimeReady).toBe(false);
    expect(registry?.state).toBe("remote-sync-ready");
    expect(registry?.local.backend).toBe("sqlite");
    expect(registry?.local.active).toBe(true);
    expect(registry?.local.sourceOfTruth).toBe(true);
    expect(registry?.remote.backend).toBe("postgres");
    expect(registry?.remote.active).toBe(true);
    expect(registry?.remote.sourceOfTruth).toBe(false);
    expect(registry?.remote.tables).toContain("workspaces");

    expect(appStore?.state).toBe("cloud-planned");
    expect(appStore?.local.backend).toBe("sqlite");
    expect(appStore?.local.path).toBe("$HASNA_PROJECTS_HOME/data/<workspace_id>/project.db");
    expect(appStore?.local.tables).toContain("project_canvases");
    expect(appStore?.local.tables).toContain("project_loop_links");
    expect(appStore?.remote.backend).toBe("postgres");
    expect(appStore?.remote.active).toBe(false);
    expect(appStore?.remote.configured).toBe(true);
    expect(appStore?.remote.requiredApproval).toBe(true);
    expect(appStore?.migration.liveMutationAllowed).toBe(false);
    expect(appStore?.migration.blocker).toContain("approved schema migration and backfill task");

    expect(assets?.local.backend).toBe("local_files");
    expect(assets?.remote.backend).toBe("s3");
    expect(assets?.remote.active).toBe(false);
    expect(assets?.migration.blocker).toContain("S3 asset backing is not implemented");
  });
});
