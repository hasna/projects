import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface SurfaceContract {
  operation: string;
  cli: string[];
  mcp: string[];
  promptAgent: string[];
  sdk: string[];
}

const contracts: SurfaceContract[] = [
  {
    operation: "create",
    cli: [".command(\"create\")"],
    mcp: ["\"projects_create\""],
    promptAgent: ["projects_create: tool("],
    sdk: ["executeWorkspaceCreation as executeProjectCreation", "planWorkspaceCreation as planProjectCreation"],
  },
  {
    operation: "import",
    cli: [".command(\"import <path>\")", ".command(\"import-github <repo>\")"],
    mcp: ["\"projects_import\"", "\"projects_import_github\"", "\"projects_scan_roots\""],
    promptAgent: ["projects_import: tool(", "projects_import_github: tool(", "projects_scan_roots: tool("],
    sdk: ["importWorkspace as importProject", "importWorkspaceFromGitHub as importProjectFromGitHub", "importRegisteredRoots"],
  },
  {
    operation: "list/show",
    cli: [".command(\"list\")", ".command(\"show <id-or-slug>\")"],
    mcp: ["\"projects_list\"", "\"projects_show\""],
    promptAgent: ["projects_list: tool(", "projects_show: tool("],
    sdk: ["listWorkspaces as listProjects", "resolveRegisteredProjectTarget"],
  },
  {
    operation: "update/link",
    cli: [".command(\"update <id-or-slug>\")", ".command(\"tag <id-or-slug> <tags...>\")", ".command(\"untag <id-or-slug> <tags...>\")", ".command(\"link <id-or-slug>\")", ".command(\"unlink <id-or-slug>\")"],
    mcp: ["\"projects_update\"", "\"projects_tag\"", "\"projects_untag\"", "\"projects_link\"", "\"projects_unlink\""],
    promptAgent: ["projects_update: tool(", "projects_tag: tool(", "projects_untag: tool(", "projects_link: tool(", "projects_unlink: tool("],
    sdk: ["updateWorkspace as updateProject", "mergeProjectTags", "removeProjectTags", "linkWorkspaceExternalIntegrations as linkProjectExternalIntegrations", "unlinkProjectIntegrationFields"],
  },
  {
    operation: "lifecycle",
    cli: [".command(\"archive <id-or-slug>\")", ".command(\"unarchive <id-or-slug>\")", ".command(\"delete <id-or-slug>\")"],
    mcp: ["\"projects_archive\"", "\"projects_unarchive\"", "\"projects_delete\""],
    promptAgent: ["projects_archive: tool(", "projects_unarchive: tool(", "projects_delete: tool("],
    sdk: ["archiveWorkspace as archiveProject", "unarchiveWorkspace as unarchiveProject", "deleteWorkspace as deleteProject"],
  },
  {
    operation: "start/status",
    cli: [".command(\"start\")", ".command(\"status [target]\")"],
    mcp: ["\"projects_start\"", "\"projects_tmux_status\""],
    promptAgent: ["projects_start: tool(", "projects_tmux_status: tool("],
    sdk: ["startProject", "projectTmuxStatus"],
  },
  {
    operation: "locations",
    cli: ["program.command(\"locations\")", ".command(\"add <project> <path>\")", ".command(\"list <project>\")"],
    mcp: ["\"projects_locations_add\"", "\"projects_locations_list\""],
    promptAgent: ["projects_locations_add: tool(", "projects_locations_list: tool("],
    sdk: ["addWorkspaceLocation as addProjectLocation", "listWorkspaceLocations as listProjectLocations", "listWorkspacesByPath as listProjectsByPath"],
  },
  {
    operation: "events",
    cli: ["program.command(\"events\")", ".command(\"record <project> <type>\")", ".command(\"list <project>\")"],
    mcp: ["\"projects_events_list\"", "\"projects_event_record\""],
    promptAgent: ["projects_events_list: tool(", "projects_event_record: tool("],
    sdk: ["listWorkspaceEvents as listProjectEvents", "recordWorkspaceEvent as recordProjectEvent"],
  },
  {
    operation: "doctor",
    cli: [".command(\"doctor [id-or-slug]\")"],
    mcp: ["\"projects_doctor\""],
    promptAgent: ["projects_doctor: tool("],
    sdk: ["doctorWorkspace as doctorProject"],
  },
  {
    operation: "agents",
    cli: ["program.command(\"agents\")", ".command(\"assign <project> <agent>\")"],
    mcp: ["\"projects_agents_assign\"", "\"projects_agents_list\""],
    promptAgent: ["projects_agents_assign: tool(", "projects_agents_list: tool("],
    sdk: ["assignAgentToWorkspace as assignAgentToProject", "listWorkspaceAgents as listProjectAgents"],
  },
];

function expectAll(source: string, tokens: string[], label: string, operation: string): void {
  for (const token of tokens) {
    expect(source, `${label} is missing ${operation} token ${token}`).toContain(token);
  }
}

describe("project surface parity", () => {
  test("core project operations are exposed through CLI, MCP, prompt agent, and SDK", () => {
    const cli = readFileSync("src/cli/commands/workspaces.ts", "utf-8");
    const mcp = readFileSync("src/mcp/index.ts", "utf-8");
    const promptAgent = readFileSync("src/lib/workspace-agent.ts", "utf-8");
    const sdk = readFileSync("src/index.ts", "utf-8");

    for (const contract of contracts) {
      expectAll(cli, contract.cli, "CLI", contract.operation);
      expectAll(mcp, contract.mcp, "MCP", contract.operation);
      expectAll(promptAgent, contract.promptAgent, "prompt agent", contract.operation);
      expectAll(sdk, contract.sdk, "SDK", contract.operation);
    }
  });

  test("public project surfaces do not reintroduce workspace aliases", () => {
    const mcp = readFileSync("src/mcp/index.ts", "utf-8");
    const cli = readFileSync("src/cli/index.ts", "utf-8");
    const completion = readFileSync("src/cli/commands/completion.ts", "utf-8");
    const sdk = readFileSync("src/index.ts", "utf-8");

    expect(mcp).not.toContain("\"projects_workspaces_");
    expect(cli).not.toContain("workspaces ");
    expect(completion).not.toContain("workspace>");
    expect(sdk).not.toContain("export * from \"./types/workspace.js\"");
    expect(sdk).not.toMatch(/^\s*createWorkspace,\s*$/m);
    expect(sdk).not.toMatch(/^\s*runWorkspaceAgentPrompt,\s*$/m);
  });
});
