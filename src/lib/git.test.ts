import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { gitInit, getCurrentBranch } from "./git.js";
import type { Project } from "../types/index.js";

function makeProject(path: string): Project {
  return {
    id: "prj_test",
    slug: "project-test",
    name: "Test Project",
    description: "A test project description",
    status: "active",
    path,
    tags: [],
    integrations: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_opened_at: null,
    synced_at: null,
    s3_bucket: null,
    s3_prefix: null,
    git_remote: null,
  };
}

describe("gitInit", () => {
  test("initial commit includes agent context and optional README", () => {
    const dir = mkdtempSync(join(tmpdir(), "project-git-init-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# Test\n", "utf-8");
    writeFileSync(join(dir, "CLAUDE.md"), "# Project: Test\n", "utf-8");
    writeFileSync(join(dir, "AGENTS.md"), "# Test\n", "utf-8");
    mkdirSync(join(dir, "docs"));

    gitInit(makeProject(dir));

    expect(getCurrentBranch(dir)).toBe("main");
    const files = execFileSync("git", ["ls-tree", "--name-only", "-r", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .sort();
    expect(files).toEqual(
      [".gitignore", ".project.json", "AGENTS.md", "CLAUDE.md", "README.md"].sort(),
    );

    rmSync(dir, { recursive: true });
  });
});
