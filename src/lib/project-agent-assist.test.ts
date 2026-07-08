import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRoot,
  createWorkspace,
  startAgentRun,
  completeAgentRun,
  ensureCliAgent,
} from "../db/workspaces.js";
import type { Workspace } from "../types/workspace.js";
import { closeDatabase, getDatabase, PROJECTS_DB_PATH_ENV } from "../db/database.js";
import { resolveProjectStore, __resetProjectStore, type ProjectStore } from "../store/project-store.js";
import {
  buildProjectAgentContext,
  buildProjectHandoff,
  explainProjectResolution,
  getProjectAgentRunDetail,
  listProjectAgentRunsView,
  suggestProjectNextActions,
  toAgentText,
} from "./project-agent-assist.js";

// The agent-assist surfaces route every registry read through the active
// ProjectStore. These tests drive the LocalProjectStore backed by a fresh
// in-memory sqlite (via HASNA_PROJECTS_DB_PATH=:memory:) so each case is
// isolated and exercises the real store seam — not a bespoke db handle.
beforeEach(() => {
  process.env[PROJECTS_DB_PATH_ENV] = ":memory:";
  delete process.env["HASNA_PROJECTS_API_URL"];
  delete process.env["HASNA_PROJECTS_API_KEY"];
  delete process.env["HASNA_PROJECTS_STORAGE_MODE"];
  closeDatabase();
  __resetProjectStore();
});

afterEach(() => {
  closeDatabase();
  __resetProjectStore();
});

function localStore(): ProjectStore {
  return resolveProjectStore({});
}

function makeProject(overrides: { root?: boolean; status?: "active" | "archived" } = {}): Workspace {
  let rootId: string | undefined;
  if (overrides.root) {
    const root = createRoot({ name: "Agent Root", base_path: mkdtempSync(join(tmpdir(), "aa-root-")) });
    rootId = root.id;
  }
  const dir = mkdtempSync(join(tmpdir(), "aa-project-"));
  return createWorkspace({
    name: "Agent Project",
    slug: "agent-project",
    kind: "project",
    primary_path: dir,
    root_id: rootId,
    agent_id: ensureCliAgent().id,
  });
}

describe("project-agent-assist: context", () => {
  test("builds a priming bundle for a resolved project by slug", async () => {
    const project = makeProject();
    const ctx = await buildProjectAgentContext(localStore(), { target: project.slug });
    expect(ctx.target.resolved).toBe(true);
    expect(ctx.target.source).toBe("id-or-slug");
    expect(ctx.project?.["slug"]).toBe("agent-project");
    expect(ctx.machine.hostname).toBeTruthy();
    expect(ctx.kind).toBe("projects.agent_context");
  });

  test("returns an unresolved bundle when nothing matches", async () => {
    const ctx = await buildProjectAgentContext(localStore(), { target: "/nonexistent/path/xyz" });
    expect(ctx.target.resolved).toBe(false);
    expect(ctx.target.note).toBeTruthy();
    expect(ctx.project).toBeUndefined();
  });

  test("renders agent-friendly text", async () => {
    const project = makeProject();
    const text = toAgentText(await buildProjectAgentContext(localStore(), { target: project.slug }));
    expect(text).toContain("Project context");
    expect(text).toContain(project.slug);
  });
});

describe("project-agent-assist: next", () => {
  test("suggests starting when an active project has no tmux session", async () => {
    const project = makeProject();
    const res = await suggestProjectNextActions(localStore(), { target: project.slug });
    const start = res.actions.find((a) => a.id === "start-session");
    expect(start).toBeDefined();
    expect(start!.command).toContain(`projects start ${project.slug}`);
  });

  test("suggests unarchive for archived projects", async () => {
    const archived = createWorkspace({ name: "Archived One", slug: "archived-one", kind: "project", agent_id: ensureCliAgent().id });
    // mark archived by direct update through the same global db the store reads
    getDatabase().run("UPDATE workspaces SET status = 'archived' WHERE id = ?", [archived.id]);
    const res = await suggestProjectNextActions(localStore(), { target: "archived-one" });
    expect(res.actions.some((a) => a.id === "unarchive")).toBe(true);
  });

  test("orders high priority first", async () => {
    const project = makeProject();
    const res = await suggestProjectNextActions(localStore(), { target: project.slug });
    const priorities = res.actions.map((a) => a.priority);
    const highIdx = priorities.indexOf("high");
    const lowIdx = priorities.indexOf("low");
    if (highIdx >= 0 && lowIdx >= 0) expect(highIdx).toBeLessThan(lowIdx);
  });
});

describe("project-agent-assist: why", () => {
  test("traces a successful id/slug resolution", async () => {
    const project = makeProject();
    const res = await explainProjectResolution(localStore(), project.slug, {});
    expect(res.resolved).toBe(true);
    const idStep = res.steps.find((s) => s.source === "id-or-slug");
    expect(idStep?.matched).toBe(true);
  });

  test("reports ambiguity in steps and suggestions for duplicate names", async () => {
    createWorkspace({ name: "Dup", slug: "dup-a", kind: "project", agent_id: ensureCliAgent().id });
    createWorkspace({ name: "Dup", slug: "dup-b", kind: "project", agent_id: ensureCliAgent().id });
    const res = await explainProjectResolution(localStore(), "Dup", {});
    const nameStep = res.steps.find((s) => s.source === "name");
    expect(nameStep?.detail).toContain("ambiguous");
    expect(res.suggestions.some((s) => s.includes("Disambiguate"))).toBe(true);
  });

  test("suggests registration when nothing matches", async () => {
    const res = await explainProjectResolution(localStore(), "never-heard-of-this", {});
    expect(res.resolved).toBe(false);
    expect(res.suggestions.some((s) => s.includes("projects import") || s.includes("projects create"))).toBe(true);
  });
});

