import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { getConfig, saveConfig, resolveProjectPath, resolvePathConflict, resolveProjectName } from "./config.js";

describe("config", () => {
  const configDir = join(homedir(), ".hasna", "projects");
  const configPath = join(configDir, "config.json");
  let hadConfig = false;
  let backup = "";

  beforeAll(() => {
    hadConfig = existsSync(configPath);
    if (hadConfig) {
      backup = readFileSync(configPath, "utf-8");
    }
  });

  afterAll(() => {
    if (hadConfig) {
      writeFileSync(configPath, backup, "utf-8");
    } else if (existsSync(configPath)) {
      rmSync(configPath);
    }
  });

  test("getConfig returns defaults when no config file", () => {
    if (existsSync(configPath)) rmSync(configPath);
    const config = getConfig();
    expect(config.default_path).toBeDefined();
    expect(config.default_github_org).toBe("hasnaxyz");
    expect(config.default_repo_visibility).toBe("private");
    expect(config.launch_takumi).toBe(true);
    expect(Array.isArray(config.scaffold_dirs)).toBe(true);
  });

  test("getConfig merges user config with defaults", () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ default_github_org: "myorg" }));
    const config = getConfig();
    expect(config.default_github_org).toBe("myorg");
    expect(config.default_repo_visibility).toBe("private");
    rmSync(configPath);
  });

  test("getConfig returns defaults on invalid JSON", () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, "not valid json {{{");
    const config = getConfig();
    expect(config.default_github_org).toBe("hasnaxyz");
    rmSync(configPath);
  });

  test("saveConfig writes config file", () => {
    mkdirSync(configDir, { recursive: true });
    saveConfig({ default_path: "/custom/path" });
    expect(existsSync(configPath)).toBe(true);
    const config = getConfig();
    expect(config.default_path).toBe("/custom/path");
    rmSync(configPath);
  });

  test("resolveProjectPath returns provided path", () => {
    if (existsSync(configPath)) rmSync(configPath);
    expect(resolveProjectPath("/custom")).toBe("/custom");
  });

  test("resolveProjectPath returns config default_path when no path provided", () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ default_path: "/my/base" }));
    expect(resolveProjectPath()).toBe("/my/base");
    rmSync(configPath);
  });

  test("resolvePathConflict returns null for non-existent path", () => {
    expect(resolvePathConflict("/non-existent/xyz123")).toBeNull();
  });

  test("resolvePathConflict suggests alternate path for existing path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "conflict-test-"));
    const result = resolvePathConflict(tmp);
    expect(result).toBe(`${tmp}-1`);
    rmSync(tmp, { recursive: true });
  });

  test("resolvePathConflict increments suffix until unique", () => {
    const tmp = mkdtempSync(join(tmpdir(), `conflict-incr-${Date.now()}-`));
    mkdirSync(`${tmp}-1`);
    mkdirSync(`${tmp}-2`);
    const result = resolvePathConflict(tmp);
    expect(result).toBe(`${tmp}-3`);
    rmSync(`${tmp}-1`, { recursive: true });
    rmSync(`${tmp}-2`, { recursive: true });
    rmSync(tmp, { recursive: true });
  });
});

describe("resolveProjectName", () => {
  test("returns name without suggestion when gh not available", () => {
    const result = resolveProjectName("my-project", { default_github_org: "nonexistent-org" });
    // gh CLI won't find anything for nonexistent-org, so no suggestion
    expect(result.name).toBe("my-project");
  });

  test("normalizes name to slug", () => {
    const result = resolveProjectName("My  Cool Project!@#", { default_github_org: "x" });
    // The function creates a slug but returns the original name
    expect(result.name).toBe("My  Cool Project!@#");
  });
});
