import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, stepCountIs, tool } from "ai";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  acquireWorkspaceLock,
  createRoot,
  createRecipe,
  completeAgentRun,
  createAgent,
  createTmuxProfile,
  ensureCliAgent,
  getAgent,
  getAgentBySlug,
  getRecipe,
  getRecipeBySlug,
  getRoot,
  getRootBySlug,
  getWorkspaceByPath,
  listAgents,
  listRecipes,
  listRoots,
  listWorkspaceEvents,
  listWorkspaceAgents,
  listWorkspaceLocations,
  listTmuxProfiles,
  listTmuxProfileWindows,
  listWorkspaces,
  mergeAgentPermissions,
  recordWorkspaceEvent,
  releaseWorkspaceLock,
  resolveTmuxProfile,
  resolveWorkspace,
  scoreRoots,
  startAgentRun,
} from "../db/workspaces.js";
import { applyWorkspaceTmux, applyWorkspaceTmuxProfile, workspaceMarkerPath, type WorkspaceTmuxWindowSpec } from "./workspace-runtime.js";
import {
  importWorkspaceFromGitHub,
  syncWorkspaceGitHubRoots,
  linkWorkspaceExternalIntegrations,
  normalizeWorkspaceIntegrations,
  publishWorkspaceToGitHub,
  unpublishWorkspaceFromGitHub,
  type GitHubRemoteProtocol,
  type GitHubVisibility,
} from "./workspace-github.js";
import { doctorWorkspace } from "./workspace-doctor.js";
import { resolveProjectStore, type ProjectStore } from "../store/project-store.js";
import { isProjectContextError } from "./project-context-errors.js";
import { importRegisteredRoots, importWorkspace, importWorkspaceBulk, planWorkspaceImport } from "./workspace-import.js";
import {
  cleanupWorkspaceCreationTarget,
  executeWorkspaceCreation,
  planWorkspaceCreation,
  type WorkspaceCreationPlanAction,
} from "./workspace-plan.js";
import {
  parseProjectStartAgent,
  startProject,
} from "./project-start.js";
import { projectTmuxStatus } from "./project-tmux-status.js";
import { ensureProjectChannel, resolveProjectChannelForProject } from "./project-channel.js";
import { filterProjectEvalArtifacts } from "./project-eval-artifacts.js";
import {
  BudgetExceededError,
  assertProjectBudgets,
  assertProjectBudgetsAfterSpend,
  createProjectBudget,
  estimateProjectCostUsd,
  getProjectBudgetStatuses,
  normalizeProjectUsage,
  recordProjectSpend,
  type ProjectBudgetStatus,
} from "./budget.js";
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
  projectExternalLinksSummary,
  projectManagementSummary,
  removeProjectTags,
  unlinkProjectIntegrationFields,
} from "./project-management.js";
import { AGENT_KINDS, PROJECT_AGENT_ROLES, WORKSPACE_KINDS, type Agent, type JsonObject, type Workspace, type WorkspaceEvent, type WorkspaceIntegrations, type WorkspaceKind } from "../types/workspace.js";

export const DEFAULT_WORKSPACE_AGENT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_SECRET_KEYS = ["hasna/takumi/live/openrouter_api_key", "openrouter/api_key", "OPENROUTER_API_KEY"];
const DEFAULT_WORKSPACE_AGENT_CONTEXT_LIMIT = 500;
const DEFAULT_PROJECT_AGENT_LIST_LIMIT = 25;

export const PROJECT_AGENT_READ_TOOLS = [
  "projects_roots_list",
  "projects_roots_match",
  "projects_recipes_list",
  "projects_recipes_show",
  "projects_agents_list",
  "projects_list",
  "projects_show",
  "projects_locations_list",
  "projects_events_list",
  "projects_doctor",
  "projects_tmux_status",
  "projects_tmux_profiles_list",
  "projects_plan_create",
] as const;

export const PROJECT_AGENT_MUTATION_TOOLS = [
  "projects_create",
  "projects_roots_add",
  "projects_recipes_add",
  "projects_agents_add",
  "projects_agents_assign",
  "projects_locations_add",
  "projects_tmux_profiles_add",
  "projects_update",
  "projects_tag",
  "projects_untag",
  "projects_archive",
  "projects_unarchive",
  "projects_delete",
  "projects_cleanup_create",
  "projects_import",
  "projects_scan_roots",
  "projects_tmux_profiles_apply",
  "projects_github_publish",
  "projects_import_github",
  "projects_github_unpublish",
  "projects_link",
  "projects_unlink",
  "projects_channel",
  "projects_event_record",
  "projects_start",
] as const;

export const PROJECT_AGENT_DESTRUCTIVE_TOOLS = [
  "projects_delete",
  "projects_cleanup_create",
  "projects_github_unpublish",
] as const;

export interface ProjectAgentMutationAudit {
  writes_allowed: boolean;
  approved: boolean;
  dry_run: boolean;
  mutating_tool_calls: string[];
  destructive_tool_calls: string[];
  planned_without_approval: string[];
  violations: string[];
}

export interface WorkspaceAgentPromptOptions {
  prompt: string;
  model?: string;
  maxSteps?: number;
  dryRun?: boolean;
  approve?: boolean;
  mock?: boolean;
  agent?: string;
  root?: string;
  recipe?: string;
  tmux?: boolean;
  budgetProject?: string;
  runBudget?: {
    maxUsd?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxTotalTokens?: number;
  };
}

export interface WorkspaceAgentPromptResult {
  mode: "ai" | "mock";
  run_id: string;
  agent_id: string;
  provider: "openrouter";
  model: string;
  actor_agent_id: string;
  approved: boolean;
  dry_run: boolean;
  text: string;
  projects: Workspace[];
  tool_calls: JsonObject[];
  mutation_audit?: ProjectAgentMutationAudit;
  usage?: JsonObject;
  budget_statuses?: JsonObject[];
}

function pickModel(model?: string): string {
  return model ?? process.env["PROJECTS_AGENT_MODEL"] ?? process.env["WORKSPACES_AGENT_MODEL"] ?? process.env["OPENROUTER_MODEL"] ?? DEFAULT_WORKSPACE_AGENT_MODEL;
}

