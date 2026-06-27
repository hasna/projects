#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isHttpMode, startMcpHttpServer, resolveMcpHttpPort } from "./http.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  acquireWorkspaceLock,
  addWorkspaceLocation,
  addTmuxProfileWindow,
  archiveWorkspace,
  assignAgentToWorkspace,
  createAgent,
  createRecipe,
  createRoot,
  createTmuxProfile,
  deleteRoot,
  deleteWorkspace,
  ensureCliAgent,
  getAgent,
  getAgentBySlug,
  getRecipe,
  getRecipeBySlug,
  getRoot,
  getRootBySlug,
  listAgents,
  listRecipes,
  listRoots,
  listTmuxProfileWindows,
  listTmuxProfiles,
  listWorkspaceEvents,
  listWorkspaceAgents,
  listWorkspaceLocations,
  listWorkspaceLocks,
  listWorkspaces,
  recordWorkspaceEvent,
  scoreRoots,
  releaseWorkspaceLock,
  resolveTmuxProfile,
  resolveWorkspace,
  unarchiveWorkspace,
  updateRoot,
  updateWorkspace,
} from "../db/workspaces.js";
import { getStorageStatus, storagePull, storagePush, storageSync } from "../db/storage-sync.js";
import { runWorkspaceAgentPrompt } from "../lib/workspace-agent.js";
import { parseWorkspaceAgentEvalCaseIds, runWorkspaceAgentEval } from "../lib/workspace-agent-eval.js";
import {
  parseProjectStartAgent,
  startProject,
} from "../lib/project-start.js";
import { projectTmuxStatus } from "../lib/project-tmux-status.js";
import { buildProjectCanvasPayload, buildProjectCanvasesPayload, buildProjectDetailPayload, buildProjectListRender, buildProjectSessionsPayload, buildRecipesRender, buildRootsRender } from "../lib/project-render.js";
import { inspectProjectStore as inspectCanonicalProjectStore } from "../lib/project-store.js";
import {
  createProjectCanvas,
  ensureDefaultProjectCanvas,
  inspectProjectStore as inspectProjectAppStore,
  inspectProjectStoreWithLoops as inspectProjectAppStoreWithLoops,
  linkProjectLoop,
  listProjectCanvases,
  listProjectDataModels,
  listProjectLoopSummaries,
} from "../db/project-store.js";
import {
  createProjectBudget,
  getProjectBudgetStatuses,
  recordProjectSpend,
  type ProjectBudget,
  type ProjectBudgetStatus,
} from "../lib/budget.js";
import { filterProjectEvalArtifacts } from "../lib/project-eval-artifacts.js";
import { resolveRegisteredProjectTarget } from "../lib/project-resolver.js";
import {
  PROJECT_PRIORITIES,
  PROJECT_STAGES,
  PROJECT_START_AGENTS,
  PROJECT_START_SESSION_POLICIES,
  expandProjectIntegrationUnlinkKeys,
  hasProjectIntegrationFields,
  hasProjectManagementFields,
  mergeProjectIntegrationFields,
  mergeProjectManagementMetadata,
  mergeProjectTags,
  projectDashboardSummary,
  projectExternalLinksSummary,
  projectManagementSummary,
  projectWithManagement,
  removeProjectTags,
  unlinkProjectIntegrationFields,
} from "../lib/project-management.js";
import { doctorWorkspace } from "../lib/workspace-doctor.js";
import {
  buildProjectAgentContext,
  buildProjectHandoff,
  explainProjectResolution,
  getProjectAgentRunDetail,
  listProjectAgentRunsView,
  suggestProjectNextActions,
  toAgentText,
} from "../lib/project-agent-assist.js";
import { builtInWorkspaceRecipes, ensureBuiltInWorkspaceRecipes } from "../lib/workspace-defaults.js";
import {
  importWorkspaceFromGitHub,
  syncWorkspaceGitHubRoots,
  linkWorkspaceExternalIntegrations,
  publishWorkspaceToGitHub,
  unpublishWorkspaceFromGitHub,
  type GitHubRemoteProtocol,
  type GitHubVisibility,
} from "../lib/workspace-github.js";
import { importRegisteredRoots, importWorkspace, importWorkspaceBulk } from "../lib/workspace-import.js";
import { runWorkspaceLegacyMigration } from "../lib/workspace-migration.js";
import {
  cleanupWorkspaceCreationTarget,
  executeWorkspaceCreation,
  type WorkspaceCreationPlanAction,
} from "../lib/workspace-plan.js";
import { applyWorkspaceTmuxProfile, workspaceMarkerPath } from "../lib/workspace-runtime.js";
import { PROJECT_AGENT_ROLES, type AgentKind, type JsonObject, type Workspace, type WorkspaceEvent, type WorkspaceIntegrations, type WorkspaceKind, type WorkspaceLocation, type WorkspaceLock } from "../types/workspace.js";

const DEFAULT_MCP_LIST_LIMIT = 25;
const DEFAULT_MCP_EVENT_LIMIT = 20;

