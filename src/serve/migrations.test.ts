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
});