function getSecretValue(key: string): string | null {
  try {
    const result = Bun.spawnSync({
      cmd: ["secrets", "get", key],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    const value = Buffer.from(result.stdout).toString("utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function resolveOpenRouterApiKey(): string | null {
  const envKey = process.env["OPENROUTER_API_KEY"] ?? process.env["PROJECTS_OPENROUTER_API_KEY"] ?? process.env["WORKSPACES_OPENROUTER_API_KEY"];
  if (envKey) return envKey;
  if ((process.env["PROJECTS_USE_SECRETS"] ?? process.env["WORKSPACES_USE_SECRETS"]) === "false") return null;

  const configured = process.env["PROJECTS_OPENROUTER_SECRET_KEY"] ?? process.env["WORKSPACES_OPENROUTER_SECRET_KEY"];
  const candidates = configured ? [configured] : DEFAULT_SECRET_KEYS;
  for (const key of candidates) {
    const value = getSecretValue(key);
    if (value) return value;
  }
  return null;
}

function ensureWorkspaceAgent(model: string): Agent {
  const existing = getAgentBySlug("project-agent");
  const permissions = [
    "project:create",
    "project:update",
    "project:delete",
    "project:import",
    "project:prepare",
    "project:start",
    "workspace:create",
    "workspace:update",
    "workspace:delete",
    "workspace:import",
    "workspace:prepare",
    "github:publish",
    "tmux:apply",
    "doctor:fix",
    "agent-runs:record",
  ];
  if (existing) {
    const missing = permissions.filter((permission) => !existing.permissions.includes(permission));
    if (missing.length === 0) return existing;
    return mergeAgentPermissions(existing.id, permissions);
  }
  return createAgent({
    slug: "project-agent",
    name: "Project Agent",
    kind: "ai",
    provider: "openrouter",
    model,
    role: "project-orchestrator",
    permissions,
  });
}

function compactRoot(root: ReturnType<typeof listRoots>[number]): JsonObject {
  return {
    id: root.id,
    slug: root.slug,
    name: root.name,
    base_path: root.base_path,
    tags: root.tags,
    default_kind: root.default_kind,
    path_template: root.path_template,
    github_org: root.github_org,
    repo_visibility: root.repo_visibility,
  };
}

function truncateText(value: string | null | undefined, max = 120): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= max) return normalized;
  if (max <= 3) return normalized.slice(0, max);
  return `${normalized.slice(0, max - 3)}...`;
}

function compactWorkspace(workspace: Workspace): JsonObject {
  const management = projectManagementSummary(workspace);
  const externalLinks = projectExternalLinksSummary(workspace);
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    kind: workspace.kind,
    status: workspace.status,
    stage: management.stage,
    priority: management.priority,
    owner: management.owner,
    primary_path: truncateText(workspace.primary_path, 160),
    tags: workspace.tags,
    links: {
      todos: externalLinks.todos.linked,
      brief: externalLinks.brief.linked,
      github: Boolean(workspace.integrations.github_repo || workspace.integrations.github_url || workspace.git_remote),
    },
    updated_at: workspace.updated_at,
    last_opened_at: workspace.last_opened_at,
  };
}

function detailedProject(workspace: Workspace): JsonObject {
  return {
    ...compactWorkspace(workspace),
    description: truncateText(workspace.description, 240),
    root_id: workspace.root_id,
    recipe_id: workspace.recipe_id,
    git_remote: workspace.git_remote,
    s3_bucket: workspace.s3_bucket,
    s3_prefix: workspace.s3_prefix,
    management: projectManagementSummary(workspace),
    external_links: projectExternalLinksSummary(workspace),
    metadata_keys: Object.keys(workspace.metadata),
    integration_keys: Object.keys(workspace.integrations),
    created_at: workspace.created_at,
    synced_at: workspace.synced_at,
  };
}

function fullProject(workspace: Workspace): JsonObject {
  return {
    ...workspace,
    management: projectManagementSummary(workspace),
    external_links: projectExternalLinksSummary(workspace),
  };
}

function compactAgentEvent(event: WorkspaceEvent): JsonObject {
  return {
    id: event.id,
    event_type: event.event_type,
    source: event.source,
    agent_id: event.agent_id,
    created_at: event.created_at,
    metadata_keys: Object.keys(event.metadata),
  };
}

function detailedAgentEvent(event: WorkspaceEvent): JsonObject {
  return {
    ...compactAgentEvent(event),
    prompt: truncateText(event.prompt, 160),
    command: truncateText(event.command, 200),
  };
}

function compactAgentAssignment(assignment: ReturnType<typeof listWorkspaceAgents>[number]): JsonObject {
  return {
    agent: assignment.agent?.slug ?? assignment.agent_id,
    role: assignment.role,
    kind: assignment.agent?.kind ?? null,
    created_at: assignment.created_at,
  };
}

function compactAgentLocation(location: ReturnType<typeof listWorkspaceLocations>[number]): JsonObject {
  return {
    id: location.id,
    label: location.label,
    kind: location.kind,
    primary: location.is_primary,
    machine: location.machine_id,
    path: truncateText(location.path, 160),
  };
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

function compactProject(workspace: Workspace): JsonObject {
  return compactWorkspace(workspace);
}

function workspaceContextLimit(): number {
  const raw = process.env["PROJECTS_AGENT_CONTEXT_LIMIT"] ?? process.env["WORKSPACES_AGENT_CONTEXT_LIMIT"];
  if (!raw) return DEFAULT_WORKSPACE_AGENT_CONTEXT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_WORKSPACE_AGENT_CONTEXT_LIMIT;
  return Math.min(parsed, 1_000);
}

export function buildWorkspaceInventoryContext(limit = workspaceContextLimit()): JsonObject {
  const projects = filterProjectEvalArtifacts(listWorkspaces({ limit, exclude_eval_artifacts: true })).map(compactProject);
  return {
    count: projects.length,
    limit,
    projects,
  };
}

export function buildProjectAgentToolCatalog(): JsonObject {
  return {
    read_only_tools: [...PROJECT_AGENT_READ_TOOLS],
    mutating_tools: [...PROJECT_AGENT_MUTATION_TOOLS],
    destructive_tools: [...PROJECT_AGENT_DESTRUCTIVE_TOOLS],
    launch_tools: ["projects_start", "projects_tmux_status", "projects_tmux_profiles_list", "projects_tmux_profiles_apply"],
    creation_tools: ["projects_plan_create", "projects_create", "projects_import", "projects_import_github", "projects_scan_roots", "projects_sync_roots", "projects_scan_local_roots"],
    management_tools: ["projects_update", "projects_tag", "projects_untag", "projects_archive", "projects_unarchive", "projects_delete", "projects_link", "projects_unlink", "projects_agents_assign", "projects_event_record"],
    boundaries: {
      projects: "identity, metadata, paths, lifecycle, integrations, launch state, agents, and audit events",
      todos: "tasks, checklists, dependencies, execution status, and sprint-level work",
      brief: "briefs, specs, decisions, and long-form planning documents",
    },
    approval_policy: {
      writes_require_yes: true,
      no_yes_means_planned_or_read_only: true,
      dry_run_overrides_yes: true,
      destructive_tools_should_be_planned_first: [...PROJECT_AGENT_DESTRUCTIVE_TOOLS],
    },
  };
}

export function buildWorkspaceAgentSystemPrompt(input: {
  actorAgentId: string;
  forcedRootId?: string;
  forcedRecipeId?: string;
  tmuxAllowed: boolean;
  projectInventory?: JsonObject;
  workspaceInventory?: JsonObject;
}): string {
  const inventory = input.projectInventory ?? input.workspaceInventory ?? buildWorkspaceInventoryContext();
  const toolCatalog = buildProjectAgentToolCatalog();
  return [
    "You are the Projects project management and launcher agent.",
    "The compact project_inventory JSON below is loaded from recorded projects before this run. Treat it as the first source of truth for deduplication by name, slug, path, tags, lifecycle, and linked-system hints.",
    "Before creating anything, compare the user request against project_inventory. If a matching project already exists, use projects_show, projects_update, projects_tag, projects_untag, projects_link, projects_unlink, projects_event_record, projects_start, projects_tmux_profiles_apply, or another existing-project tool instead of creating a duplicate.",
    "If the request may refer to an existing project and the compact inventory is not specific enough, call projects_list with query/tags/kind/status and projects_show with verbose=true before deciding, especially when metadata or integration values are needed for deduplication.",
    "Use projects_roots_list/projects_roots_match, projects_recipes_list/projects_recipes_show, projects_agents_list, projects_list/projects_show/projects_locations_list/projects_events_list, and projects_tmux_profiles_list to inspect recorded state before creating anything.",
    "A project can represent any project, repository, app, docs folder, scaffold, experiment, or remote-intended project in any folder.",
    "Projects owns project identity, metadata, paths, lifecycle, integrations, launch state, agents, and audit events. Todos owns tasks and checklists. Brief owns briefs, specs, and decision documents. Link to those systems through integrations; do not duplicate task or brief data inside Projects.",
    "For high-level project management, use first-class fields on projects_create/projects_update: stage, priority, owner, launch_profile, start_agent, start_command, start_session_policy, start_windows, todos_project_id, todos_task_list_id, brief_id, and brief_path.",
    `Prompt constraints: acting agent id is ${input.actorAgentId};${input.forcedRootId ? ` root id ${input.forcedRootId} is required for new projects;` : ""}${input.forcedRecipeId ? ` recipe id ${input.forcedRecipeId} is required for new projects;` : ""} tmux is ${input.tmuxAllowed ? "allowed" : "disabled"}.`,
    "Prefer an explicit user-requested path when present. Otherwise select a registered root whose tags/kind match the request.",
    "If a prompt constraint provides a required root or recipe, pass that root/recipe to projects_create or let the tool apply the constraint; do not choose a different one.",
    "If a required root is provided, do not invent or pass a project path; let the root path template determine the path.",
    "Only mutating tools are allowed to make changes, and those tools will refuse to mutate unless the CLI was run with --yes.",
    "For every requested mutation, call the corresponding mutating tool even in dry-run mode so it returns a structured planned action. Do not only describe a change after inspection.",
    "Use projects_roots_add for registering a new root/path, projects_locations_add for registering additional folders for an existing project, projects_recipes_add for new creation recipes, projects_agents_add for recording human/AI/service/CLI agents, projects_agents_assign for assigning project owner/maintainer/contributor/service/prompt-agent roles, and projects_tmux_profiles_add for saved tmux layouts.",
    "Use projects_plan_create for explicit no-write planning, projects_update for requested metadata changes, projects_tag/projects_untag for additive tag changes, projects_archive/projects_unarchive for status changes, projects_delete for lifecycle deletion, projects_cleanup_create for cleaning up a partial or unwanted creation run, projects_import for one-folder import requests, projects_scan_roots/projects_sync_roots for configured GitHub root repository scans/imports, projects_scan_local_roots for local child-folder scans/imports, projects_import_github for GitHub repository imports, projects_github_publish/projects_github_unpublish for GitHub publication state, projects_link/projects_unlink for external IDs, projects_doctor for checks, projects_event_record for custom audit events, projects_tmux_status for launch/runtime inspection, projects_start for open/start/resume requests, and projects_create for new projects.",
    "For projects_import_github, set remote_only=true only when the user explicitly wants a remote-only record and did not provide a root, path, or clone request. A root/path/clone request means local project registration.",
    "When a user asks to inspect running project sessions or tmux state, call projects_tmux_status.",
    "When a user asks to start, open, resume, or launch work in a project, call projects_start. It creates or reuses a tmux session, ensures default 01 and 02 windows, can register an unknown folder with tags/metadata, can apply a saved tmux profile, can choose reuse/new/error-if-running session policy, can launch codewith, claude, opencode, cursor, or no tool, and can use windows to request the exact tmux window names to create.",
    "When a user asks for tmux or mentions a saved tmux profile, call projects_tmux_profiles_list before projects_create or projects_tmux_profiles_apply. The tools reject saved profile usage until profiles have been inspected.",
    "If tmux is disabled, do not call tmux tools and do not include tmux or tmux_profile arguments in projects_create, even if the user mentions tmux.",
    "When creating a local project directory, write a .project.json marker unless the user explicitly asks not to. The marker name is a current storage detail.",
    "Finish with a concise summary of the plan or what was changed.",
    `tool_catalog=${JSON.stringify(toolCatalog)}`,
    `project_inventory=${JSON.stringify(inventory)}`,
  ].join("\n");
}

function resolveRootId(idOrSlug: string | undefined): string | undefined {
  if (!idOrSlug) return undefined;
  const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
  if (!root) throw new Error(`Root not found: ${idOrSlug}`);
  return root.id;
}

function resolveRecipeId(idOrSlug: string | undefined): string | undefined {
  if (!idOrSlug) return undefined;
  const recipe = getRecipe(idOrSlug) ?? getRecipeBySlug(idOrSlug);
  if (!recipe) throw new Error(`Recipe not found: ${idOrSlug}`);
  return recipe.id;
}

function resolvePromptAgent(idOrSlug: string | undefined): Agent | null {
  if (!idOrSlug) return null;
  const agent = getAgent(idOrSlug) ?? getAgentBySlug(idOrSlug);
  if (!agent) throw new Error(`Agent not found: ${idOrSlug}`);
  return agent;
}

function promptCommand(options: WorkspaceAgentPromptOptions): string {
  const flags: string[] = [];
  if (options.approve) flags.push("--yes");
  if (options.dryRun) flags.push("--dry-run");
  if (options.model) flags.push("--model", options.model);
  if (options.maxSteps) flags.push("--max-steps", String(options.maxSteps));
  if (options.agent) flags.push("--agent", options.agent);
  if (options.root) flags.push("--root", options.root);
  if (options.recipe) flags.push("--recipe", options.recipe);
  if (options.tmux === false) flags.push("--no-tmux");
  return ["projects", ...flags, JSON.stringify(options.prompt)].join(" ");
}

function splitPromptName(prompt: string): string {
  const quoted = prompt.match(/["']([^"']+)["']/)?.[1];
  if (quoted) return quoted.trim();
  const named = prompt.match(/\bnamed\s+(.+?)(?:\s+(?:in|at|under)\s+\/|\s+with\b|[.,;:]|$)/i)?.[1];
  if (named) return named.trim();
  return prompt
    .replace(/\b(plan|create|make|new|generic|workspace|project|repo|repository|folder|directory)\b/gi, " ")
    .replace(/\b(in|at|under)\s+\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ") || "New Workspace";
}

function inferPathFromPrompt(prompt: string): string | undefined {
  const path = prompt.match(/\b(?:in|at|under)\s+(\/\S+)/i)?.[1] ?? prompt.match(/(\/[^\s]+)/)?.[1];
  return path?.replace(/[.,;:!?)]$/, "");
}

function isCreateIntent(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(plan|create|make|new|scaffold)\b/.test(text) && /\b(workspace|project|repo|repository|folder|directory|app|tool|site|service)\b/.test(text);
}

function isStartIntent(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(start|open|resume|launch)\b/.test(text)
    && /\b(project|repo|repository|folder|directory|app|workspace)\b/.test(text)
    && !/\b(create|make|new|scaffold)\b/.test(text);
}

function inferStartTargetFromPrompt(prompt: string): string | undefined {
  const quoted = prompt.match(/["']([^"']+)["']/)?.[1];
  if (quoted) return quoted.trim();
  const path = inferPathFromPrompt(prompt);
  if (path) return path;
  const named = prompt.match(/\b(?:project|repo|repository|folder|directory|app|workspace)\s+([a-z0-9][a-z0-9._/-]*)/i)?.[1];
  if (named) return named.trim();
  const afterVerb = prompt.match(/\b(?:start|open|resume|launch)\s+(.+?)(?:\s+(?:with|using|in|at)\b|[.,;:]|$)/i)?.[1];
  return afterVerb?.replace(/\b(project|repo|repository|folder|directory|app|workspace)\b/gi, " ").replace(/\s+/g, " ").trim() || undefined;
}

function inferStartAgentFromPrompt(prompt: string): string | undefined {
  const text = prompt.toLowerCase();
  if (/\bclaude\b/.test(text)) return "claude";
  if (/\bopencode\b/.test(text)) return "opencode";
  if (/\bcursor\b/.test(text)) return "cursor";
  if (/\bno\s+(agent|tool)|without\s+(agent|tool)\b/.test(text)) return "none";
  if (/\bcodewith\b/.test(text)) return "codewith";
  return undefined;
}

function comparisonKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findExistingWorkspaceForCreate(input: {
  name: string;
  slug?: string;
  primary_path?: string;
  path?: string;
}): Workspace | null {
  if (input.slug) {
    const bySlug = resolveWorkspace(input.slug);
    if (bySlug) return bySlug;
  }

  const path = input.primary_path ?? input.path;
  if (path) {
    const byPath = getWorkspaceByPath(path);
    if (byPath) return byPath;
  }

  const nameKey = comparisonKey(input.name);
  if (!nameKey) return null;
  return listWorkspaces({ query: input.name, limit: 25 }).find((workspace) => (
    comparisonKey(workspace.name) === nameKey || comparisonKey(workspace.slug) === nameKey
  )) ?? null;
}

async function findExistingWorkspaceForCreateViaStore(
  store: ProjectStore,
  input: { name: string; slug?: string; primary_path?: string; path?: string },
): Promise<Workspace | null> {
  const path = input.primary_path ?? input.path;
  if (path) {
    try {
      return (await store.resolveTargetResolution(path, {
        allowPath: true,
        allowMarker: true,
        intent: "read",
      })).project;
    } catch (error) {
      if (!isProjectContextError(error) || error.code !== "PROJECT_NOT_FOUND") throw error;
    }
  }
  if (input.slug) {
    const bySlug = await store.getProject(input.slug);
    if (bySlug) return bySlug;
  }
  const nameKey = comparisonKey(input.name);
  if (!nameKey) return null;
  return (await store.listProjects({ query: input.name, limit: 25 })).find((workspace) => (
    comparisonKey(workspace.name) === nameKey || comparisonKey(workspace.slug) === nameKey
  )) ?? null;
}

function existingWorkspaceOutput(workspace: Workspace): JsonObject {
  return {
    status: "already_exists",
    project: compactProject(workspace),
    note: "A matching recorded project already exists. Use update/link/start/tmux tools for changes instead of creating a duplicate.",
  };
}

function hasToolCall(toolCalls: JsonObject[], name: string): boolean {
  return toolCalls.some((call) => call["name"] === name);
}

function hasMutationToolCall(toolCalls: JsonObject[]): boolean {
  const mutationTools = new Set<string>(PROJECT_AGENT_MUTATION_TOOLS);
  return toolCalls.some((call) => typeof call["name"] === "string" && mutationTools.has(call["name"]));
}

function hasExistingWorkspaceInspection(toolCalls: JsonObject[]): boolean {
  return toolCalls.some((call) => {
    if (call["name"] !== "projects_show" || call["success"] !== true) return false;
    const output = call["output"];
    if (!output || typeof output !== "object" || Array.isArray(output)) return false;
    const record = ((output as Record<string, unknown>)["project"] ?? output) as Record<string, unknown>;
    return typeof record["id"] === "string" && typeof record["slug"] === "string" && !record["error"];
  });
}

function isProjectAgentMutationToolCall(call: JsonObject): boolean {
  const name = call["name"];
  if (typeof name !== "string") return false;
  if ((PROJECT_AGENT_MUTATION_TOOLS as readonly string[]).includes(name)) return true;
  if (name === "projects_doctor") {
    const input = call["input"];
    return Boolean(input && typeof input === "object" && !Array.isArray(input) && (input as Record<string, unknown>)["fix"]);
  }
  return false;
}

function isProjectAgentDestructiveToolCall(call: JsonObject): boolean {
  const name = call["name"];
  return typeof name === "string" && (PROJECT_AGENT_DESTRUCTIVE_TOOLS as readonly string[]).includes(name);
}

function outputLooksPlannedOrReadOnly(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, unknown>;
  if (typeof record.error === "string") return true;
  if (record.status === "planned" || record.status === "already_exists") return true;
  if (record.dry_run === true) return true;
  if (record.preview || record.plan) return true;
  const tmux = record.tmux;
  if (tmux && typeof tmux === "object" && !Array.isArray(tmux) && (tmux as Record<string, unknown>).dry_run === true) return true;
  const result = record.result;
  if (result && typeof result === "object" && !Array.isArray(result) && outputLooksPlannedOrReadOnly(result)) return true;
  const cleanup = record.cleanup;
  if (cleanup && typeof cleanup === "object" && !Array.isArray(cleanup) && outputLooksPlannedOrReadOnly(cleanup)) return true;
  return false;
}

export function auditProjectAgentToolCalls(
  toolCalls: JsonObject[],
  options: { approve: boolean; dryRun: boolean },
): ProjectAgentMutationAudit {
  const writesAllowed = options.approve && !options.dryRun;
  const mutatingToolCalls = toolCalls
    .filter(isProjectAgentMutationToolCall)
    .map((call) => String(call["name"]));
  const destructiveToolCalls = toolCalls
    .filter(isProjectAgentDestructiveToolCall)
    .map((call) => String(call["name"]));
  const plannedWithoutApproval: string[] = [];
  const violations: string[] = [];

  for (const call of toolCalls) {
    if (!isProjectAgentMutationToolCall(call)) continue;
    const name = String(call["name"]);
    if (writesAllowed) continue;
    const output = call["output"];
    if (outputLooksPlannedOrReadOnly(output)) {
      plannedWithoutApproval.push(name);
    } else {
      violations.push(`${name} did not return a clearly planned, dry-run, preview, already-existing, or error result while writes were disabled`);
    }
  }

  return {
    writes_allowed: writesAllowed,
    approved: options.approve,
    dry_run: options.dryRun,
    mutating_tool_calls: mutatingToolCalls,
    destructive_tool_calls: destructiveToolCalls,
    planned_without_approval: plannedWithoutApproval,
    violations,
  };
}

export function shouldRunWorkspaceCreateFallback(toolCalls: JsonObject[], prompt: string): boolean {
  return isCreateIntent(prompt)
    && !hasMutationToolCall(toolCalls)
    && !hasToolCall(toolCalls, "projects_plan_create")
    && !hasExistingWorkspaceInspection(toolCalls);
}

export const shouldRunProjectCreateFallback = shouldRunWorkspaceCreateFallback;

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

function withAgentWorkspaceLock<T>(workspace: Workspace, agentId: string, reason: string, fn: () => T): T {
  const key = `workspace:${workspace.id}`;
  acquireWorkspaceLock({ lock_key: key, workspace_id: workspace.id, agent_id: agentId, reason, ttl_seconds: 600 });
  try {
    return fn();
  } finally {
    releaseWorkspaceLock(key);
  }
}

async function fallbackWorkspaceCreate(
  agent: Agent,
  options: Required<Pick<WorkspaceAgentPromptOptions, "prompt" | "dryRun" | "approve">> & {
    store: ProjectStore;
    root_id?: string;
    recipe_id?: string;
    command: string;
  },
): Promise<{ call: JsonObject; workspace?: Workspace; text: string } | null> {
  if (!isCreateIntent(options.prompt)) return null;
  const workspaceInput = {
    name: splitPromptName(options.prompt),
    primary_path: options.root_id ? undefined : inferPathFromPrompt(options.prompt),
    root_id: options.root_id,
    recipe_id: options.recipe_id,
    agent_id: agent.id,
    source: "agent" as const,
    prompt: options.prompt,
    command: options.command,
  };
  const existing = await findExistingWorkspaceForCreateViaStore(options.store, workspaceInput);
  if (existing) {
    return {
      text: `Project ${existing.slug} already exists at ${existing.primary_path ?? "no local path"}.`,
      call: {
        name: "projects_create",
        input: workspaceInput,
        success: true,
        fallback: true,
        output: existingWorkspaceOutput(existing),
      },
    };
  }

  if (options.approve && !options.dryRun) {
    if (options.store.mode === "api") {
      const project = await options.store.createProject({
        ...workspaceInput,
        agent_id: undefined,
      });
      return {
        workspace: project,
        text: `Created project ${project.slug}.`,
        call: {
          name: "projects_create",
          input: workspaceInput,
          success: true,
          fallback: true,
          output: projectPayload({ status: "created", workspace: compactProject(project) }) as JsonObject,
        },
      };
    }
    const result = await executeWorkspaceCreation(workspaceInput, {
      createProject: (input) => options.store.createProject(input),
    });
    return {
      workspace: result.workspace ?? undefined,
      text: result.workspace
        ? `Created project ${result.workspace.slug}.`
        : `Executed project creation fallback for ${workspaceInput.name}.`,
      call: {
        name: "projects_create",
        input: workspaceInput,
        success: true,
        fallback: true,
        output: projectPayload({ status: "created", ...result, workspace: result.workspace ? compactProject(result.workspace) : null }) as JsonObject,
      },
    };
  }

  const plan = planWorkspaceCreation(workspaceInput);
  return {
    text: `Planned project ${plan.workspace.slug}${plan.workspace.primary_path ? ` at ${plan.workspace.primary_path}` : ""}. Run again with --yes to create it.`,
    call: {
      name: "projects_create",
      input: workspaceInput,
      success: true,
      fallback: true,
      output: projectPayload({ status: "planned", plan, note: "Run again with --yes to create this project." }) as JsonObject,
    },
  };
}

function extractToolCalls(result: { steps?: Array<{ toolCalls?: unknown[]; toolResults?: unknown[] }> }): JsonObject[] {
  const calls: JsonObject[] = [];
  for (const step of result.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      calls.push(call as unknown as JsonObject);
    }
    for (const toolResult of step.toolResults ?? []) {
      calls.push(toolResult as unknown as JsonObject);
    }
  }
  return calls;
}

async function runMockPrompt(
  agent: Agent,
  runId: string,
  options: Required<Pick<WorkspaceAgentPromptOptions, "prompt" | "dryRun" | "approve">> & {
    model: string;
    root_id?: string;
    recipe_id?: string;
    tmuxAllowed: boolean;
    command: string;
  },
): Promise<WorkspaceAgentPromptResult> {
  if (isStartIntent(options.prompt)) {
    const toolCalls: JsonObject[] = [];
    try {
      if (!options.tmuxAllowed) {
        const output = { error: "Tmux is disabled for this prompt run by --no-tmux." };
        toolCalls.push({
          name: "projects_start",
          input: { target: inferStartTargetFromPrompt(options.prompt) },
          dry_run: true,
          approved: options.approve,
          output,
        });
        completeAgentRun(runId, {
          status: "completed",
          tool_calls: toolCalls,
          result: { text: output.error, projects: [] },
        });
        return {
          mode: "mock",
          run_id: runId,
          agent_id: agent.id,
          provider: "openrouter",
          model: options.model,
          actor_agent_id: agent.id,
          approved: options.approve,
          dry_run: options.dryRun,
          text: output.error,
          projects: [],
          tool_calls: toolCalls,
        };
      }

      const input = {
        target: inferStartTargetFromPrompt(options.prompt),
        agent_tool: inferStartAgentFromPrompt(options.prompt),
      };
      const result = await startProject(input.target, {
        agentTool: input.agent_tool ? parseProjectStartAgent(input.agent_tool) : undefined,
        dryRun: options.dryRun || !options.approve,
        attach: false,
        agentId: agent.id,
        source: "agent",
        auditCommand: options.command,
      });
      const output = projectPayload(result) as JsonObject;
      toolCalls.push({
        name: "projects_start",
        input,
        dry_run: options.dryRun || !options.approve,
        approved: options.approve,
        output,
      });
      const text = options.approve && !options.dryRun
        ? `Started project ${result.project.slug} in tmux session ${result.tmux.session_name}.`
        : `Planned start for project ${result.project.slug} in tmux session ${result.tmux.session_name}. Run with --yes to execute.`;
      completeAgentRun(runId, {
        status: "completed",
        workspace_id: result.project.id === "planned" ? undefined : result.project.id,
        tool_calls: toolCalls,
        result: { text, projects: result.project.id === "planned" ? [] : [compactProject(result.project)] },
      });
      return {
        mode: "mock",
        run_id: runId,
        agent_id: agent.id,
        provider: "openrouter",
        model: options.model,
        actor_agent_id: agent.id,
        approved: options.approve,
        dry_run: options.dryRun,
        text,
        projects: result.project.id === "planned" ? [] : [result.project],
        tool_calls: toolCalls,
      };
    } catch (err) {
      const output = { error: err instanceof Error ? err.message : String(err) };
      toolCalls.push({
        name: "projects_start",
        input: { target: inferStartTargetFromPrompt(options.prompt), agent_tool: inferStartAgentFromPrompt(options.prompt) },
        dry_run: true,
        approved: options.approve,
        output,
      });
      completeAgentRun(runId, {
        status: "completed",
        tool_calls: toolCalls,
        result: { text: output.error, projects: [] },
      });
      return {
        mode: "mock",
        run_id: runId,
        agent_id: agent.id,
        provider: "openrouter",
        model: options.model,
        actor_agent_id: agent.id,
        approved: options.approve,
        dry_run: options.dryRun,
        text: output.error,
        projects: [],
        tool_calls: toolCalls,
      };
    }
  }

  const plannedPath = inferPathFromPrompt(options.prompt);
  const workspaceInput = {
    name: splitPromptName(options.prompt),
    primary_path: options.root_id ? undefined : plannedPath,
    root_id: options.root_id,
    recipe_id: options.recipe_id,
    agent_id: agent.id,
    source: "agent" as const,
    prompt: options.prompt,
    command: options.command,
    tags: ["agent-created"],
  };

  const store = resolveProjectStore();
  if (store.mode === "api") {
    // Cloud project rows are created through the Store (shared registry), never
    // the local sqlite island. Machine-local runtime does not apply to a cloud
    // row, so this mirrors the projects_create tool's api-mode path.
    const cloudExisting = await findExistingWorkspaceForCreateViaStore(store, workspaceInput);
    const projects: Workspace[] = [];
    let text: string;
    if (cloudExisting) {
      text = `Project ${cloudExisting.slug} already exists in the cloud registry.`;
    } else if (options.approve && !options.dryRun) {
      const project = await store.createProject({
        name: workspaceInput.name,
        root_id: workspaceInput.root_id,
        recipe_id: workspaceInput.recipe_id,
        primary_path: workspaceInput.primary_path,
        tags: workspaceInput.tags,
      });
      projects.push(project);
      text = `Created project ${project.slug} in the cloud registry.`;
    } else {
      text = `Plan: create cloud project "${workspaceInput.name}". Run with --yes to execute.`;
    }
    const toolCalls: JsonObject[] = [{
      name: "projects_create",
      input: workspaceInput,
      dry_run: options.dryRun || !options.approve,
      approved: options.approve,
      output: projectPayload(cloudExisting
        ? existingWorkspaceOutput(cloudExisting)
        : { status: projects.length ? "created" : "planned", workspace: projects[0] ? compactProject(projects[0]) : null }) as JsonObject,
    }];
    completeAgentRun(runId, {
      status: "completed",
      workspace_id: projects[0]?.id ?? cloudExisting?.id,
      tool_calls: toolCalls,
      result: projectPayload({ text, workspaces: projects.map(compactProject) }) as JsonObject,
    });
    return {
      mode: "mock",
      run_id: runId,
      agent_id: agent.id,
      provider: "openrouter",
      model: options.model,
      actor_agent_id: agent.id,
      approved: options.approve,
      dry_run: options.dryRun,
      text,
      projects,
      tool_calls: toolCalls,
    };
  }

  const existing = await findExistingWorkspaceForCreateViaStore(store, workspaceInput);
  if (existing) {
    const output = existingWorkspaceOutput(existing);
    const text = `Project ${existing.slug} already exists at ${existing.primary_path ?? "no local path"}.`;
    const toolCalls: JsonObject[] = [{
      name: "projects_create",
      input: workspaceInput,
      dry_run: options.dryRun,
      approved: options.approve,
      output,
    }];
    completeAgentRun(runId, {
      status: "completed",
      workspace_id: existing.id,
      tool_calls: toolCalls,
      result: { text, projects: [], existing_project: compactProject(existing) },
    });
    return {
      mode: "mock",
      run_id: runId,
      agent_id: agent.id,
      provider: "openrouter",
      model: options.model,
      actor_agent_id: agent.id,
      approved: options.approve,
      dry_run: options.dryRun,
      text,
      projects: [],
      tool_calls: toolCalls,
    };
  }

  const projects: Workspace[] = [];
  const plan = planWorkspaceCreation(workspaceInput);
  const toolCalls: JsonObject[] = [{
    name: "projects_create",
    input: workspaceInput,
    dry_run: options.dryRun,
    approved: options.approve,
    output: projectPayload({ status: options.approve && !options.dryRun ? "created" : "planned", plan }) as JsonObject,
  }];

  if (options.approve && !options.dryRun) {
    const result = await executeWorkspaceCreation(workspaceInput);
    if (result.workspace) projects.push(result.workspace);
    toolCalls[0]!["output"] = {
      status: "created",
      ...projectPayload({
        plan,
        workspace: result.workspace ? compactProject(result.workspace) : null,
      }) as JsonObject,
    };
  }

  const text = projects.length > 0
    ? `Created project ${projects[0]!.slug}.`
    : `Plan: create project "${workspaceInput.name}"${plan.workspace.primary_path ? ` at ${plan.workspace.primary_path}` : ""}. Run with --yes to execute.`;

  completeAgentRun(runId, {
    status: "completed",
    workspace_id: projects[0]?.id,
    tool_calls: toolCalls,
    result: projectPayload({ text, plan, workspaces: projects.map(compactProject) }) as JsonObject,
  });

  return {
    mode: "mock",
    run_id: runId,
    agent_id: agent.id,
    provider: "openrouter",
    model: options.model,
    actor_agent_id: agent.id,
    approved: options.approve,
    dry_run: options.dryRun,
    text,
    projects,
    tool_calls: toolCalls,
  };
}

const tmuxWindowSchema = z.object({
  name: z.string().min(1).describe("Window name"),
  path: z.string().optional().describe("Optional working directory for this tmux window"),
  command: z.string().optional().describe("Optional command to send or launch in the window"),
  index: z.number().int().nonnegative().optional().describe("Optional tmux window index"),
  detached: z.boolean().optional().describe("Create the window detached; default true"),
});

const projectManagementToolFields = {
  stage: z.enum(PROJECT_STAGES).optional().describe(`Project stage: ${PROJECT_STAGES.join(", ")}`),
  priority: z.enum(PROJECT_PRIORITIES).optional().describe(`Project priority: ${PROJECT_PRIORITIES.join(", ")}`),
  owner: z.string().optional().describe("Project owner or accountable person/agent"),
  launch_profile: z.string().optional().describe("Default tmux launch profile slug"),
  start_agent: z.enum(PROJECT_START_AGENTS).optional().describe(`Default start tool: ${PROJECT_START_AGENTS.join(", ")}`),
  start_command: z.string().optional().describe("Default command for the primary start window"),
  start_session_policy: z.enum(PROJECT_START_SESSION_POLICIES).optional().describe(`Default tmux session policy: ${PROJECT_START_SESSION_POLICIES.join(", ")}`),
  start_windows: z.array(tmuxWindowSchema).optional().describe("Default extra tmux windows for project start"),
  todos_project_id: z.string().optional().describe("Linked todos project id"),
  todos_task_list_id: z.string().optional().describe("Linked todos task list id"),
  brief_id: z.string().optional().describe("Linked brief/spec id"),
  brief_path: z.string().optional().describe("Linked brief/spec path"),
  integrations: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

interface WorkspaceAgentToolContext {
  store: ProjectStore;
  actorAgent: Agent;
  approve: boolean;
  options: WorkspaceAgentPromptOptions;
  command: string;
  forcedRootId?: string;
  forcedRecipeId?: string;
  tmuxAllowed: boolean;
  createdWorkspaces: Workspace[];
}

/**
 * Build the prompt-agent tool set bound to the active ProjectStore. Extracted
 * from runWorkspaceAgentPrompt so the mutation handlers can be unit-tested
 * against a fake Store. In api/cloud mode every shared-registry mutation
 * (create/update/archive/unarchive/delete/tag/untag/unlink/event/agent/location)
 * routes through the Store (cloud HTTP), never local sqlite; local mode is
 * byte-for-byte unchanged.
 */
export function buildWorkspaceAgentTools(ctx: WorkspaceAgentToolContext) {
  const {
    store,
    actorAgent,
    approve,
    options,
    command,
    forcedRootId,
    forcedRecipeId,
    tmuxAllowed,
    createdWorkspaces,
  } = ctx;
  let inspectedTmuxProfiles = false;
  // Attribution agent for a mutation: local uses the on-box actor agent;
  // api/cloud leaves attribution to the server (derived from the bearer key),
  // never sending a local agent id the cloud registry does not know.
  const mutationAgentId = store.mode === "local" ? actorAgent.id : undefined;
  // Resolve a caller-supplied target through the active Store (cloud-aware in
  // api mode; on-disk path/marker aware in local mode). store.resolveTarget
  // THROWS when nothing matches, whereas the prompt-agent tools expect a null
  // so they can surface their existing friendly "Project not found" error.
  const resolveStoreTargetOrNull = async (target: string | undefined): Promise<Workspace | null> => {
    try {
      return await store.resolveTarget(target, { allowPath: true, allowMarker: true, intent: "read" });
    } catch (error) {
      if (isProjectContextError(error) && error.code === "PROJECT_NOT_FOUND") return null;
      throw error;
    }
  };
  const resolveStoreRootId = async (idOrSlug: string | undefined): Promise<string | undefined> => {
    if (!idOrSlug) return undefined;
    const root = await store.getRoot(idOrSlug);
    if (!root) throw new Error(`Root not found: ${idOrSlug}`);
    return root.id;
  };
  const resolveStoreRecipeId = async (idOrSlug: string | undefined): Promise<string | undefined> => {
    if (!idOrSlug) return undefined;
    const recipe = await store.getRecipe(idOrSlug);
    if (!recipe) throw new Error(`Recipe not found: ${idOrSlug}`);
    return recipe.id;
  };
  return {
    projects_roots_list: tool({
      description: "List registered root folders and templates where projects can be created.",
      inputSchema: z.object({}),
      execute: async () => listRoots().map(compactRoot),
    }),
    projects_roots_match: tool({
      description: "Score registered roots by path, kind, tags, and GitHub org.",
      inputSchema: z.object({
        path: z.string().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        tags: z.array(z.string()).optional(),
        github_org: z.string().optional(),
      }),
      execute: async (input) => {
        const matches = scoreRoots({
          path: input.path,
          kind: input.kind,
          tags: input.tags,
          github_org: input.github_org,
        });
        return matches.map((item) => ({ root: compactRoot(item.root), score: item.score, reasons: item.reasons }));
      },
    }),
    projects_roots_add: tool({
      description: "Register a new root/path where projects can be created. Mutates only when approved.",
      inputSchema: z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        slug: z.string().optional(),
        tags: z.array(z.string()).optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        github_org: z.string().optional(),
        repo_visibility: z.enum(["public", "private"]).optional(),
        path_template: z.string().optional(),
        name_template: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const rootInput = {
          name: input.name,
          slug: input.slug,
          base_path: input.path,
          tags: input.tags,
          default_kind: input.kind,
          github_org: input.github_org,
          repo_visibility: input.repo_visibility,
          path_template: input.path_template,
          name_template: input.name_template,
          metadata: input.metadata as JsonObject | undefined,
        };
        if (!approve) return { status: "planned", root: rootInput, note: "Run again with --yes to register this root." };
        return { status: "created", root: compactRoot(createRoot(rootInput)) };
      },
    }),
    projects_recipes_list: tool({
      description: "List project creation recipes with default kind, tags, and steps.",
      inputSchema: z.object({}),
      execute: async () => listRecipes().map((recipe) => ({
        id: recipe.id,
        slug: recipe.slug,
        name: recipe.name,
        kind: recipe.kind,
        default_tags: recipe.default_tags,
        steps: recipe.steps,
      })),
    }),
    projects_recipes_show: tool({
      description: "Get one project creation recipe by id or slug, including steps and variables.",
      inputSchema: z.object({
        id_or_slug: z.string().min(1),
      }),
      execute: async (input) => {
        const recipe = getRecipe(input.id_or_slug) ?? getRecipeBySlug(input.id_or_slug);
        return recipe ?? { error: `Recipe not found: ${input.id_or_slug}` };
      },
    }),
    projects_recipes_add: tool({
      description: "Create a project creation recipe. Mutates only when approved.",
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        default_tags: z.array(z.string()).optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
        variables: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const recipeInput = {
          name: input.name,
          slug: input.slug,
          description: input.description,
          kind: input.kind,
          default_tags: input.default_tags,
          steps: input.steps as JsonObject[] | undefined,
          variables: input.variables as JsonObject | undefined,
          metadata: input.metadata as JsonObject | undefined,
        };
        if (!approve) return { status: "planned", recipe: recipeInput, note: "Run again with --yes to create this recipe." };
        const recipe = createRecipe(recipeInput);
        return { status: "created", recipe: { id: recipe.id, slug: recipe.slug, name: recipe.name, kind: recipe.kind, default_tags: recipe.default_tags, steps: recipe.steps } };
      },
    }),
    projects_agents_list: tool({
      description: "List registered human, CLI, service, and AI agents, or agents assigned to one project.",
      inputSchema: z.object({
        project: z.string().optional(),
      }),
      execute: async (input) => {
        if (input.project) {
          const workspace = await resolveStoreTargetOrNull(input.project);
          if (!workspace) return { error: `Project not found: ${input.project}` };
          return { project: compactProject(workspace), agents: listWorkspaceAgents(workspace.id) };
        }
        return listAgents().map((registeredAgent) => ({
          id: registeredAgent.id,
          slug: registeredAgent.slug,
          name: registeredAgent.name,
          kind: registeredAgent.kind,
          provider: registeredAgent.provider,
          model: registeredAgent.model,
          role: registeredAgent.role,
        }));
      },
    }),
    projects_agents_add: tool({
      description: "Record a human, AI, service, or CLI agent that can be attributed to project changes. Mutates only when approved.",
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional(),
        kind: z.enum(AGENT_KINDS).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        role: z.string().optional(),
        permissions: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const agentInput = {
          name: input.name,
          slug: input.slug,
          kind: input.kind ?? "human",
          provider: input.provider,
          model: input.model,
          role: input.role,
          permissions: input.permissions,
          metadata: input.metadata as JsonObject | undefined,
        };
        if (!approve) return { status: "planned", agent: agentInput, note: "Run again with --yes to create this agent." };
        const agent = createAgent(agentInput);
        return { status: "created", agent: { id: agent.id, slug: agent.slug, name: agent.name, kind: agent.kind, provider: agent.provider, model: agent.model, role: agent.role, permissions: agent.permissions } };
      },
    }),
    projects_agents_assign: tool({
      description: "Assign a registered agent to a project role. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1),
        agent: z.string().min(1),
        role: z.enum(PROJECT_AGENT_ROLES).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const assignedAgent = getAgent(input.agent) ?? getAgentBySlug(input.agent);
        if (!assignedAgent) return { error: `Agent not found: ${input.agent}` };
        const role = input.role ?? "contributor";
        if (!approve) {
          return {
            status: "planned",
            project: compactProject(workspace),
            agent: {
              id: assignedAgent.id,
              slug: assignedAgent.slug,
              name: assignedAgent.name,
              kind: assignedAgent.kind,
            },
            role,
            metadata: input.metadata,
            note: "Run again with --yes to assign this project agent.",
          };
        }
        // Route the assignment (and its audit event) through the Store so it
        // lands wherever the project lives. Per-project agent assignments are an
        // on-box sub-resource: in api/cloud mode the Store throws
        // LocalOnlyOperationError rather than silently writing local sqlite —
        // surface that as a clean tool error, not an unhandled crash.
        try {
          const assignment = await store.assignAgent(workspace.id, {
            agentId: assignedAgent.id,
            role,
            assignedBy: mutationAgentId,
            metadata: input.metadata as JsonObject | undefined,
            source: "agent",
            command,
          });
          return { status: "assigned", project: compactProject(workspace), assignment };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
    projects_list: tool({
      description: "List existing projects for deduplication before creating a new one. Compact by default; pass verbose for metadata/integration key summaries.",
      inputSchema: z.object({
        kind: z.enum(WORKSPACE_KINDS).optional(),
        status: z.enum(["active", "archived", "deleted"]).optional(),
        query: z.string().optional(),
        tags: z.array(z.string()).optional(),
        include_evals: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
        verbose: z.boolean().optional(),
      }),
      execute: async (input) => {
        const limit = input.limit ?? DEFAULT_PROJECT_AGENT_LIST_LIMIT;
        const projects = filterProjectEvalArtifacts(listWorkspaces({
          kind: input.kind,
          status: input.status,
          query: input.query,
          tags: input.tags,
          exclude_eval_artifacts: !input.include_evals,
          limit: limit + 1,
        }), input.include_evals);
        const visible = projects.slice(0, limit);
        return {
          projects: visible.map(input.verbose ? detailedProject : compactProject),
          count: visible.length,
          limit,
          has_more: projects.length > visible.length,
          next_steps: "Use projects_show with id_or_slug for details; pass verbose=true for metadata/integration key summaries.",
        };
      },
    }),
    projects_show: tool({
      description: "Resolve one project by id or slug. Compact by default; pass verbose=true for full project, agents, locations, and recent event records.",
      inputSchema: z.object({
        id_or_slug: z.string().min(1),
        verbose: z.boolean().optional(),
        events_limit: z.number().int().positive().max(100).optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.id_or_slug);
        if (!workspace) return { error: `Project not found: ${input.id_or_slug}` };
        const agents = listWorkspaceAgents(workspace.id);
        const locations = listWorkspaceLocations(workspace.id);
        const events = listWorkspaceEvents(workspace.id);
        if (input.verbose) {
          const eventLimit = input.events_limit ?? DEFAULT_PROJECT_AGENT_LIST_LIMIT;
          return {
            project: fullProject(workspace),
            agents,
            locations,
            events: events.slice(-eventLimit).reverse(),
            events_limit: eventLimit,
            total_events: events.length,
          };
        }
        return {
          project: compactProject(workspace),
          counts: {
            agents: agents.length,
            locations: locations.length,
            events: events.length,
          },
          agents: agents.slice(0, 10).map(compactAgentAssignment),
          recent_events: events.slice(-3).reverse().map(compactAgentEvent),
          next_steps: "Pass verbose=true for full project, agents, locations, and recent event records.",
        };
      },
    }),
    projects_locations_list: tool({
      description: "List registered folder locations for one project. Compact by default; pass verbose=true for full location records.",
      inputSchema: z.object({
        project: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
        verbose: z.boolean().optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const locations = listWorkspaceLocations(workspace.id);
        const limit = input.limit ?? DEFAULT_PROJECT_AGENT_LIST_LIMIT;
        const visible = locations.slice(0, limit);
        return {
          project: compactProject(workspace),
          locations: input.verbose ? visible : visible.map(compactAgentLocation),
          count: visible.length,
          total: locations.length,
          limit,
          has_more: locations.length > visible.length,
          next_steps: "Pass verbose=true for full location records.",
        };
      },
    }),
    projects_locations_add: tool({
      description: "Register another folder location for an existing project. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1),
        path: z.string().min(1),
        label: z.string().optional(),
        kind: z.string().optional(),
        primary: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const locationInput = {
          path: input.path,
          label: input.label,
          kind: input.kind,
          isPrimary: input.primary,
          metadata: input.metadata as JsonObject | undefined,
          agentId: mutationAgentId,
          source: "agent" as const,
          command,
        };
        if (!approve) return projectPayload({ status: "planned", project: compactProject(workspace), location: locationInput, note: "Run again with --yes to register this project location." });
        // Extra on-disk locations are an on-box sub-resource: route through the
        // Store so local mode writes sqlite as before, while api/cloud mode
        // throws LocalOnlyOperationError instead of silently writing local —
        // surface that as a clean tool error.
        try {
          const { project: updated, location } = await store.addLocation(workspace.id, locationInput);
          return projectPayload({ status: "registered", project: compactProject(updated), location });
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
    projects_events_list: tool({
      description: "List immutable audit events for one project. Compact by default; pass verbose=true for full event records.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        limit: z.number().int().positive().max(100).optional(),
        verbose: z.boolean().optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const events = listWorkspaceEvents(workspace.id);
        const limit = input.limit ?? DEFAULT_PROJECT_AGENT_LIST_LIMIT;
        const visible = events.slice(-limit).reverse();
        return {
          project: compactProject(workspace),
          events: input.verbose ? visible : visible.map(compactAgentEvent),
          count: visible.length,
          total: events.length,
          limit,
          has_more: events.length > visible.length,
          next_steps: "Pass verbose=true for full event records or increase limit.",
        };
      },
    }),
    projects_event_record: tool({
      description: "Record a custom immutable project event. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().optional().describe("Project id or slug; omit for system-level events"),
        event_type: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
        after: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const workspace = input.project ? await resolveStoreTargetOrNull(input.project) : null;
        if (input.project && !workspace) return { error: `Project not found: ${input.project}` };
        const eventInput = {
          workspace_id: workspace?.id,
          agent_id: actorAgent.id,
          event_type: input.event_type,
          source: "agent" as const,
          prompt: options.prompt,
          command,
          after: input.after as JsonObject | undefined,
          metadata: input.metadata as JsonObject | undefined,
        };
        if (!approve) return projectPayload({ status: "planned", event: eventInput, note: "Run again with --yes to record this event." });
        // A project-scoped event routes through the Store so it lands wherever
        // the project lives (cloud in api mode). A project-less system event has
        // no shared-registry home and stays machine-local telemetry, as today.
        const event = workspace
          ? await store.recordEvent(workspace.id, {
              event_type: input.event_type,
              source: "agent",
              agentId: mutationAgentId,
              prompt: options.prompt,
              command,
              after: input.after as JsonObject | undefined,
              metadata: input.metadata as JsonObject | undefined,
            })
          : recordWorkspaceEvent(eventInput);
        return projectPayload({ status: "recorded", project: workspace ? compactProject(workspace) : null, event });
      },
    }),
    projects_doctor: tool({
      description: "Run project verification checks through the project doctor. This is no-write unless fix=true and the prompt is approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        fix: z.boolean().optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const doctor = () => doctorWorkspace(workspace, { fix: Boolean(input.fix && approve), dryRun: !approve });
        return projectPayload(input.fix && approve ? withAgentWorkspaceLock(workspace, actorAgent.id, "project doctor fix", doctor) : doctor());
      },
    }),
    projects_update: tool({
      description: "Update existing project metadata. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        name: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().nullable().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        status: z.enum(["active", "archived", "deleted"]).optional(),
        root: z.string().nullable().optional().describe("Root id or slug, null to clear"),
        recipe: z.string().nullable().optional().describe("Recipe id or slug, null to clear"),
        path: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        git_remote: z.string().nullable().optional(),
        integrations: z.record(z.string(), z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        stage: z.enum(PROJECT_STAGES).nullable().optional(),
        priority: z.enum(PROJECT_PRIORITIES).nullable().optional(),
        owner: z.string().nullable().optional(),
        launch_profile: z.string().nullable().optional(),
        start_agent: z.enum(PROJECT_START_AGENTS).nullable().optional(),
        start_command: z.string().nullable().optional(),
        start_session_policy: z.enum(PROJECT_START_SESSION_POLICIES).nullable().optional(),
        start_windows: z.array(tmuxWindowSchema).nullable().optional(),
        todos_project_id: z.string().nullable().optional(),
        todos_task_list_id: z.string().nullable().optional(),
        brief_id: z.string().nullable().optional(),
        brief_path: z.string().nullable().optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const metadataBase = input.metadata === undefined ? workspace.metadata : input.metadata as JsonObject;
        const metadataFields = {
          stage: input.stage,
          priority: input.priority,
          owner: input.owner,
          launch_profile: input.launch_profile,
          start_agent: input.start_agent,
          start_command: input.start_command,
          start_session_policy: input.start_session_policy,
          start_windows: input.start_windows as WorkspaceTmuxWindowSpec[] | null | undefined,
        };
        const metadata = hasProjectManagementFields(metadataFields)
          ? mergeProjectManagementMetadata(metadataBase, metadataFields)
          : input.metadata === undefined ? undefined : metadataBase;
        const integrationsBase = input.integrations === undefined ? workspace.integrations : input.integrations as WorkspaceIntegrations;
        const integrationFields = {
          todos_project_id: input.todos_project_id,
          todos_task_list_id: input.todos_task_list_id,
          brief_id: input.brief_id,
          brief_path: input.brief_path,
        };
        const integrations = hasProjectIntegrationFields(integrationFields)
          ? mergeProjectIntegrationFields(integrationsBase, integrationFields)
          : input.integrations === undefined ? undefined : integrationsBase;
        const updateInput = {
          name: input.name,
          slug: input.slug,
          description: input.description,
          kind: input.kind,
          status: input.status,
          root_id: input.root === null ? null : await resolveStoreRootId(input.root),
          recipe_id: input.recipe === null ? null : await resolveStoreRecipeId(input.recipe),
          primary_path: input.path,
          tags: input.tags,
          git_remote: input.git_remote,
          integrations,
          metadata,
          agent_id: mutationAgentId,
          source: "agent" as const,
          prompt: options.prompt,
          command,
        };
        if (!approve) return projectPayload({ status: "planned", workspace: compactProject(workspace), input: updateInput, note: "Run again with --yes to update this project." });
        const updated = await store.updateProject(workspace.id, updateInput);
        return { status: "updated", project: compactProject(updated) };
      },
    }),
    projects_archive: tool({
      description: "Archive an existing project. Mutates only when approved.",
      inputSchema: z.object({ project: z.string().min(1).describe("Project id or slug") }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        if (!approve) return { status: "planned", project: compactProject(workspace), next_status: "archived" };
        return { status: "archived", project: compactProject(await store.archiveProject(workspace.id, {
          agentId: mutationAgentId,
          source: "agent",
          prompt: options.prompt,
          command,
        })) };
      },
    }),
    projects_unarchive: tool({
      description: "Restore an archived or deleted project to active. Mutates only when approved.",
      inputSchema: z.object({ project: z.string().min(1).describe("Project id or slug") }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        if (!approve) return { status: "planned", project: compactProject(workspace), next_status: "active" };
        return { status: "active", project: compactProject(await store.unarchiveProject(workspace.id, {
          agentId: mutationAgentId,
          source: "agent",
          prompt: options.prompt,
          command,
        })) };
      },
    }),
    projects_delete: tool({
      description: "Mark a project deleted, or hard-delete when hard=true. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        hard: z.boolean().optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        if (!approve) return { status: "planned", project: compactProject(workspace), hard: Boolean(input.hard), next_status: input.hard ? "removed" : "deleted" };
        const result = await store.deleteProject(workspace.id, { hard: input.hard }, {
          agentId: mutationAgentId,
          source: "agent",
          prompt: options.prompt,
          command,
        });
        return { status: result.hard ? "deleted" : "marked_deleted", hard: result.hard, project: compactProject(result.workspace ?? workspace) };
      },
    }),
    projects_cleanup_create: tool({
      description: "Safely clean up files and DB rows created by a project creation run. Uses stored rollback records unless rollback_actions are supplied. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        rollback_actions: z.array(z.object({
          type: z.literal("rollback"),
          action: z.string(),
          target: z.string(),
          status: z.literal("planned"),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })).optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const target = cleanupTargetFromWorkspace(workspace, input.rollback_actions as WorkspaceCreationPlanAction[] | undefined);
        if (!approve) {
          return {
            status: "planned",
            project: compactProject(workspace),
            cleanup: cleanupWorkspaceCreationTarget(target, {
              dryRun: true,
              agentId: actorAgent.id,
              source: "agent",
              prompt: options.prompt,
              command,
            }),
            note: "Run again with --yes to apply this cleanup.",
          };
        }
        return {
          status: "cleaned",
          cleanup: projectPayload(withAgentWorkspaceLock(workspace, actorAgent.id, "project creation cleanup", () => cleanupWorkspaceCreationTarget(target, {
            agentId: actorAgent.id,
            source: "agent",
            prompt: options.prompt,
            command,
          }))),
        };
      },
    }),
    projects_import: tool({
      description: "Import an existing folder or direct child folders as projects. Mutates only when approved.",
      inputSchema: z.object({
        path: z.string().min(1),
        bulk: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      }),
      execute: async (input) => {
        if (!approve) {
          if (input.bulk) return projectPayload({ status: "planned", result: await importWorkspaceBulk(input.path, { dryRun: true, tags: input.tags, agent_id: actorAgent.id, store }) });
          return { status: "planned", preview: planWorkspaceImport(input.path, { tags: input.tags, agent_id: actorAgent.id, store }) };
        }
        return projectPayload(input.bulk
          ? await importWorkspaceBulk(input.path, { tags: input.tags, agent_id: actorAgent.id, store })
          : await importWorkspace(input.path, { tags: input.tags, agent_id: actorAgent.id, store }));
      },
    }),
    projects_scan_roots: tool({
      description: "Dry-run import plans for repositories in configured GitHub roots.",
      inputSchema: z.object({
        root: z.string().optional(),
        repo_prefix: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        clone: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        remote_protocol: z.enum(["https", "ssh"]).optional(),
      }),
      execute: async (input) => projectPayload(await syncWorkspaceGitHubRoots(store, {
        root: input.root,
        repoPrefix: input.repo_prefix,
        limit: input.limit,
        clone: input.clone,
        tags: input.tags,
        remoteProtocol: input.remote_protocol,
        dryRun: true,
        agent_id: actorAgent.id,
        source: "agent",
        command: "projects_scan_roots",
      })),
    }),
    projects_sync_roots: tool({
      description: "Import and optionally clone repositories from configured GitHub roots. Mutates only when approved.",
      inputSchema: z.object({
        root: z.string().optional(),
        repo_prefix: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        clone: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        remote_protocol: z.enum(["https", "ssh"]).optional(),
      }),
      execute: async (input) => projectPayload(await syncWorkspaceGitHubRoots(store, {
        root: input.root,
        repoPrefix: input.repo_prefix,
        limit: input.limit,
        clone: input.clone,
        tags: input.tags,
        remoteProtocol: input.remote_protocol,
        dryRun: !approve,
        agent_id: actorAgent.id,
        source: "agent",
        command: "projects_sync_roots",
      })),
    }),
    projects_scan_local_roots: tool({
      description: "Scan all registered local roots and preview/import direct child folders as projects. Mutates only when approved.",
      inputSchema: z.object({
        tags: z.array(z.string()).optional(),
      }),
      execute: async (input) => projectPayload(await importRegisteredRoots({
        dryRun: !approve,
        tags: input.tags,
        agent_id: actorAgent.id,
        store,
      })),
    }),
    projects_github_publish: tool({
      description: "Publish an existing project to GitHub. Mutates only when approved; otherwise returns the exact gh/git plan.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        org: z.string().optional().describe("GitHub organization/user"),
        repo: z.string().optional().describe("Repository name"),
        visibility: z.enum(["public", "private"]).optional(),
        description: z.string().optional(),
        remote_protocol: z.enum(["https", "ssh"]).optional(),
        push: z.boolean().optional().describe("Push the current branch after creating the repo; default true"),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        // Registry write serialized by store.updateProject; no coarse lock.
        return projectPayload(await publishWorkspaceToGitHub(store, workspace, {
          org: input.org,
          repoName: input.repo,
          visibility: input.visibility as GitHubVisibility | undefined,
          description: input.description,
          remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
          push: input.push,
          dryRun: !approve,
          agent_id: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        }));
      },
    }),
    projects_github_unpublish: tool({
      description: "Remove GitHub origin metadata from an existing project without deleting the GitHub repository. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        clear_integrations: z.boolean().optional(),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        return projectPayload(await unpublishWorkspaceFromGitHub(store, workspace, {
          clearIntegrations: input.clear_integrations,
          dryRun: !approve,
          agent_id: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        }));
      },
    }),
    projects_import_github: tool({
      description: "Import a GitHub repository as a project. Can create a remote-only project or clone/register a local path. Mutates only when approved.",
      inputSchema: z.object({
        repo: z.string().min(1).describe("GitHub URL, git URL, or org/repo"),
        root: z.string().optional().describe("Root id or slug for path derivation"),
        path: z.string().optional().describe("Explicit clone/import path"),
        clone: z.boolean().optional(),
        remote_only: z.boolean().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        tags: z.array(z.string()).optional(),
        remote_protocol: z.enum(["https", "ssh"]).optional(),
      }),
      execute: async (input) => projectPayload(await importWorkspaceFromGitHub(store, input.repo, {
        root: forcedRootId ?? input.root,
        path: forcedRootId ? undefined : input.path,
        clone: input.clone,
        remoteOnly: input.remote_only,
        kind: input.kind,
        tags: input.tags,
        remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
        dryRun: !approve,
        agent_id: actorAgent.id,
        source: "agent",
        prompt: options.prompt,
        command,
      })),
    }),
    projects_channel: tool({
      description: "Resolve the project's conversations channel (project -> channel) from the stored integration or the fleet naming convention. ensure=true creates the channel if missing and links it on the project record; mutates only when approved.",
      inputSchema: z.object({
        target: z.string().optional().describe("Project id, slug, name, or path; defaults to the working directory"),
        ensure: z.boolean().optional().describe("Create the conversations channel if missing and persist the link on the project record"),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.target?.trim() || ".");
        if (!workspace) return { error: `Project not found: ${input.target ?? "."}` };
        if (!input.ensure) return resolveProjectChannelForProject(workspace);
        const result = ensureProjectChannel(workspace, {
          agentId: actorAgent.id,
          source: "agent",
          command,
          dryRun: !approve,
        });
        return {
          ...result,
          project: compactProject(result.project),
          ...(approve ? {} : { note: "Run again with --yes to create the channel." }),
        };
      },
    }),
    projects_link: tool({
      description: "Merge external integration IDs, such as todos/mementos/conversations/files/GitHub IDs, into an existing project. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        integrations: z.record(z.string(), z.string()).describe("Integration key/value pairs"),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const integrations = normalizeWorkspaceIntegrations(input.integrations as WorkspaceIntegrations);
        if (!approve) {
          return {
            status: "planned",
            project: compactProject(workspace),
            integrations: { ...workspace.integrations, ...integrations },
            note: "Run again with --yes to link these integrations.",
          };
        }
        return { status: "linked", project: compactProject(await linkWorkspaceExternalIntegrations(store, workspace, integrations, {
          agent_id: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        })) };
      },
    }),
    projects_unlink: tool({
      description: "Clear external integration IDs or integration groups from an existing project. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        keys: z.array(z.string()).min(1).describe("Integration keys or groups to clear, such as github, todos, brief, files_index_id"),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const unlinked = expandProjectIntegrationUnlinkKeys(input.keys);
        if (unlinked.length === 0) return { error: "Provide at least one integration key or group to unlink" };
        const integrations = unlinkProjectIntegrationFields(workspace.integrations, input.keys);
        if (!approve) {
          return {
            status: "planned",
            project: compactProject(workspace),
            unlinked,
            integrations,
            note: "Run again with --yes to unlink these integrations.",
          };
        }
        const updated = await store.updateProject(workspace.id, {
          integrations,
          agent_id: mutationAgentId,
          source: "agent",
          prompt: options.prompt,
          command,
        });
        return { status: "unlinked", project: compactProject(updated), unlinked };
      },
    }),
    projects_tag: tool({
      description: "Add tags to an existing project without replacing its full tag list. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        tags: z.array(z.string()).min(1),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const tags = mergeProjectTags(workspace.tags, input.tags);
        if (!approve) return { status: "planned", project: compactProject(workspace), tags, note: "Run again with --yes to add these tags." };
        const updated = await store.updateProject(workspace.id, {
          tags,
          agent_id: mutationAgentId,
          source: "agent",
          prompt: options.prompt,
          command,
        });
        return { status: "tagged", project: compactProject(updated) };
      },
    }),
    projects_untag: tool({
      description: "Remove tags from an existing project without replacing its full tag list. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        tags: z.array(z.string()).min(1),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        const tags = removeProjectTags(workspace.tags, input.tags);
        if (!approve) return { status: "planned", project: compactProject(workspace), tags, note: "Run again with --yes to remove these tags." };
        const updated = await store.updateProject(workspace.id, {
          tags,
          agent_id: mutationAgentId,
          source: "agent",
          prompt: options.prompt,
          command,
        });
        return { status: "untagged", project: compactProject(updated) };
      },
    }),
    projects_plan_create: tool({
      description: "Return a deterministic no-write creation plan for a new project.",
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        root: z.string().optional().describe("Root id or slug"),
        recipe: z.string().optional().describe("Recipe id or slug"),
        path: z.string().optional().describe("Explicit primary path"),
        tags: z.array(z.string()).optional(),
        ...projectManagementToolFields,
        git_remote: z.string().optional(),
        create_directory: z.boolean().optional(),
        git_init: z.boolean().optional(),
        write_marker: z.boolean().optional(),
        tmux: z.object({
          session: z.string().optional(),
          windows: z.array(tmuxWindowSchema).optional(),
        }).optional(),
        tmux_profile: z.string().optional(),
      }),
      execute: async (input) => {
        const createInput = {
          name: input.name,
          slug: input.slug,
          description: input.description,
          kind: input.kind,
          root_id: forcedRootId ?? await resolveStoreRootId(input.root),
          recipe_id: forcedRecipeId ?? await resolveStoreRecipeId(input.recipe),
          primary_path: forcedRootId ? undefined : input.path,
          git_remote: input.git_remote,
          tags: input.tags,
          integrations: mergeProjectIntegrationFields(input.integrations as WorkspaceIntegrations | undefined, {
            todos_project_id: input.todos_project_id,
            todos_task_list_id: input.todos_task_list_id,
            brief_id: input.brief_id,
            brief_path: input.brief_path,
          }) ?? input.integrations as WorkspaceIntegrations | undefined,
          metadata: mergeProjectManagementMetadata(input.metadata as JsonObject | undefined, {
            stage: input.stage,
            priority: input.priority,
            owner: input.owner,
            launch_profile: input.launch_profile,
            start_agent: input.start_agent,
            start_command: input.start_command,
            start_session_policy: input.start_session_policy,
            start_windows: input.start_windows as WorkspaceTmuxWindowSpec[] | undefined,
          }) ?? input.metadata as JsonObject | undefined,
          agent_id: actorAgent.id,
          source: "agent" as const,
          prompt: options.prompt,
          command,
        };
        const existing = await findExistingWorkspaceForCreateViaStore(store, {
          name: createInput.name,
          slug: createInput.slug,
          primary_path: forcedRootId ? undefined : input.path,
        });
        if (existing) return existingWorkspaceOutput(existing);
        return projectPayload({
          status: "planned",
          plan: planWorkspaceCreation({
            ...createInput,
            createDirectory: input.create_directory,
            gitInit: input.git_init,
            writeMarker: input.write_marker ?? input.create_directory,
            tmux: tmuxAllowed && input.tmux ? {
              session: input.tmux.session,
              windows: input.tmux.windows as WorkspaceTmuxWindowSpec[] | undefined,
            } : undefined,
            tmux_profile: tmuxAllowed ? input.tmux_profile : undefined,
          }),
        });
      },
    }),
    projects_create: tool({
      description: "Create/register a project anywhere on disk, optionally preparing the directory, git repo, and tmux windows. Mutates only when approved.",
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        root: z.string().optional().describe("Root id or slug"),
        recipe: z.string().optional().describe("Recipe id or slug"),
        path: z.string().optional().describe("Explicit absolute or relative primary path"),
        tags: z.array(z.string()).optional(),
        ...projectManagementToolFields,
        git_remote: z.string().optional(),
        create_directory: z.boolean().optional(),
        git_init: z.boolean().optional(),
        write_marker: z.boolean().optional(),
        tmux: z.object({
          session: z.string().optional(),
          windows: z.array(tmuxWindowSchema).optional(),
        }).optional(),
        tmux_profile: z.string().optional().describe("Existing tmux profile id or slug to apply"),
      }),
      execute: async (input) => {
        if (store.mode === "api") {
          if (input.create_directory || input.git_init || input.write_marker || input.tmux || input.tmux_profile) {
            return { error: "Local directory, marker, git, and tmux activation are unavailable in API mode." };
          }
          // Cloud project rows are created through the Store so they land in
          // the shared registry (not the local sqlite island). Machine-local
          // runtime (directory/git/tmux/marker) and the on-box run ledger do
          // not apply to a shared cloud row. Root/recipe are shared registry
          // resources resolved through the Store so intent is honored.
          const rootId = forcedRootId ?? (input.root ? (await store.getRoot(input.root))?.id : undefined);
          if (input.root && !rootId) return { error: `Root not found: ${input.root}` };
          const recipeId = forcedRecipeId ?? (input.recipe ? (await store.getRecipe(input.recipe))?.id : undefined);
          if (input.recipe && !recipeId) return { error: `Recipe not found: ${input.recipe}` };

          const cloudIntegrations = mergeProjectIntegrationFields(input.integrations as WorkspaceIntegrations | undefined, {
            todos_project_id: input.todos_project_id,
            todos_task_list_id: input.todos_task_list_id,
            brief_id: input.brief_id,
            brief_path: input.brief_path,
          }) ?? input.integrations as WorkspaceIntegrations | undefined;
          const cloudMetadata = mergeProjectManagementMetadata(input.metadata as JsonObject | undefined, {
            stage: input.stage,
            priority: input.priority,
            owner: input.owner,
            launch_profile: input.launch_profile,
            start_agent: input.start_agent,
            start_command: input.start_command,
            start_session_policy: input.start_session_policy,
            start_windows: input.start_windows as WorkspaceTmuxWindowSpec[] | undefined,
          }) ?? input.metadata as JsonObject | undefined;

          const existing = await findExistingWorkspaceForCreateViaStore(store, {
            name: input.name,
            slug: input.slug,
            primary_path: forcedRootId ? undefined : input.path,
          });
          if (existing) return existingWorkspaceOutput(existing);

          if (!approve) {
            return projectPayload({
              status: "planned",
              plan: { workspace: { name: input.name, slug: input.slug, kind: input.kind, root_id: rootId, recipe_id: recipeId } },
              note: "Run again with --yes to create this project in the shared cloud registry. Machine-local runtime (directory/git/tmux) is not applied to cloud projects.",
            });
          }

          const project = await store.createProject({
            name: input.name,
            slug: input.slug,
            description: input.description,
            kind: input.kind,
            root_id: rootId,
            recipe_id: recipeId,
            primary_path: forcedRootId ? undefined : input.path,
            git_remote: input.git_remote,
            tags: input.tags,
            integrations: cloudIntegrations,
            metadata: cloudMetadata,
          });
          createdWorkspaces.push(project);
          return projectPayload({ status: "created", workspace: compactProject(project) });
        }
        if (tmuxAllowed && input.tmux_profile && !inspectedTmuxProfiles) {
          return { error: "Call projects_tmux_profiles_list before using a saved tmux_profile, then retry projects_create with the selected profile slug." };
        }
        const createInput = {
          name: input.name,
          slug: input.slug,
          description: input.description,
          kind: input.kind,
          root_id: forcedRootId ?? await resolveStoreRootId(input.root),
          recipe_id: forcedRecipeId ?? await resolveStoreRecipeId(input.recipe),
          primary_path: forcedRootId ? undefined : input.path,
          git_remote: input.git_remote,
          tags: input.tags,
          integrations: mergeProjectIntegrationFields(input.integrations as WorkspaceIntegrations | undefined, {
            todos_project_id: input.todos_project_id,
            todos_task_list_id: input.todos_task_list_id,
            brief_id: input.brief_id,
            brief_path: input.brief_path,
          }) ?? input.integrations as WorkspaceIntegrations | undefined,
          metadata: mergeProjectManagementMetadata(input.metadata as JsonObject | undefined, {
            stage: input.stage,
            priority: input.priority,
            owner: input.owner,
            launch_profile: input.launch_profile,
            start_agent: input.start_agent,
            start_command: input.start_command,
            start_session_policy: input.start_session_policy,
            start_windows: input.start_windows as WorkspaceTmuxWindowSpec[] | undefined,
          }) ?? input.metadata as JsonObject | undefined,
          agent_id: actorAgent.id,
          source: "agent" as const,
          prompt: options.prompt,
          command,
        };
        const existing = await findExistingWorkspaceForCreateViaStore(store, {
          name: createInput.name,
          slug: createInput.slug,
          primary_path: forcedRootId ? undefined : input.path,
        });
        if (existing) return existingWorkspaceOutput(existing);

        if (!approve) {
          return projectPayload({
            status: "planned",
            plan: planWorkspaceCreation({
              ...createInput,
              createDirectory: input.create_directory,
              gitInit: input.git_init,
              writeMarker: input.write_marker ?? input.create_directory,
              tmux: tmuxAllowed && input.tmux ? {
                session: input.tmux.session,
                windows: input.tmux.windows as WorkspaceTmuxWindowSpec[] | undefined,
              } : undefined,
              tmux_profile: tmuxAllowed ? input.tmux_profile : undefined,
            }),
            note: tmuxAllowed
              ? "Run again with --yes to create this project."
              : "Run again with --yes to create this project. Tmux is disabled for this prompt run.",
          });
        }

        const result = await executeWorkspaceCreation({
          ...createInput,
          createDirectory: input.create_directory,
          gitInit: input.git_init,
          writeMarker: input.write_marker ?? input.create_directory,
          tmux: tmuxAllowed && input.tmux ? {
            session: input.tmux.session,
            windows: input.tmux.windows as WorkspaceTmuxWindowSpec[] | undefined,
          } : undefined,
          tmux_profile: tmuxAllowed ? input.tmux_profile : undefined,
        }, { createProject: (createInput) => store.createProject(createInput) });
        if (result.workspace) createdWorkspaces.push(result.workspace);
        return projectPayload({ status: "created", ...result, workspace: result.workspace ? compactProject(result.workspace) : null });
      },
    }),
    projects_start: tool({
      description: "Start, open, resume, or launch a project in tmux, ensuring default 01/02 windows, and optionally run codewith, claude, opencode, cursor, or no tool. Provide windows to request the exact tmux window set.",
      inputSchema: z.object({
        target: z.string().optional().describe("Project id, slug, exact name, or path. Omit for current directory."),
        agent_tool: z.enum(["codewith", "claude", "opencode", "cursor", "none"]).optional(),
        command: z.string().optional().describe("Override command for the primary window"),
        profile: z.string().optional().describe("Saved tmux profile id or slug to apply while starting"),
        session: z.string().optional(),
        session_policy: z.enum(PROJECT_START_SESSION_POLICIES).optional(),
        window_name: z.string().optional(),
        windows: z.array(tmuxWindowSchema).optional().describe("Exact tmux windows to create for this start; overrides saved/profile windows when provided"),
        register: z.boolean().optional().describe("Register an untracked folder before starting; default true"),
        tags: z.array(z.string()).optional().describe("Tags to apply if an unknown folder is registered before start"),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Metadata to apply if an unknown folder is registered before start"),
      }),
      execute: async (input) => {
        if (!tmuxAllowed) return { error: "Tmux is disabled for this prompt run by --no-tmux." };
        const result = await startProject(input.target, {
          agentTool: input.agent_tool ? parseProjectStartAgent(input.agent_tool) : undefined,
          toolCommand: input.command,
          profile: input.profile,
          session: input.session,
          sessionPolicy: input.session_policy,
          windowName: input.window_name,
          requestedWindows: input.windows as WorkspaceTmuxWindowSpec[] | undefined,
          register: input.register,
          importTags: input.tags,
          importMetadata: input.metadata as JsonObject | undefined,
          dryRun: !approve,
          attach: false,
          agentId: actorAgent.id,
          source: "agent",
          auditCommand: command,
        });
        if (approve && result.project.id !== "planned") createdWorkspaces.push(result.project);
        return projectPayload(result);
      },
    }),
    projects_tmux_status: tool({
      description: "Inspect the expected and current tmux session/window status for a project, including default 01/02 windows unless exact windows are provided. Read-only.",
      inputSchema: z.object({
        target: z.string().optional().describe("Project id, slug, exact name, or path. Omit for current directory."),
        profile: z.string().optional().describe("Saved tmux profile id or slug used to compute expected windows"),
        session: z.string().optional(),
        agent_tool: z.enum(["codewith", "claude", "opencode", "cursor", "none"]).optional(),
        command: z.string().optional(),
        window_name: z.string().optional(),
        windows: z.array(tmuxWindowSchema).optional().describe("Exact expected tmux windows for this status check; overrides saved/profile windows when provided"),
      }),
      execute: async (input) => {
        if (!tmuxAllowed) return { error: "Tmux is disabled for this prompt run by --no-tmux." };
        return projectPayload(await projectTmuxStatus(input.target, {
          profile: input.profile,
          session: input.session,
          agentTool: input.agent_tool ? parseProjectStartAgent(input.agent_tool) : undefined,
          command: input.command,
          windowName: input.window_name,
          requestedWindows: input.windows as WorkspaceTmuxWindowSpec[] | undefined,
        }));
      },
    }),
    projects_tmux_profiles_add: tool({
      description: "Create a saved tmux profile with one or more windows. Mutates only when approved.",
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        session_template: z.string().optional(),
        attach: z.boolean().optional(),
        windows: z.array(tmuxWindowSchema).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const profileInput = {
          name: input.name,
          slug: input.slug,
          description: input.description,
          session_template: input.session_template,
          attach: input.attach,
          metadata: input.metadata as JsonObject | undefined,
          windows: input.windows?.map((window) => ({
            window_name_template: window.name,
            path_template: window.path,
            command: window.command,
            window_index: window.index,
            detached: window.detached,
          })),
        };
        if (!approve) return { status: "planned", profile: profileInput, note: "Run again with --yes to create this tmux profile." };
        const profile = createTmuxProfile(profileInput);
        return {
          status: "created",
          profile: {
            id: profile.id,
            slug: profile.slug,
            name: profile.name,
            session_template: profile.session_template,
            windows: listTmuxProfileWindows(profile.id),
          },
        };
      },
    }),
    projects_tmux_profiles_list: tool({
      description: "List saved tmux profiles that can be applied to a project.",
      inputSchema: z.object({}),
      execute: async () => {
        inspectedTmuxProfiles = true;
        return listTmuxProfiles().map((profile) => ({
          id: profile.id,
          slug: profile.slug,
          name: profile.name,
          session_template: profile.session_template,
          windows: listTmuxProfileWindows(profile.id),
        }));
      },
    }),
    projects_tmux_profiles_apply: tool({
      description: "Create or update a tmux session/windows for an existing project. Mutates only when approved.",
      inputSchema: z.object({
        project: z.string().min(1).describe("Project id or slug"),
        session: z.string().optional(),
        windows: z.array(tmuxWindowSchema).optional(),
        profile: z.string().optional().describe("Optional saved tmux profile id or slug"),
      }),
      execute: async (input) => {
        const workspace = await resolveStoreTargetOrNull(input.project);
        if (!workspace) return { error: `Project not found: ${input.project}` };
        if (!tmuxAllowed) return { error: "Tmux is disabled for this prompt run by --no-tmux." };
        if (input.profile && !inspectedTmuxProfiles) {
          return { error: "Call projects_tmux_profiles_list before using a saved profile, then retry projects_tmux_profiles_apply with the selected profile slug." };
        }
        if (!approve) {
          if (input.profile) {
            const profile = resolveTmuxProfile(input.profile);
            if (!profile) return { error: `Tmux profile not found: ${input.profile}` };
            return {
              status: "planned",
              result: applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), { dryRun: true }),
            };
          }
          return {
            status: "planned",
            result: applyWorkspaceTmux(workspace, {
              session: input.session,
              windows: input.windows as WorkspaceTmuxWindowSpec[] | undefined,
              dryRun: true,
            }),
          };
        }
        if (input.profile) {
          const profile = resolveTmuxProfile(input.profile);
          if (!profile) return { error: `Tmux profile not found: ${input.profile}` };
          return withAgentWorkspaceLock(workspace, actorAgent.id, "project tmux apply", () => applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), {
            agentId: actorAgent.id,
            source: "agent",
            prompt: options.prompt,
            command,
          }));
        }
        return withAgentWorkspaceLock(workspace, actorAgent.id, "project tmux apply", () => applyWorkspaceTmux(workspace, {
          session: input.session,
          windows: input.windows as WorkspaceTmuxWindowSpec[] | undefined,
          agentId: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        }));
      },
    }),
  };
}

