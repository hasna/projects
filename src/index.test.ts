import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("workspace-only SDK barrel", () => {
  test("does not publicly export legacy project APIs", () => {
    const source = readFileSync("src/index.ts", "utf-8");

    expect(source).toContain("./types/workspace.js");
    expect(source).toContain("createWorkspace");
    expect(source).toContain("runWorkspaceAgentPrompt");
    expect(source).not.toContain("createProject");
    expect(source).not.toContain("importProject");
    expect(source).not.toContain("publishProject");
    expect(source).not.toContain("./types/index.js");
  });
});
