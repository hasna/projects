// Agent-assist library: features that help AI coding agents perform better
// when driving the `projects` CLI / MCP server.
//
// Six surfaces live here:
//   1. buildProjectAgentContext  -> `projects context`  (one-shot priming bundle)
//   2. suggestProjectNextActions -> `projects next`     (action suggestions)
//   3. explainProjectResolution  -> `projects why`      (resolution explainer)
//   4. buildProjectHandoff       -> `projects handoff`  (cross-agent bundle)
//   5. listProjectAgentRunsView  -> `projects runs`     (agent_runs ledger read)
//   6. toAgentText               -> `--for-agent`       (LLM-friendly text mode)
//
// All functions are pure derivations over existing storage state; none mutate.

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import {
  getAgent,
  getRecipe,
  getRoot,
  listAgentRuns,
  listWorkspaces,
  listWorkspacesByPath,
  listWorkspaceAgents,
  listWorkspaceEvents,
  listWorkspaceLocations,
  listWorkspaceLocks,
  resolveWorkspace,
} from "../db/workspaces.js";
import { getProjectBudgetStatuses } from "./budget.js";
import { doctorWorkspace, type WorkspaceDoctorResult } from "./workspace-doctor.js";
import {
  projectExternalLinksSummary,
  projectManagementSummary,
  projectPathHealth,
} from "./project-management.js";
import {
  isProjectPathLike,
  normalizeProjectPath,
  readProjectMarker,
  resolveRegisteredProjectTarget,
  type ProjectMarkerReference,
  type ProjectResolverSource,
  type ProjectTargetResolution,
} from "./project-resolver.js";
import { PROJECT_RENDER_SCHEMA_VERSION } from "./project-render.js";
import { listSessions } from "./tmux.js";
import type {
  AgentRun,
  JsonObject,
  Root,
  Workspace,
  WorkspaceAgentAssignment,
  WorkspaceEvent,
  WorkspaceLocation,
} from "../types/workspace.js";

const MACHINE_ID = (() => {
  try {
    return hostname().replace(/\.local$/, "");
  } catch {
    return "unknown";
  }
})();

// Resolution can throw (ambiguous name, missing path). For agent-assist
// surfaces we prefer an "unresolved" result over a thrown error so agents get
// actionable output instead of a stack trace.
function safeResolveProjectTarget(
  target: string,
  db?: Database,
): ProjectTargetResolution | null {
  try {
    return resolveRegisteredProjectTarget(target, { allowPath: true, allowMarker: true, db });
  } catch {
    return null;
  }
}

export interface ProjectAgentContextOptions {
  target?: string;
  cwd?: string;
  eventsLimit?: number;
  siblingsLimit?: number;
  db?: Database;
}

export interface ProjectAgentContext {
  schema_version: typeof PROJECT_RENDER_SCHEMA_VERSION;
  kind: "projects.agent_context";
  machine: { hostname: string };
  target: { input: string; resolved: boolean; source: ProjectResolverSource | "none"; note?: string };
  project?: JsonObject;
  root?: JsonObject;
  recipe?: JsonObject;
  assigned_agents?: WorkspaceAgentAssignment[];
  siblings?: JsonObject[];
  recent_events?: WorkspaceEvent[];
  tmux?: { available: boolean; session_names: string[] };
  integrations?: JsonObject;
  doctor?: { ok: boolean; checks: { code: string; status: string; message: string }[] };
  budgets?: { exhausted: boolean; warnings: string[] }[];
  marker?: ProjectMarkerReference | null;
}