describe("project-agent-assist: handoff", () => {
  test("builds a handoff bundle with instructions and recent runs", async () => {
    const project = makeProject();
    const run = startAgentRun({ workspace_id: project.id, prompt: "do the thing", model: "openai/gpt-4o-mini" });
    completeAgentRun(run.id, { status: "completed", tool_calls: [{ name: "projects_list" }] });
    const h = await buildProjectHandoff(localStore(), { target: project.slug });
    expect(h.kind).toBe("projects.handoff");
    expect(h.project["slug"]).toBe(project.slug);
    expect(h.recent_runs.length).toBeGreaterThanOrEqual(1);
    expect(h.handoff_instructions).toContain(project.slug);
  });

  test("throws when project is not found", async () => {
    await expect(buildProjectHandoff(localStore(), { target: "/no/such/path" })).rejects.toThrow();
  });
});

describe("project-agent-assist: runs", () => {
  test("lists runs scoped to a project", async () => {
    const project = makeProject();
    startAgentRun({ workspace_id: project.id, prompt: "first" });
    startAgentRun({ workspace_id: project.id, prompt: "second" });
    const res = await listProjectAgentRunsView(localStore(), { target: project.slug });
    expect(res.target.resolved).toBe(true);
    expect(res.runs.length).toBe(2);
  });

  test("shows full run detail including tool calls", async () => {
    const project = makeProject();
    const run = startAgentRun({ workspace_id: project.id, prompt: "detailed" });
    completeAgentRun(run.id, { tool_calls: [{ name: "projects_show" }, { name: "projects_list" }] });
    const detail = await getProjectAgentRunDetail(localStore(), { runId: run.id, target: project.slug });
    expect(detail.run.id).toBe(run.id);
    expect(detail.run.tool_calls_json.length).toBe(2);
  });

  test("does not leak run detail when target does not resolve", async () => {
    const project = makeProject();
    const run = startAgentRun({ workspace_id: project.id, prompt: "private prompt" });
    await expect(getProjectAgentRunDetail(localStore(), { runId: run.id, target: "does-not-exist" })).rejects.toThrow(
      "Project not found for run detail",
    );
  });

  test("returns empty list for unresolved target", async () => {
    const res = await listProjectAgentRunsView(localStore(), { target: "/nope" });
    expect(res.target.resolved).toBe(false);
    expect(res.runs).toEqual([]);
  });
});

// Regression for the review's split-brain READ finding: on a machine flipped
// to api/cloud, `projects context` / `projects next` MUST resolve and read the
// SHARED cloud dataset through the Store's api transport — never the stale
// local sqlite island. We seed a LOCAL project with the same slug but a
// different id, drive the api store through a stub fetch, and assert the
// api-mode context returns the CLOUD id (proving no local read leaked in).
describe("project-agent-assist: api mode routes through the Store (no split-brain)", () => {
  const CLOUD_ENV = {
    HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
    HASNA_PROJECTS_API_KEY: "secret-key",
  };

  function apiStore(handler: (method: string, path: string) => unknown): { store: ProjectStore; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      const url = new URL(input);
      calls.push(`${method} ${url.pathname}${url.search}`);
      return new Response(JSON.stringify(handler(method, `${url.pathname}${url.search}`) ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    __resetProjectStore();
    return { store: resolveProjectStore(CLOUD_ENV, fetchImpl), calls };
  }

  const cloudProject = {
    id: "cloud-1",
    slug: "agent-project",
    name: "Cloud Project",
    kind: "project",
    status: "active",
    primary_path: null,
    root_id: null,
    recipe_id: null,
    tags: [],
    integrations: {},
    metadata: {},
    last_opened_at: null,
    updated_at: "2026-01-01T00:00:00Z",
  };

  test("context resolves the cloud project over HTTP, not the local sqlite row", async () => {
    // A stale local island row with the SAME slug but a different id.
    makeProject();
    const { store, calls } = apiStore((method, path) => {
      if (method === "GET" && path === "/v1/projects/agent-project") return cloudProject;
      if (method === "GET" && path.startsWith("/v1/projects/cloud-1/events")) return { events: [] };
      return {};
    });
    const ctx = await buildProjectAgentContext(store, { target: "agent-project" });
    expect(ctx.target.resolved).toBe(true);
    expect(ctx.project?.["id"]).toBe("cloud-1"); // cloud row, not the local one
    expect(calls.some((c) => c.includes("GET /v1/projects/agent-project"))).toBe(true);
  });

  test("next reads events over HTTP and skips machine-local doctor in api mode", async () => {
    makeProject();
    const { store, calls } = apiStore((method, path) => {
      if (method === "GET" && path === "/v1/projects/agent-project") return cloudProject;
      if (method === "GET" && path.startsWith("/v1/projects/cloud-1/events")) return { events: [] };
      return {};
    });
    const res = await suggestProjectNextActions(store, { target: "agent-project" });
    expect(res.target.resolved).toBe(true);
    // doctor findings are machine-local and must not appear for a cloud project.
    expect(res.actions.some((a) => a.id === "doctor-fix")).toBe(false);
    expect(calls.some((c) => c.includes("/v1/projects/cloud-1/events"))).toBe(true);
  });
});

describe("project-agent-assist: toAgentText", () => {
  test("handles primitives and arrays", () => {
    expect(toAgentText("hi")).toBe("hi");
    expect(toAgentText(42)).toBe("42");
    expect(toAgentText(["a", "b"])).toBe("a\nb");
  });

  test("renders a next result as readable text", async () => {
    const project = makeProject();
    const text = toAgentText(await suggestProjectNextActions(localStore(), { target: project.slug }));
    expect(text).toContain("Suggested next actions");
  });
});
