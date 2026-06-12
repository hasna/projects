import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../types/workspace.js";
import {
  PROJECT_PRIORITIES,
  PROJECT_STAGES,
  PROJECT_START_AGENTS,
  PROJECT_START_SESSION_POLICIES,
  expandProjectIntegrationUnlinkKeys,
  mergeProjectIntegrationFields,
  mergeProjectManagementMetadata,
  mergeProjectTags,
  projectExternalLinksSummary,
  removeProjectTags,
  unlinkProjectIntegrationFields,
} from "./project-management.js";

describe("project management taxonomy", () => {
  test("normalizes canonical stage, priority, start agent, and start windows", () => {
    const metadata = mergeProjectManagementMetadata({ keep: true }, {
      stage: " Active ",
      priority: "CRITICAL",
      owner: " hasna ",
      launch_profile: " dev ",
      start_agent: "Claude",
      start_command: " claude --resume ",
      start_session_policy: "ERROR-IF-RUNNING",
      start_windows: [{ name: " server ", command: " bun run dev " }],
    });

    expect(metadata).toEqual({
      keep: true,
      stage: "active",
      priority: "critical",
      owner: "hasna",
      launch_profile: "dev",
      start_agent: "claude",
      start_command: "claude --resume",
      start_session_policy: "error-if-running",
      start_windows: [{ name: "server", command: "bun run dev" }],
    });
  });

  test("rejects unknown lifecycle and launcher values", () => {
    expect(PROJECT_STAGES).toContain("active");
    expect(PROJECT_PRIORITIES).toContain("critical");
    expect(PROJECT_START_AGENTS).toContain("codewith");
    expect(PROJECT_START_SESSION_POLICIES).toContain("error-if-running");
    expect(() => mergeProjectManagementMetadata({}, { stage: "blocked" })).toThrow("Invalid project stage");
    expect(() => mergeProjectManagementMetadata({}, { priority: "urgent" })).toThrow("Invalid project priority");
    expect(() => mergeProjectManagementMetadata({}, { start_agent: "vim" })).toThrow("Invalid project start_agent");
    expect(() => mergeProjectManagementMetadata({}, { start_session_policy: "replace" })).toThrow("Invalid project start_session_policy");
  });

  test("cleans and clears linked project-system integrations", () => {
    const integrations = mergeProjectIntegrationFields({
      todos_project_id: "todo_old",
      brief_id: "brief_old",
    }, {
      todos_project_id: " todo_new ",
      brief_id: null,
      brief_path: " docs/brief.md ",
    });

    expect(integrations).toEqual({
      todos_project_id: "todo_new",
      brief_path: "docs/brief.md",
    });
  });

  test("adds and removes project tags without replacing unrelated tags", () => {
    expect(mergeProjectTags(["security", "family"], [" family ", "cameras", ""])).toEqual(["security", "family", "cameras"]);
    expect(removeProjectTags(["security", "family", "cameras"], [" family ", "missing"])).toEqual(["security", "cameras"]);
  });

  test("expands and clears integration unlink groups", () => {
    expect(expandProjectIntegrationUnlinkKeys(["github", "todos-task-list", "brief_path", "files"])).toEqual([
      "github_repo",
      "github_url",
      "todos_task_list_id",
      "brief_path",
      "files_index_id",
    ]);

    expect(unlinkProjectIntegrationFields({
      github_repo: "hasna/app",
      github_url: "https://github.com/hasna/app",
      todos_project_id: "todo_123",
      todos_task_list_id: "list_456",
      brief_id: "brief_123",
      brief_path: "docs/brief.md",
      files_index_id: "idx_123",
    }, ["github", "todos", "brief_path"])).toEqual({
      brief_id: "brief_123",
      files_index_id: "idx_123",
    });
  });

  test("summarizes linked todos and brief references without task or brief content", () => {
    const root = mkdtempSync(join(tmpdir(), "project-links-"));
    const briefPath = join(root, "brief.md");
    writeFileSync(briefPath, "# Brief\n\nPrivate content that should not be embedded.");
    const project = {
      integrations: {
        todos_project_id: "todo_123",
        todos_task_list_id: "list_456",
        brief_id: "brief_789",
        brief_path: briefPath,
      },
    } as unknown as Workspace;

    expect(projectExternalLinksSummary(project)).toEqual({
      todos: {
        linked: true,
        status: "linked",
        project_id: "todo_123",
        task_list_id: "list_456",
      },
      brief: {
        linked: true,
        status: "linked",
        id: "brief_789",
        path: briefPath,
        path_exists: true,
      },
    });
  });
});