export function buildProjectAgentContext(options: ProjectAgentContextOptions = {}): ProjectAgentContext {
  const cwd = options.cwd ?? process.cwd();
  const target = options.target ?? cwd;
  const eventsLimit = options.eventsLimit ?? 8;
  const siblingsLimit = options.siblingsLimit ?? 12;

  const resolution = safeResolveProjectTarget(target, options.db);
  const base: ProjectAgentContext = {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.agent_context",
    machine: { hostname: MACHINE_ID },
    target: {
      input: target,
      resolved: Boolean(resolution),
      source: resolution?.source ?? "none",
      note: resolution ? undefined : "no registered project matched; pass an id/slug/name/path or run from a project dir",
    },
  };

  if (!resolution) return base;

  const project = resolution.project;
  const root = project.root_id ? getRoot(project.root_id, options.db) : null;
  const recipe = project.recipe_id ? getRecipe(project.recipe_id, options.db) : null;
  const agents = listWorkspaceAgents(project.id, options.db);
  const events = listWorkspaceEvents(project.id, options.db).slice(0, eventsLimit);
  const locations = listWorkspaceLocations(project.id, options.db);

  const siblings = root
    ? listWorkspaces({ root_id: root.id, limit: siblingsLimit + 1 }, options.db)
        .filter((w) => w.id !== project.id && w.status !== "deleted")
        .slice(0, siblingsLimit)
    : [];

  let tmuxBlock: ProjectAgentContext["tmux"];
  try {
    const sessions = listSessions();
    const matching = sessions
      .map((s) => s.name)
      .filter((name) => name.includes(project.slug) || (project.name && name.includes(project.slug)));
    tmuxBlock = { available: true, session_names: matching };
  } catch {
    tmuxBlock = { available: false, session_names: [] };
  }

  let doctorBlock: ProjectAgentContext["doctor"] | undefined;
  try {
    const doc = doctorWorkspace(project, {}, options.db) as WorkspaceDoctorResult;
    doctorBlock = {
      ok: doc.ok,
      checks: doc.checks.map((c) => ({ code: c.code, status: c.status, message: c.message })),
    };
  } catch {
    doctorBlock = undefined;
  }

  let budgetBlock: ProjectAgentContext["budgets"] | undefined;
  try {
    const statuses = getProjectBudgetStatuses({ workspace_id: project.id }, options.db);
    budgetBlock = statuses.map((s) => ({ exhausted: s.exhausted, warnings: s.warnings }));
  } catch {
    budgetBlock = undefined;
  }

  const links = projectExternalLinksSummary(project);
  const integrations: JsonObject = {
    github_repo: project.integrations.github_repo ?? null,
    github_url: project.integrations.github_url ?? null,
    todos: links.todos,
    brief: {
      id: links.brief.id,
      path: links.brief.path,
      path_exists: links.brief.path ? existsSync(links.brief.path) : null,
    },
    conversations_space: project.integrations.conversations_space ?? null,
    conversations_channel: project.integrations.conversations_channel ?? null,
    mementos_project_id: project.integrations.mementos_project_id ?? null,
    files_index_id: project.integrations.files_index_id ?? null,
  };

  return {
    ...base,
    project: compactProject(project, locations),
    root: root ? compactRoot(root) : undefined,
    recipe: recipe ? { id: recipe.id, slug: recipe.slug, name: recipe.name } : undefined,
    assigned_agents: agents,
    siblings: siblings.map((w) => ({ id: w.id, slug: w.slug, name: w.name, status: w.status })),
    recent_events: events,
    tmux: tmuxBlock,
    integrations,
    doctor: doctorBlock,
    budgets: budgetBlock,
    marker: resolution.marker ?? null,
  };
}

function compactProject(project: Workspace, locations: WorkspaceLocation[]): JsonObject {
  const management = projectManagementSummary(project);
  const health = projectPathHealth(project);
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    kind: project.kind,
    status: project.status,
    stage: management.stage,
    priority: management.priority,
    owner: management.owner,
    primary_path: project.primary_path,
    path_health: health,
    locations: locations.map((l) => ({ path: l.path, label: l.label, kind: l.kind, machine_id: l.machine_id })),
    tags: project.tags,
    launch: {
      start_agent: management.start_agent,
      start_command: management.start_command,
      launch_profile: management.launch_profile,
      session_policy: management.start_session_policy,
      windows: management.start_windows,
    },
    last_opened_at: project.last_opened_at,
    updated_at: project.updated_at,
  };
}

