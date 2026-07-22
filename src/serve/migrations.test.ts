import { describe, expect, test } from "bun:test";
import { loadMigrations, resolveMigrationsDir } from "./migrations.js";

describe("projects-serve migrations", () => {
  test("resolves the on-disk migrations directory", () => {
    const dir = resolveMigrationsDir();
    expect(dir).toContain("migrations");
  });

  test("loads baseline schema + api-keys migrations with unique ids", () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    const ids = migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.startsWith("projects:0001_baseline"))).toBe(true);
    // The api-keys table migration comes from @hasna/contracts/auth.
    expect(migrations.some((m) => /api_key/i.test(m.sql))).toBe(true);
    // Baseline creates the core workspaces table.
    expect(migrations.some((m) => /CREATE TABLE IF NOT EXISTS workspaces/i.test(m.sql))).toBe(true);
  });

  test("every migration has a sha256 checksum", () => {
    for (const m of loadMigrations()) {
      expect(m.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("adds persisted idempotency, canonical bindings, and collision audit without guessing", () => {
    const migrations = loadMigrations();
    const identity = migrations.find((migration) => migration.id.includes("context_identity"));
    expect(identity).toBeDefined();
    const sql = identity?.sql ?? "";
    expect(sql).toContain("project_idempotency");
    expect(sql).toContain("request_hash");
    expect(sql).toContain("response_json");
    expect(sql).toContain("workspace_identity_bindings");
    expect(sql).toContain("project_identity_migration_audit");
    expect(sql).toMatch(/UNIQUE\s*\(location_owner_id,\s*real_path\)/i);
    expect(sql).toMatch(/HAVING\s+COUNT\s*\(DISTINCT\s+workspace_id\)\s*>\s*1/i);
    expect(sql).toContain("historical_location_unattested");
    expect(sql).not.toContain("migration-normalized-path");
    expect(sql).toContain("historical_primary_path_unbound");
    expect(sql).toMatch(/workspaces\.primary_path/);
  });
});