export async function runWorkspaceAgentPrompt(options: WorkspaceAgentPromptOptions): Promise<WorkspaceAgentPromptResult> {
  const model = pickModel(options.model);
  const dryRun = Boolean(options.dryRun);
  const approve = Boolean(options.approve) && !dryRun;
  const mock = Boolean(options.mock || process.env["WORKSPACES_AGENT_MOCK"]);
  const runAgent = ensureWorkspaceAgent(model);
  const store = resolveProjectStore();
  const actorAgent = resolvePromptAgent(options.agent) ?? runAgent;
  const forcedRoot = options.root ? await store.getRoot(options.root) : null;
  if (options.root && !forcedRoot) throw new Error(`Root not found: ${options.root}`);
  const forcedRecipe = options.recipe ? await store.getRecipe(options.recipe) : null;
  if (options.recipe && !forcedRecipe) throw new Error(`Recipe not found: ${options.recipe}`);
  const forcedRootId = forcedRoot?.id;
  const forcedRecipeId = forcedRecipe?.id;
  let budgetProject: Workspace | null = null;
  if (options.budgetProject) {
    try {
      budgetProject = await store.resolveTarget(options.budgetProject, {
        allowPath: true,
        allowMarker: true,
        intent: "read",
      });
    } catch (error) {
      if (isProjectContextError(error) && error.code === "PROJECT_NOT_FOUND") {
        throw new Error(`Budget project not found: ${options.budgetProject}`);
      }
      throw error;
    }
  }
  const tmuxAllowed = options.tmux !== false;
  const command = promptCommand(options);
  const runLock = acquireWorkspaceLock({
    lock_key: `agent-run:${actorAgent.id}`,
    agent_id: actorAgent.id,
    reason: "active workspace agent prompt run",
    ttl_seconds: 900,
  });
  const run = startAgentRun({
    agent_id: runAgent.id,
    workspace_id: budgetProject?.id,
    provider: "openrouter",
    model,
    prompt: options.prompt,
    metadata: {
      dry_run: dryRun,
      approved: approve,
      mock,
      actor_agent_id: actorAgent.id,
      root_id: forcedRootId,
      recipe_id: forcedRecipeId,
      budget_project_id: budgetProject?.id,
      run_budget: options.runBudget as JsonObject | undefined,
      tmux_allowed: tmuxAllowed,
    },
  });

  if (options.runBudget && (
    options.runBudget.maxUsd !== undefined ||
    options.runBudget.maxInputTokens !== undefined ||
    options.runBudget.maxOutputTokens !== undefined ||
    options.runBudget.maxTotalTokens !== undefined
  )) {
    createProjectBudget({
      id: `run-${run.id}`,
      scope_type: "run",
      scope_id: run.id,
      window: "lifetime",
      mode: "hard",
      max_usd: options.runBudget.maxUsd,
      max_input_tokens: options.runBudget.maxInputTokens,
      max_output_tokens: options.runBudget.maxOutputTokens,
      max_total_tokens: options.runBudget.maxTotalTokens,
      metadata: { source: "prompt-run" },
    });
  }

  try {
    assertProjectBudgets({ workspace_id: budgetProject?.id, run_id: run.id });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    completeAgentRun(run.id, { status: "failed", error, result: { error } });
    releaseWorkspaceLock(runLock.lock_key);
    throw err;
  }

  if (mock) {
    try {
      return runMockPrompt(actorAgent, run.id, {
        prompt: options.prompt,
        dryRun,
        approve,
        model,
        root_id: forcedRootId,
        recipe_id: forcedRecipeId,
        tmuxAllowed,
        command,
      });
    } finally {
      releaseWorkspaceLock(runLock.lock_key);
    }
  }

  const apiKey = resolveOpenRouterApiKey();
  if (!apiKey) {
    const error = "Missing OpenRouter API key. Set OPENROUTER_API_KEY or store it in the local secrets vault.";
    completeAgentRun(run.id, { status: "failed", error, result: { error } });
    releaseWorkspaceLock(runLock.lock_key);
    throw new Error(error);
  }

  const createdWorkspaces: Workspace[] = [];
  const observedToolCalls: JsonObject[] = [];
  const observedBudgetStatuses: ProjectBudgetStatus[] = [];
  const provider = createOpenRouter({
    apiKey,
    appName: "open-projects",
    appUrl: "https://github.com/hasna/projects",
  });

  const tools = buildWorkspaceAgentTools({
    store,
    actorAgent,
    approve,
    options,
    command,
    forcedRootId,
    forcedRecipeId,
    tmuxAllowed,
    createdWorkspaces,
  });

  try {
    const result = await generateText({
      model: provider(model),
      system: buildWorkspaceAgentSystemPrompt({
        actorAgentId: actorAgent.id,
        forcedRootId,
        forcedRecipeId,
        tmuxAllowed,
      }),
      prompt: options.prompt,
      tools,
      stopWhen: stepCountIs(options.maxSteps ?? 6),
      temperature: 0.2,
      onStepFinish: async (event) => {
        const usage = normalizeProjectUsage(event.usage);
        const usd = estimateProjectCostUsd(usage, model, event.providerMetadata);
        recordProjectSpend({
          workspace_id: budgetProject?.id,
          run_id: run.id,
          provider: "openrouter",
          model,
          usd,
          cost_unknown: usd === undefined && usage.total_tokens > 0,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          total_tokens: usage.total_tokens,
          metadata: {
            step_number: event.stepNumber,
            finish_reason: event.finishReason,
          },
        });
        observedBudgetStatuses.splice(
          0,
          observedBudgetStatuses.length,
          ...assertProjectBudgetsAfterSpend({ workspace_id: budgetProject?.id, run_id: run.id }),
        );
      },
      experimental_onToolCallFinish: (event) => {
        observedToolCalls.push({
          name: event.toolCall.toolName,
          input: event.toolCall.input,
          success: event.success,
          output: event.success ? event.output : undefined,
          error: event.success ? undefined : String(event.error),
        });
      },
    });

    const toolCalls = observedToolCalls.length > 0 ? observedToolCalls : extractToolCalls(result);
    const fallback = shouldRunWorkspaceCreateFallback(toolCalls, options.prompt)
      ? await fallbackWorkspaceCreate(actorAgent, {
        store,
        prompt: options.prompt,
        dryRun,
        approve,
        root_id: forcedRootId,
        recipe_id: forcedRecipeId,
        command,
      })
      : null;
    if (fallback) {
      toolCalls.push(fallback.call);
      if (fallback.workspace) createdWorkspaces.push(fallback.workspace);
    }
    const mutationAudit = auditProjectAgentToolCalls(toolCalls, { approve, dryRun });
    if (mutationAudit.violations.length > 0) {
      const error = `Project agent mutation audit failed: ${mutationAudit.violations.join("; ")}`;
      completeAgentRun(run.id, {
        status: "failed",
        error,
        tool_calls: toolCalls,
        result: { error, mutation_audit: mutationAudit as unknown as JsonObject },
      });
      throw new Error(error);
    }
    const text = fallback ? `${result.text}\n\n${fallback.text}` : result.text;
    const usage = result.totalUsage as unknown as JsonObject;
    const budgetStatuses = observedBudgetStatuses.length > 0
      ? observedBudgetStatuses
      : getProjectBudgetStatuses({ workspace_id: budgetProject?.id, run_id: run.id });
    completeAgentRun(run.id, {
      status: "completed",
      workspace_id: budgetProject?.id ?? createdWorkspaces[0]?.id,
      tool_calls: toolCalls,
      result: {
        text,
        projects: createdWorkspaces.map(compactProject),
        mutation_audit: mutationAudit as unknown as JsonObject,
        usage,
        budget_statuses: budgetStatuses as unknown as JsonObject[],
      },
    });

    return {
      mode: "ai",
      run_id: run.id,
      agent_id: runAgent.id,
      provider: "openrouter",
      model,
      actor_agent_id: actorAgent.id,
      approved: approve,
      dry_run: dryRun,
      text,
      projects: createdWorkspaces,
      tool_calls: toolCalls,
      mutation_audit: mutationAudit,
      usage,
      budget_statuses: budgetStatuses as unknown as JsonObject[],
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    completeAgentRun(run.id, {
      status: "failed",
      error,
      tool_calls: observedToolCalls,
      result: {
        error,
        ...(err instanceof BudgetExceededError ? { budget_statuses: err.statuses as unknown as JsonObject[] } : {}),
      },
    });
    throw err;
  } finally {
    releaseWorkspaceLock(runLock.lock_key);
    ensureCliAgent();
  }
}