function compactRoot(root: Root): JsonObject {
  return {
    id: root.id,
    slug: root.slug,
    name: root.name,
    base_path: root.base_path,
    default_kind: root.default_kind,
    path_template: root.path_template,
    github_org: root.github_org,
    repo_visibility: root.repo_visibility,
  };
}

// ---------------------------------------------------------------------------
// projects next — action suggestions
// ---------------------------------------------------------------------------

export interface ProjectNextAction {
  id: string;
  priority: "high" | "medium" | "low";
  title: string;
  rationale: string;
  command: string;
}

export interface ProjectNextOptions {
  target?: string;
  cwd?: string;
  limit?: number;
  db?: Database;
}

export interface ProjectNextResult {
  schema_version: typeof PROJECT_RENDER_SCHEMA_VERSION;
  kind: "projects.next";
  machine: { hostname: string };
  target: { input: string; resolved: boolean };
  actions: ProjectNextAction[];
}

export function suggestProjectNextActions(options: ProjectNextOptions = {}): ProjectNextResult {
  const cwd = options.cwd ?? process.cwd();
  const target = options.target ?? cwd;
  const limit = options.limit ?? 6;
  const actions: ProjectNextAction[] = [];

  const resolution = safeResolveProjectTarget(target, options.db);
  const result: ProjectNextResult = {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.next",
    machine: { hostname: MACHINE_ID },
    target: { input: target, resolved: Boolean(resolution) },
    actions,
  };
  if (!resolution) return result;

  const project = resolution.project;
  const slug = project.slug;

  // 1. active project with no running tmux session -> start
  if (project.status === "active") {
    const running = safeTmuxSessionNames();
    const matches = running.filter((n) => n.includes(slug));
    if (matches.length === 0) {
      actions.push({
        id: "start-session",
        priority: "high",
        title: `Start/resume tmux session for ${project.name}`,
        rationale: "Project is active but no tmux session matching its slug is running.",
        command: `projects start ${slug}`,
      });
    }
  }

  // 2. doctor findings -> doctor --fix
  try {
    const doc = doctorWorkspace(project, {}, options.db) as WorkspaceDoctorResult;
    const fixable = doc.checks.filter((c) => c.fixable);
    const errors = doc.checks.filter((c) => c.status === "error");
    if (fixable.length > 0 || errors.length > 0) {
      actions.push({
        id: "doctor-fix",
        priority: errors.length > 0 ? "high" : "medium",
        title: `Run doctor${fixable.length ? " and apply fixes" : ""} for ${project.name}`,
        rationale: `doctor reported ${errors.length} error(s) and ${fixable.length} fixable check(s).`,
        command: `projects doctor ${slug} --fix`,
      });
    }
  } catch {
    // doctor may fail when path is missing; ignore.
  }

  // 3. near-limit budget -> budgets remaining
  try {
    const statuses = getProjectBudgetStatuses({ workspace_id: project.id }, options.db);
    const concerning = statuses.filter((s) => s.exhausted || s.warnings.length > 0);
    if (concerning.length > 0) {
      actions.push({
        id: "budget-check",
        priority: concerning.some((s) => s.exhausted) ? "high" : "medium",
        title: `Review budget for ${project.name}`,
        rationale: `${concerning.length} budget(s) exhausted or near limit.`,
        command: `projects budgets remaining --project ${slug}`,
      });
    }
  } catch {
    // budgets optional
  }

  // 4. unresolved rename report from last start -> sessions --unrenamed
  const startEvents = listWorkspaceEvents(project.id, options.db)
    .filter((e) => e.event_type === "started");
  if (startEvents.length > 0) {
    const last = startEvents.at(-1)!;
    const after = (last.after_json ?? {}) as JsonObject;
    const renameReport = after.rename_report as JsonObject[] | undefined;
    const unrenamed = Array.isArray(renameReport) ? renameReport.filter((r) => r && (r as JsonObject).unrenamed) : [];
    if (unrenamed.length > 0) {
      actions.push({
        id: "fix-rename",
        priority: "medium",
        title: `Resolve ${unrenamed.length} pending coding-agent rename(s)`,
        rationale: "Last start recorded manual/unsupported rename work for coding-agent panes.",
        command: `projects sessions ${slug} --unrenamed`,
      });
    }
  }

  // 5. stale partial create with rollback records -> cleanup-create
  const createEvents = listWorkspaceEvents(project.id, options.db).filter((e) => e.event_type === "created");
  if (createEvents.length > 0) {
    const lastCreate = createEvents.at(-1)!;
    const after = (lastCreate.after_json ?? {}) as JsonObject;
    const plan = after.plan as JsonObject | undefined;
    const rollback = plan?.rollback_actions as JsonObject[] | undefined;
    const pathHealth = projectPathHealth(project);
    if (Array.isArray(rollback) && rollback.length > 0 && pathHealth.status !== "ok") {
      actions.push({
        id: "cleanup-create",
        priority: "high",
        title: `Clean up partial/failed creation for ${project.name}`,
        rationale: "Last create recorded rollback actions and the project path is missing.",
        command: `projects cleanup-create ${slug}`,
      });
    }
  }

  // 6. open locks -> unlock
  const locks = listWorkspaceLocks(options.db).filter((l) => l.workspace_id === project.id);
  if (locks.length > 0) {
    actions.push({
      id: "release-locks",
      priority: "medium",
      title: `Release ${locks.length} stale project mutation lock(s)`,
      rationale: "Project has open mutation locks that may block edits.",
      command: `projects unlock ${locks[0]!.lock_key}`,
    });
  }

  // 7. paused project recently touched -> unarchive or start
  if (project.status === "archived") {
    actions.push({
      id: "unarchive",
      priority: "low",
      title: `Unarchive ${project.name} if work is resuming`,
      rationale: "Project is archived; unarchive before starting or updating.",
      command: `projects unarchive ${slug}`,
    });
  }

  actions.sort((a, b) => rankPriority(a.priority) - rankPriority(b.priority));
  result.actions = actions.slice(0, limit);
  return result;
}

