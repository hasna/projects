import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "../db/database.js";
import { createWorkspace } from "../db/workspaces.js";
import {
  auditProjectAgentToolCalls,
  buildWorkspaceAgentSystemPrompt,
  buildWorkspaceInventoryContext,
  shouldRunProjectCreateFallback,
} from "./workspace-agent.js";

describe("project agent system prompt", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["HASNA_PROJECTS_DB_PATH"];
  });

  test("includes recorded project inventory and metadata for duplicate checks", () => {
    const system = buildWorkspaceAgentSystemPrompt({
      actorAgentId: "agt_test",
      tmuxAllowed: true,
      projectInventory: {
        count: 1,
        limit: 500,
        projects: [
          {
            slug: "hasnafamily-security",
            name: "Hasnafamily Security",
            description: "Family home security project",
            primary_path: "/home/hasna/workspace/hasna/hasnaxyz/project/hasnafamily-security",
            tags: ["hasnafamily", "family-security", "security-cameras"],
            metadata: {
              purpose: "home security planning and purchasing",
              focus: ["security cameras", "coverage planning"],
            },
          },
        ],
      },
    });

    expect(system).toContain("project_inventory=");
    expect(system).toContain("tool_catalog=");
    expect(system).toContain("first source of truth for deduplication");
    expect(system).toContain("writes_require_yes");
    expect(system).toContain("briefs, specs, decisions");
    expect(system).toContain("projects_start");
    expect(system).toContain("start_session_policy");
    expect(system).toContain("projects_tag");
    expect(system).toContain("projects_unlink");
    expect(system).toContain("projects_agents_assign");
    expect(system).toContain("projects_locations_add");
    expect(system).toContain("hasnafamily-security");
    expect(system).toContain("home security planning and purchasing");
    expect(system).toContain("security cameras");
  });

  test("does not append create fallback after showing an existing project", () => {
    expect(shouldRunProjectCreateFallback([
      {
        name: "projects_show",
        success: true,
        output: {
          project: {
            id: "wks_family",
            slug: "hasnafamily-security",
            name: "Hasnafamily Security",
          },
        },
      },
    ], "create a hasnafamily family security project")).toBe(false);
  });

  test("default project inventory hides prompt-agent eval fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "project-agent-inventory-"));
    process.env["HASNA_PROJECTS_DB_PATH"] = join(root, "projects.db");

    createWorkspace({ name: "Normal Project", slug: "normal-project", kind: "generic" });
    createWorkspace({ name: "Eval Hidden", slug: "eval-hidden", kind: "generic" });

    const inventory = buildWorkspaceInventoryContext() as { projects: Array<{ slug: string }> };
    expect(inventory.projects.map((project) => project.slug)).toEqual(["normal-project"]);
  });

  test("audits prompt-agent mutation tool calls against approval mode", () => {
    const planned = auditProjectAgentToolCalls([
      {
        name: "projects_update",
        input: { project: "app", priority: "high" },
        output: { status: "planned", input: { priority: "high" } },
      },
      {
        name: "projects_start",
        input: { target: "app" },
        output: { tmux: { dry_run: true } },
      },
    ], { approve: false, dryRun: false });

    expect(planned.writes_allowed).toBe(false);
    expect(planned.mutating_tool_calls).toEqual(["projects_update", "projects_start"]);
    expect(planned.planned_without_approval).toEqual(["projects_update", "projects_start"]);
    expect(planned.violations).toEqual([]);

    const unsafe = auditProjectAgentToolCalls([
      {
        name: "projects_delete",
        input: { project: "app" },
        output: { status: "marked_deleted" },
      },
    ], { approve: false, dryRun: false });

    expect(unsafe.destructive_tool_calls).toEqual(["projects_delete"]);
    expect(unsafe.violations).toHaveLength(1);
    expect(unsafe.violations[0]).toContain("projects_delete");
  });
});
