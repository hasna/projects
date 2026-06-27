import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("project-first SDK barrel", () => {
  test("exports project-named services and launch helpers", () => {
    const source = readFileSync("src/index.ts", "utf-8");

    expect(source).toContain("CreateWorkspaceInput as CreateProjectInput");
    expect(source).toContain("Workspace as Project");
    expect(source).toContain("createWorkspace as createProject");
    expect(source).toContain("updateWorkspace as updateProject");
    expect(source).toContain("listWorkspaces as listProjects");
    expect(source).toContain("runWorkspaceAgentPrompt as runProjectAgentPrompt");
    expect(source).toContain("executeWorkspaceCreation as executeProjectCreation");
    expect(source).toContain("planWorkspaceCreation as planProjectCreation");
    expect(source).toContain("buildProjectAgentToolCatalog");
    expect(source).toContain("auditProjectAgentToolCalls");
    expect(source).toContain("cleanupProjectEvalArtifacts");
    expect(source).toContain("startProject");
    expect(source).toContain("PROJECT_MANAGEMENT_TAXONOMY");
    expect(source).toContain("PROJECT_START_AGENTS");
    expect(source).toContain("PROJECT_START_SESSION_POLICIES");
    expect(source).toContain("projectDashboardSummary");
    expect(source).toContain("projectExternalLinksSummary");
    expect(source).toContain("projectPathHealth");
    expect(source).toContain("mergeProjectTags");
    expect(source).toContain("removeProjectTags");
    expect(source).toContain("unlinkProjectIntegrationFields");
    expect(source).toContain("listWorkspacesByPath as listProjectsByPath");
    expect(source).toContain("getWorkspaceLocationByPath as getProjectLocationByPath");
    expect(source).toContain("resolveRegisteredProjectTarget");
    expect(source).toContain("readProjectMarker");
    expect(source).toContain("importWorkspace as importProject");
    expect(source).toContain("publishWorkspaceToGitHub as publishProjectToGitHub");
    expect(source).toContain("buildProjectCanvasPayload");
    expect(source).toContain("buildProjectCanvasesPayload");
    expect(source).toContain("PROJECT_RENDER_UI_CONTRACT");
    expect(source).not.toContain("export * from \"./types/workspace.js\"");
    expect(source).not.toMatch(/^\s*createWorkspace,\s*$/m);
    expect(source).not.toMatch(/^\s*runWorkspaceAgentPrompt,\s*$/m);
    expect(source).not.toContain("./types/index.js");
  });
});