function rankPriority(p: ProjectNextAction["priority"]): number {
  return p === "high" ? 0 : p === "medium" ? 1 : 2;
}

function safeTmuxSessionNames(): string[] {
  try {
    return listSessions().map((s) => s.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// projects why — resolution explainer
// ---------------------------------------------------------------------------

export interface ProjectWhyStep {
  source: ProjectResolverSource;
  tried: boolean;
  matched: boolean;
  detail: string;
}

export interface ProjectWhyResult {
  schema_version: typeof PROJECT_RENDER_SCHEMA_VERSION;
  kind: "projects.why";
  target: string;
  resolved: boolean;
  resolution?: ProjectTargetResolution;
  steps: ProjectWhyStep[];
  marker?: ProjectMarkerReference | null;
  suggestions: string[];
}

export function explainProjectResolution(target: string | undefined, options: { cwd?: string; db?: Database } = {}): ProjectWhyResult {
  const cwd = options.cwd ?? process.cwd();
  const normalizedTarget = target?.trim() || cwd;
  const db = options.db;
  const steps: ProjectWhyStep[] = [];
  const suggestions: string[] = [];

  // id-or-slug
  const byIdOrSlug = resolveWorkspace(normalizedTarget, db);
  steps.push({
    source: "id-or-slug",
    tried: true,
    matched: Boolean(byIdOrSlug),
    detail: byIdOrSlug ? `matched ${byIdOrSlug.slug} (${byIdOrSlug.id})` : "no workspace with id or slug",
  });

  // name (exact, case-insensitive)
  const lower = normalizedTarget.toLowerCase();
  const nameMatches = listWorkspaces({ query: normalizedTarget, limit: 200 }, db)
    .filter((w) => w.status !== "deleted")
    .filter((w) => w.name.toLowerCase() === lower);
  steps.push({
    source: "name",
    tried: true,
    matched: nameMatches.length === 1,
    detail:
      nameMatches.length === 0
        ? "no exact name match"
        : nameMatches.length === 1
          ? `matched ${nameMatches[0]!.slug}`
          : `ambiguous: ${nameMatches.map((w) => w.slug).join(", ")}`,
  });

  // path
  let pathMatched: Workspace[] = [];
  let pathTried = false;
  if (isProjectPathLike(normalizedTarget)) {
    pathTried = true;
    const path = normalizeProjectPath(normalizedTarget);
    if (existsSync(path) && existsSync(path) && statIsDir(path)) {
      pathMatched = listWorkspacesByPath(path, db).filter((w) => w.status !== "deleted");
      steps.push({
        source: "path",
        tried: true,
        matched: pathMatched.length === 1,
        detail:
          pathMatched.length === 0
            ? `directory exists at ${path} but no project registers it`
            : pathMatched.length === 1
              ? `matched ${pathMatched[0]!.slug} by path`
              : `ambiguous path: ${pathMatched.map((w) => w.slug).join(", ")}`,
      });
    } else {
      steps.push({
        source: "path",
        tried: true,
        matched: false,
        detail: `path-like target ${path} does not exist or is not a directory`,
      });
    }
  } else {
    steps.push({ source: "path", tried: false, matched: false, detail: "target is not path-like" });
  }

  // marker
  let marker: ProjectMarkerReference | null = null;
  if (isProjectPathLike(normalizedTarget)) {
    const path = normalizeProjectPath(normalizedTarget);
    if (statIsDir(path)) {
      marker = readProjectMarker(path);
      steps.push({
        source: "marker",
        tried: true,
        matched: Boolean(marker),
        detail: marker
          ? `marker found at ${marker.path} (id=${marker.id ?? "—"}, slug=${marker.slug ?? "—"}, legacy=${marker.legacy})`
          : `no project marker in ${path}`,
      });
      if (marker && (!marker.id || !marker.slug)) {
        suggestions.push("Marker is missing id/slug; recreate it via `projects import <path>` or `projects create`.");
      }
    } else {
      steps.push({ source: "marker", tried: false, matched: false, detail: "cannot read marker from a non-directory path" });
    }
  } else {
    steps.push({ source: "marker", tried: false, matched: false, detail: "target is not path-like" });
  }

  const resolution = safeResolveProjectTarget(normalizedTarget, db);

  if (!resolution) {
    if (nameMatches.length > 1) suggestions.push("Disambiguate by slug or id instead of name.");
    if (pathMatched.length > 1) suggestions.push("Multiple projects register this path; reference one by slug.");
    if (marker && !byIdOrSlug) suggestions.push("Marker references an unknown project; run `projects doctor` or re-import.");
    if (!steps.some((s) => s.matched)) {
      suggestions.push("No match. Register the folder with `projects import <path>` or create with `projects create`.");
    }
  }

  return {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.why",
    target: normalizedTarget,
    resolved: Boolean(resolution),
    resolution: resolution ?? undefined,
    steps,
    marker: marker ?? undefined,
    suggestions,
  };
}

function statIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// projects handoff — cross-agent / cross-machine handoff bundle
// ---------------------------------------------------------------------------

export interface ProjectHandoffOptions {
  target?: string;
  cwd?: string;
  eventsLimit?: number;
  runsLimit?: number;
  db?: Database;
}

export interface ProjectHandoff {
  schema_version: typeof PROJECT_RENDER_SCHEMA_VERSION;
  kind: "projects.handoff";
  machine: { hostname: string };
  project: JsonObject;
  root?: JsonObject;
  integrations: JsonObject;
  tmux: { available: boolean; session_names: string[] };
  open_locks: { lock_key: string; reason: string | null; created_at: string }[];
  recent_events: WorkspaceEvent[];
  recent_runs: AgentRun[];
  handoff_instructions: string;
}

export function buildProjectHandoff(options: ProjectHandoffOptions = {}): ProjectHandoff {
  const cwd = options.cwd ?? process.cwd();
  const target = options.target ?? cwd;
  const eventsLimit = options.eventsLimit ?? 10;
  const runsLimit = options.runsLimit ?? 5;

  const resolution = safeResolveProjectTarget(target, options.db);
  if (!resolution) throw new Error(`Project not found for handoff: ${target}`);

  const project = resolution.project;
  const root = project.root_id ? getRoot(project.root_id, options.db) : null;
  const events = listWorkspaceEvents(project.id, options.db).slice(0, eventsLimit);
  const runs = listAgentRuns({ workspace_id: project.id, limit: runsLimit }, options.db);
  const locks = listWorkspaceLocks(options.db)
    .filter((l) => l.workspace_id === project.id)
    .map((l) => ({ lock_key: l.lock_key, reason: l.reason, created_at: l.created_at }));

  const links = projectExternalLinksSummary(project);
  const integrations: JsonObject = {
    github_repo: project.integrations.github_repo ?? null,
    github_url: project.integrations.github_url ?? null,
    todos: links.todos,
    brief: { id: links.brief.id, path: links.brief.path, path_exists: links.brief.path ? existsSync(links.brief.path) : null },
    conversations_space: project.integrations.conversations_space ?? null,
    conversations_channel: project.integrations.conversations_channel ?? null,
  };

  const tmuxSessions = safeTmuxSessionNames().filter((n) => n.includes(project.slug));

  const instructions = [
    `Project: ${project.name} (${project.slug}) on machine ${MACHINE_ID}.`,
    `Primary path: ${project.primary_path ?? "(none)"}.`,
    root ? `Root: ${root.name} (${root.slug}) at ${root.base_path}.` : "Root: (none).",
    `Status: ${project.status}. Stage: ${projectManagementSummary(project).stage ?? "—"}.`,
    `Running tmux sessions on this machine: ${tmuxSessions.length ? tmuxSessions.join(", ") : "none"}.`,
    locks.length ? `Open locks: ${locks.length} — release or wait before mutating.` : "No open locks.",
    `Last ${events.length} event(s) and ${runs.length} agent run(s) are included for continuity.`,
    "Continue from the most recent event/run; do not redo finished work.",
  ].join("\n");

  return {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.handoff",
    machine: { hostname: MACHINE_ID },
    project: compactProject(project, listWorkspaceLocations(project.id, options.db)),
    root: root ? compactRoot(root) : undefined,
    integrations,
    tmux: { available: tmuxSessions.length > 0 || tmuxAvailableRaw(), session_names: tmuxSessions },
    open_locks: locks,
    recent_events: events,
    recent_runs: runs,
    handoff_instructions: instructions,
  };
}

function tmuxAvailableRaw(): boolean {
  try {
    listSessions();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// projects runs — agent_runs ledger read view
// ---------------------------------------------------------------------------

export interface ProjectRunsOptions {
  target?: string;
  cwd?: string;
  limit?: number;
  status?: AgentRun["status"];
  db?: Database;
}

export interface ProjectRunsResult {
  schema_version: typeof PROJECT_RENDER_SCHEMA_VERSION;
  kind: "projects.runs";
  target: { input: string; resolved: boolean };
  runs: Array<{
    id: string;
    status: AgentRun["status"];
    agent_id: string | null;
    model: string | null;
    prompt: string;
    tool_calls: number;
    error: string | null;
    started_at: string;
    completed_at: string | null;
  }>;
}

export function listProjectAgentRunsView(options: ProjectRunsOptions = {}): ProjectRunsResult {
  const cwd = options.cwd ?? process.cwd();
  const target = options.target ?? cwd;
  const limit = options.limit ?? 20;
  const resolution = safeResolveProjectTarget(target, options.db);
  const result: ProjectRunsResult = {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.runs",
    target: { input: target, resolved: Boolean(resolution) },
    runs: [],
  };
  if (!resolution) return result;

  const runs = listAgentRuns(
    { workspace_id: resolution.project.id, limit, status: options.status },
    options.db,
  );
  result.runs = runs.map((r) => ({
    id: r.id,
    status: r.status,
    agent_id: r.agent_id,
    model: r.model,
    prompt: r.prompt.length > 200 ? r.prompt.slice(0, 200) + "…" : r.prompt,
    tool_calls: Array.isArray(r.tool_calls_json) ? r.tool_calls_json.length : 0,
    error: r.error,
    started_at: r.started_at,
    completed_at: r.completed_at,
  }));
  return result;
}

export interface ProjectRunDetailOptions {
  target?: string;
  cwd?: string;
  runId: string;
  db?: Database;
}

export interface ProjectRunDetail {
  schema_version: typeof PROJECT_RENDER_SCHEMA_VERSION;
  kind: "projects.run_detail";
  run: AgentRun;
  agent?: JsonObject;
}

export function getProjectAgentRunDetail(options: ProjectRunDetailOptions): ProjectRunDetail {
  const cwd = options.cwd ?? process.cwd();
  const target = options.target ?? cwd;
  const resolution = safeResolveProjectTarget(target, options.db);
  if (!resolution) throw new Error(`Project not found for run detail: ${target}`);
  const runs = listAgentRuns(
    { workspace_id: resolution.project.id, limit: 200 },
    options.db,
  );
  const run = runs.find((r) => r.id === options.runId);
  if (!run) throw new Error(`Agent run not found for project: ${options.runId}`);
  const agent = run.agent_id ? getAgent(run.agent_id, options.db) : null;
  return {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.run_detail",
    run,
    agent: agent ? { id: agent.id, slug: agent.slug, name: agent.name, kind: agent.kind } : undefined,
  };
}

// ---------------------------------------------------------------------------
// --for-agent text mode
// ---------------------------------------------------------------------------

export function toAgentText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => toAgentText(v)).join("\n");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const kind = obj["kind"];
    if (kind === "projects.agent_context") return contextToText(obj as unknown as ProjectAgentContext);
    if (kind === "projects.next") return nextToText(obj as unknown as ProjectNextResult);
    if (kind === "projects.why") return whyToText(obj as unknown as ProjectWhyResult);
    if (kind === "projects.handoff") return handoffToText(obj as unknown as ProjectHandoff);
    if (kind === "projects.runs") return runsToText(obj as unknown as ProjectRunsResult);
    return genericObjectToText(obj);
  }
  return String(value);
}

function genericObjectToText(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      lines.push(`${key}:`);
      lines.push(indent(toAgentText(value)));
    } else {
      lines.push(`${key}: ${toAgentText(value)}`);
    }
  }
  return lines.join("\n");
}

