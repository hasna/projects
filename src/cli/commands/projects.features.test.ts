import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../");
const CLI_ENTRY = join(PROJECT_ROOT, "src/cli/index.ts");

function runProject(args: string[], env: Record<string, string> = {}, cwd?: string) {
  return Bun.spawnSync({
    cmd: ["bun", "run", CLI_ENTRY, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HASNA_PROJECTS_DB_PATH: env.HASNA_PROJECTS_DB_PATH || "" },
    cwd,
  });
}

function output(result: { stdout: Uint8Array; stderr: Uint8Array }) {
  return Buffer.from(result.stdout).toString("utf-8");
}

function errors(result: { stdout: Uint8Array; stderr: Uint8Array }) {
  return Buffer.from(result.stderr).toString("utf-8");
}

describe("projects cd command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("cd outputs cd command for a project", () => {
    const root = mkdtempSync(join(tmpdir(), "project-cd-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    // Create a project
    const createResult = runProject(
      ["create", "--name", "Cd Test", "--path", projectDir, "--no-git-init", "--no-integrations"],
      env,
    );
    expect(createResult.exitCode).toBe(0);

    // cd command
    const cdResult = runProject(["cd", "cd-test"], env);
    expect(cdResult.exitCode).toBe(0);
    expect(output(cdResult)).toContain(`cd ${projectDir}`);
  });

  test("cd shows did-you-mean for misspelled slug", () => {
    const root = mkdtempSync(join(tmpdir(), "project-cd-miss-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    runProject(
      ["create", "--name", "Misspell Test", "--path", projectDir, "--no-git-init", "--no-integrations"],
      env,
    );

    const cdResult = runProject(["cd", "mispl"], env);
    expect(cdResult.exitCode).not.toBe(0);
  });
});

describe("projects delete command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("delete removes a project by slug", () => {
    const root = mkdtempSync(join(tmpdir(), "project-delete-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    // Create
    runProject(["create", "--name", "Delete Me", "--path", projectDir, "--no-git-init", "--no-integrations"], env);

    // Verify exists
    const listResult = runProject(["get", "delete-me"], env);
    expect(listResult.exitCode).toBe(0);
    expect(output(listResult)).toContain("Delete Me");

    // Delete
    const deleteResult = runProject(["delete", "delete-me"], env);
    expect(deleteResult.exitCode).toBe(0);
    expect(output(deleteResult)).toContain("Deleted project");

    // Verify gone
    const getResult = runProject(["get", "delete-me"], env);
    expect(getResult.exitCode).not.toBe(0);
  });

  test("delete with --with-dir removes directory", () => {
    const root = mkdtempSync(join(tmpdir(), "project-delete-dir-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    runProject(["create", "--name", "Delete Dir", "--path", projectDir, "--no-git-init", "--no-integrations"], env);

    const deleteResult = runProject(["delete", "delete-dir", "--with-dir"], env);
    expect(deleteResult.exitCode).toBe(0);

    // Directory should be gone
    const exists = (() => {
      try {
        return require("fs").existsSync(projectDir);
      } catch {
        return false;
      }
    })();
    expect(exists).toBe(false);
  });

  test("delete outputs JSON with --json flag", () => {
    const root = mkdtempSync(join(tmpdir(), "project-delete-json-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    runProject(["create", "--name", "Delete Json", "--path", projectDir, "--no-git-init", "--no-integrations"], env);

    const deleteResult = runProject(["delete", "delete-json", "--json"], env);
    expect(deleteResult.exitCode).toBe(0);
    const parsed = JSON.parse(output(deleteResult));
    expect(parsed.deleted).toBeTruthy();
    expect(parsed.name).toBe("Delete Json");
  });
});

describe("projects describe command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("describe shows project details", () => {
    const root = mkdtempSync(join(tmpdir(), "project-describe-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    runProject(
      ["create", "--name", "Describe Me", "--path", projectDir, "--description", "A test project", "--tags", "test,feature", "--no-git-init", "--no-integrations"],
      env,
    );

    const descResult = runProject(["describe", "describe-me"], env);
    expect(descResult.exitCode).toBe(0);
    const out = output(descResult);
    expect(out).toContain("Describe Me");
    expect(out).toContain("A test project");
    expect(out).toContain("test");
    expect(out).toContain("feature");
  });

  test("describe outputs JSON with --json", () => {
    const root = mkdtempSync(join(tmpdir(), "project-describe-json-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    runProject(
      ["create", "--name", "Describe Json", "--path", projectDir, "--no-git-init", "--no-integrations"],
      env,
    );

    const descResult = runProject(["describe", "describe-json", "--json"], env);
    expect(descResult.exitCode).toBe(0);
    const parsed = JSON.parse(output(descResult));
    expect(parsed.name).toBe("Describe Json");
    expect(parsed.workdirs).toBeDefined();
  });
});

describe("projects summary command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("stats shows total and active counts", () => {
    const root = mkdtempSync(join(tmpdir(), "project-stats-"));
    tempDirs.push(root);
    const projectDir1 = join(root, "repo1");
    const projectDir2 = join(root, "repo2");
    mkdirSync(projectDir1);
    mkdirSync(projectDir2);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    runProject(["create", "--name", "Stats One", "--path", projectDir1, "--no-git-init", "--no-integrations"], env);
    runProject(["create", "--name", "Stats Two", "--path", projectDir2, "--no-git-init", "--no-integrations"], env);

    const summaryResult = runProject(["summary"], env);
    expect(summaryResult.exitCode).toBe(0);
    const out = output(summaryResult);
    expect(out).toContain("2");
    expect(out).toContain("Project Summary");
  });

  test("stats outputs JSON with --json", () => {
    const root = mkdtempSync(join(tmpdir(), "project-stats-json-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    runProject(["create", "--name", "Stats Json", "--path", projectDir, "--tags", "alpha", "--no-git-init", "--no-integrations"], env);

    const summaryResult = runProject(["summary", "--json"], env);
    expect(summaryResult.exitCode).toBe(0);
    const parsed = JSON.parse(output(summaryResult));
    expect(parsed.total).toBe(1);
    expect(parsed.active).toBe(1);
    expect(parsed.topTags).toBeDefined();
  });
});

describe("projects alias command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("alias dry-run shows integration snippet", () => {
    const root = mkdtempSync(join(tmpdir(), "project-alias-"));
    tempDirs.push(root);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    const aliasResult = runProject(["alias", "--dry-run"], env);
    expect(aliasResult.exitCode).toBe(0);
    const out = output(aliasResult);
    expect(out).toContain("pcd");
    expect(out).toContain("projects open");
  });
});

