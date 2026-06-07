import { describe, expect, test } from "bun:test";
import { buildWorkspaceAgentSystemPrompt } from "./workspace-agent.js";

describe("workspace agent system prompt", () => {
  test("includes recorded workspace inventory and metadata for duplicate checks", () => {
    const system = buildWorkspaceAgentSystemPrompt({
      actorAgentId: "agt_test",
      tmuxAllowed: true,
      workspaceInventory: {
        count: 1,
        limit: 500,
        workspaces: [
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

    expect(system).toContain("workspace_inventory=");
    expect(system).toContain("first source of truth for deduplication");
    expect(system).toContain("hasnafamily-security");
    expect(system).toContain("home security planning and purchasing");
    expect(system).toContain("security cameras");
  });
});