function indent(text: string): string {
  return text.split("\n").map((l) => `  ${l}`).join("\n");
}

function contextToText(ctx: ProjectAgentContext): string {
  const lines: string[] = [];
  lines.push(`# Project context — machine ${ctx.machine.hostname}`);
  lines.push(`Target: ${ctx.target.input} (${ctx.target.resolved ? `resolved via ${ctx.target.source}` : "unresolved"})`);
  if (!ctx.target.resolved) {
    if (ctx.target.note) lines.push(ctx.target.note);
    return lines.join("\n");
  }
  if (ctx.project) lines.push(toAgentText(ctx.project));
  if (ctx.root) lines.push(`root: ${ctx.root.name} (${ctx.root.slug}) — ${ctx.root.base_path}`);
  if (ctx.recipe) lines.push(`recipe: ${ctx.recipe.name} (${ctx.recipe.slug})`);
  if (ctx.siblings && ctx.siblings.length) {
    lines.push(`siblings: ${ctx.siblings.map((s) => s.slug).join(", ")}`);
  }
  if (ctx.tmux) lines.push(`tmux: ${ctx.tmux.available ? `sessions: ${ctx.tmux.session_names.join(", ") || "none"}` : "unavailable"}`);
  if (ctx.integrations) lines.push(`integrations: ${toAgentText(ctx.integrations)}`);
  if (ctx.doctor) lines.push(`doctor: ${ctx.doctor.ok ? "ok" : "issues"} (${ctx.doctor.checks.map((c) => `${c.code}=${c.status}`).join(", ")})`);
  if (ctx.budgets && ctx.budgets.length) lines.push(`budgets: ${ctx.budgets.length} active, ${ctx.budgets.filter((b) => b.exhausted).length} exhausted`);
  if (ctx.recent_events && ctx.recent_events.length) {
    lines.push("recent events:");
    for (const e of ctx.recent_events) lines.push(`  ${e.created_at} ${e.event_type} (${e.source})`);
  }
  return lines.join("\n");
}