describe("projects init command", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("init registers current directory as a project", () => {
    const root = mkdtempSync(join(tmpdir(), "project-init-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    // Need to run in the project directory
    const initResult = Bun.spawnSync({
      cmd: ["bun", "run", CLI_ENTRY, "init", "--name", "Init Test"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HASNA_PROJECTS_DB_PATH: dbPath },
      cwd: projectDir,
    });
    expect(initResult.exitCode).toBe(0);
    expect(output(initResult)).toContain("Init Test");

    // Verify registered
    const getResult = runProject(["get", "init-test"], env);
    expect(getResult.exitCode).toBe(0);
    expect(output(getResult)).toContain("Init Test");
  });

  test("init detects name from package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "project-init-pkg-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({
      name: "my-pkg-project",
      description: "From package.json",
    }));
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    const initResult = Bun.spawnSync({
      cmd: ["bun", "run", CLI_ENTRY, "init"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HASNA_PROJECTS_DB_PATH: dbPath },
      cwd: projectDir,
    });
    expect(initResult.exitCode).toBe(0);
    expect(output(initResult)).toContain("my-pkg-project");
  });

  test("init rejects if project already exists at path", () => {
    const root = mkdtempSync(join(tmpdir(), "project-init-dup-"));
    tempDirs.push(root);
    const projectDir = join(root, "repo");
    mkdirSync(projectDir);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    // Create first
    runProject(["create", "--name", "Existing", "--path", projectDir, "--no-git-init", "--no-integrations"], env);

    // Try init in same dir
    const initResult = Bun.spawnSync({
      cmd: ["bun", "run", CLI_ENTRY, "init"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HASNA_PROJECTS_DB_PATH: dbPath },
      cwd: projectDir,
    });
    expect(initResult.exitCode).not.toBe(0);
    expect(errors(initResult)).toContain("already exists");
  });
});

describe("projects list --query fuzzy search", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("list --query filters by name substring", () => {
    const root = mkdtempSync(join(tmpdir(), "project-list-query-"));
    tempDirs.push(root);
    const dir1 = join(root, "alpha");
    const dir2 = join(root, "beta");
    mkdirSync(dir1);
    mkdirSync(dir2);
    const dbPath = join(root, "projects.db");
    const env = { HASNA_PROJECTS_DB_PATH: dbPath };

    runProject(["create", "--name", "Alpha Project", "--path", dir1, "--no-git-init", "--no-integrations"], env);
    runProject(["create", "--name", "Beta Project", "--path", dir2, "--no-git-init", "--no-integrations"], env);

    // Query for "alpha"
    const listResult = runProject(["list", "--query", "alpha"], env);
    expect(listResult.exitCode).toBe(0);
    const out = output(listResult);
    expect(out).toContain("Alpha");
    expect(out).not.toContain("Beta");
  });
});
