import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRoot,
  createWorkspace,
  recordWorkspaceEvent,
  startAgentRun,
  completeAgentRun,
  ensureCliAgent,
} from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import {
  buildProjectAgentContext,
  buildProjectHandoff,
  explainProjectResolution,
  getProjectAgentRunDetail,
  listProjectAgentRunsView,
  suggestProjectNextActions,
  toAgentText,
} from "./project-agent-assist.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

function makeProject(db: Database, overrides: { root?: boolean; status?: "active" | "archived" } = {}) {
  let rootId: string | undefined;
  if (overrides.root) {
    const root = createRoot({ name: "Agent Root", base_path: mkdtempSync(join(tmpdir(), "aa-root-")) }, db);
    rootId = root.id;
  }
  const dir = mkdtempSync(join(tmpdir(), "aa-project-"));
  return createWorkspace(
    {
      name: "Agent Project",
      slug: "agent-project",
      kind: "project",
      primary_path: dir,
      root_id: rootId,
      agent_id: ensureCliAgent(db).id,
    },
    db,
  );
}

describe("project-agent-assist: context", () => {
  test("builds a priming bundle for a resolved project by slug", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const ctx = await buildProjectAgentContext({ target: project.slug, db });
    expect(ctx.target.resolved).toBe(true);
    expect(ctx.target.source).toBe("id-or-slug");
    expect(ctx.project?.["slug"]).toBe("agent-project");
    expect(ctx.machine.hostname).toBeTruthy();
    expect(ctx.kind).toBe("projects.agent_context");
    db.close();
  });

  test("returns an unresolved bundle when nothing matches", async () => {
    const db = makeDb();
    const ctx = await buildProjectAgentContext({ target: "/nonexistent/path/xyz", db });
    expect(ctx.target.resolved).toBe(false);
    expect(ctx.target.note).toBeTruthy();
    expect(ctx.project).toBeUndefined();
    db.close();
  });

  test("renders agent-friendly text", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const text = toAgentText(await buildProjectAgentContext({ target: project.slug, db }));
    expect(text).toContain("Project context");
    expect(text).toContain(project.slug);
    db.close();
  });
});

describe("project-agent-assist: next", () => {
  test("suggests starting when an active project has no tmux session", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const res = await suggestProjectNextActions({ target: project.slug, db });
    const start = res.actions.find((a) => a.id === "start-session");
    expect(start).toBeDefined();
    expect(start!.command).toContain(`projects start ${project.slug}`);
    db.close();
  });

  test("suggests unarchive for archived projects", async () => {
    const db = makeDb();
    const project = makeProject(db);
    // archive by updating status via createWorkspace replacement is not trivial;
    // instead create an archived project directly through a second workspace.
    const archived = createWorkspace(
      { name: "Archived One", slug: "archived-one", kind: "project", agent_id: ensureCliAgent(db).id },
      db,
    );
    // mark archived by direct update
    db.run("UPDATE workspaces SET status = 'archived' WHERE id = ?", [archived.id]);
    const res = await suggestProjectNextActions({ target: "archived-one", db });
    expect(res.actions.some((a) => a.id === "unarchive")).toBe(true);
    db.close();
  });

  test("orders high priority first", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const res = await suggestProjectNextActions({ target: project.slug, db });
    const priorities = res.actions.map((a) => a.priority);
    const highIdx = priorities.indexOf("high");
    const lowIdx = priorities.indexOf("low");
    if (highIdx >= 0 && lowIdx >= 0) expect(highIdx).toBeLessThan(lowIdx);
    db.close();
  });
});

