import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "../db/database.js";
import { createWorkspace } from "../db/workspaces.js";
import type { ProjectStore } from "../store/project-store.js";
import type { Agent, Workspace, WorkspaceEvent } from "../types/workspace.js";
import {
  auditProjectAgentToolCalls,
  buildWorkspaceAgentSystemPrompt,
  buildWorkspaceAgentTools,
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

  test("default project inventory omits bulky metadata and integration values", () => {
    const root = mkdtempSync(join(tmpdir(), "project-agent-compact-inventory-"));
    process.env["HASNA_PROJECTS_DB_PATH"] = join(root, "projects.db");

    createWorkspace({
      name: "Noisy Project",
      slug: "noisy-project",
      description: "x".repeat(500),
      primary_path: `/tmp/${"very-long-segment-".repeat(20)}`,
      integrations: { github_url: "https://example.com/" + "long".repeat(100) },
      metadata: { notes: "secret-ish bulky note ".repeat(50) },
    });

    const inventory = buildWorkspaceInventoryContext() as { projects: Array<Record<string, unknown>> };
    const [project] = inventory.projects;
    expect(project?.slug).toBe("noisy-project");
    expect(project).not.toHaveProperty("description");
    expect(project).not.toHaveProperty("metadata");
    expect(project).not.toHaveProperty("integrations");
    expect(JSON.stringify(project)).not.toContain("secret-ish bulky note");
    expect(String(project?.primary_path).length).toBeLessThanOrEqual(160);
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

// --------------------------------------------------------------------------
// Cloud-mode split-brain regression: in api/cloud mode the prompt-agent's
// shared-registry mutations MUST route through the ProjectStore (cloud HTTP),
// never local sqlite. These tests inject a fake api-mode Store and assert the
// tool handlers call the corresponding store method and surface the cloud
// result — a local-sqlite write would instead throw / miss the cloud project.
// --------------------------------------------------------------------------

const LOCAL_ONLY_SENTINEL = "is a local-only operation and is not available in api/cloud mode.";

function makeCloudProject(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "wks_cloud",
    slug: "cloud-proj",
    name: "Cloud Proj",
    kind: "generic",
    status: "active",
    description: null,
    primary_path: null,
    git_remote: null,
    root_id: null,
    recipe_id: null,
    tags: [],
    integrations: {},
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_opened_at: null,
    ...overrides,
  } as unknown as Workspace;
}

interface StoreCall {
  method: string;
  args: unknown[];
}

function makeFakeApiStore() {
  const calls: StoreCall[] = [];
  const project = makeCloudProject();
  const track = <T>(method: string, ret: (args: unknown[]) => T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return ret(args);
    };
  // Any method NOT explicitly modelled here would be undefined and throw if a
  // handler tried to call it — a strong signal it took an unexpected path.
  const store = {
    mode: "api" as const,
    baseUrl: "https://projects.hasna.xyz/v1",
    resolveTarget: track("resolveTarget", () => project),
    updateProject: track("updateProject", () => makeCloudProject({ tags: ["cloud-tag"] })),
    archiveProject: track("archiveProject", () => makeCloudProject({ status: "archived" })),
    unarchiveProject: track("unarchiveProject", () => makeCloudProject({ status: "active" })),
    deleteProject: track("deleteProject", () => ({
      workspace: makeCloudProject({ status: "deleted" }),
      hard: false,
      id: "wks_cloud",
    })),
    recordEvent: track("recordEvent", () => ({
      id: "evt_cloud",
      workspace_id: "wks_cloud",
      event_type: "note",
      source: "agent",
      created_at: "2026-01-01T00:00:00.000Z",
    } as unknown as WorkspaceEvent)),
    // On-box sub-resource: api mode throws LocalOnlyOperationError instead of
    // silently writing local sqlite.
    addLocation: async (...args: unknown[]) => {
      calls.push({ method: "addLocation", args });
      throw new Error(`add project location ${LOCAL_ONLY_SENTINEL}`);
    },
  };
  return { store: store as unknown as ProjectStore, calls, project };
}

function apiTools(store: ProjectStore) {
  return buildWorkspaceAgentTools({
    store,
    actorAgent: { id: "agt_local", slug: "local", name: "Local", kind: "cli" } as unknown as Agent,
    approve: true,
    options: { prompt: "cloud split-brain test" } as unknown as Parameters<typeof buildWorkspaceAgentTools>[0]["options"],
    command: "projects --yes 'cloud split-brain test'",
    tmuxAllowed: false,
    createdWorkspaces: [],
  });
}

// The `ai` tool wrapper exposes the raw handler as `.execute`; invoking it
// directly bypasses schema coercion (inputs below are already valid).
async function invoke(toolDef: unknown, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const execute = (toolDef as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  return (await execute(input, { toolCallId: "test", messages: [] })) as Record<string, unknown>;
}

describe("prompt-agent mutations route through the Store in api/cloud mode", () => {
  test("projects_update calls store.updateProject (not local sqlite) with server-attributed agent", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_update, { project: "cloud-proj", priority: "high" });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("updated");
    expect((result.project as { id: string }).id).toBe("wks_cloud");

    const updateCall = calls.find((c) => c.method === "updateProject");
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[0]).toBe("wks_cloud");
    // api mode leaves attribution to the server (derived from the bearer key).
    expect((updateCall!.args[1] as { agent_id?: string }).agent_id).toBeUndefined();
    expect(calls.some((c) => c.method === "resolveTarget")).toBe(true);
  });

  test("projects_tag calls store.updateProject with the merged tag set", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_tag, { project: "cloud-proj", tags: ["new-tag"] });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("tagged");
    const updateCall = calls.find((c) => c.method === "updateProject");
    expect(updateCall).toBeDefined();
    expect((updateCall!.args[1] as { tags?: string[] }).tags).toEqual(["new-tag"]);
  });

  test("projects_untag calls store.updateProject", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_untag, { project: "cloud-proj", tags: ["cloud-tag"] });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("untagged");
    expect(calls.some((c) => c.method === "updateProject")).toBe(true);
  });

  test("projects_unlink calls store.updateProject", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_unlink, { project: "cloud-proj", keys: ["github"] });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("unlinked");
    expect(calls.some((c) => c.method === "updateProject")).toBe(true);
  });

  test("projects_archive calls store.archiveProject", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_archive, { project: "cloud-proj" });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("archived");
    const archiveCall = calls.find((c) => c.method === "archiveProject");
    expect(archiveCall).toBeDefined();
    expect(archiveCall!.args[0]).toBe("wks_cloud");
    expect((archiveCall!.args[1] as { agentId?: string }).agentId).toBeUndefined();
  });

  test("projects_unarchive calls store.unarchiveProject", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_unarchive, { project: "cloud-proj" });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("active");
    expect(calls.some((c) => c.method === "unarchiveProject")).toBe(true);
  });

  test("projects_delete calls store.deleteProject", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_delete, { project: "cloud-proj" });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("marked_deleted");
    const delCall = calls.find((c) => c.method === "deleteProject");
    expect(delCall).toBeDefined();
    expect(delCall!.args[0]).toBe("wks_cloud");
  });

  test("projects_event_record calls store.recordEvent for a project-scoped event", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_event_record, { project: "cloud-proj", event_type: "note" });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("recorded");
    const evCall = calls.find((c) => c.method === "recordEvent");
    expect(evCall).toBeDefined();
    expect(evCall!.args[0]).toBe("wks_cloud");
    expect((evCall!.args[1] as { event_type?: string }).event_type).toBe("note");
  });

  test("projects_locations_add surfaces the Store's local-only error cleanly (no silent local write)", async () => {
    const { store, calls } = makeFakeApiStore();
    const tools = apiTools(store);
    const result = await invoke(tools.projects_locations_add, { project: "cloud-proj", path: "/tmp/x" });

    // The write is attempted through the Store (which throws in api mode) and
    // the loud failure is returned as a clean tool error, never a local write.
    expect(calls.some((c) => c.method === "addLocation")).toBe(true);
    expect(String(result.error)).toContain(LOCAL_ONLY_SENTINEL);
    expect(result.status).toBeUndefined();
  });
});