function nextToText(res: ProjectNextResult): string {
  const lines: string[] = [`# Suggested next actions — ${res.target.resolved ? "resolved" : "unresolved"}`];
  if (!res.actions.length) {
    lines.push("No suggestions. Project is in good shape.");
    return lines.join("\n");
  }
  for (const a of res.actions) {
    lines.push(`- [${a.priority}] ${a.title}`);
    lines.push(`    why: ${a.rationale}`);
    lines.push(`    run: \`${a.command}\``);
  }
  return lines.join("\n");
}

function whyToText(res: ProjectWhyResult): string {
  const lines: string[] = [`# Resolution trace — ${res.target}`];
  lines.push(`resolved: ${res.resolved}`);
  for (const s of res.steps) {
    const mark = s.matched ? "✓" : s.tried ? "✗" : "·";
    lines.push(`  ${mark} ${s.source}: ${s.detail}`);
  }
  if (res.suggestions.length) {
    lines.push("suggestions:");
    for (const s of res.suggestions) lines.push(`  - ${s}`);
  }
  return lines.join("\n");
}

function handoffToText(h: ProjectHandoff): string {
  const lines: string[] = [`# Project handoff — machine ${h.machine.hostname}`];
  lines.push(h.handoff_instructions);
  if (h.open_locks.length) {
    lines.push("open locks:");
    for (const l of h.open_locks) lines.push(`  ${l.lock_key} — ${l.reason ?? "(no reason)"} @ ${l.created_at}`);
  }
  if (h.recent_events.length) {
    lines.push("recent events:");
    for (const e of h.recent_events) lines.push(`  ${e.created_at} ${e.event_type}`);
  }
  if (h.recent_runs.length) {
    lines.push("recent agent runs:");
    for (const r of h.recent_runs) lines.push(`  ${r.id} ${r.status} — ${r.prompt.slice(0, 80)}`);
  }
  return lines.join("\n");
}

function runsToText(res: ProjectRunsResult): string {
  const lines: string[] = [`# Agent runs — ${res.target.resolved ? "resolved" : "unresolved"}`];
  if (!res.runs.length) {
    lines.push("No agent runs recorded.");
    return lines.join("\n");
  }
  for (const r of res.runs) {
    lines.push(`- ${r.id} [${r.status}] ${r.model ?? "?"} — ${r.tool_calls} tool call(s) @ ${r.started_at}`);
    if (r.error) lines.push(`    error: ${r.error}`);
  }
  return lines.join("\n");
}

export { PROJECT_RENDER_SCHEMA_VERSION };
