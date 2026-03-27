import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/schema.js";
import { importProject, importBulk } from "./import.js";

// Use in-memory DB for tests
process.env["HASNA_PROJECTS_DB_PATH"] = ":memory:";

// Reset the singleton DB between tests
function resetDb() {
  // Re-initialize by clearing the module-level singleton
  // We achieve isolation by using unique paths per test
}

describe("importProject", () => {
  test("imports a plain directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-test-"));
    const { project, error } = await importProject(dir, { defaultTags: ["test"] });
    expect(error).toBeUndefined();
    expect(project).toBeDefined();
    expect(project?.path).toBe(dir);
    expect(project?.tags).toContain("test");
    rmSync(dir, { recursive: true });
  });

  test("infers name from package.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-pkg-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@scope/my-lib" }));
    const { project } = await importProject(dir);
    expect(project?.name).toBe("my-lib");
    rmSync(dir, { recursive: true });
  });

  test("returns error for non-existent path", async () => {
    const { error } = await importProject("/this/does/not/exist");
    expect(error).toContain("does not exist");
  });

  test("dry run does not import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-dry-"));
    const { skipped } = await importProject(dir, { dryRun: true });
    expect(skipped).toBe("dry-run");
    rmSync(dir, { recursive: true });
  });
});

describe("importBulk", () => {
  test("imports all subdirectories", async () => {
    const root = mkdtempSync(join(tmpdir(), "bulk-root-"));
    const sub1 = join(root, "proj-a");
    const sub2 = join(root, "proj-b");
    mkdirSync(sub1);
    mkdirSync(sub2);

    const result = await importBulk(root);
    expect(result.imported.length).toBe(2);
    expect(result.errors.length).toBe(0);
    rmSync(root, { recursive: true });
  });

  test("skips hidden directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "bulk-hidden-"));
    mkdirSync(join(root, "visible"));
    mkdirSync(join(root, ".hidden"));

    const result = await importBulk(root);
    expect(result.imported.length).toBe(1);
    rmSync(root, { recursive: true });
  });

  test("dry run returns skipped entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "bulk-dry-"));
    mkdirSync(join(root, "proj-x"));
    const result = await importBulk(root, { dryRun: true });
    expect(result.skipped.length).toBe(1);
    expect(result.imported.length).toBe(0);
    rmSync(root, { recursive: true });
  });
});