describe("project-agent-assist: why", () => {
  test("traces a successful id/slug resolution", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const res = await explainProjectResolution(project.slug, { db });
    expect(res.resolved).toBe(true);
    const idStep = res.steps.find((s) => s.source === "id-or-slug");
    expect(idStep?.matched).toBe(true);
    db.close();
  });

  test("reports ambiguity in steps and suggestions for duplicate names", async () => {
    const db = makeDb();
    createWorkspace({ name: "Dup", slug: "dup-a", kind: "project", agent_id: ensureCliAgent(db).id }, db);
    createWorkspace({ name: "Dup", slug: "dup-b", kind: "project", agent_id: ensureCliAgent(db).id }, db);
    const res = await explainProjectResolution("Dup", { db });
    const nameStep = res.steps.find((s) => s.source === "name");
    expect(nameStep?.detail).toContain("ambiguous");
    expect(res.suggestions.some((s) => s.includes("Disambiguate"))).toBe(true);
    db.close();
  });

  test("suggests registration when nothing matches", async () => {
    const db = makeDb();
    const res = await explainProjectResolution("never-heard-of-this", { db });
    expect(res.resolved).toBe(false);
    expect(res.suggestions.some((s) => s.includes("projects import") || s.includes("projects create"))).toBe(true);
    db.close();
  });
});

describe("project-agent-assist: handoff", () => {
  test("builds a handoff bundle with instructions and recent runs", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const run = startAgentRun({ workspace_id: project.id, prompt: "do the thing", model: "openai/gpt-4o-mini" }, db);
    completeAgentRun(run.id, { status: "completed", tool_calls: [{ name: "projects_list" }] }, db);
    const h = await buildProjectHandoff({ target: project.slug, db });
    expect(h.kind).toBe("projects.handoff");
    expect(h.project["slug"]).toBe(project.slug);
    expect(h.recent_runs.length).toBeGreaterThanOrEqual(1);
    expect(h.handoff_instructions).toContain(project.slug);
    db.close();
  });

  test("throws when project is not found", async () => {
    const db = makeDb();
    await expect(buildProjectHandoff({ target: "/no/such/path", db })).rejects.toThrow();
    db.close();
  });
});

describe("project-agent-assist: runs", () => {
  test("lists runs scoped to a project", async () => {
    const db = makeDb();
    const project = makeProject(db);
    startAgentRun({ workspace_id: project.id, prompt: "first" }, db);
    startAgentRun({ workspace_id: project.id, prompt: "second" }, db);
    const res = await listProjectAgentRunsView({ target: project.slug, db });
    expect(res.target.resolved).toBe(true);
    expect(res.runs.length).toBe(2);
    db.close();
  });

  test("shows full run detail including tool calls", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const run = startAgentRun({ workspace_id: project.id, prompt: "detailed" }, db);
    completeAgentRun(run.id, { tool_calls: [{ name: "projects_show" }, { name: "projects_list" }] }, db);
    const detail = await getProjectAgentRunDetail({ runId: run.id, target: project.slug, db });
    expect(detail.run.id).toBe(run.id);
    expect(detail.run.tool_calls_json.length).toBe(2);
    db.close();
  });

  test("does not leak run detail when target does not resolve", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const run = startAgentRun({ workspace_id: project.id, prompt: "private prompt" }, db);
    await expect(getProjectAgentRunDetail({ runId: run.id, target: "does-not-exist", db })).rejects.toThrow(
      "Project not found for run detail",
    );
    db.close();
  });

  test("returns empty list for unresolved target", async () => {
    const db = makeDb();
    const res = await listProjectAgentRunsView({ target: "/nope", db });
    expect(res.target.resolved).toBe(false);
    expect(res.runs).toEqual([]);
    db.close();
  });
});

describe("project-agent-assist: toAgentText", () => {
  test("handles primitives and arrays", () => {
    expect(toAgentText("hi")).toBe("hi");
    expect(toAgentText(42)).toBe("42");
    expect(toAgentText(["a", "b"])).toBe("a\nb");
  });

  test("renders a next result as readable text", async () => {
    const db = makeDb();
    const project = makeProject(db);
    const text = toAgentText(await suggestProjectNextActions({ target: project.slug, db }));
    expect(text).toContain("Suggested next actions");
    db.close();
  });
});
