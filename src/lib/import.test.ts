import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/schema.js";
import { importProject, importBulk } from "./import.js";
import { getProjectByPath } from "../db/projects.js";

// Test malformed JSON handling in inferProjectName (lines 27, 38)
describe("importProject malformed metadata", () => {
  test("handles malformed package.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-bad-pkg-"));
    writeFileSync(join(dir, "package.json"), "{not valid json");
    const { project, error } = await importProject(dir, { defaultTags: ["test"] });
    expect(error).toBeUndefined();
    expect(project).toBeDefined();
    rmSync(dir, { recursive: true });
  });

  test("handles malformed .project.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-bad-proj-"));
    writeFileSync(join(dir, ".project.json"), "{{{malformed");
    const { project, error } = await importProject(dir, { defaultTags: ["test"] });
    expect(error).toBeUndefined();
    expect(project).toBeDefined();
    rmSync(dir, { recursive: true });
  });
});

// Test error paths: not a directory, import failure, bulk errors
describe("importProject error paths", () => {
  test("returns error for file path (not a directory)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-file-"));
    const filePath = join(dir, "some-file.txt");
    writeFileSync(filePath, "hello");
    const { error } = await importProject(filePath);
    expect(error).toContain("Not a directory");
    rmSync(dir, { recursive: true });
  });
});

describe("importBulk error paths", () => {
  test("skips non-directory entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "bulk-skip-file-"));
    // Create a file instead of directory - should be skipped silently
    writeFileSync(join(root, "not-a-dir"), "test");
    mkdirSync(join(root, "valid-proj"));

    const result = await importBulk(root);
    expect(result.errors.length).toBe(0);
    expect(result.imported.length).toBe(1);
    rmSync(root, { recursive: true });
  });

  test("skipped entries appear in result", async () => {
    const root = mkdtempSync(join(tmpdir(), "bulk-skip-"));
    const sub = join(root, "proj-a");
    mkdirSync(sub);
    // Import first
    await importProject(sub);
    // Now bulk import should skip it
    const result = await importBulk(root);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]!.reason).toContain("Already registered");
    rmSync(root, { recursive: true });
  });
});

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

  test("importBulk returns error for non-existent directory", async () => {
    const result = await importBulk("/this/does/not/exist");
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.error).toContain("does not exist");
  });
});

describe("importProject edge cases", () => {
  test("skips already registered project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-existing-"));
    const { project } = await importProject(dir);
    expect(project).toBeDefined();

    // Try importing again — should be skipped
    const { skipped } = await importProject(dir);
    expect(skipped).toContain("Already registered");
    rmSync(dir, { recursive: true });
  });

  test("infers name from .project.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-proj-"));
    writeFileSync(join(dir, ".project.json"), JSON.stringify({ name: "from-proj-json" }));
    const { project } = await importProject(dir);
    expect(project?.name).toBe("from-proj-json");
    rmSync(dir, { recursive: true });
  });

  test("falls back to directory name when no metadata", async () => {
    const dirName = `test-dirname-${Date.now()}`;
    const dir = join(tmpdir(), dirName);
    mkdirSync(dir);
    const { project } = await importProject(dir);
    expect(project?.name).toBe(dirName);
    rmSync(dir, { recursive: true });
  });

  test("infers git remote from .git/config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-git-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), `[core]
  repositoryformatversion = 0
  filemode = true
[remote "origin"]
  url = https://github.com/user/repo.git
  fetch = +refs/heads/*:refs/remotes/origin/*
`);
    const { project } = await importProject(dir);
    expect(project?.git_remote).toBe("https://github.com/user/repo.git");
    rmSync(dir, { recursive: true });
  });

  test("calls onProgress callback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-progress-"));
    const messages: string[] = [];
    await importProject(dir, { onProgress: (msg) => messages.push(msg) });
    expect(messages.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true });
  });
});