function getPkgVersion(): string {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(p, "utf-8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  console.log(`Usage: projects-mcp [options]

MCP server for project management and launch tools (stdio transport by default)

Options:
  --http         serve MCP over Streamable HTTP on 127.0.0.1 (also MCP_HTTP=1)
  --port <n>     HTTP port (default 8871, or MCP_HTTP_PORT)
  -V, --version  output the version number
  -h, --help     display help for command`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  console.log(getPkgVersion());
  process.exit(0);
}

export function buildServer(): McpServer {
const server = new McpServer({
  name: "projects",
  version: getPkgVersion(),
});

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorText(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function projectPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => projectPayload(item));
  if (!value || typeof value !== "object") return value;
  const payload: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const nextKey = key === "workspace"
      ? "project"
      : key === "workspaces"
        ? "projects"
        : key === "workspace_id"
          ? "project_id"
          : key === "workspace_slug"
            ? "project_slug"
            : key === "workspace_input"
              ? "project_input"
              : key;
    payload[nextKey] = projectPayload(raw);
  }
  return payload;
}

function jsonProjectText(value: unknown) {
  return jsonText(projectPayload(value));
}

function compactText(value: string | null | undefined, max = 120): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  if (max <= 3) return normalized.slice(0, max);
  return `${normalized.slice(0, max - 3)}...`;
}

function mcpLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(value ?? fallback, 500));
}

function compactProject(project: Workspace) {
  const management = projectManagementSummary(project);
  const externalLinks = projectExternalLinksSummary(project);
  const dashboard = projectDashboardSummary(project);
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    kind: project.kind,
    status: project.status,
    stage: management.stage,
    priority: management.priority,
    owner: management.owner,
    path: compactText(project.primary_path, 160) || null,
    path_health: dashboard.path_health.status,
    tags: project.tags,
    links: {
      todos: externalLinks.todos.linked,
      brief: externalLinks.brief.linked,
    },
  };
}

function compactEvent(event: WorkspaceEvent, verbose = false) {
  const payload: Record<string, unknown> = {
    id: event.id,
    type: event.event_type,
    source: event.source,
    agent_id: event.agent_id,
    created_at: event.created_at,
  };
  if (verbose) {
    payload.prompt = compactText(event.prompt, 160);
    payload.command = compactText(event.command, 200);
    payload.metadata_keys = Object.keys(event.metadata);
  }
  return payload;
}

function compactLocation(location: WorkspaceLocation) {
  return {
    id: location.id,
    label: location.label,
    kind: location.kind,
    primary: location.is_primary,
    machine: location.machine_id,
    path: compactText(location.path, 160),
    exists_at_create: location.exists_at_create,
  };
}

function compactLock(lock: WorkspaceLock) {
  return {
    lock_key: lock.lock_key,
    project_id: lock.workspace_id,
    agent_id: lock.agent_id,
    reason: compactText(lock.reason, 100) || null,
    created_at: lock.created_at,
    expires_at: lock.expires_at,
  };
}

function compactBudget(budget: ProjectBudget) {
  return {
    id: budget.id,
    scope: `${budget.scope_type}:${budget.scope_id}`,
    window: budget.window,
    mode: budget.mode,
    limits: {
      usd: budget.max_usd,
      input_tokens: budget.max_input_tokens,
      output_tokens: budget.max_output_tokens,
      total_tokens: budget.max_total_tokens,
    },
  };
}

function compactBudgetStatus(status: ProjectBudgetStatus) {
  return {
    budget: compactBudget(status.budget),
    remaining: status.remaining,
    spent: status.spent,
    exhausted: status.exhausted,
    exceeded: status.exceeded,
    warnings: status.warnings,
  };
}

function compactDoctorResult(result: ReturnType<typeof doctorWorkspace>) {
  const issues = result.checks.filter((check) => check.status !== "ok");
  return {
    project: compactProject(result.workspace),
    ok: result.ok,
    checks: {
      ok: result.checks.filter((check) => check.status === "ok").length,
      warn: result.checks.filter((check) => check.status === "warn").length,
      error: result.checks.filter((check) => check.status === "error").length,
    },
    issues: issues.map((check) => ({
      code: check.code,
      status: check.status,
      message: compactText(check.message, 160),
      fixable: Boolean(check.fixable),
    })),
    fixes: result.fixes,
  };
}

function compactListPayload<T>(items: T[], visible: unknown[], limit: number, nextSteps: string) {
  return {
    items: visible,
    count: visible.length,
    total_returned: items.length,
    limit,
    has_more: items.length > visible.length,
    next_steps: nextSteps,
  };
}

function withoutRender<T extends Record<string, unknown>>(value: T): Omit<T, "render" | "schema_version" | "kind"> {
  const { render: _render, schema_version: _schemaVersion, kind: _kind, ...rest } = value;
  return rest;
}

function rootId(idOrSlug: string | undefined): string | undefined {
  if (!idOrSlug) return undefined;
  const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
  if (!root) throw new Error(`Root not found: ${idOrSlug}`);
  return root.id;
}

function recipeId(idOrSlug: string | undefined): string | undefined {
  if (!idOrSlug) return undefined;
  const recipe = getRecipe(idOrSlug) ?? getRecipeBySlug(idOrSlug);
  if (!recipe) throw new Error(`Recipe not found: ${idOrSlug}`);
  return recipe.id;
}

function agentId(idOrSlug: string | undefined): string {
  if (!idOrSlug) return ensureCliAgent().id;
  const agent = getAgent(idOrSlug) ?? getAgentBySlug(idOrSlug);
  if (!agent) throw new Error(`Agent not found: ${idOrSlug}`);
  return agent.id;
}

function findProjectTarget(target: string | undefined): Workspace | null {
  return resolveRegisteredProjectTarget(target)?.project ?? null;
}

function withWorkspaceMutationLock<T>(workspace: Workspace, owner: string | undefined, reason: string, fn: () => T): T {
  const key = `workspace:${workspace.id}`;
  acquireWorkspaceLock({ lock_key: key, workspace_id: workspace.id, agent_id: owner, reason, ttl_seconds: 600 });
  try {
    return fn();
  } finally {
    releaseWorkspaceLock(key);
  }
}

function isRollbackAction(value: unknown): value is WorkspaceCreationPlanAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  return action.type === "rollback"
    && typeof action.action === "string"
    && typeof action.target === "string"
    && action.status === "planned";
}

function parseRollbackActions(value: unknown): WorkspaceCreationPlanAction[] | null {
  if (!Array.isArray(value)) return null;
  const actions = value.filter(isRollbackAction);
  return actions.length === value.length ? actions : null;
}

function cleanupTargetFromWorkspace(workspace: Workspace, rollbackActions?: WorkspaceCreationPlanAction[]) {
  if (rollbackActions?.length) {
    return {
      workspace_slug: workspace.slug,
      primary_path: workspace.primary_path,
      rollback_actions: rollbackActions,
    };
  }
  for (const event of listWorkspaceEvents(workspace.id).slice().reverse()) {
    const fromMetadata = parseRollbackActions(event.metadata.rollback_actions);
    if (fromMetadata) return { workspace_slug: workspace.slug, primary_path: workspace.primary_path, rollback_actions: fromMetadata };
    const after = event.after_json as Record<string, unknown> | null;
    const plan = after?.plan as Record<string, unknown> | undefined;
    const fromPlan = parseRollbackActions(plan?.rollback_actions);
    if (fromPlan) return { workspace_slug: workspace.slug, primary_path: workspace.primary_path, rollback_actions: fromPlan };
  }
  const fallback: WorkspaceCreationPlanAction[] = [
    { type: "rollback", action: "delete", target: `workspaces:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
    { type: "rollback", action: "delete", target: `workspace_events:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
  ];
  if (workspace.primary_path) {
    fallback.push({ type: "rollback", action: "delete", target: `workspace_locations:${workspace.primary_path}`, status: "planned", metadata: { automatic: false } });
    fallback.push({ type: "rollback", action: "remove_file", target: workspaceMarkerPath(workspace), status: "planned", metadata: { automatic: false } });
    fallback.push({ type: "rollback", action: "remove_git_dir", target: join(workspace.primary_path, ".git"), status: "planned", metadata: { automatic: false } });
    fallback.push({ type: "rollback", action: "remove_empty_directory", target: workspace.primary_path, status: "planned", metadata: { automatic: false } });
  }
  return { workspace_slug: workspace.slug, primary_path: workspace.primary_path, rollback_actions: fallback };
}

server.tool(
  "projects_roots_list",
  "List registered root folders and path templates for projects. Full records by default; pass compact=true for compact summaries.",
  {
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const roots = listRoots();
    if (!input.compact || input.verbose) return jsonText(roots);
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    return jsonText(compactListPayload(roots, roots.slice(0, limit).map((root) => ({
      id: root.id,
      slug: root.slug,
      name: root.name,
      kind: root.default_kind,
      path: compactText(root.base_path, 160),
      tags: root.tags,
    })), limit, "Use projects_roots_show with an id, or projects_roots_list verbose=true for full root records."));
  },
);

server.tool(
  "projects_roots_add",
  "Register a root folder that projects can be created under.",
  {
    name: z.string(),
    path: z.string(),
    slug: z.string().optional(),
    tags: z.array(z.string()).optional(),
    kind: z.string().optional(),
    github_org: z.string().optional(),
    repo_visibility: z.enum(["public", "private"]).optional(),
    path_template: z.string().optional(),
    name_template: z.string().optional(),
  },
  async (input) => {
    try {
      return jsonText(createRoot({
        name: input.name,
        base_path: input.path,
        slug: input.slug,
        tags: input.tags,
        default_kind: input.kind as WorkspaceKind | undefined,
        github_org: input.github_org,
        repo_visibility: input.repo_visibility,
        path_template: input.path_template,
        name_template: input.name_template,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_roots_show",
  "Show one registered root by id or slug.",
  { id: z.string() },
  async (input) => {
    const root = getRoot(input.id) ?? getRootBySlug(input.id);
    return root ? jsonText(root) : errorText(`Root not found: ${input.id}`);
  },
);

server.tool(
  "projects_roots_update",
  "Update a registered root folder and its defaults.",
  {
    id: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    path: z.string().optional(),
    tags: z.array(z.string()).optional(),
    kind: z.string().nullable().optional(),
    github_org: z.string().nullable().optional(),
    repo_visibility: z.enum(["public", "private"]).nullable().optional(),
    path_template: z.string().nullable().optional(),
    name_template: z.string().nullable().optional(),
    allowed_recipes: z.array(z.string()).optional(),
    allowed_agents: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async (input) => {
    try {
      const root = getRoot(input.id) ?? getRootBySlug(input.id);
      if (!root) return errorText(`Root not found: ${input.id}`);
      return jsonText(updateRoot(root.id, {
        name: input.name,
        slug: input.slug,
        base_path: input.path,
        tags: input.tags,
        default_kind: input.kind as WorkspaceKind | null | undefined,
        github_org: input.github_org,
        repo_visibility: input.repo_visibility,
        path_template: input.path_template,
        name_template: input.name_template,
        allowed_recipes: input.allowed_recipes,
        allowed_agents: input.allowed_agents,
        metadata: input.metadata,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_roots_delete",
  "Delete a registered root. Refuses roots referenced by projects unless detach_projects=true.",
  {
    id: z.string(),
    detach_projects: z.boolean().optional(),
  },
  async (input) => {
    try {
      const root = getRoot(input.id) ?? getRootBySlug(input.id);
      if (!root) return errorText(`Root not found: ${input.id}`);
      return jsonText(deleteRoot(root.id, { detachWorkspaces: input.detach_projects }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_roots_match",
  "Score and match registered roots by path, kind, tags, and GitHub org.",
  {
    path: z.string().optional(),
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    github_org: z.string().optional(),
  },
  async (input) => jsonText(scoreRoots({
    path: input.path,
    kind: input.kind as WorkspaceKind | undefined,
    tags: input.tags,
    github_org: input.github_org,
  })),
);

server.tool(
  "projects_recipes_list",
  "List project recipes for agent-visible creation defaults. Full records by default; pass compact=true for compact summaries.",
  {
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const recipes = listRecipes();
    if (!input.compact || input.verbose) return jsonText(recipes);
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    return jsonText(compactListPayload(recipes, recipes.slice(0, limit).map((recipe) => ({
      id: recipe.id,
      slug: recipe.slug,
      name: recipe.name,
      kind: recipe.kind,
      version: recipe.version,
      tags: recipe.default_tags,
    })), limit, "Use projects_recipes_list verbose=true for full recipe records including steps."));
  },
);

server.tool(
  "projects_recipes_add",
  "Register a project recipe with optional default tags and JSON steps.",
  {
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    steps: z.array(z.record(z.unknown())).optional(),
  },
  async (input) => {
    try {
      return jsonText(createRecipe({
        name: input.name,
        slug: input.slug,
        description: input.description,
        kind: input.kind as WorkspaceKind | undefined,
        default_tags: input.tags,
        steps: input.steps,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_recipes_built_ins",
  "List built-in project recipe definitions. Full records by default; pass compact=true for compact summaries.",
  {
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const recipes = builtInWorkspaceRecipes();
    if (!input.compact || input.verbose) return jsonText(recipes);
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    return jsonText(compactListPayload(recipes, recipes.slice(0, limit).map((recipe) => ({
      slug: recipe.slug,
      name: recipe.name,
      kind: recipe.kind,
      tags: recipe.default_tags ?? [],
    })), limit, "Use projects_recipes_built_ins verbose=true for full built-in recipe definitions."));
  },
);

server.tool(
  "projects_recipes_seed_defaults",
  "Create any missing built-in project recipes.",
  {},
  async () => jsonText(ensureBuiltInWorkspaceRecipes()),
);

server.tool(
  "projects_agents_list",
  "List registered agents, or agents assigned to a specific project. Full records by default; pass compact=true for compact summaries.",
  {
    project: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    if (!input.project) {
      const agents = listAgents();
      if (!input.compact || input.verbose) return jsonText(agents);
      return jsonText(compactListPayload(agents, agents.slice(0, limit).map((agent) => ({
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        kind: agent.kind,
        provider: agent.provider,
        model: agent.model,
        role: agent.role,
      })), limit, "Use projects_agents_list verbose=true for full agent records."));
    }
    const project = findProjectTarget(input.project);
    if (!project) return errorText(`Project not found: ${input.project}`);
    const assignments = listWorkspaceAgents(project.id);
    if (!input.compact || input.verbose) return jsonText(assignments);
    return jsonText(compactListPayload(assignments, assignments.slice(0, limit).map((assignment) => ({
      agent: assignment.agent?.slug ?? assignment.agent_id,
      role: assignment.role,
      kind: assignment.agent?.kind ?? null,
      created_at: assignment.created_at,
    })), limit, "Use projects_agents_list verbose=true for full assignment records."));
  },
);

server.tool(
  "projects_agents_add",
  "Register a human, CLI, service, or AI agent for project attribution.",
  {
    name: z.string(),
    kind: z.enum(["human", "ai", "service", "cli"]),
    slug: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    role: z.string().optional(),
    permissions: z.array(z.string()).optional(),
  },
  async (input) => {
    try {
      return jsonText(createAgent({
        name: input.name,
        slug: input.slug,
        kind: input.kind as AgentKind,
        provider: input.provider,
        model: input.model,
        role: input.role,
        permissions: input.permissions,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_agents_assign",
  "Assign a registered agent to a project role and record an audit event.",
  {
    project: z.string(),
    agent: z.string(),
    role: z.enum(PROJECT_AGENT_ROLES).optional(),
    assigned_by: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const agent = getAgent(input.agent) ?? getAgentBySlug(input.agent);
      if (!agent) return errorText(`Agent not found: ${input.agent}`);
      const assignedBy = input.assigned_by ? agentId(input.assigned_by) : ensureCliAgent().id;
      const assignment = assignAgentToWorkspace(
        project.id,
        agent.id,
        input.role ?? "contributor",
        assignedBy,
        input.metadata as JsonObject | undefined,
      );
      recordWorkspaceEvent({
        workspace_id: project.id,
        agent_id: assignedBy,
        event_type: "agent_assigned",
        source: "mcp",
        command: "projects_agents_assign",
        after: {
          agent_id: agent.id,
          agent_slug: agent.slug,
          role: assignment.role,
          assignment_id: assignment.id,
        },
      });
      return jsonText(assignment);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_tmux_profiles_list",
  "List saved project tmux profiles. Full records by default; pass compact=true for compact summaries.",
  {
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const profiles = listTmuxProfiles();
    const full = profiles.map((profile) => ({ ...profile, windows: listTmuxProfileWindows(profile.id) }));
    if (!input.compact || input.verbose) return jsonText(full);
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    return jsonText(compactListPayload(full, full.slice(0, limit).map((profile) => ({
      id: profile.id,
      slug: profile.slug,
      name: profile.name,
      session: profile.session_template,
      attach: profile.attach,
      windows: profile.windows.length,
    })), limit, "Use projects_tmux_profiles_list verbose=true or projects_tmux_profiles_apply dry_run=true for details."));
  },
);

server.tool(
  "projects_tmux_profiles_add",
  "Create a saved tmux profile with optional windows.",
  {
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    session_template: z.string().optional(),
    attach: z.boolean().optional(),
    windows: z.array(z.object({
      name: z.string(),
      path_template: z.string().optional(),
      command: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      detached: z.boolean().optional(),
    })).optional(),
  },
  async (input) => {
    try {
      const profile = createTmuxProfile({
        name: input.name,
        slug: input.slug,
        description: input.description,
        session_template: input.session_template,
        attach: input.attach,
      });
      for (const window of input.windows ?? []) {
        addTmuxProfileWindow({
          profile_id: profile.id,
          window_name_template: window.name,
          path_template: window.path_template,
          command: window.command,
          window_index: window.index,
          detached: window.detached,
        });
      }
      return jsonText({ profile, windows: listTmuxProfileWindows(profile.id) });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const tmuxWindowInput = z.object({
  name: z.string(),
  path: z.string().optional(),
  command: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  detached: z.boolean().optional(),
});

const rollbackActionInput = z.object({
  type: z.literal("rollback"),
  action: z.string(),
  target: z.string(),
  status: z.literal("planned"),
  metadata: z.record(z.unknown()).optional(),
});

server.tool(
  "projects_tmux_profiles_apply",
  "Apply a saved tmux profile to a project.",
  {
    profile: z.string(),
    project: z.string(),
    dry_run: z.boolean().optional(),
  },
  async (input) => {
    try {
      const profile = resolveTmuxProfile(input.profile);
      if (!profile) return errorText(`Tmux profile not found: ${input.profile}`);
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = ensureCliAgent().id;
      const apply = () => applyWorkspaceTmuxProfile(project, profile, listTmuxProfileWindows(profile.id), {
        dryRun: input.dry_run,
        source: "mcp",
        command: "projects_tmux_profiles_apply",
      });
      return jsonText(input.dry_run ? apply() : withWorkspaceMutationLock(project, owner, "project tmux profile apply", apply));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

function projectDoctorPayload(result: ReturnType<typeof doctorWorkspace>) {
  const { workspace, ...rest } = result;
  return { ...rest, project: workspace };
}

server.tool(
  "projects_list",
  "List registered projects across all roots and arbitrary paths. Full records by default; pass compact=true for compact summaries.",
  {
    kind: z.string().optional(),
    status: z.enum(["active", "archived", "deleted"]).optional(),
    query: z.string().optional(),
    tags: z.array(z.string()).optional(),
    include_evals: z.boolean().optional(),
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    const projects = filterProjectEvalArtifacts(listWorkspaces({
      kind: input.kind as WorkspaceKind | undefined,
      status: input.status,
      query: input.query,
      tags: input.tags,
      exclude_eval_artifacts: !input.include_evals,
      limit: input.compact && !input.verbose ? limit + 1 : input.limit,
    }), input.include_evals);
    if (!input.compact || input.verbose) return jsonText(projects.map(projectWithManagement));
    const visible = projects.slice(0, limit);
    return jsonText({
      projects: visible.map(compactProject),
      count: visible.length,
      limit,
      has_more: projects.length > visible.length,
      next_steps: "Use projects_show with an id/slug for details, omit compact or pass verbose=true for full records, or limit/query/tags filters to narrow results.",
    });
  },
);

server.tool(
  "projects_show",
  "Show a project with locations and event history. Full records by default; pass compact=true for a compact summary.",
  {
    id: z.string(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
    events_limit: z.number().int().positive().max(500).optional(),
  },
  async (input) => {
    const project = findProjectTarget(input.id);
    if (!project) return errorText(`Project not found: ${input.id}`);
    const events = listWorkspaceEvents(project.id);
    const payload = buildProjectDetailPayload({
      project: projectWithManagement(project),
      agents: listWorkspaceAgents(project.id),
      locations: listWorkspaceLocations(project.id),
      events,
    });
    if (!input.compact || input.verbose) return jsonText(withoutRender(payload));
    return jsonText({
      project: compactProject(project),
      management: projectManagementSummary(project),
      external_links: projectExternalLinksSummary(project),
      dashboard: projectDashboardSummary(project),
      counts: {
        agents: listWorkspaceAgents(project.id).length,
        locations: listWorkspaceLocations(project.id).length,
        events: events.length,
      },
      recent_events: events.slice(-3).reverse().map((event) => compactEvent(event)),
      next_steps: "Pass verbose=true for full locations, agents, and event history; use projects_events_list for paged event summaries.",
    });
  },
);

server.tool(
  "projects_render_list",
  "Return a validated JSON Render spec for the projects list surface.",
  {
    kind: z.string().optional(),
    status: z.enum(["active", "archived", "deleted"]).optional(),
    query: z.string().optional(),
    tags: z.array(z.string()).optional(),
    include_evals: z.boolean().optional(),
    limit: z.number().int().positive().max(500).optional(),
  },
  async (input) => jsonText(buildProjectListRender(filterProjectEvalArtifacts(listWorkspaces({
    kind: input.kind as WorkspaceKind | undefined,
    status: input.status,
    query: input.query,
    tags: input.tags,
    exclude_eval_artifacts: !input.include_evals,
    limit: input.limit,
  }), input.include_evals))),
);

server.tool(
  "projects_render_show",
  "Return a validated JSON Render spec for one project detail surface.",
  { id: z.string() },
  async (input) => {
    const project = findProjectTarget(input.id);
    if (!project) return errorText(`Project not found: ${input.id}`);
    const payload = buildProjectDetailPayload({
      project: projectWithManagement(project),
      agents: listWorkspaceAgents(project.id),
      locations: listWorkspaceLocations(project.id),
      events: listWorkspaceEvents(project.id),
    });
    return jsonText(payload.render);
  },
);

server.tool(
  "projects_render_sessions",
  "Return a validated JSON Render spec for recent project start sessions.",
  { project: z.string(), limit: z.number().int().positive().max(100).optional(), unrenamed: z.boolean().optional() },
  async (input) => {
    const project = findProjectTarget(input.project);
    if (!project) return errorText(`Project not found: ${input.project}`);
    return jsonText(buildProjectSessionsPayload({
      project,
      events: listWorkspaceEvents(project.id),
      limit: input.limit,
      unrenamedOnly: input.unrenamed,
    }).render);
  },
);

server.tool(
  "projects_render_start",
  "Dry-run start and return the validated JSON Render spec for the start surface.",
  {
    target: z.string().optional(),
    agent_tool: z.enum(["codewith", "claude", "opencode", "cursor", "none"]).optional(),
    command: z.string().optional(),
    profile: z.string().optional(),
    session: z.string().optional(),
    session_policy: z.enum(PROJECT_START_SESSION_POLICIES).optional(),
    window_name: z.string().optional(),
    windows: z.array(tmuxWindowInput).optional(),
    register: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const result = await startProject(input.target, {
        agentTool: input.agent_tool ? parseProjectStartAgent(input.agent_tool) : undefined,
        toolCommand: input.command,
        profile: input.profile,
        session: input.session,
        sessionPolicy: input.session_policy,
        windowName: input.window_name,
        requestedWindows: input.windows,
        register: input.register,
        importTags: input.tags,
        importMetadata: input.metadata as JsonObject | undefined,
        dryRun: true,
        attach: false,
        agentId: input.agent ? agentId(input.agent) : ensureCliAgent().id,
        source: "mcp",
        auditCommand: "projects_render_start",
      });
      return jsonText(result.render);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_render_status",
  "Return a validated JSON Render spec for project tmux status.",
  {
    target: z.string().optional(),
    profile: z.string().optional(),
    session: z.string().optional(),
    agent_tool: z.enum(["codewith", "claude", "opencode", "cursor", "none"]).optional(),
    command: z.string().optional(),
    window_name: z.string().optional(),
    windows: z.array(tmuxWindowInput).optional(),
  },
  async (input) => {
    try {
      const result = await projectTmuxStatus(input.target, {
        profile: input.profile,
        session: input.session,
        agentTool: input.agent_tool ? parseProjectStartAgent(input.agent_tool) : undefined,
        command: input.command,
        windowName: input.window_name,
        requestedWindows: input.windows,
      });
      return jsonText(result.render);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_render_roots",
  "Return a validated JSON Render spec for registered project roots.",
  {},
  async () => jsonText(buildRootsRender(listRoots())),
);

server.tool(
  "projects_render_recipes",
  "Return a validated JSON Render spec for project recipes.",
  {},
  async () => jsonText(buildRecipesRender(listRecipes())),
);

server.tool(
  "projects_store_inspect",
  "Inspect canonical project storage and the per-project app store under $HASNA_PROJECTS_HOME/data/<workspace_id>/project.db.",
  {
    project: z.string(),
    include_loops: z.boolean().optional(),
    include_runs: z.boolean().optional(),
  },
  async (input) => {
    const project = findProjectTarget(input.project);
    if (!project) return errorText(`Project not found: ${input.project}`);
    return jsonText({
      project: projectWithManagement(project),
      store: inspectCanonicalProjectStore(project),
      app_store: input.include_loops
        ? await inspectProjectAppStoreWithLoops(project, { includeRuns: input.include_runs })
        : inspectProjectAppStore(project),
    });
  },
);

server.tool(
  "projects_canvases_list",
  "List per-project React Flow canvas records from the project's project.db.",
  {
    project: z.string(),
    ensure_default: z.boolean().optional(),
    render_spec: z.boolean().optional(),
  },
  async (input) => {
    const project = findProjectTarget(input.project);
    if (!project) return errorText(`Project not found: ${input.project}`);
    if (input.ensure_default) ensureDefaultProjectCanvas(project);
    const payload = buildProjectCanvasesPayload({ project, canvases: listProjectCanvases(project) });
    return jsonText(input.render_spec ? payload.render : withoutRender(payload));
  },
);

server.tool(
  "projects_canvases_create",
  "Create a per-project React Flow canvas record in the project's project.db.",
  {
    project: z.string(),
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    viewport: z.record(z.unknown()).optional(),
    nodes: z.array(z.record(z.unknown())).optional(),
    edges: z.array(z.record(z.unknown())).optional(),
    data: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    render_spec: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const canvas = withWorkspaceMutationLock(project, owner, "project canvas create", () => createProjectCanvas(project, {
        name: input.name,
        slug: input.slug,
        description: input.description,
        viewport: input.viewport as JsonObject | undefined,
        nodes: input.nodes as never,
        edges: input.edges as never,
        data: input.data as JsonObject | undefined,
        metadata: input.metadata as JsonObject | undefined,
      }));
      const payload = buildProjectCanvasPayload({
        project,
        canvas,
        dataModels: listProjectDataModels(project),
      });
      return jsonText(input.render_spec ? payload.render : withoutRender(payload));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_render_canvas",
  "Return a validated JSON Render spec for one per-project React Flow canvas.",
  {
    project: z.string(),
    canvas: z.string().optional(),
    include_loops: z.boolean().optional(),
    include_runs: z.boolean().optional(),
  },
  async (input) => {
    const project = findProjectTarget(input.project);
    if (!project) return errorText(`Project not found: ${input.project}`);
    const target = input.canvas ?? "dashboard";
    const canvas = listProjectCanvases(project).find((item) => item.id === target || item.slug === target);
    if (!canvas) return errorText(`Project canvas not found: ${target}`);
    const payload = buildProjectCanvasPayload({
      project,
      canvas,
      loops: input.include_loops ? await listProjectLoopSummaries(project, { includeRuns: input.include_runs }) : [],
      dataModels: listProjectDataModels(project),
    });
    return jsonText(payload.render);
  },
);

server.tool(
  "projects_loops_link",
  "Link an @hasna/loops loop id or name to a project store.",
  {
    project: z.string(),
    loop: z.string(),
    name: z.string().optional(),
    role: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const link = withWorkspaceMutationLock(project, owner, "project OpenLoops link", () => linkProjectLoop(project, {
        loop_id: input.loop,
        loop_name: input.name,
        role: input.role,
        metadata: input.metadata as JsonObject | undefined,
      }));
      return jsonText({ project: projectWithManagement(project), link });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_loops_list",
  "List linked OpenLoops summaries for a project through @hasna/loops.",
  {
    project: z.string(),
    include_runs: z.boolean().optional(),
  },
  async (input) => {
    const project = findProjectTarget(input.project);
    if (!project) return errorText(`Project not found: ${input.project}`);
    return jsonText({
      project: projectWithManagement(project),
      loops: await listProjectLoopSummaries(project, { includeRuns: input.include_runs }),
    });
  },
);
server.tool(
  "projects_locations_list",
  "List registered folder locations for a project. Full records by default; pass compact=true for compact summaries.",
  {
    project: z.string(),
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const project = findProjectTarget(input.project);
    if (!project) return errorText(`Project not found: ${input.project}`);
    const locations = listWorkspaceLocations(project.id);
    if (!input.compact || input.verbose) return jsonText({ project: projectWithManagement(project), locations });
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    const visible = locations.slice(0, limit);
    return jsonText({
      project: compactProject(project),
      locations: visible.map(compactLocation),
      count: visible.length,
      total: locations.length,
      limit,
      has_more: locations.length > visible.length,
      next_steps: "Pass verbose=true for full location records, or use projects_show verbose=true for project context.",
    });
  },
);

server.tool(
  "projects_locations_add",
  "Register another folder location for a project. Use primary=true to make it the default project path.",
  {
    project: z.string(),
    path: z.string(),
    label: z.string().optional(),
    kind: z.string().optional(),
    primary: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const location = withWorkspaceMutationLock(project, owner, "project location add", () => addWorkspaceLocation({
        workspace_id: project.id,
        path: input.path,
        label: input.label,
        kind: input.kind,
        is_primary: input.primary,
        metadata: input.metadata as JsonObject | undefined,
        agent_id: owner,
        source: "mcp",
        command: "projects_locations_add",
      }));
      const updated = resolveWorkspace(project.id) ?? project;
      return jsonText({ project: projectWithManagement(updated), location });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_create",
  "Create/register a project anywhere on disk, optionally preparing directory/git and tmux windows.",
  {
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    kind: z.string().optional(),
    root: z.string().optional(),
    recipe: z.string().optional(),
    path: z.string().optional(),
    tags: z.array(z.string()).optional(),
    stage: z.enum(PROJECT_STAGES).optional(),
    priority: z.enum(PROJECT_PRIORITIES).optional(),
    owner: z.string().optional(),
    launch_profile: z.string().optional(),
    start_agent: z.enum(PROJECT_START_AGENTS).optional(),
    start_command: z.string().optional(),
    start_session_policy: z.enum(PROJECT_START_SESSION_POLICIES).optional(),
    start_windows: z.array(tmuxWindowInput).optional(),
    todos_project_id: z.string().optional(),
    todos_task_list_id: z.string().optional(),
    brief_id: z.string().optional(),
    brief_path: z.string().optional(),
    integrations: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    agent: z.string().optional(),
    git_remote: z.string().optional(),
    mkdir: z.boolean().optional(),
    git_init: z.boolean().optional(),
    marker: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    dry_run_runtime: z.boolean().optional(),
    tmux_session: z.string().optional(),
    tmux_windows: z.array(tmuxWindowInput).optional(),
    tmux_profile: z.string().optional(),
  },
  async (input) => {
    try {
      const owner = agentId(input.agent);
      const metadataBase = (input.metadata ?? {}) as JsonObject;
      const metadata = mergeProjectManagementMetadata(metadataBase, {
        stage: input.stage,
        priority: input.priority,
        owner: input.owner,
        launch_profile: input.launch_profile,
        start_agent: input.start_agent,
        start_command: input.start_command,
        start_session_policy: input.start_session_policy,
        start_windows: input.start_windows,
      }) ?? metadataBase;
      const integrationsBase = input.integrations as WorkspaceIntegrations | undefined ?? {};
      const integrations = mergeProjectIntegrationFields(integrationsBase, {
        todos_project_id: input.todos_project_id,
        todos_task_list_id: input.todos_task_list_id,
        brief_id: input.brief_id,
        brief_path: input.brief_path,
      }) ?? integrationsBase;
      return jsonProjectText(executeWorkspaceCreation({
        name: input.name,
        slug: input.slug,
        description: input.description,
        kind: input.kind as WorkspaceKind | undefined,
        root_id: rootId(input.root),
        recipe_id: recipeId(input.recipe),
        primary_path: input.path,
        tags: input.tags,
        integrations,
        metadata,
        git_remote: input.git_remote,
        agent_id: owner,
        source: "mcp",
        command: "projects_create",
        createDirectory: input.mkdir || input.git_init,
        gitInit: input.git_init,
        writeMarker: input.marker,
        tmux: input.tmux_session || input.tmux_windows ? {
          session: input.tmux_session,
          windows: input.tmux_windows,
        } : undefined,
        tmux_profile: input.tmux_profile,
      }, { dryRun: input.dry_run, runtimeDryRun: input.dry_run_runtime }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_import",
  "Import an existing folder or direct child folders as projects.",
  {
    path: z.string(),
    bulk: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const owner = input.agent ? agentId(input.agent) : undefined;
      return jsonProjectText(input.bulk
        ? await importWorkspaceBulk(input.path, { dryRun: input.dry_run, tags: input.tags, agent_id: owner })
        : await importWorkspace(input.path, { dryRun: input.dry_run, tags: input.tags, agent_id: owner }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_import_github",
  "Import a GitHub repository as a project. Can plan, clone, or register remote-only projects.",
  {
    repo: z.string(),
    root: z.string().optional(),
    path: z.string().optional(),
    clone: z.boolean().optional(),
    remote_only: z.boolean().optional(),
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    agent: z.string().optional(),
    remote_protocol: z.enum(["https", "ssh"]).optional(),
    dry_run: z.boolean().optional(),
  },
  async (input) => {
    try {
      const owner = input.agent ? agentId(input.agent) : undefined;
      return jsonProjectText(await importWorkspaceFromGitHub(input.repo, {
        root: input.root,
        path: input.path,
        clone: input.clone,
        remoteOnly: input.remote_only,
        kind: input.kind as WorkspaceKind | undefined,
        tags: input.tags,
        remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
        dryRun: input.dry_run,
        agent_id: owner,
        source: "mcp",
        command: "projects_import_github",
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_scan_roots",
  "Dry-run import plans for repositories in configured GitHub roots.",
  {
    root: z.string().optional(),
    repo_prefix: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    clone: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    remote_protocol: z.enum(["https", "ssh"]).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const owner = input.agent ? agentId(input.agent) : undefined;
      return jsonText(await syncWorkspaceGitHubRoots({
        root: input.root,
        repoPrefix: input.repo_prefix,
        limit: input.limit,
        clone: input.clone,
        tags: input.tags,
        remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
        dryRun: true,
        agent_id: owner,
        source: "mcp",
        command: "projects_scan_roots",
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_sync_roots",
  "Import and optionally clone repositories from configured GitHub roots. Mutates by default unless dry_run=true.",
  {
    root: z.string().optional(),
    repo_prefix: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    clone: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    remote_protocol: z.enum(["https", "ssh"]).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const owner = input.agent ? agentId(input.agent) : undefined;
      return jsonText(await syncWorkspaceGitHubRoots({
        root: input.root,
        repoPrefix: input.repo_prefix,
        limit: input.limit,
        clone: input.clone,
        tags: input.tags,
        remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
        dryRun: Boolean(input.dry_run),
        agent_id: owner,
        source: "mcp",
        command: "projects_sync_roots",
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_scan_local_roots",
  "Scan registered local root folders and preview/import direct child folders as projects. Dry-run by default.",
  {
    apply: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const owner = input.agent ? agentId(input.agent) : undefined;
      return jsonText(await importRegisteredRoots({
        dryRun: !input.apply,
        tags: input.tags,
        agent_id: owner,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_github_publish",
  "Publish a project to GitHub. Creates the repo, updates project metadata, and can push local git.",
  {
    project: z.string(),
    org: z.string().optional(),
    repo: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
    description: z.string().optional(),
    remote_protocol: z.enum(["https", "ssh"]).optional(),
    push: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const publish = () => publishWorkspaceToGitHub(project, {
        org: input.org,
        repoName: input.repo,
        visibility: input.visibility as GitHubVisibility | undefined,
        description: input.description,
        remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
        push: input.push,
        dryRun: input.dry_run,
        agent_id: owner,
        source: "mcp",
        command: "projects_github_publish",
      });
      return jsonProjectText(input.dry_run ? publish() : withWorkspaceMutationLock(project, owner, "project GitHub publish", publish));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_github_unpublish",
  "Remove GitHub origin metadata from a project without deleting the GitHub repo.",
  {
    project: z.string(),
    clear_integrations: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const unpublish = () => unpublishWorkspaceFromGitHub(project, {
        clearIntegrations: input.clear_integrations,
        dryRun: input.dry_run,
        agent_id: owner,
        source: "mcp",
        command: "projects_github_unpublish",
      });
      return jsonProjectText(input.dry_run ? unpublish() : withWorkspaceMutationLock(project, owner, "project GitHub unpublish", unpublish));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_start",
  "Start a project by creating or reusing a tmux session, ensuring default 01/02 windows, and launching a coding tool. The windows field, when provided, is the exact tmux window set to create.",
  {
    target: z.string().optional(),
    agent_tool: z.enum(["codewith", "claude", "opencode", "cursor", "none"]).optional(),
    command: z.string().optional(),
    profile: z.string().optional(),
    session: z.string().optional(),
    session_policy: z.enum(PROJECT_START_SESSION_POLICIES).optional(),
    window_name: z.string().optional(),
    windows: z.array(tmuxWindowInput).optional(),
    register: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    dry_run: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      return jsonText(await startProject(input.target, {
        agentTool: input.agent_tool ? parseProjectStartAgent(input.agent_tool) : undefined,
        toolCommand: input.command,
        profile: input.profile,
        session: input.session,
        sessionPolicy: input.session_policy,
        windowName: input.window_name,
        requestedWindows: input.windows,
        register: input.register,
        importTags: input.tags,
        importMetadata: input.metadata as JsonObject | undefined,
        dryRun: input.dry_run,
        attach: false,
        agentId: input.agent ? agentId(input.agent) : ensureCliAgent().id,
        source: "mcp",
        auditCommand: "projects_start",
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_tmux_status",
  "Inspect the expected and current tmux session/window status for a project, including default 01/02 windows unless exact windows are provided.",
  {
    target: z.string().optional(),
    profile: z.string().optional(),
    session: z.string().optional(),
    agent_tool: z.enum(["codewith", "claude", "opencode", "cursor", "none"]).optional(),
    command: z.string().optional(),
    window_name: z.string().optional(),
    windows: z.array(tmuxWindowInput).optional(),
  },
  async (input) => {
    try {
      return jsonText(await projectTmuxStatus(input.target, {
        profile: input.profile,
        session: input.session,
        agentTool: input.agent_tool ? parseProjectStartAgent(input.agent_tool) : undefined,
        command: input.command,
        windowName: input.window_name,
        requestedWindows: input.windows,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_cleanup_create",
  "Safely clean up DB/files created by a project creation run using rollback records.",
  {
    project: z.string(),
    rollback_actions: z.array(rollbackActionInput).optional(),
    dry_run: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      return jsonText(withWorkspaceMutationLock(project, owner, "project creation cleanup", () => cleanupWorkspaceCreationTarget(
        cleanupTargetFromWorkspace(project, input.rollback_actions),
        {
          dryRun: input.dry_run,
          agentId: owner,
          source: "mcp",
          command: "projects_cleanup_create",
        },
      )));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_update",
  "Update project metadata. Acquires a mutation lock and records an immutable event.",
  {
    id: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().nullable().optional(),
    kind: z.string().optional(),
    status: z.enum(["active", "archived", "deleted"]).optional(),
    root: z.string().optional(),
    clear_root: z.boolean().optional(),
    recipe: z.string().optional(),
    clear_recipe: z.boolean().optional(),
    path: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    git_remote: z.string().nullable().optional(),
    s3_bucket: z.string().nullable().optional(),
    s3_prefix: z.string().nullable().optional(),
    integrations: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    stage: z.enum(PROJECT_STAGES).nullable().optional(),
    priority: z.enum(PROJECT_PRIORITIES).nullable().optional(),
    owner: z.string().nullable().optional(),
    launch_profile: z.string().nullable().optional(),
    start_agent: z.enum(PROJECT_START_AGENTS).nullable().optional(),
    start_command: z.string().nullable().optional(),
    start_session_policy: z.enum(PROJECT_START_SESSION_POLICIES).nullable().optional(),
    start_windows: z.array(tmuxWindowInput).nullable().optional(),
    todos_project_id: z.string().nullable().optional(),
    todos_task_list_id: z.string().nullable().optional(),
    brief_id: z.string().nullable().optional(),
    brief_path: z.string().nullable().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.id);
      if (!project) return errorText(`Project not found: ${input.id}`);
      const owner = agentId(input.agent);
      const metadataBase = input.metadata === undefined ? project.metadata : input.metadata as JsonObject;
      const metadataFields = {
        stage: input.stage,
        priority: input.priority,
        owner: input.owner,
        launch_profile: input.launch_profile,
        start_agent: input.start_agent,
        start_command: input.start_command,
        start_session_policy: input.start_session_policy,
        start_windows: input.start_windows,
      };
      const metadata = hasProjectManagementFields(metadataFields)
        ? mergeProjectManagementMetadata(metadataBase, metadataFields)
        : input.metadata === undefined ? undefined : metadataBase;
      const integrationsBase = input.integrations === undefined ? project.integrations : input.integrations as WorkspaceIntegrations;
      const integrationFields = {
        todos_project_id: input.todos_project_id,
        todos_task_list_id: input.todos_task_list_id,
        brief_id: input.brief_id,
        brief_path: input.brief_path,
      };
      const integrations = hasProjectIntegrationFields(integrationFields)
        ? mergeProjectIntegrationFields(integrationsBase, integrationFields)
        : input.integrations === undefined ? undefined : integrationsBase;
      const updated = withWorkspaceMutationLock(project, owner, "project update", () => updateWorkspace(project.id, {
        name: input.name,
        slug: input.slug,
        description: input.description,
        kind: input.kind as WorkspaceKind | undefined,
        status: input.status,
        root_id: input.clear_root ? null : rootId(input.root),
        recipe_id: input.clear_recipe ? null : recipeId(input.recipe),
        primary_path: input.path,
        tags: input.tags,
        git_remote: input.git_remote,
        s3_bucket: input.s3_bucket,
        s3_prefix: input.s3_prefix,
        integrations,
        metadata,
        agent_id: owner,
        source: "mcp",
        command: "projects_update",
      }));
      return jsonText({ project: updated });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_link",
  "Merge external integration IDs into a project and record an update event.",
  {
    project: z.string(),
    integrations: z.record(z.string()),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      return jsonText({ project: linkWorkspaceExternalIntegrations(project, input.integrations as WorkspaceIntegrations, {
        agent_id: owner,
        source: "mcp",
        command: "projects_link",
      }) });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_tag",
  "Add tags to a project and record an update event.",
  {
    project: z.string(),
    tags: z.array(z.string()).min(1),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const updated = withWorkspaceMutationLock(project, owner, "project tag", () => updateWorkspace(project.id, {
        tags: mergeProjectTags(project.tags, input.tags),
        agent_id: owner,
        source: "mcp",
        command: "projects_tag",
      }));
      return jsonText({ project: projectWithManagement(updated) });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_untag",
  "Remove tags from a project and record an update event.",
  {
    project: z.string(),
    tags: z.array(z.string()).min(1),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const updated = withWorkspaceMutationLock(project, owner, "project untag", () => updateWorkspace(project.id, {
        tags: removeProjectTags(project.tags, input.tags),
        agent_id: owner,
        source: "mcp",
        command: "projects_untag",
      }));
      return jsonText({ project: projectWithManagement(updated) });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_unlink",
  "Clear external integration IDs from a project and record an update event.",
  {
    project: z.string(),
    keys: z.array(z.string()).min(1),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const unlinked = expandProjectIntegrationUnlinkKeys(input.keys);
      if (unlinked.length === 0) return errorText("Provide at least one integration key or group to unlink");
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const updated = withWorkspaceMutationLock(project, owner, "project integration unlink", () => updateWorkspace(project.id, {
        integrations: unlinkProjectIntegrationFields(project.integrations, input.keys),
        agent_id: owner,
        source: "mcp",
        command: "projects_unlink",
      }));
      return jsonText({ project: projectWithManagement(updated), unlinked });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_archive",
  "Archive a project. Acquires a mutation lock and records an event.",
  { id: z.string(), agent: z.string().optional() },
  async (input) => {
    try {
      const project = findProjectTarget(input.id);
      if (!project) return errorText(`Project not found: ${input.id}`);
      const owner = agentId(input.agent);
      return jsonText({ project: withWorkspaceMutationLock(project, owner, "project archive", () => archiveWorkspace(project.id, {
        agent_id: owner,
        source: "mcp",
        command: "projects_archive",
      })) });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_unarchive",
  "Restore an archived or deleted project to active.",
  { id: z.string(), agent: z.string().optional() },
  async (input) => {
    try {
      const project = findProjectTarget(input.id);
      if (!project) return errorText(`Project not found: ${input.id}`);
      const owner = agentId(input.agent);
      return jsonText({ project: withWorkspaceMutationLock(project, owner, "project unarchive", () => unarchiveWorkspace(project.id, {
        agent_id: owner,
        source: "mcp",
        command: "projects_unarchive",
      })) });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_delete",
  "Mark a project deleted, or hard-delete the row when hard=true.",
  { id: z.string(), hard: z.boolean().optional(), agent: z.string().optional() },
  async (input) => {
    try {
      const project = findProjectTarget(input.id);
      if (!project) return errorText(`Project not found: ${input.id}`);
      const owner = agentId(input.agent);
      return jsonProjectText(withWorkspaceMutationLock(project, owner, "project delete", () => deleteWorkspace(project.id, {
        hard: input.hard,
        agent_id: owner,
        source: "mcp",
        command: "projects_delete",
      })));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_doctor",
  "Check one or all projects for path, marker, reference, location, and failed-run issues. Full records by default; pass compact=true for compact summaries.",
  {
    id: z.string().optional(),
    fix: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const options = { fix: input.fix, dryRun: input.dry_run };
    if (input.id) {
      const project = findProjectTarget(input.id);
      if (!project) return errorText(`Project not found: ${input.id}`);
      const owner = ensureCliAgent().id;
      const result = input.fix && !input.dry_run
        ? withWorkspaceMutationLock(project, owner, "project doctor fix", () => doctorWorkspace(project, options))
        : doctorWorkspace(project, options);
      return jsonText(!input.compact || input.verbose
        ? [projectDoctorPayload(result)]
        : {
            results: [compactDoctorResult(result)],
            count: 1,
            total: 1,
            limit: 1,
            has_more: false,
            next_steps: "Pass verbose=true for full check records and full project payloads.",
          });
    }
    const owner = ensureCliAgent().id;
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    const projects = listWorkspaces({ limit: input.compact && !input.verbose ? limit + 1 : input.limit ?? 500 });
    const results = projects.map((project) => input.fix && !input.dry_run
      ? withWorkspaceMutationLock(project, owner, "project doctor fix", () => doctorWorkspace(project, options))
      : doctorWorkspace(project, options));
    if (!input.compact || input.verbose) return jsonText(results.map(projectDoctorPayload));
    const visible = results.slice(0, limit);
    return jsonText({
      results: visible.map(compactDoctorResult),
      count: visible.length,
      total_returned: results.length,
      limit,
      has_more: results.length > visible.length,
      next_steps: "Pass verbose=true for full check records and full project payloads, or pass id to inspect one project.",
    });
  },
);

server.tool(
  "projects_events_list",
  "List audit events for a project. Full records by default; pass compact=true for compact summaries.",
  {
    project: z.string(),
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const project = findProjectTarget(input.project);
    if (!project) return errorText(`Project not found: ${input.project}`);
    const events = listWorkspaceEvents(project.id);
    if (!input.compact) return jsonText({ project, events });
    const limit = mcpLimit(input.limit, DEFAULT_MCP_EVENT_LIMIT);
    const visible = events.slice(-limit).reverse();
    return jsonText({
      project: input.verbose ? projectWithManagement(project) : compactProject(project),
      events: input.verbose ? visible : visible.map((event) => compactEvent(event)),
      count: visible.length,
      total: events.length,
      limit,
      has_more: events.length > visible.length,
      next_steps: "Increase limit, pass verbose=true for full event records, or use projects_show verbose=true for full project context.",
    });
  },
);

server.tool(
  "projects_event_record",
  "Record a custom audit event for a project.",
  {
    project: z.string(),
    event_type: z.string(),
    agent: z.string().optional(),
    prompt: z.string().optional(),
    before: z.record(z.unknown()).nullable().optional(),
    after: z.record(z.unknown()).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      const event = recordWorkspaceEvent({
        workspace_id: project.id,
        agent_id: input.agent ? agentId(input.agent) : undefined,
        event_type: input.event_type,
        source: "mcp",
        prompt: input.prompt,
        command: "projects_event_record",
        before: input.before as JsonObject | null | undefined,
        after: input.after as JsonObject | null | undefined,
        metadata: input.metadata as JsonObject | undefined,
      });
      return jsonText({ project, event });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_locks",
  "List currently held project mutation locks. Full records by default; pass compact=true for compact summaries.",
  {
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    const locks = listWorkspaceLocks();
    if (!input.compact || input.verbose) return jsonText(locks);
    const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
    return jsonText(compactListPayload(locks, locks.slice(0, limit).map(compactLock), limit, "Pass verbose=true for full lock records."));
  },
);

server.tool(
  "projects_lock",
  "Acquire a project mutation lock.",
  {
    project: z.string(),
    key: z.string().optional(),
    agent: z.string().optional(),
    reason: z.string().optional(),
    ttl_seconds: z.number().int().positive().optional(),
  },
  async (input) => {
    try {
      const project = findProjectTarget(input.project);
      if (!project) return errorText(`Project not found: ${input.project}`);
      return jsonText(acquireWorkspaceLock({
        lock_key: input.key ?? `workspace:${project.id}`,
        workspace_id: project.id,
        agent_id: input.agent ? agentId(input.agent) : undefined,
        reason: input.reason,
        ttl_seconds: input.ttl_seconds,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_unlock",
  "Release a project mutation lock.",
  { key: z.string() },
  async (input) => jsonText({ released: releaseWorkspaceLock(input.key) }),
);

server.tool(
  "projects_agent_eval",
  "Run project prompt-agent eval cases and return pass rate/confidence.",
  {
    mock: z.boolean().optional(),
    model: z.string().optional(),
    max_steps: z.number().int().positive().max(20).optional(),
    cases: z.array(z.string()).optional(),
    base_path: z.string().optional(),
  },
  async (input) => {
    try {
      return jsonText(await runWorkspaceAgentEval({
        mock: input.mock,
        model: input.model,
        maxSteps: input.max_steps,
        caseIds: parseWorkspaceAgentEvalCaseIds(input.cases?.join(",")),
        basePath: input.base_path,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_agent_prompt",
  "Run the AI SDK/OpenRouter project agent prompt loop. Use dry_run unless explicit mutation is desired.",
  {
    prompt: z.string(),
    yes: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    model: z.string().optional(),
    max_steps: z.number().int().positive().max(20).optional(),
    agent: z.string().optional(),
    root: z.string().optional(),
    recipe: z.string().optional(),
    tmux: z.boolean().optional(),
    mock: z.boolean().optional(),
    budget_project: z.string().optional(),
    run_budget_usd: z.number().nonnegative().optional(),
    run_budget_input_tokens: z.number().int().nonnegative().optional(),
    run_budget_output_tokens: z.number().int().nonnegative().optional(),
    run_budget_total_tokens: z.number().int().nonnegative().optional(),
  },
  async (input) => {
    try {
      return jsonText(await runWorkspaceAgentPrompt({
        prompt: input.prompt,
        approve: input.yes,
        dryRun: input.dry_run,
        model: input.model,
        maxSteps: input.max_steps,
        agent: input.agent,
        root: input.root,
        recipe: input.recipe,
        tmux: input.tmux,
        mock: input.mock,
        budgetProject: input.budget_project,
        runBudget: {
          maxUsd: input.run_budget_usd,
          maxInputTokens: input.run_budget_input_tokens,
          maxOutputTokens: input.run_budget_output_tokens,
          maxTotalTokens: input.run_budget_total_tokens,
        },
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_budgets_set",
  "Create or update a hard/soft money and token budget for a project or agent run.",
  {
    project: z.string().optional(),
    run_id: z.string().optional(),
    id: z.string().optional(),
    window: z.enum(["daily", "monthly", "lifetime"]).optional(),
    mode: z.enum(["hard", "soft"]).optional(),
    max_usd: z.number().nonnegative().optional(),
    max_input_tokens: z.number().int().nonnegative().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    max_total_tokens: z.number().int().nonnegative().optional(),
    warning_threshold: z.number().min(0).max(1).optional(),
  },
  async (input) => {
    try {
      const project = input.project ? findProjectTarget(input.project) : null;
      if (input.project && !project) return errorText(`Project not found: ${input.project}`);
      if (!project && !input.run_id) return errorText("Pass project or run_id");
      if (project && input.run_id) return errorText("Choose only one scope: project or run_id");
      const scopeType = project ? "project" : "run";
      const scopeId = project?.id ?? input.run_id!;
      return jsonText({
        budget: createProjectBudget({
          id: input.id ?? `${scopeType}-${scopeId}`,
          scope_type: scopeType,
          scope_id: scopeId,
          window: input.window,
          mode: input.mode,
          max_usd: input.max_usd,
          max_input_tokens: input.max_input_tokens,
          max_output_tokens: input.max_output_tokens,
          max_total_tokens: input.max_total_tokens,
          warning_threshold: input.warning_threshold,
          metadata: { project_slug: project?.slug },
        }),
      });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_budgets_remaining",
  "Return remaining money and token budget for a project, run, or budget id. Full records by default; pass compact=true for compact summaries.",
  {
    project: z.string().optional(),
    run_id: z.string().optional(),
    budget_id: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
    compact: z.boolean().optional(),
    verbose: z.boolean().optional(),
  },
  async (input) => {
    try {
      const project = input.project ? findProjectTarget(input.project) : null;
      if (input.project && !project) return errorText(`Project not found: ${input.project}`);
      const statuses = getProjectBudgetStatuses({
        workspace_id: project?.id,
        run_id: input.run_id,
        budget_id: input.budget_id,
      });
      if (!input.compact || input.verbose) return jsonText(statuses);
      const limit = mcpLimit(input.limit, DEFAULT_MCP_LIST_LIMIT);
      return jsonText(compactListPayload(statuses, statuses.slice(0, limit).map(compactBudgetStatus), limit, "Pass verbose=true for full budget records."));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_budgets_spend",
  "Record audited project or run spend in USD and tokens.",
  {
    project: z.string().optional(),
    run_id: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    usd: z.number().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  },
  async (input) => {
    try {
      const project = input.project ? findProjectTarget(input.project) : null;
      if (input.project && !project) return errorText(`Project not found: ${input.project}`);
      if (!project && !input.run_id) return errorText("Pass project or run_id");
      return jsonText({
        spend: recordProjectSpend({
          workspace_id: project?.id,
          run_id: input.run_id,
          provider: input.provider,
          model: input.model,
          usd: input.usd,
          input_tokens: input.input_tokens,
          output_tokens: input.output_tokens,
          total_tokens: input.total_tokens,
          metadata: { source: "mcp" },
        }),
      });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "storage_status",
  "Show projects storage sync configuration and local sync history.",
  {},
  async () => jsonText(getStorageStatus()),
);

server.tool(
  "storage_push",
  "Push local project data to storage PostgreSQL.",
  { tables: z.array(z.string()).optional() },
  async (input) => jsonText(await storagePush(input.tables ? { tables: input.tables } : undefined)),
);

server.tool(
  "storage_pull",
  "Pull project data from storage PostgreSQL to local SQLite.",
  { tables: z.array(z.string()).optional() },
  async (input) => jsonText(await storagePull(input.tables ? { tables: input.tables } : undefined)),
);

server.tool(
  "storage_sync",
  "Bidirectional project storage sync: pull then push.",
  { tables: z.array(z.string()).optional() },
  async (input) => jsonText(await storageSync(input.tables ? { tables: input.tables } : undefined)),
);

server.tool(
  "projects_context",
  "Emit a compact agent-priming bundle for a project: resolved project, root/recipe, siblings, recent events, tmux state, integrations, doctor, budgets, and storage sync. Resolves the project from target or cwd.",
  {
    target: z.string().optional(),
    cwd: z.string().optional(),
    events_limit: z.number().int().positive().optional(),
    siblings_limit: z.number().int().positive().optional(),
    for_agent: z.boolean().optional(),
  },
  async (input) => {
    try {
      const ctx = buildProjectAgentContext({
        target: input.target,
        cwd: input.cwd,
        eventsLimit: input.events_limit,
        siblingsLimit: input.siblings_limit,
      });
      if (input.for_agent) return jsonText({ text: toAgentText(ctx) });
      return jsonText(ctx);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_next",
  "Suggest high-leverage next actions for a project (start, doctor --fix, budget review, rename resolution, cleanup, lock release, unarchive). Derives from existing state only.",
  {
    target: z.string().optional(),
    cwd: z.string().optional(),
    limit: z.number().int().positive().optional(),
    for_agent: z.boolean().optional(),
  },
  async (input) => {
    try {
      const res = suggestProjectNextActions({
        target: input.target,
        cwd: input.cwd,
        limit: input.limit,
      });
      if (input.for_agent) return jsonText({ text: toAgentText(res) });
      return jsonText(res);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_why",
  "Explain how a project target resolves (id/slug, name, path, marker) with a step-by-step trace and suggestions when resolution fails.",
  {
    target: z.string().optional(),
    cwd: z.string().optional(),
    for_agent: z.boolean().optional(),
  },
  async (input) => {
    try {
      const res = explainProjectResolution(input.target, { cwd: input.cwd });
      if (input.for_agent) return jsonText({ text: toAgentText(res) });
      return jsonText(res);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_handoff",
  "Emit a cross-agent/cross-machine handoff bundle: project state, integrations, tmux sessions, open locks, recent events and agent runs, plus handoff instructions.",
  {
    target: z.string().optional(),
    cwd: z.string().optional(),
    events_limit: z.number().int().positive().optional(),
    runs_limit: z.number().int().positive().optional(),
    for_agent: z.boolean().optional(),
  },
  async (input) => {
    try {
      const h = buildProjectHandoff({
        target: input.target,
        cwd: input.cwd,
        eventsLimit: input.events_limit,
        runsLimit: input.runs_limit,
      });
      if (input.for_agent) return jsonText({ text: toAgentText(h) });
      return jsonText(h);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_runs_list",
  "List recent prompt-agent runs recorded for a project (status, model, tool-call count, timing).",
  {
    target: z.string().optional(),
    cwd: z.string().optional(),
    limit: z.number().int().positive().optional(),
    status: z.enum(["planned", "running", "completed", "failed"]).optional(),
    for_agent: z.boolean().optional(),
  },
  async (input) => {
    try {
      const res = listProjectAgentRunsView({
        target: input.target,
        cwd: input.cwd,
        limit: input.limit,
        status: input.status,
      });
      if (input.for_agent) return jsonText({ text: toAgentText(res) });
      return jsonText(res);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_runs_show",
  "Show full detail for one prompt-agent run, including the prompt, tool-call trace, result, and error.",
  {
    run_id: z.string(),
    target: z.string().optional(),
    cwd: z.string().optional(),
    for_agent: z.boolean().optional(),
  },
  async (input) => {
    try {
      const detail = getProjectAgentRunDetail({ runId: input.run_id, target: input.target, cwd: input.cwd });
      if (input.for_agent) return jsonText({ text: toAgentText(detail) });
      return jsonText(detail);
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (isHttpMode(args)) {
    startMcpHttpServer({ name: "projects", port: resolveMcpHttpPort(args), buildServer });
    return;
  }
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
}

if (import.meta.main) {
  await main();
}
