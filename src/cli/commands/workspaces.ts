import chalk from "chalk";
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  deleteWorkspace,
  deleteRoot,
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
  resolveWorkspace,
  resolveTmuxProfile,
  unarchiveWorkspace,
  updateWorkspace,
  updateRoot,
} from "../../db/workspaces.js";
import {
  applyWorkspaceTmuxProfile,
  workspaceMarkerPath,
  type WorkspaceTmuxWindowSpec,
} from "../../lib/workspace-runtime.js";
import {
  cleanupWorkspaceCreationTarget,
  executeWorkspaceCreation,
  type WorkspaceCreationCleanupTarget,
  type WorkspaceCreationPlanAction,
} from "../../lib/workspace-plan.js";
import { doctorWorkspace } from "../../lib/workspace-doctor.js";
import { builtInWorkspaceRecipes, ensureBuiltInWorkspaceRecipes } from "../../lib/workspace-defaults.js";
import {
  importWorkspaceFromGitHub,
  syncWorkspaceGitHubRoots,
  linkWorkspaceExternalIntegrations,
  publishWorkspaceToGitHub,
  unpublishWorkspaceFromGitHub,
  type GitHubRemoteProtocol,
  type GitHubVisibility,
} from "../../lib/workspace-github.js";
import { importRegisteredRoots, importWorkspace, importWorkspaceBulk } from "../../lib/workspace-import.js";
import { runWorkspaceLegacyMigration } from "../../lib/workspace-migration.js";
import { parseWorkspaceAgentEvalCaseIds, runWorkspaceAgentEval } from "../../lib/workspace-agent-eval.js";
import { cleanupProjectEvalArtifacts, filterProjectEvalArtifacts } from "../../lib/project-eval-artifacts.js";
import { resolveRegisteredProjectTargetOrThrow } from "../../lib/project-resolver.js";
import {
  parseProjectStartAgent,
  parseProjectStartSessionPolicy,
  startProject,
  type ProjectStartSessionPolicy,
  type ProjectStartResult,
} from "../../lib/project-start.js";
import { projectTmuxStatus } from "../../lib/project-tmux-status.js";
import { buildProjectDetailPayload, buildProjectListRender, buildProjectSessionsPayload, buildProjectStartBulkRender, buildRecipesRender, buildRootsRender } from "../../lib/project-render.js";
import {
  createProjectBudget,
  getProjectBudgetStatuses,
  listProjectBudgets,
  recordProjectSpend,
  resetProjectBudget,
} from "../../lib/budget.js";
import {
  PROJECT_PRIORITIES,
  PROJECT_START_AGENTS,
  PROJECT_START_SESSION_POLICIES,
  PROJECT_STAGES,
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
} from "../../lib/project-management.js";
import { PROJECT_AGENT_ROLES, WORKSPACE_KINDS, WORKSPACE_STATUSES, type AgentKind, type JsonObject, type Workspace, type WorkspaceEvent, type WorkspaceIntegrations, type WorkspaceKind, type WorkspaceLock, type WorkspaceStatus } from "../../types/workspace.js";

const DEFAULT_LIST_LIMIT = 25;
const DEFAULT_EVENT_LIMIT = 20;
const MAX_HUMAN_LIMIT = 200;

function wantsRenderSpec(opts?: { renderSpec?: boolean }): boolean {
  return Boolean(opts?.renderSpec || process.argv.includes("--render-spec"));
}

function wantsJson(opts?: { json?: boolean }): boolean {
  return Boolean(opts?.json || process.env["PROJECTS_JSON"] || process.env["WORKSPACES_JSON"] || process.argv.includes("--json") || process.argv.includes("-j"));
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function splitVariadicList(values: string[] | undefined): string[] {
  return splitList(values?.join(","));
}

function printObject(value: unknown, opts?: { json?: boolean }): void {
  if (wantsJson(opts)) {
    console.log(JSON.stringify(value, null, 2));
  }
}

function printRenderSpec(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function withoutRender<T extends Record<string, unknown>>(value: T): Omit<T, "render" | "schema_version" | "kind"> {
  const { render: _render, schema_version: _schemaVersion, kind: _kind, ...rest } = value;
  return rest;
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

function projectLockPayload(lock: WorkspaceLock): Omit<WorkspaceLock, "workspace_id"> & { project_id: string | null } {
  const { workspace_id, ...payload } = lock;
  return { ...payload, project_id: workspace_id };
}

function parseKind(value: string | undefined): WorkspaceKind | undefined {
  if (!value) return undefined;
  if ((WORKSPACE_KINDS as readonly string[]).includes(value)) return value as WorkspaceKind;
  throw new Error(`Invalid workspace kind: ${value}. Expected one of: ${WORKSPACE_KINDS.join(", ")}`);
}

function parseStatus(value: string | undefined): WorkspaceStatus | undefined {
  if (!value) return undefined;
  if ((WORKSPACE_STATUSES as readonly string[]).includes(value)) return value as WorkspaceStatus;
  throw new Error(`Invalid workspace status: ${value}. Expected one of: ${WORKSPACE_STATUSES.join(", ")}`);
}

function parseProjectAgentRole(value: string | undefined): string {
  const role = value ?? "contributor";
  if ((PROJECT_AGENT_ROLES as readonly string[]).includes(role)) return role;
  throw new Error(`Invalid project agent role: ${role}. Expected one of: ${PROJECT_AGENT_ROLES.join(", ")}`);
}

function parseJsonObject(value: string | undefined, label: string): JsonObject | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function parseIntegrationsJson(value: string | undefined): WorkspaceIntegrations | undefined {
  const parsed = parseJsonObject(value, "--integrations-json");
  if (!parsed) return undefined;
  const integrations: WorkspaceIntegrations = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (item === null) continue;
    if (typeof item !== "string") throw new Error("--integrations-json values must be strings or null");
    integrations[key] = item;
  }
  return integrations;
}

function parseIntegrationPairs(values: string[] | undefined): WorkspaceIntegrations {
  const integrations: WorkspaceIntegrations = {};
  for (const value of values ?? []) {
    const index = value.indexOf("=");
    if (index <= 0) throw new Error("--integration values must use key=value");
    const key = value.slice(0, index).trim();
    const pairValue = value.slice(index + 1).trim();
    if (!key || !pairValue) throw new Error("--integration values must use non-empty key=value");
    integrations[key] = pairValue;
  }
  return integrations;
}

function mergeIntegrations(...items: Array<WorkspaceIntegrations | undefined>): WorkspaceIntegrations {
  return Object.assign({}, ...items.filter(Boolean));
}

function parseGitHubVisibility(value: string | undefined): GitHubVisibility | undefined {
  if (!value) return undefined;
  if (value === "public" || value === "private") return value;
  throw new Error("GitHub visibility must be public or private");
}

function parseGitHubRemoteProtocol(value: string | undefined): GitHubRemoteProtocol | undefined {
  if (!value) return undefined;
  if (value === "https" || value === "ssh") return value;
  throw new Error("GitHub remote protocol must be https or ssh");
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseNonNegativeNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number`);
  return parsed;
}

function withWorkspaceLock<T>(workspace: Workspace, agentId: string | undefined, reason: string, fn: () => T): T {
  const key = `workspace:${workspace.id}`;
  try {
    acquireWorkspaceLock({ lock_key: key, workspace_id: workspace.id, agent_id: agentId, reason, ttl_seconds: 600 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Workspace lock already held:")) {
      throw new Error(message.replace("Workspace lock", "Project lock"));
    }
    throw err;
  }
  try {
    return fn();
  } finally {
    releaseWorkspaceLock(key);
  }
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

function resolveAgentId(idOrSlug: string | undefined): string {
  if (!idOrSlug) return ensureCliAgent().id;
  const agent = getAgent(idOrSlug) ?? getAgentBySlug(idOrSlug);
  if (!agent) throw new Error(`Agent not found: ${idOrSlug}`);
  return agent.id;
}

function resolveProjectTarget(target: string | undefined): Workspace {
  return resolveRegisteredProjectTargetOrThrow(target).project;
}

function printRows(rows: Array<Record<string, unknown>>, columns: string[]): void {
  if (!rows.length) {
    console.log(chalk.dim("No records found."));
    return;
  }
  for (const row of rows) {
    console.log(columns.map((column) => String(row[column] ?? "")).join("\t"));
  }
}

function compactText(value: string | null | undefined, max = 80): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  if (max <= 3) return normalized.slice(0, max);
  return `${normalized.slice(0, max - 3)}...`;
}

function parseHumanLimit(value: string | undefined, defaultLimit: number, label = "--limit"): number {
  const parsed = parsePositiveInteger(value, label) ?? defaultLimit;
  if (parsed > MAX_HUMAN_LIMIT) throw new Error(`${label} must be ${MAX_HUMAN_LIMIT} or less for terminal output`);
  return parsed;
}

function printDiscoveryHint(message: string): void {
  console.log(chalk.dim(message));
}

function eventSummary(event: WorkspaceEvent, verbose = false): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: event.id,
    event_type: event.event_type,
    source: event.source,
    agent_id: event.agent_id ?? "",
    created_at: event.created_at,
  };
  if (verbose) {
    row.prompt = compactText(event.prompt, 60);
    row.command = compactText(event.command, 80);
    row.metadata = Object.keys(event.metadata).join(",");
  }
  return row;
}

function parseTmuxWindowsJson(value: string | undefined, label = "--tmux-windows-json"): WorkspaceTmuxWindowSpec[] | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each tmux window must be an object");
    const window = item as Record<string, unknown>;
    if (typeof window.name !== "string" || window.name.trim().length === 0) {
      throw new Error("Each tmux window needs a non-empty name");
    }
    return {
      name: window.name,
      path: typeof window.path === "string" ? window.path : undefined,
      command: typeof window.command === "string" ? window.command : undefined,
      index: typeof window.index === "number" ? window.index : undefined,
      detached: typeof window.detached === "boolean" ? window.detached : undefined,
    };
  });
}

function parseStartWindows(values: string[] | undefined): WorkspaceTmuxWindowSpec[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((value) => {
    const index = value.indexOf(":");
    const name = (index === -1 ? value : value.slice(0, index)).trim();
    const command = index === -1 ? undefined : value.slice(index + 1).trim();
    if (!name) throw new Error("--window values must use a non-empty name or name:command");
    return {
      name,
      command: command || undefined,
      detached: true,
    };
  });
}

function parseStartBulkFile(path: string): string[] {
  const text = readFileSync(path, "utf-8").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("--bulk-file JSON must be an array of project targets");
    }
    return parsed.map((item) => item.trim()).filter(Boolean);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function collectStartTargets(targets: string[] | undefined, bulkFile: string | undefined): Array<string | undefined> {
  const collected = [...(targets ?? [])];
  if (bulkFile) collected.push(...parseStartBulkFile(bulkFile));
  return collected.length > 0 ? collected : [undefined];
}

function parseStartSessionPolicyOptions(opts: { reuse?: boolean; new?: boolean; errorIfRunning?: boolean }): ProjectStartSessionPolicy | undefined {
  const selected = [
    opts.reuse ? "reuse" : undefined,
    opts.new ? "new" : undefined,
    opts.errorIfRunning ? "error-if-running" : undefined,
  ].filter(Boolean) as ProjectStartSessionPolicy[];
  if (selected.length > 1) {
    throw new Error("Choose only one session policy: --reuse, --new, or --error-if-running");
  }
  if (selected.length === 0) return undefined;
  return parseProjectStartSessionPolicy(selected[0]);
}

interface ProjectStartFailure {
  target: string;
  error: string;
}

interface ProjectStartBulkSummary {
  total: number;
  succeeded: number;
  failed: number;
  planned: number;
  created_sessions: number;
  reused_sessions: number;
  planned_sessions: number;
  failed_sessions: number;
  imported: number;
  planned_imports: number;
  windows: {
    completed: number;
    skipped: number;
    planned: number;
    failed: number;
  };
}

interface ProjectStartBulkResult {
  bulk: true;
  dry_run: boolean;
  total: number;
  started: ProjectStartResult[];
  failed: ProjectStartFailure[];
  summary: ProjectStartBulkSummary;
}

function summarizeProjectStarts(started: ProjectStartResult[], failed: ProjectStartFailure[]): ProjectStartBulkSummary {
  const windowCounts = { completed: 0, skipped: 0, planned: 0, failed: 0 };
  for (const result of started) {
    for (const window of result.tmux.windows) {
      if (window.status === "completed") windowCounts.completed += 1;
      if (window.status === "skipped") windowCounts.skipped += 1;
      if (window.status === "planned") windowCounts.planned += 1;
      if (window.status === "failed") windowCounts.failed += 1;
    }
  }
  return {
    total: started.length + failed.length,
    succeeded: started.filter((result) => result.tmux.success).length,
    failed: failed.length + started.filter((result) => !result.tmux.success).length,
    planned: started.filter((result) => result.tmux.dry_run).length,
    created_sessions: started.filter((result) => result.tmux.session_action === "created").length,
    reused_sessions: started.filter((result) => result.tmux.session_action === "reused").length,
    planned_sessions: started.filter((result) => result.tmux.session_action === "planned").length,
    failed_sessions: started.filter((result) => result.tmux.session_action === "failed").length,
    imported: started.filter((result) => result.resolution.source === "imported").length,
    planned_imports: started.filter((result) => result.resolution.source === "planned-import").length,
    windows: windowCounts,
  };
}

function compactWindowSummary(result: ProjectStartResult): string {
  const names = result.tmux.windows
    .map((window) => {
      const parts = window.target.split(":");
      const name = parts.length > 1 ? parts.slice(1).join(":") : window.target;
      return `${name} ${window.status}`;
    })
    .join(", ");
  return names || "none";
}

function pendingRenameReports(result: ProjectStartResult): ProjectStartResult["rename_report"] {
  return result.rename_report.filter((report) => report.status === "manual" || report.status === "unsupported");
}

function printRenameReports(result: ProjectStartResult): void {
  for (const report of result.rename_report) {
    const status = report.status === "configured"
      ? chalk.green(report.status)
      : report.status === "skipped"
        ? chalk.dim(report.status)
        : chalk.yellow(report.status);
    console.log(`  ${chalk.dim("rename:")} ${report.agent_tool} ${status} -> ${report.desired_name}`);
    console.log(`    ${chalk.dim(report.message)}`);
    if (report.manual_instruction) console.log(`    ${chalk.dim(report.manual_instruction)}`);
  }
}

function printProjectStartResult(result: ProjectStartResult, opts: { verbose?: boolean; renameReport?: boolean } = {}): void {
  const prefix = result.tmux.dry_run ? "[dry-run] " : "";
  console.log(`${chalk.green(`${prefix}Project started:`)} ${result.project.slug}`);
  if (result.project.primary_path) console.log(`  ${chalk.dim("path:")} ${result.project.primary_path}`);
  console.log(`  ${chalk.dim("session:")} ${result.tmux.session_name} (${result.tmux.session_action})`);
  console.log(`  ${chalk.dim("session policy:")} ${result.session_policy}`);
  console.log(`  ${chalk.dim("agent:")} ${result.agent_tool}${result.tool_command ? ` -> ${result.tool_command}` : ""}`);
  console.log(`  ${chalk.dim("windows:")} ${compactWindowSummary(result)}`);
  const pendingRename = pendingRenameReports(result);
  if (pendingRename.length) {
    console.log(`  ${chalk.dim("rename:")} ${pendingRename.length} pending; use --rename-report or projects sessions ${result.project.slug}`);
  }
  if (opts.verbose) {
    for (const window of result.tmux.windows) {
      console.log(`  ${chalk.dim("window:")} ${window.status} ${window.target}${window.message ? chalk.dim(` - ${window.message}`) : ""}`);
    }
  }
  if (opts.renameReport || opts.verbose) {
    printRenameReports(result);
  }
  if (result.resolution.source === "imported") {
    console.log(chalk.dim("  registered project from path before starting"));
  } else if (result.resolution.source === "planned-import") {
    console.log(chalk.dim("  would register project from path before starting"));
  }
  if (result.attached) console.log(chalk.dim("  attached to tmux session"));
}

function printProjectStartBulkResult(result: ProjectStartBulkResult): void {
  const prefix = result.dry_run ? "[dry-run] " : "";
  console.log(`${chalk.green(`${prefix}Projects start summary:`)} ${result.summary.succeeded}/${result.summary.total} ok, ${result.summary.failed} failed`);
  console.log(`  ${chalk.dim("sessions:")} planned ${result.summary.planned_sessions}, created ${result.summary.created_sessions}, reused ${result.summary.reused_sessions}, failed ${result.summary.failed_sessions}`);
  console.log(`  ${chalk.dim("windows:")} planned ${result.summary.windows.planned}, completed ${result.summary.windows.completed}, skipped ${result.summary.windows.skipped}, failed ${result.summary.windows.failed}`);
  for (const started of result.started) {
    const marker = started.tmux.success ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${marker} ${started.project.slug} ${chalk.dim(started.tmux.session_name)} (${started.tmux.session_action})`);
  }
  for (const failure of result.failed) {
    console.log(`  ${chalk.red("✗")} ${failure.target}: ${failure.error}`);
  }
}

function parseTmuxProfileWindowsJson(value: string | undefined) {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("--windows-json must be a JSON array");
  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each profile window must be an object");
    const window = item as Record<string, unknown>;
    const name = window.window_name_template ?? window.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Each profile window needs name or window_name_template");
    }
    return {
      window_name_template: name,
      path_template: typeof window.path_template === "string" ? window.path_template : typeof window.path === "string" ? window.path : undefined,
      command: typeof window.command === "string" ? window.command : undefined,
      window_index: typeof window.window_index === "number" ? window.window_index : typeof window.index === "number" ? window.index : undefined,
      detached: typeof window.detached === "boolean" ? window.detached : undefined,
      env: window.env && typeof window.env === "object" ? window.env as Record<string, string> : undefined,
      revive: typeof window.revive === "boolean" ? window.revive : undefined,
    };
  });
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
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

function cleanupTargetFromPlanFile(path: string): WorkspaceCreationCleanupTarget {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const plan = payload.plan && typeof payload.plan === "object" ? payload.plan as Record<string, unknown> : payload;
  const workspace = plan.workspace && typeof plan.workspace === "object" ? plan.workspace as Record<string, unknown> : null;
  const rollbackActions = parseRollbackActions(plan.rollback_actions);
  if (!workspace || typeof workspace.slug !== "string" || !rollbackActions) {
    throw new Error("--plan must point to a workspace creation plan or execution JSON payload");
  }
  return {
    workspace_slug: workspace.slug,
    primary_path: typeof workspace.primary_path === "string" ? workspace.primary_path : null,
    rollback_actions: rollbackActions,
  };
}

function cleanupTargetFromWorkspace(workspace: Workspace): WorkspaceCreationCleanupTarget {
  for (const event of listWorkspaceEvents(workspace.id).slice().reverse()) {
    const fromMetadata = parseRollbackActions(event.metadata.rollback_actions);
    if (fromMetadata) {
      return {
        workspace_slug: workspace.slug,
        primary_path: workspace.primary_path,
        rollback_actions: fromMetadata,
      };
    }
    const after = event.after_json as Record<string, unknown> | null;
    const plan = after?.plan as Record<string, unknown> | undefined;
    const fromPlan = parseRollbackActions(plan?.rollback_actions);
    if (fromPlan) {
      return {
        workspace_slug: workspace.slug,
        primary_path: workspace.primary_path,
        rollback_actions: fromPlan,
      };
    }
  }

  const rollbackActions: WorkspaceCreationPlanAction[] = [
    { type: "rollback", action: "delete", target: `workspaces:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
    { type: "rollback", action: "delete", target: `workspace_events:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
  ];
  if (workspace.primary_path) {
    rollbackActions.push({ type: "rollback", action: "delete", target: `workspace_locations:${workspace.primary_path}`, status: "planned", metadata: { automatic: false } });
    rollbackActions.push({ type: "rollback", action: "remove_file", target: workspaceMarkerPath(workspace), status: "planned", metadata: { automatic: false } });
    rollbackActions.push({ type: "rollback", action: "remove_git_dir", target: join(workspace.primary_path, ".git"), status: "planned", metadata: { automatic: false } });
    rollbackActions.push({ type: "rollback", action: "remove_empty_directory", target: workspace.primary_path, status: "planned", metadata: { automatic: false } });
  }
  return {
    workspace_slug: workspace.slug,
    primary_path: workspace.primary_path,
    rollback_actions: rollbackActions,
  };
}

export function registerWorkspaceCommands(program: Command): void {
  registerProjectStartCommand(program);
  registerProjectStatusCommand(program);
  registerProjectSessionsCommand(program);
  registerProjectCommands(program);
  registerBudgetCommands(program);
  registerLocationsCommand(program);
  registerRootsCommand(program);
  registerRecipesCommand(program);
  registerAgentsCommand(program);
  registerTmuxProfilesCommand(program);
}

function registerBudgetCommands(program: Command): void {
  const cmd = program
    .command("budgets")
    .description("Define, inspect, and account for project/run money and token budgets");

  cmd
    .command("set")
    .description("Create or update a project or run budget")
    .option("--id <id>", "Budget id")
    .option("--project <project>", "Project id, slug, name, or path")
    .option("--run-id <run>", "Agent run id")
    .option("--window <window>", "Budget window: daily, monthly, lifetime", "lifetime")
    .option("--mode <mode>", "Budget mode: hard or soft", "hard")
    .option("--max-usd <amount>", "USD budget")
    .option("--max-input-tokens <n>", "Input token budget")
    .option("--max-output-tokens <n>", "Output token budget")
    .option("--max-total-tokens <n>", "Total token budget")
    .option("--warning-threshold <ratio>", "Soft warning threshold ratio, e.g. 0.8")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const project = opts.project ? resolveProjectTarget(opts.project) : null;
        if (!project && !opts.runId) throw new Error("Pass --project or --run-id");
        if (opts.project && opts.runId) throw new Error("Choose only one scope: --project or --run-id");
        const scopeType = project ? "project" : "run";
        const scopeId = project?.id ?? opts.runId;
        const budget = createProjectBudget({
          id: opts.id ?? `${scopeType}-${scopeId}`,
          scope_type: scopeType,
          scope_id: scopeId,
          window: opts.window,
          mode: opts.mode,
          max_usd: parseNonNegativeNumber(opts.maxUsd, "--max-usd"),
          max_input_tokens: parseNonNegativeNumber(opts.maxInputTokens, "--max-input-tokens"),
          max_output_tokens: parseNonNegativeNumber(opts.maxOutputTokens, "--max-output-tokens"),
          max_total_tokens: parseNonNegativeNumber(opts.maxTotalTokens, "--max-total-tokens"),
          warning_threshold: parseNonNegativeNumber(opts.warningThreshold, "--warning-threshold"),
          metadata: { project_slug: project?.slug },
        });
        const payload = { budget, project: project ? projectPayload(project) : null };
        if (wantsJson(opts)) { printObject(payload, opts); return; }
        console.log(chalk.green(`✓ Budget saved: ${budget.id}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .description("List configured budgets")
    .option("--project <project>", "Project id, slug, name, or path")
    .option("--run-id <run>", "Agent run id")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const project = opts.project ? resolveProjectTarget(opts.project) : null;
        const budgets = listProjectBudgets({ workspace_id: project?.id, run_id: opts.runId });
        if (wantsJson(opts)) { printObject(budgets, opts); return; }
        const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
        const visible = budgets.slice(0, limit);
        printRows(visible.map((budget) => ({
          id: budget.id,
          scope: `${budget.scope_type}:${budget.scope_id}`,
          mode: budget.mode,
          window: budget.window,
        })), ["id", "scope", "mode", "window"]);
        printDiscoveryHint(`Showing ${visible.length} of ${budgets.length} budget(s). Use --limit <n> or --json for full records.`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("remaining")
    .description("Show remaining money and token budget")
    .option("--id <id>", "Budget id")
    .option("--project <project>", "Project id, slug, name, or path")
    .option("--run-id <run>", "Agent run id")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const project = opts.project ? resolveProjectTarget(opts.project) : null;
        const statuses = getProjectBudgetStatuses({ workspace_id: project?.id, run_id: opts.runId, budget_id: opts.id });
        if (wantsJson(opts)) { printObject(statuses, opts); return; }
        const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
        const visible = statuses.slice(0, limit);
        printRows(visible.map((status) => ({
          id: status.budget.id,
          usd: status.remaining.usd ?? "",
          input: status.remaining.input_tokens ?? "",
          output: status.remaining.output_tokens ?? "",
          total: status.remaining.total_tokens ?? "",
        })), ["id", "usd", "input", "output", "total"]);
        printDiscoveryHint(`Showing ${visible.length} of ${statuses.length} budget status row(s). Use --limit <n> or --json for full records.`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("reset <id>")
    .description("Reset a budget window from now")
    .option("-j, --json", "Output JSON")
    .action((id, opts) => {
      try {
        const budget = resetProjectBudget(id);
        if (wantsJson(opts)) { printObject({ budget }, opts); return; }
        console.log(chalk.green(`✓ Budget reset: ${budget.id}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("spend")
    .description("Record audited project/run spend")
    .option("--project <project>", "Project id, slug, name, or path")
    .option("--run-id <run>", "Agent run id")
    .option("--provider <provider>", "Provider name", "openrouter")
    .option("--model <model>", "Model id")
    .option("--usd <amount>", "USD spend", "0")
    .option("--input-tokens <n>", "Input tokens", "0")
    .option("--output-tokens <n>", "Output tokens", "0")
    .option("--total-tokens <n>", "Total tokens")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const project = opts.project ? resolveProjectTarget(opts.project) : null;
        if (!project && !opts.runId) throw new Error("Pass --project or --run-id");
        const spend = recordProjectSpend({
          workspace_id: project?.id,
          run_id: opts.runId,
          provider: opts.provider,
          model: opts.model,
          usd: parseNonNegativeNumber(opts.usd, "--usd"),
          input_tokens: parseNonNegativeNumber(opts.inputTokens, "--input-tokens"),
          output_tokens: parseNonNegativeNumber(opts.outputTokens, "--output-tokens"),
          total_tokens: parseNonNegativeNumber(opts.totalTokens, "--total-tokens"),
          metadata: { source: "cli" },
        });
        if (wantsJson(opts)) { printObject({ spend }, opts); return; }
        console.log(chalk.green(`✓ Spend recorded: ${spend.id}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerProjectStatusCommand(program: Command): void {
  program
    .command("status [target]")
    .description("Show project launch and tmux session status")
    .option("--profile <id-or-slug>", "Saved tmux profile used to compute expected windows")
    .option("--session <name>", "Expected tmux session name")
    .option("--agent <tool>", "Expected start tool: codewith, claude, opencode, cursor, or none")
    .option("--command <command>", "Expected command for the primary window")
    .option("--window-name <name>", "Expected primary window name; defaults to 01")
    .option("--window <name:command>", "Expected additional tmux window; repeatable", collectOption, [])
    .option("--windows-json <json>", "Exact expected tmux windows JSON array")
    .option("--render-spec", "Output a JSON Render spec")
    .option("-j, --json", "Output JSON")
    .action(async (target, opts) => {
      try {
        const requestedWindows = parseTmuxWindowsJson(opts.windowsJson, "--windows-json");
        const result = await projectTmuxStatus(target, {
          profile: opts.profile,
          session: opts.session,
          agentTool: opts.agent ? parseProjectStartAgent(opts.agent) : undefined,
          command: opts.command,
          windowName: opts.windowName,
          requestedWindows,
          extraWindows: parseStartWindows(opts.window),
        });
        if (wantsRenderSpec(opts)) { printRenderSpec(result.render); return; }
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(`${chalk.bold(result.project.name)} ${chalk.dim(`(${result.project.slug})`)}`);
        console.log(`  ${chalk.dim("expected session:")} ${result.expected.session_name}`);
        if (result.expected.profile) console.log(`  ${chalk.dim("profile:")} ${result.expected.profile.slug}`);
        if (!result.tmux_available) {
          console.log(`  ${chalk.dim("tmux:")} unavailable`);
          for (const error of result.errors) console.log(`  ${chalk.red("error:")} ${error}`);
          return;
        }
        console.log(`  ${chalk.dim("session:")} ${result.exists ? chalk.green("running") : chalk.yellow("missing")}`);
        if (result.session) {
          console.log(`  ${chalk.dim("windows:")} ${result.session.windows}${result.session.attached ? " attached" : ""}`);
        }
        for (const window of result.windows) {
          const state = window.dead ? chalk.yellow(window.reason) : chalk.green("alive");
          console.log(`  ${chalk.dim("window:")} ${window.index}:${window.name} ${state}`);
        }
        if (!result.windows.length && result.expected.windows.length) {
          console.log(`  ${chalk.dim("expected windows:")} ${result.expected.windows.map((window) => window.name).join(", ")}`);
        }
        if (result.related_sessions.length > 1) {
          console.log(`  ${chalk.dim("related sessions:")} ${result.related_sessions.map((session) => session.name).join(", ")}`);
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerProjectSessionsCommand(program: Command): void {
  program
    .command("sessions [target]")
    .description("Report recent project start sessions and coding-agent rename status")
    .option("--unrenamed", "Only show sessions with pending/manual rename work")
    .option("--limit <n>", "Maximum session records to return", "20")
    .option("--render-spec", "Output a JSON Render spec")
    .option("-j, --json", "Output JSON")
    .action((target, opts) => {
      try {
        const project = resolveProjectTarget(target);
        const limit = parsePositiveInteger(opts.limit, "--limit") ?? 20;
        const payload = buildProjectSessionsPayload({
          project,
          events: listWorkspaceEvents(project.id),
          limit,
          unrenamedOnly: opts.unrenamed,
        });
        if (wantsRenderSpec(opts)) { printRenderSpec(payload.render); return; }
        if (wantsJson(opts)) { printObject(projectPayload(payload), opts); return; }
        const sessions = payload.sessions as Array<Record<string, unknown>>;
        console.log(`${chalk.bold(project.name)} ${chalk.dim(`(${project.slug})`)}`);
        console.log(`  ${chalk.dim("sessions:")} ${payload.returned}/${payload.total} shown, ${payload.unrenamed_count} pending rename`);
        if (!sessions.length) {
          console.log(chalk.dim("  No project start session records found."));
          return;
        }
        for (const session of sessions) {
          const unrenamed = session.unrenamed ? chalk.yellow("rename pending") : chalk.green("rename ok");
          console.log(`  ${session.created_at} ${chalk.dim(String(session.session_name ?? ""))} ${session.session_action ?? ""} ${unrenamed}`);
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerProjectStartCommand(program: Command): void {
  program
    .command("start")
    .argument("[targets...]", "Project target(s): id, slug, name, path, or .")
    .description("Start a project by opening or reusing its tmux session")
    .option("--bulk", "Treat targets as a bulk start set")
    .option("--bulk-file <path>", "Read project targets from a JSON array or newline-delimited file")
    .option("--agent <tool>", "Tool to start: codewith, claude, opencode, cursor, or none")
    .option("--command <command>", "Override the command started in the main window")
    .option("--profile <id-or-slug>", "Saved tmux profile to apply while starting")
    .option("--session <name>", "Tmux session name")
    .option("--name <name>", "Tmux session name alias")
    .option("--reuse", "Reuse an existing tmux session when present")
    .option("--new", "Create a new tmux session if the default session already exists")
    .option("--error-if-running", "Fail if the resolved tmux session already exists")
    .option("--window-name <name>", "Main tmux window name; defaults to 01")
    .option("--window <name:command>", "Additional tmux window; repeatable", collectOption, [])
    .option("--windows-json <json>", "Exact tmux windows JSON array to create for this start")
    .option("--tags <tags>", "Tags to apply when registering an unknown folder")
    .option("--metadata-json <json>", "Metadata JSON to apply when registering an unknown folder")
    .option("--actor <id-or-slug>", "Projects agent credited for the start event")
    .option("--attach", "Attach to the tmux session after starting", false)
    .option("--no-attach", "Do not attach to the tmux session after starting")
    .option("--no-register", "Do not import unknown path targets before starting")
    .option("--dry-run", "Preview project resolution and tmux actions without writing")
    .option("--rename-report", "Show coding-agent session rename details")
    .option("--verbose", "Show detailed tmux window and rename actions")
    .option("--render-spec", "Output a JSON Render spec")
    .option("-j, --json", "Output JSON")
    .action(async (targets, opts) => {
      try {
        const startTargets = collectStartTargets(targets, opts.bulkFile);
        const bulk = Boolean(opts.bulk || opts.bulkFile || startTargets.length > 1);
        if (bulk && opts.attach) {
          throw new Error("--attach is only supported for a single project start");
        }
        if (bulk && (opts.session || opts.name)) {
          throw new Error("--session/--name is only supported for a single project start");
        }

        const agentId = opts.actor ? resolveAgentId(opts.actor) : ensureCliAgent().id;
        const requestedWindows = parseTmuxWindowsJson(opts.windowsJson, "--windows-json");
        const commonOptions = {
          agentTool: opts.agent ? parseProjectStartAgent(opts.agent) : undefined,
          toolCommand: opts.command,
          profile: opts.profile,
          sessionPolicy: parseStartSessionPolicyOptions(opts),
          windowName: opts.windowName,
          requestedWindows,
          extraWindows: parseStartWindows(opts.window),
          register: opts.register,
          importTags: splitList(opts.tags),
          importMetadata: parseJsonObject(opts.metadataJson, "--metadata-json"),
          dryRun: opts.dryRun,
          agentId,
          source: "cli" as const,
          auditCommand: process.argv.join(" "),
        };

        if (bulk) {
          const started: ProjectStartResult[] = [];
          const failed: ProjectStartFailure[] = [];
          for (const startTarget of startTargets) {
            try {
              started.push(await startProject(startTarget, {
                ...commonOptions,
                attach: false,
              }));
            } catch (err) {
              failed.push({
                target: startTarget ?? ".",
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const result: ProjectStartBulkResult = {
            bulk: true,
            dry_run: Boolean(opts.dryRun),
            total: started.length + failed.length,
            started,
            failed,
            summary: summarizeProjectStarts(started, failed),
          };
          if (wantsRenderSpec(opts)) {
            printRenderSpec(buildProjectStartBulkRender({
              dryRun: result.dry_run,
              started: result.started,
              failed: result.failed,
              summary: result.summary as unknown as Record<string, unknown>,
            }));
            if (result.summary.failed > 0) process.exitCode = 1;
            return;
          }
          if (wantsJson(opts)) { printObject(projectPayload(result), opts); return; }
          printProjectStartBulkResult(result);
          if (result.summary.failed > 0) process.exitCode = 1;
          return;
        }

        const result = await startProject(startTargets[0], {
          ...commonOptions,
          session: opts.session ?? opts.name,
          attach: opts.attach,
        });
        if (wantsRenderSpec(opts)) { printRenderSpec(result.render); return; }
        if (wantsJson(opts)) { printObject(projectPayload(result), opts); return; }

        printProjectStartResult(result, { verbose: opts.verbose, renameReport: opts.renameReport });
        if (!result.tmux.success) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerProjectCommands(program: Command): void {
  program
    .command("create")
    .description("Create or plan a project anywhere on disk")
    .requiredOption("--name <name>", "Project name")
    .option("--slug <slug>", "Project slug")
    .option("--description <text>", "Description")
    .option("--kind <kind>", `Project kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--root <id-or-slug>", "Root id or slug")
    .option("--recipe <id-or-slug>", "Recipe id or slug")
    .option("--path <path>", "Explicit primary path")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--stage <stage>", `Project stage (${PROJECT_STAGES.join(", ")})`)
    .option("--priority <priority>", `Project priority (${PROJECT_PRIORITIES.join(", ")})`)
    .option("--owner <owner>", "Project owner")
    .option("--launch-profile <id-or-slug>", "Default tmux launch profile")
    .option("--start-agent <tool>", `Default start tool (${PROJECT_START_AGENTS.join(", ")})`)
    .option("--start-command <command>", "Default command for the primary start window")
    .option("--start-session-policy <policy>", `Default tmux session policy (${PROJECT_START_SESSION_POLICIES.join(", ")})`)
    .option("--start-windows-json <json>", "Default start windows JSON array")
    .option("--todos-project-id <id>", "Linked todos project id")
    .option("--todos-task-list-id <id>", "Linked todos task list id")
    .option("--brief-id <id>", "Linked brief/spec id")
    .option("--brief-path <path>", "Linked brief/spec path")
    .option("--metadata-json <json>", "Initial metadata JSON object")
    .option("--integrations-json <json>", "Initial integrations JSON object")
    .option("--agent <id-or-slug>", "Creating agent; defaults to CLI agent")
    .option("--git-remote <url>", "Git remote URL")
    .option("--mkdir", "Create the project directory")
    .option("--git-init", "Initialize a git repository in the project directory")
    .option("--marker", "Write local project marker")
    .option("--tmux-session <name>", "Create or reuse a tmux session after creating the project")
    .option("--tmux-windows-json <json>", "JSON array of tmux windows: [{\"name\":\"editor\",\"command\":\"npm run dev\"}]")
    .option("--tmux-profile <id-or-slug>", "Apply a saved tmux profile")
    .option("--dry-run", "Preview full creation without writing DB/files/tmux")
    .option("--dry-run-runtime", "Plan directory/git/tmux runtime actions without applying them")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const agentId = resolveAgentId(opts.agent);
        const tmuxWindows = parseTmuxWindowsJson(opts.tmuxWindowsJson);
        const baseMetadata = parseJsonObject(opts.metadataJson, "--metadata-json") ?? {};
        const startWindows = parseTmuxWindowsJson(opts.startWindowsJson, "--start-windows-json");
        const managementMetadata = mergeProjectManagementMetadata(baseMetadata, {
          stage: opts.stage,
          priority: opts.priority,
          owner: opts.owner,
          launch_profile: opts.launchProfile,
          start_agent: opts.startAgent,
          start_command: opts.startCommand,
          start_session_policy: opts.startSessionPolicy,
          start_windows: startWindows,
        }) ?? baseMetadata;
        const baseIntegrations = parseIntegrationsJson(opts.integrationsJson) ?? {};
        const integrations = mergeProjectIntegrationFields(baseIntegrations, {
          todos_project_id: opts.todosProjectId,
          todos_task_list_id: opts.todosTaskListId,
          brief_id: opts.briefId,
          brief_path: opts.briefPath,
        }) ?? baseIntegrations;
        const result = executeWorkspaceCreation({
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          kind: parseKind(opts.kind),
          root_id: resolveRootId(opts.root),
          recipe_id: resolveRecipeId(opts.recipe),
          primary_path: opts.path,
          git_remote: opts.gitRemote,
          tags: splitList(opts.tags),
          integrations,
          metadata: managementMetadata,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
          createDirectory: opts.mkdir || opts.gitInit,
          gitInit: opts.gitInit,
          writeMarker: opts.marker,
          tmux: opts.tmuxSession || tmuxWindows ? { session: opts.tmuxSession, windows: tmuxWindows } : undefined,
          tmux_profile: opts.tmuxProfile,
        }, { dryRun: opts.dryRun, runtimeDryRun: opts.dryRunRuntime });
        if (wantsJson(opts)) { printObject(projectPayload(result), opts); return; }
        if (result.dry_run) {
          console.log(chalk.dim(`[dry-run] Project plan: ${result.plan.workspace.slug}`));
          if (result.plan.workspace.primary_path) console.log(`  ${chalk.dim("path:")} ${result.plan.workspace.primary_path}`);
          for (const action of result.plan.runtime_actions) {
            console.log(`  ${chalk.dim(action.type + ":")} ${action.status} ${action.target}`);
          }
          if (result.plan.tmux) console.log(`  ${chalk.dim("tmux:")} planned ${result.plan.tmux.session_name}`);
          return;
        }
        const project = result.workspace!;
        console.log(chalk.green(`✓ Project created: ${project.slug}`));
        if (project.primary_path) console.log(`  ${chalk.dim("path:")} ${project.primary_path}`);
        for (const action of result.prepare) {
          console.log(`  ${chalk.dim(action.type + ":")} ${action.status} ${action.target}`);
        }
        if (result.tmux) {
          const status = result.tmux.success ? result.tmux.session_action : "failed";
          console.log(`  ${chalk.dim("tmux:")} ${status} ${result.tmux.session_name}`);
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("import <path>")
    .description("Import an existing folder as a project")
    .option("--bulk", "Import direct child directories")
    .option("--dry-run", "Preview imports without writing project rows")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action(async (path, opts) => {
      try {
        const agentId = opts.agent ? resolveAgentId(opts.agent) : undefined;
        const result = opts.bulk
          ? await importWorkspaceBulk(path, { dryRun: opts.dryRun, tags: splitList(opts.tags), agent_id: agentId })
          : await importWorkspace(path, { dryRun: opts.dryRun, tags: splitList(opts.tags), agent_id: agentId });
        if (wantsJson(opts)) { printObject(projectPayload(result), opts); return; }
        if ("imported" in result) {
          console.log(chalk.green(`✓ Imported ${result.imported.length} project(s)`));
          if (result.previews.length) console.log(chalk.dim(`  previews: ${result.previews.length}`));
          if (result.skipped.length) console.log(chalk.dim(`  skipped: ${result.skipped.length}`));
          if (result.errors.length) console.log(chalk.yellow(`  errors: ${result.errors.length}`));
          return;
        }
        if (result.workspace) console.log(chalk.green(`✓ Imported project: ${result.workspace.slug}`));
        else if (result.preview) console.log(`${chalk.dim("[dry-run]")} ${result.preview.slug} ${result.preview.path}`);
        else console.log(chalk.yellow(result.skipped ?? result.error ?? "No import performed"));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("cleanup-create [id-or-slug]")
    .description("Safely clean up DB/files created by a project creation run")
    .option("--plan <path>", "Creation plan/execution JSON file to clean up")
    .option("--dry-run", "Preview cleanup actions without mutating DB/files")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const target = opts.plan
          ? cleanupTargetFromPlanFile(opts.plan)
          : (() => {
              if (!idOrSlug) throw new Error("Provide a project id/slug or --plan");
              const project = resolveProjectTarget(idOrSlug);
              return cleanupTargetFromWorkspace(project);
            })();
        const result = cleanupWorkspaceCreationTarget(target, {
          dryRun: opts.dryRun,
          agentId: opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id,
          source: "cli",
          command: process.argv.join(" "),
        });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(result.dry_run ? chalk.dim(`[dry-run] Cleanup ${result.workspace_slug}`) : chalk.green(`✓ Cleanup ${result.workspace_slug}`));
        for (const action of result.actions) {
          const color = action.status === "failed" ? chalk.red : action.status === "skipped" ? chalk.yellow : action.status === "planned" ? chalk.dim : chalk.green;
          console.log(`  ${color(action.status)} ${action.action} ${action.target}${action.message ? chalk.dim(` - ${action.message}`) : ""}`);
        }
        if (!result.success) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("import-github <repo>")
    .description("Import a GitHub repository as a project")
    .option("--root <id-or-slug>", "Root id or slug used for path derivation")
    .option("--path <path>", "Explicit clone/import path")
    .option("--clone", "Clone the repository before registering the project")
    .option("--remote-only", "Register a remote-only project without a local path")
    .option("--kind <kind>", `Project kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--tags <tags>", "Comma-separated tags")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("--remote-protocol <protocol>", "Git remote protocol: https or ssh")
    .option("--dry-run", "Preview the import without cloning or writing DB rows")
    .option("-j, --json", "Output JSON")
    .action(async (repo, opts) => {
      try {
        const result = await importWorkspaceFromGitHub(repo, {
          root: opts.root,
          path: opts.path,
          clone: opts.clone,
          remoteOnly: opts.remoteOnly,
          kind: parseKind(opts.kind),
          tags: splitList(opts.tags),
          remoteProtocol: parseGitHubRemoteProtocol(opts.remoteProtocol),
          dryRun: Boolean(opts.dryRun),
          agent_id: opts.agent ? resolveAgentId(opts.agent) : undefined,
          source: "cli",
          command: process.argv.join(" "),
        });
        if (wantsJson(opts)) { printObject(projectPayload(result), opts); return; }
        if (result.status === "planned") {
          console.log(chalk.dim(`[dry-run] GitHub import: ${result.full_name}`));
          if (result.path) console.log(`  ${chalk.dim("path:")} ${result.path}`);
          return;
        }
        if (result.status === "skipped") {
          console.log(chalk.yellow(`Skipped: ${result.skipped}`));
          return;
        }
        console.log(chalk.green(`✓ Imported GitHub project: ${result.workspace?.slug ?? result.full_name}`));
        if (result.path) console.log(`  ${chalk.dim("path:")} ${result.path}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("scan-roots")
    .description("Dry-run import plans for repositories in configured GitHub roots")
    .option("--root <id-or-slug>", "Only scan one configured root")
    .option("--repo-prefix <prefix>", "Only include repositories with this name prefix")
    .option("--limit <n>", "Maximum GitHub repositories to list per root", "500")
    .option("--tags <tags>", "Comma-separated tags to apply")
    .option("--clone", "Include clone commands in the dry-run plan")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("--remote-protocol <protocol>", "Git remote protocol: https or ssh")
    .option("-j, --json", "Output JSON")
    .action(async (opts) => {
      try {
        const limit = parsePositiveInteger(opts.limit, "--limit") ?? 500;
        const result = await syncWorkspaceGitHubRoots({
          root: opts.root,
          repoPrefix: opts.repoPrefix,
          limit,
          clone: opts.clone,
          tags: splitList(opts.tags),
          remoteProtocol: parseGitHubRemoteProtocol(opts.remoteProtocol),
          dryRun: true,
          agent_id: opts.agent ? resolveAgentId(opts.agent) : undefined,
          source: "cli",
          command: process.argv.join(" "),
        });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(chalk.dim(`[dry-run] Scanned ${result.roots.length} GitHub root(s), ${result.planned.length} repo plan(s)`));
        if (result.errors.length) console.log(chalk.yellow(`  errors: ${result.errors.length}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("sync-roots")
    .description("Import and optionally clone repositories from configured GitHub roots")
    .option("--root <id-or-slug>", "Only sync one configured root")
    .option("--repo-prefix <prefix>", "Only include repositories with this name prefix")
    .option("--limit <n>", "Maximum GitHub repositories to list per root", "500")
    .option("--tags <tags>", "Comma-separated tags to apply")
    .option("--clone", "Clone repositories while importing", true)
    .option("--no-clone", "Register repositories without cloning")
    .option("--dry-run", "Preview imports without cloning or writing")
    .option("--allow-partial", "Exit successfully even if some repositories fail")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("--remote-protocol <protocol>", "Git remote protocol: https or ssh")
    .option("-j, --json", "Output JSON")
    .action(async (opts) => {
      try {
        const limit = parsePositiveInteger(opts.limit, "--limit") ?? 500;
        const result = await syncWorkspaceGitHubRoots({
          root: opts.root,
          repoPrefix: opts.repoPrefix,
          limit,
          clone: opts.clone,
          tags: splitList(opts.tags),
          remoteProtocol: parseGitHubRemoteProtocol(opts.remoteProtocol),
          dryRun: opts.dryRun,
          agent_id: opts.agent ? resolveAgentId(opts.agent) : undefined,
          source: "cli",
          command: process.argv.join(" "),
        });
        if (wantsJson(opts)) {
          printObject(result, opts);
          if (result.errors.length && !opts.allowPartial) process.exitCode = 1;
          return;
        }
        console.log(chalk.green(`✓ Synced ${result.imported.length} GitHub project(s)`));
        if (result.planned.length) console.log(chalk.dim(`  planned: ${result.planned.length}`));
        if (result.skipped.length) console.log(chalk.dim(`  skipped: ${result.skipped.length}`));
        if (result.errors.length) console.log(chalk.yellow(`  errors: ${result.errors.length}`));
        if (result.errors.length && !opts.allowPartial) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
  program
    .command("agent-eval")
    .description("Run project prompt-agent eval cases")
    .option("--mock", "Use deterministic mock mode instead of a live model")
    .option("--model <model>", "OpenRouter model")
    .option("--max-steps <n>", "Maximum AI SDK tool-call steps per case", "8")
    .option("--case <ids>", "Comma-separated eval case ids")
    .option("--base-path <path>", "Base path for eval fixtures")
    .option("--fail-on-error", "Exit nonzero if any executed eval case fails")
    .option("-j, --json", "Output JSON")
    .action(async (opts) => {
      try {
        const maxSteps = Number.parseInt(opts.maxSteps, 10);
        if (!Number.isInteger(maxSteps) || maxSteps <= 0) throw new Error("--max-steps must be a positive integer");
        const result = await runWorkspaceAgentEval({
          mock: opts.mock,
          model: opts.model,
          maxSteps,
          caseIds: parseWorkspaceAgentEvalCaseIds(opts.case),
          basePath: opts.basePath,
        });
        if (wantsJson(opts)) {
          printObject(result, opts);
        } else {
          const rate = `${Math.round(result.summary.success_rate * 100)}%`;
          const confidence = `${Math.round(result.summary.confidence * 100)}%`;
          console.log(`${result.summary.failed === 0 ? chalk.green("✓") : chalk.red("✗")} agent eval ${rate} success, ${confidence} confidence`);
          console.log(`  ${chalk.dim("executed:")} ${result.summary.executed}`);
          console.log(`  ${chalk.dim("passed:")}   ${result.summary.passed}`);
          console.log(`  ${chalk.dim("failed:")}   ${result.summary.failed}`);
          console.log(`  ${chalk.dim("skipped:")}  ${result.summary.skipped}`);
          for (const item of result.cases) {
            const status = item.skipped ? chalk.dim("skipped") : item.passed ? chalk.green("pass") : chalk.red("fail");
            console.log(`  ${status} ${item.id}`);
          }
        }
        if (opts.failOnError && result.summary.failed > 0) process.exit(1);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("cleanup-evals")
    .description("Preview or remove prompt-agent eval fixture records from the project registry")
    .option("--dry-run", "Preview eval artifacts without deleting them", true)
    .option("--apply", "Delete eval artifacts")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const result = cleanupProjectEvalArtifacts({
          dryRun: !opts.apply,
          agentId: opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id,
          source: "cli",
          command: process.argv.join(" "),
        });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        const total = result.projects.length
          + result.supporting.roots.length
          + result.supporting.recipes.length
          + result.supporting.agents.length
          + result.supporting.tmux_profiles.length;
        console.log(result.dry_run ? chalk.dim(`[dry-run] Eval artifacts found: ${total}`) : chalk.green(`✓ Eval artifacts removed: ${Object.values(result.deleted).reduce((sum, count) => sum + count, 0)}`));
        if (result.projects.length) console.log(`  ${chalk.dim("projects:")} ${result.projects.map((item) => item.slug).join(", ")}`);
        if (result.supporting.roots.length) console.log(`  ${chalk.dim("roots:")} ${result.supporting.roots.map((item) => item.slug).join(", ")}`);
        if (result.supporting.recipes.length) console.log(`  ${chalk.dim("recipes:")} ${result.supporting.recipes.map((item) => item.slug).join(", ")}`);
        if (result.supporting.agents.length) console.log(`  ${chalk.dim("agents:")} ${result.supporting.agents.map((item) => item.slug).join(", ")}`);
        if (result.supporting.tmux_profiles.length) console.log(`  ${chalk.dim("tmux profiles:")} ${result.supporting.tmux_profiles.map((item) => item.slug).join(", ")}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("list")
    .description("List registered projects")
    .option("--kind <kind>", "Filter by kind")
    .option("--status <status>", "Filter by status")
    .option("--query <text>", "Search name, slug, description, path, tags, integrations, or metadata")
    .option("--tags <tags>", "Comma-separated tag filter")
    .option("--include-evals", "Include prompt-agent eval fixture projects")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Show additional columns in terminal output")
    .option("--render-spec", "Output a JSON Render spec")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const json = wantsJson(opts);
        const baseFilter = {
          kind: parseKind(opts.kind),
          status: parseStatus(opts.status),
          query: opts.query,
          tags: splitList(opts.tags),
        };
        if (wantsRenderSpec(opts)) {
          const projects = filterProjectEvalArtifacts(listWorkspaces({
            ...baseFilter,
            exclude_eval_artifacts: !opts.includeEvals,
            limit: parsePositiveInteger(opts.limit, "--limit"),
          }), opts.includeEvals);
          printRenderSpec(buildProjectListRender(projects));
          return;
        }
        if (json) {
          const projects = filterProjectEvalArtifacts(listWorkspaces({
            ...baseFilter,
            exclude_eval_artifacts: !opts.includeEvals,
            limit: parsePositiveInteger(opts.limit, "--limit"),
          }), opts.includeEvals);
          printObject(projects.map(projectWithManagement), opts);
          return;
        }
        const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
        const projects = filterProjectEvalArtifacts(listWorkspaces({
          ...baseFilter,
          exclude_eval_artifacts: !opts.includeEvals,
          limit: limit + 1,
        }), opts.includeEvals);
        const visible = projects.slice(0, limit);
        const hasMore = projects.length > limit;
        printRows(visible.map((project) => {
          const management = projectManagementSummary(project);
          const externalLinks = projectExternalLinksSummary(project);
          const dashboard = projectDashboardSummary(project);
          const base = {
            slug: project.slug,
            status: project.status,
            stage: management.stage ?? "",
            priority: management.priority ?? "",
            health: dashboard.path_health.status,
            path: compactText(project.primary_path, opts.verbose ? 96 : 56),
          };
          if (!opts.verbose) return base;
          return {
            ...base,
            kind: project.kind,
            owner: management.owner ?? "",
            tags: compactText(project.tags.join(","), 40),
            todos: externalLinks.todos.project_id ?? externalLinks.todos.task_list_id ?? "",
            brief: externalLinks.brief.id ?? externalLinks.brief.path ?? "",
            last_opened: dashboard.launch.last_opened_at ?? "",
          };
        }), opts.verbose
          ? ["slug", "status", "stage", "priority", "health", "path", "kind", "owner", "tags", "todos", "brief", "last_opened"]
          : ["slug", "status", "stage", "priority", "health", "path"]);
        const more = hasMore ? ` Showing ${visible.length} of more than ${limit} matching projects.` : ` Showing ${visible.length} project(s).`;
        printDiscoveryHint(`${more} Use --limit <n>, --verbose, --json, or 'projects show <slug>' for details.`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("show <id-or-slug>")
    .alias("get")
    .description("Show project details")
    .option("--verbose", "Show registered locations, agents, and a longer event summary")
    .option("--render-spec", "Output a JSON Render spec")
    .option("-j, --json", "Output JSON")
    .action(async (idOrSlug, opts) => {
      const project = resolveProjectTarget(idOrSlug);
      const dashboard = projectDashboardSummary(project);
      const agents = listWorkspaceAgents(project.id);
      const locations = listWorkspaceLocations(project.id);
      const events = listWorkspaceEvents(project.id);
      const payload = buildProjectDetailPayload({ project, agents, locations, events });
      if (wantsRenderSpec(opts)) { printRenderSpec(payload.render); return; }
      if (wantsJson(opts)) { printObject(withoutRender(payload), opts); return; }
      console.log(`${chalk.bold(project.name)} ${chalk.dim(`(${project.slug})`)} ${chalk.green(`[${project.status}]`)}`);
      console.log(`  ${chalk.dim("id:")}   ${project.id}`);
      console.log(`  ${chalk.dim("kind:")} ${project.kind}`);
      const management = projectManagementSummary(project);
      const externalLinks = projectExternalLinksSummary(project);
      const duplicateNames = listWorkspaces({ query: project.name, limit: 100 })
        .filter((item) => item.id !== project.id && item.name.trim().toLowerCase() === project.name.trim().toLowerCase());
      if (management.stage) console.log(`  ${chalk.dim("stage:")} ${management.stage}`);
      if (management.priority) console.log(`  ${chalk.dim("priority:")} ${management.priority}`);
      if (management.owner) console.log(`  ${chalk.dim("owner:")} ${management.owner}`);
      if (management.launch_profile) console.log(`  ${chalk.dim("launch profile:")} ${management.launch_profile}`);
      if (management.start_agent) console.log(`  ${chalk.dim("start agent:")} ${management.start_agent}`);
      if (management.start_command) console.log(`  ${chalk.dim("start command:")} ${opts.verbose ? management.start_command : compactText(management.start_command, 140)}`);
      if (management.start_session_policy) console.log(`  ${chalk.dim("start session policy:")} ${management.start_session_policy}`);
      if (management.start_windows.length) {
        const startWindows = management.start_windows.map((window) => window.name).join(", ");
        console.log(`  ${chalk.dim("start windows:")} ${opts.verbose ? startWindows : compactText(startWindows, 100)}`);
      }
      if (project.primary_path) console.log(`  ${chalk.dim("path:")} ${opts.verbose ? project.primary_path : compactText(project.primary_path, 160)}`);
      console.log(`  ${chalk.dim("path health:")} ${dashboard.path_health.status}${dashboard.path_health.exists === false ? " (missing)" : ""}`);
      if (dashboard.launch.last_opened_at) console.log(`  ${chalk.dim("last opened:")} ${dashboard.launch.last_opened_at}`);
      if (project.tags.length) {
        const tags = project.tags.join(", ");
        console.log(`  ${chalk.dim("tags:")} ${opts.verbose ? tags : compactText(tags, 120)}`);
      }
      if (agents.length) {
        const agentLabels = agents.map((assignment) => `${assignment.agent?.slug ?? assignment.agent_id}:${assignment.role}`);
        const visibleAgents = opts.verbose ? agentLabels : agentLabels.slice(0, 10);
        console.log(`  ${chalk.dim("agents:")} ${compactText(visibleAgents.join(", "), opts.verbose ? 240 : 120)}${!opts.verbose && agentLabels.length > visibleAgents.length ? chalk.dim(` (+${agentLabels.length - visibleAgents.length} more)`) : ""}`);
      }
      console.log(`  ${chalk.dim("locations:")} ${locations.length} registered${locations.length > 1 ? chalk.dim(" (use --verbose for paths)") : ""}`);
      if (duplicateNames.length) console.log(`  ${chalk.yellow("warning:")} duplicate project name also used by ${duplicateNames.map((item) => item.slug).join(", ")}`);
      if (externalLinks.todos.linked) {
        console.log(`  ${chalk.dim("todos:")} ${externalLinks.todos.project_id ?? "none"}${externalLinks.todos.task_list_id ? ` task-list=${externalLinks.todos.task_list_id}` : ""}`);
      }
      if (externalLinks.brief.linked) {
        const briefTarget = externalLinks.brief.id ?? externalLinks.brief.path;
        console.log(`  ${chalk.dim("brief:")} ${opts.verbose ? briefTarget : compactText(briefTarget, 120)}${externalLinks.brief.path_exists === false ? " (path missing)" : ""}`);
      }
      try {
        const tmux = await projectTmuxStatus(project.slug);
        if (tmux.tmux_available) {
          console.log(`  ${chalk.dim("current session:")} ${tmux.exists ? "running" : "missing"} ${tmux.expected.session_name}${tmux.session ? ` windows=${tmux.session.windows}` : ""}`);
        } else if (tmux.errors.length) {
          console.log(`  ${chalk.dim("tmux:")} unavailable (${tmux.errors[0]})`);
        }
      } catch (err) {
        console.log(`  ${chalk.dim("tmux:")} ${err instanceof Error ? err.message : String(err)}`);
      }
      const recentEvents = events.slice(-3).reverse();
      if (recentEvents.length) {
        console.log(`  ${chalk.dim("recent events:")} ${recentEvents.map((event) => `${event.event_type}@${event.created_at}`).join(", ")}`);
      }
      if (opts.verbose) {
        if (locations.length) {
          for (const location of locations) {
            console.log(`  ${chalk.dim("location:")} ${location.is_primary ? "primary " : ""}${location.label} ${compactText(location.path, 100)}`);
          }
        }
        const verboseEvents = events.slice(-10).reverse();
        for (const event of verboseEvents) {
          console.log(`  ${chalk.dim("event:")} ${event.event_type} ${event.source} ${event.created_at}${event.command ? chalk.dim(` ${compactText(event.command, 80)}`) : ""}`);
        }
      }
      printDiscoveryHint(`  Use --json for the full project record${opts.verbose ? "." : ", or --verbose for locations and more recent events."}`);
    });

  const events = program.command("events").description("Inspect and record project audit events");

  events
    .command("list <project>")
    .description("List audit events for a project")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_EVENT_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Include compact prompt, command, and metadata-key columns")
    .option("-j, --json", "Output JSON")
    .action((projectTarget, opts) => {
      try {
        const project = resolveProjectTarget(projectTarget);
        const events = listWorkspaceEvents(project.id);
        const payload = { project: projectWithManagement(project), events };
        if (wantsJson(opts)) { printObject(payload, opts); return; }
        const limit = parseHumanLimit(opts.limit, DEFAULT_EVENT_LIMIT);
        const visible = events.slice(-limit).reverse();
        printRows(visible.map((event) => eventSummary(event, Boolean(opts.verbose))), opts.verbose
          ? ["id", "event_type", "source", "agent_id", "created_at", "prompt", "command", "metadata"]
          : ["id", "event_type", "source", "agent_id", "created_at"]);
        const hidden = Math.max(0, events.length - visible.length);
        printDiscoveryHint(`Showing latest ${visible.length} of ${events.length} event(s).${hidden ? ` ${hidden} older hidden.` : ""} Use --limit <n>, --verbose, or --json for details.`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  events
    .command("record <project> <type>")
    .description("Record a custom project audit event")
    .option("--metadata-json <json>", "Event metadata JSON object")
    .option("--before-json <json>", "Before-state JSON object")
    .option("--after-json <json>", "After-state JSON object")
    .option("--prompt <text>", "Prompt or note that led to this event")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((projectTarget, type, opts) => {
      try {
        const project = resolveProjectTarget(projectTarget);
        const event = recordWorkspaceEvent({
          workspace_id: project.id,
          agent_id: opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id,
          event_type: type,
          source: "cli",
          prompt: opts.prompt,
          command: process.argv.join(" "),
          before: parseJsonObject(opts.beforeJson, "--before-json"),
          after: parseJsonObject(opts.afterJson, "--after-json"),
          metadata: parseJsonObject(opts.metadataJson, "--metadata-json"),
        });
        const payload = { project: projectWithManagement(project), event };
        if (wantsJson(opts)) { printObject(payload, opts); return; }
        console.log(chalk.green(`✓ Project event recorded: ${event.event_type}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("update <id-or-slug>")
    .description("Update project metadata")
    .option("--name <name>", "Project name")
    .option("--slug <slug>", "Project slug")
    .option("--description <text>", "Description")
    .option("--kind <kind>", `Project kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--status <status>", `Project status (${WORKSPACE_STATUSES.join(", ")})`)
    .option("--root <id-or-slug>", "Root id or slug")
    .option("--clear-root", "Clear root")
    .option("--recipe <id-or-slug>", "Recipe id or slug")
    .option("--clear-recipe", "Clear recipe")
    .option("--path <path>", "Primary path")
    .option("--clear-path", "Clear primary path")
    .option("--tags <tags>", "Replace tags with comma-separated tags")
    .option("--stage <stage>", `Project stage (${PROJECT_STAGES.join(", ")})`)
    .option("--clear-stage", "Clear project stage")
    .option("--priority <priority>", `Project priority (${PROJECT_PRIORITIES.join(", ")})`)
    .option("--clear-priority", "Clear project priority")
    .option("--owner <owner>", "Project owner")
    .option("--clear-owner", "Clear project owner")
    .option("--launch-profile <id-or-slug>", "Default tmux launch profile")
    .option("--clear-launch-profile", "Clear default tmux launch profile")
    .option("--start-agent <tool>", `Default start tool (${PROJECT_START_AGENTS.join(", ")})`)
    .option("--clear-start-agent", "Clear default start tool")
    .option("--start-command <command>", "Default command for the primary start window")
    .option("--clear-start-command", "Clear default command for the primary start window")
    .option("--start-session-policy <policy>", `Default tmux session policy (${PROJECT_START_SESSION_POLICIES.join(", ")})`)
    .option("--clear-start-session-policy", "Clear default tmux session policy")
    .option("--start-windows-json <json>", "Replace default start windows with a JSON array")
    .option("--clear-start-windows", "Clear default start windows")
    .option("--todos-project-id <id>", "Linked todos project id")
    .option("--clear-todos-project-id", "Clear linked todos project id")
    .option("--todos-task-list-id <id>", "Linked todos task list id")
    .option("--clear-todos-task-list-id", "Clear linked todos task list id")
    .option("--brief-id <id>", "Linked brief/spec id")
    .option("--clear-brief-id", "Clear linked brief/spec id")
    .option("--brief-path <path>", "Linked brief/spec path")
    .option("--clear-brief-path", "Clear linked brief/spec path")
    .option("--git-remote <url>", "Git remote URL")
    .option("--clear-git-remote", "Clear git remote")
    .option("--s3-bucket <bucket>", "S3 bucket")
    .option("--clear-s3-bucket", "Clear S3 bucket")
    .option("--s3-prefix <prefix>", "S3 prefix")
    .option("--clear-s3-prefix", "Clear S3 prefix")
    .option("--integrations-json <json>", "Replace integrations with a JSON object")
    .option("--metadata-json <json>", "Replace metadata with a JSON object")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const metadataBase = opts.metadataJson === undefined
          ? project.metadata
          : parseJsonObject(opts.metadataJson, "--metadata-json") ?? {};
        const startWindows = opts.clearStartWindows
          ? null
          : parseTmuxWindowsJson(opts.startWindowsJson, "--start-windows-json");
        const metadataFields = {
          stage: opts.clearStage ? null : opts.stage,
          priority: opts.clearPriority ? null : opts.priority,
          owner: opts.clearOwner ? null : opts.owner,
          launch_profile: opts.clearLaunchProfile ? null : opts.launchProfile,
          start_agent: opts.clearStartAgent ? null : opts.startAgent,
          start_command: opts.clearStartCommand ? null : opts.startCommand,
          start_session_policy: opts.clearStartSessionPolicy ? null : opts.startSessionPolicy,
          start_windows: startWindows,
        };
        const mergedMetadata = hasProjectManagementFields(metadataFields)
          ? mergeProjectManagementMetadata(metadataBase, metadataFields)
          : opts.metadataJson === undefined ? undefined : metadataBase;
        const integrationsBase = opts.integrationsJson === undefined
          ? project.integrations
          : parseIntegrationsJson(opts.integrationsJson) ?? {};
        const integrationFields = {
          todos_project_id: opts.clearTodosProjectId ? null : opts.todosProjectId,
          todos_task_list_id: opts.clearTodosTaskListId ? null : opts.todosTaskListId,
          brief_id: opts.clearBriefId ? null : opts.briefId,
          brief_path: opts.clearBriefPath ? null : opts.briefPath,
        };
        const mergedIntegrations = hasProjectIntegrationFields(integrationFields)
          ? mergeProjectIntegrationFields(integrationsBase, integrationFields)
          : opts.integrationsJson === undefined ? undefined : integrationsBase;
        const updated = withWorkspaceLock(project, agentId, "project update", () => updateWorkspace(project.id, {
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          kind: parseKind(opts.kind),
          status: parseStatus(opts.status),
          root_id: opts.clearRoot ? null : resolveRootId(opts.root),
          recipe_id: opts.clearRecipe ? null : resolveRecipeId(opts.recipe),
          primary_path: opts.clearPath ? null : opts.path,
          tags: opts.tags === undefined ? undefined : splitList(opts.tags),
          git_remote: opts.clearGitRemote ? null : opts.gitRemote,
          s3_bucket: opts.clearS3Bucket ? null : opts.s3Bucket,
          s3_prefix: opts.clearS3Prefix ? null : opts.s3Prefix,
          integrations: mergedIntegrations,
          metadata: mergedMetadata,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(updated, opts); return; }
        console.log(chalk.green(`✓ Project updated: ${updated.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("tag <id-or-slug> <tags...>")
    .description("Add tags to a project")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, tags, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const requestedTags = splitVariadicList(tags);
        if (requestedTags.length === 0) throw new Error("Provide at least one tag");
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const updated = withWorkspaceLock(project, agentId, "project tag", () => updateWorkspace(project.id, {
          tags: mergeProjectTags(project.tags, requestedTags),
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(projectWithManagement(updated), opts); return; }
        console.log(chalk.green(`✓ Tagged project: ${updated.slug} (${updated.tags.join(", ")})`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("untag <id-or-slug> <tags...>")
    .description("Remove tags from a project")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, tags, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const requestedTags = splitVariadicList(tags);
        if (requestedTags.length === 0) throw new Error("Provide at least one tag");
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const updated = withWorkspaceLock(project, agentId, "project untag", () => updateWorkspace(project.id, {
          tags: removeProjectTags(project.tags, requestedTags),
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(projectWithManagement(updated), opts); return; }
        console.log(chalk.green(`✓ Removed tags from project: ${updated.slug} (${updated.tags.join(", ")})`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("link <id-or-slug>")
    .description("Merge external integration IDs into a project")
    .option("--github-repo <name>", "GitHub full name, such as org/repo")
    .option("--github-url <url>", "GitHub repository URL")
    .option("--todos-project-id <id>", "Todos project id")
    .option("--todos-task-list-id <id>", "Todos task list id")
    .option("--brief-id <id>", "Brief/spec id")
    .option("--brief-path <path>", "Brief/spec path")
    .option("--mementos-project-id <id>", "Mementos project id")
    .option("--conversations-space <space>", "Conversations space")
    .option("--files-index-id <id>", "Files index id")
    .option("--integration <key=value>", "Additional integration key=value", collectOption, [])
    .option("--integrations-json <json>", "Additional integrations JSON object")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const integrations = mergeIntegrations(
          {
            github_repo: opts.githubRepo,
            github_url: opts.githubUrl,
            todos_project_id: opts.todosProjectId,
            todos_task_list_id: opts.todosTaskListId,
            brief_id: opts.briefId,
            brief_path: opts.briefPath,
            mementos_project_id: opts.mementosProjectId,
            conversations_space: opts.conversationsSpace,
            files_index_id: opts.filesIndexId,
          },
          parseIntegrationPairs(opts.integration),
          parseIntegrationsJson(opts.integrationsJson),
        );
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const updated = withWorkspaceLock(project, agentId, "project integration link", () => linkWorkspaceExternalIntegrations(project, integrations, {
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(updated, opts); return; }
        console.log(chalk.green(`✓ Linked integrations for ${updated.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("unlink <id-or-slug>")
    .description("Clear external integration IDs from a project")
    .option("--github", "Clear GitHub repo and URL links")
    .option("--todos", "Clear todos project and task-list links")
    .option("--brief", "Clear brief/spec id and path links")
    .option("--mementos", "Clear mementos project link")
    .option("--conversations", "Clear conversations space link")
    .option("--files", "Clear files index link")
    .option("--key <key>", "Integration key or group to clear; repeatable", collectOption, [])
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const requestedKeys = [
          ...(opts.github ? ["github"] : []),
          ...(opts.todos ? ["todos"] : []),
          ...(opts.brief ? ["brief"] : []),
          ...(opts.mementos ? ["mementos"] : []),
          ...(opts.conversations ? ["conversations"] : []),
          ...(opts.files ? ["files"] : []),
          ...(opts.key ?? []),
        ];
        const expandedKeys = expandProjectIntegrationUnlinkKeys(requestedKeys);
        if (expandedKeys.length === 0) throw new Error("Provide at least one integration key or group to unlink");
        const nextIntegrations = unlinkProjectIntegrationFields(project.integrations, requestedKeys);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const updated = withWorkspaceLock(project, agentId, "project integration unlink", () => updateWorkspace(project.id, {
          integrations: nextIntegrations,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject({ project: projectWithManagement(updated), unlinked: expandedKeys }, opts); return; }
        console.log(chalk.green(`✓ Unlinked integrations for ${updated.slug}: ${expandedKeys.join(", ")}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("publish <id-or-slug>")
    .description("Plan or publish a project to GitHub")
    .option("--org <org>", "GitHub organization or owner")
    .option("--repo <name>", "GitHub repository name")
    .option("--visibility <visibility>", "Repository visibility: public or private")
    .option("--description <text>", "Repository description")
    .option("--remote-protocol <protocol>", "Git remote protocol: https or ssh")
    .option("--no-push", "Create/update the repository without pushing the current branch")
    .option("--dry-run", "Preview GitHub and git actions without mutating")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const publish = () => publishWorkspaceToGitHub(project, {
          org: opts.org,
          repoName: opts.repo,
          visibility: parseGitHubVisibility(opts.visibility),
          description: opts.description,
          remoteProtocol: parseGitHubRemoteProtocol(opts.remoteProtocol),
          push: opts.push,
          dryRun: opts.dryRun,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        });
        const result = opts.dryRun
          ? publish()
          : withWorkspaceLock(project, agentId, "project GitHub publish", publish);
        if (wantsJson(opts)) { printObject(projectPayload(result), opts); return; }
        const marker = result.dry_run ? chalk.dim("[dry-run]") : chalk.green("✓");
        console.log(`${marker} GitHub publish ${result.full_name}`);
        console.log(`  ${chalk.dim("visibility:")} ${result.visibility}`);
        console.log(`  ${chalk.dim("remote:")} ${result.remote}`);
        for (const command of result.commands) console.log(`  ${chalk.dim("cmd:")} ${command}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("unpublish <id-or-slug>")
    .description("Remove local GitHub publication metadata from a project")
    .option("--clear-integrations", "Remove stored GitHub integration fields")
    .option("--dry-run", "Preview changes without mutating")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const unpublish = () => unpublishWorkspaceFromGitHub(project, {
          clearIntegrations: opts.clearIntegrations,
          dryRun: opts.dryRun,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        });
        const result = opts.dryRun
          ? unpublish()
          : withWorkspaceLock(project, agentId, "project GitHub unpublish", unpublish);
        if (wantsJson(opts)) { printObject(projectPayload(result), opts); return; }
        const marker = result.dry_run ? chalk.dim("[dry-run]") : chalk.green("✓");
        console.log(`${marker} GitHub unpublish ${project.slug}`);
        if (result.local_path) console.log(`  ${chalk.dim("path:")} ${result.local_path}`);
        console.log(`  ${chalk.dim("remote removed:")} ${result.remote_removed}`);
        console.log(`  ${chalk.dim("integrations cleared:")} ${result.integrations_cleared}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("archive <id-or-slug>")
    .description("Archive a project")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const archived = withWorkspaceLock(project, agentId, "project archive", () => archiveWorkspace(project.id, {
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(archived, opts); return; }
        console.log(chalk.green(`✓ Archived ${archived.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("unarchive <id-or-slug>")
    .description("Unarchive a project")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const unarchived = withWorkspaceLock(project, agentId, "project unarchive", () => unarchiveWorkspace(project.id, {
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(unarchived, opts); return; }
        console.log(chalk.green(`✓ Unarchived ${unarchived.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("delete <id-or-slug>")
    .description("Mark a project deleted, or hard-delete the row with --hard")
    .option("--hard", "Hard-delete the project row")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const result = withWorkspaceLock(project, agentId, "project delete", () => deleteWorkspace(project.id, {
          hard: opts.hard,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(projectPayload(result), opts); return; }
        console.log(result.hard ? chalk.yellow(`Deleted ${result.workspace.slug}`) : chalk.green(`✓ Marked deleted ${result.workspace.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("lock <id-or-slug>")
    .description("Acquire an explicit project mutation lock")
    .option("--key <key>", "Lock key; defaults to the project's mutation lock")
    .option("--reason <text>", "Lock reason", "manual project lock")
    .option("--ttl-seconds <seconds>", "Lock TTL in seconds")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(idOrSlug);
        const lock = acquireWorkspaceLock({
          lock_key: opts.key ?? `workspace:${project.id}`,
          workspace_id: project.id,
          agent_id: opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id,
          reason: opts.reason,
          ttl_seconds: parsePositiveInteger(opts.ttlSeconds, "--ttl-seconds"),
        });
        if (wantsJson(opts)) { printObject(projectLockPayload(lock), opts); return; }
        console.log(chalk.green(`✓ Project lock acquired: ${lock.lock_key}`));
      } catch (err) {
        const message = err instanceof Error ? err.message.replace("Workspace lock", "Project lock") : String(err);
        console.error(chalk.red(message));
        process.exit(1);
      }
    });

  program
    .command("locks")
    .description("List active project mutation locks")
    .option("--project <id-or-slug>", "Filter by project")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const project = opts.project
          ? (() => {
              return resolveProjectTarget(opts.project);
            })()
          : null;
        const locks = listWorkspaceLocks()
          .filter((lock) => !project || lock.workspace_id === project.id)
          .map(projectLockPayload);
        if (wantsJson(opts)) { printObject(locks, opts); return; }
        const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
        const visible = locks.slice(0, limit);
        printRows(visible.map((lock) => ({
          lock_key: lock.lock_key,
          project_id: lock.project_id ?? "",
          agent_id: lock.agent_id ?? "",
          reason: compactText(lock.reason, 80),
          expires_at: lock.expires_at ?? "",
        })), ["lock_key", "project_id", "agent_id", "reason", "expires_at"]);
        printDiscoveryHint(`Showing ${visible.length} of ${locks.length} lock(s). Use --limit <n> or --json for full records.`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  program
    .command("unlock <key>")
    .description("Release a project mutation lock")
    .option("-j, --json", "Output JSON")
    .action((key, opts) => {
      const released = releaseWorkspaceLock(key);
      if (wantsJson(opts)) { printObject({ released }, opts); return; }
      console.log(released ? chalk.green(`✓ Project lock released: ${key}`) : chalk.yellow(`No project lock found: ${key}`));
    });

  program
    .command("doctor [id-or-slug]")
    .description("Validate project markers, paths, locations, references, and failed runs")
    .option("--fix", "Apply safe fixes")
    .option("--dry-run", "Preview fixes without writing")
    .option("--limit <n>", `Max projects for terminal output when no project is provided (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Show every check instead of only issue counts")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      const runDoctor = (project: Workspace) => opts.fix && !opts.dryRun
        ? withWorkspaceLock(project, ensureCliAgent().id, "project doctor fix", () => doctorWorkspace(project, { fix: opts.fix, dryRun: opts.dryRun }))
        : doctorWorkspace(project, { fix: opts.fix, dryRun: opts.dryRun });
      try {
        const json = wantsJson(opts);
        const limit = json ? undefined : parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
        const results = idOrSlug
          ? (() => {
              const project = resolveProjectTarget(idOrSlug);
              return [runDoctor(project)];
            })()
          : listWorkspaces({ limit: json ? undefined : limit! + 1 }).map(runDoctor);
        if (json) { printObject(results, opts); return; }
        const visible = idOrSlug ? results : results.slice(0, limit);
        for (const result of visible) {
          console.log(`${chalk.bold(result.workspace.slug)} ${result.ok ? chalk.green("[ok]") : chalk.yellow("[needs attention]")}`);
          const checks = opts.verbose ? result.checks : result.checks.filter((check) => check.status !== "ok");
          if (!opts.verbose && checks.length === 0) {
            const okCount = result.checks.filter((check) => check.status === "ok").length;
            console.log(`  ${chalk.dim("checks:")} ${okCount} ok`);
          }
          for (const check of checks) {
            const color = check.status === "ok" ? chalk.green : check.status === "error" ? chalk.red : chalk.yellow;
            console.log(`  ${color(check.status)} ${check.code} ${chalk.dim(compactText(check.message, 140))}`);
          }
        }
        if (!idOrSlug) {
          const hasMore = results.length > visible.length;
          printDiscoveryHint(`${hasMore ? `Showing ${visible.length} of more than ${limit} checked project(s).` : `Showing ${visible.length} checked project(s).`} Use --limit <n>, --verbose, --json, or 'projects doctor <slug>' for details.`);
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerLocationsCommand(program: Command): void {
  const cmd = program.command("locations").description("Manage project folder locations");

  cmd
    .command("list <project>")
    .description("List registered folder locations for a project")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Show full paths and location metadata keys")
    .option("-j, --json", "Output JSON")
    .action((projectIdOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(projectIdOrSlug);
        const locations = listWorkspaceLocations(project.id);
        if (wantsJson(opts)) { printObject({ project: projectWithManagement(project), locations }, opts); return; }
        const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
        const visible = locations.slice(0, limit);
        printRows(visible.map((location) => ({
          path: opts.verbose ? location.path : compactText(location.path, 100),
          label: location.label,
          kind: location.kind,
          primary: location.is_primary ? "yes" : "no",
          machine: location.machine_id,
          ...(opts.verbose ? { metadata: Object.keys(location.metadata).join(",") } : {}),
        })), opts.verbose ? ["path", "label", "kind", "primary", "machine", "metadata"] : ["path", "label", "kind", "primary", "machine"]);
        printDiscoveryHint(`Showing ${visible.length} of ${locations.length} location(s). Use --limit <n>, --verbose, or --json for full records.`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("add <project> <path>")
    .description("Register another folder location for a project")
    .option("--label <label>", "Location label", "main")
    .option("--kind <kind>", "Location kind", "local")
    .option("--primary", "Make this the primary project path")
    .option("--metadata-json <json>", "Location metadata JSON object")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((projectIdOrSlug, path, opts) => {
      try {
        const project = resolveProjectTarget(projectIdOrSlug);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const location = withWorkspaceLock(project, agentId, "project location add", () => addWorkspaceLocation({
          workspace_id: project.id,
          path,
          label: opts.label,
          kind: opts.kind,
          is_primary: Boolean(opts.primary),
          metadata: parseJsonObject(opts.metadataJson, "--metadata-json"),
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        const updated = resolveWorkspace(project.id) ?? project;
        if (wantsJson(opts)) { printObject({ project: projectWithManagement(updated), location }, opts); return; }
        console.log(chalk.green(`✓ Project location registered: ${location.path}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerRootsCommand(program: Command): void {
  const cmd = program.command("roots").description("Manage registered project roots");

  cmd
    .command("add")
    .requiredOption("--name <name>", "Root name")
    .requiredOption("--path <path>", "Base path")
    .option("--slug <slug>", "Root slug")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--kind <kind>", `Default project kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--github-org <org>", "Default GitHub organization")
    .option("--visibility <visibility>", "Default repo visibility: public or private")
    .option("--path-template <template>", "Path template relative to base path")
    .option("--name-template <template>", "Name template for generated names")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const visibility = opts.visibility as "public" | "private" | undefined;
        if (visibility && visibility !== "public" && visibility !== "private") {
          throw new Error("Visibility must be public or private");
        }
        const root = createRoot({
          name: opts.name,
          slug: opts.slug,
          base_path: opts.path,
          tags: splitList(opts.tags),
          default_kind: parseKind(opts.kind),
          github_org: opts.githubOrg,
          repo_visibility: visibility,
          path_template: opts.pathTemplate,
          name_template: opts.nameTemplate,
        });
        if (wantsJson(opts)) { printObject(root, opts); return; }
        console.log(chalk.green(`✓ Root created: ${root.slug}`));
        console.log(`  ${chalk.dim("path:")} ${root.base_path}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Show full paths and tags")
    .option("--render-spec", "Output a JSON Render spec")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const roots = listRoots();
      if (wantsRenderSpec(opts)) { printRenderSpec(buildRootsRender(roots)); return; }
      if (wantsJson(opts)) { printObject(roots, opts); return; }
      const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
      const visible = roots.slice(0, limit);
      printRows(visible.map((root) => ({
        slug: root.slug,
        kind: root.default_kind ?? "",
        path: opts.verbose ? root.base_path : compactText(root.base_path, 100),
        tags: compactText(root.tags.join(","), opts.verbose ? 120 : 40),
      })), ["slug", "kind", "path", "tags"]);
      printDiscoveryHint(`Showing ${visible.length} of ${roots.length} root(s). Use --limit <n>, --verbose, --json, or 'projects roots show <slug>' for details.`);
    });

  cmd
    .command("show <id-or-slug>")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
      if (!root) {
        console.error(chalk.red(`Root not found: ${idOrSlug}`));
        process.exit(1);
      }
      if (wantsJson(opts)) { printObject(root, opts); return; }
      console.log(`${chalk.bold(root.name)} ${chalk.dim(`(${root.slug})`)}`);
      console.log(`  ${chalk.dim("path:")} ${root.base_path}`);
      if (root.default_kind) console.log(`  ${chalk.dim("kind:")} ${root.default_kind}`);
      if (root.github_org) console.log(`  ${chalk.dim("github:")} ${root.github_org}`);
    });

  cmd
    .command("update <id-or-slug>")
    .option("--name <name>", "Root name")
    .option("--slug <slug>", "Root slug")
    .option("--path <path>", "Base path")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--kind <kind>", `Default project kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--clear-kind", "Clear default kind")
    .option("--github-org <org>", "Default GitHub organization")
    .option("--clear-github-org", "Clear default GitHub organization")
    .option("--visibility <visibility>", "Default repo visibility: public or private")
    .option("--clear-visibility", "Clear default repo visibility")
    .option("--path-template <template>", "Path template relative to base path")
    .option("--clear-path-template", "Clear path template")
    .option("--name-template <template>", "Name template")
    .option("--clear-name-template", "Clear name template")
    .option("--allowed-recipes <ids>", "Comma-separated allowed recipe ids/slugs")
    .option("--allowed-agents <ids>", "Comma-separated allowed agent ids/slugs")
    .option("--metadata-json <json>", "Replace metadata with JSON object")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
        if (!root) throw new Error(`Root not found: ${idOrSlug}`);
        const visibility = opts.clearVisibility ? null : opts.visibility as "public" | "private" | undefined;
        if (visibility && visibility !== "public" && visibility !== "private") throw new Error("Visibility must be public or private");
        const updated = updateRoot(root.id, {
          name: opts.name,
          slug: opts.slug,
          base_path: opts.path,
          tags: opts.tags === undefined ? undefined : splitList(opts.tags),
          default_kind: opts.clearKind ? null : parseKind(opts.kind),
          github_org: opts.clearGithubOrg ? null : opts.githubOrg,
          repo_visibility: visibility,
          path_template: opts.clearPathTemplate ? null : opts.pathTemplate,
          name_template: opts.clearNameTemplate ? null : opts.nameTemplate,
          allowed_recipes: opts.allowedRecipes === undefined ? undefined : splitList(opts.allowedRecipes),
          allowed_agents: opts.allowedAgents === undefined ? undefined : splitList(opts.allowedAgents),
          metadata: parseJsonObject(opts.metadataJson, "--metadata-json"),
        });
        if (wantsJson(opts)) { printObject(updated, opts); return; }
        console.log(chalk.green(`✓ Root updated: ${updated.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("delete <id-or-slug>")
    .option("--detach-workspaces", "Clear root_id on referencing projects before deleting")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
        if (!root) throw new Error(`Root not found: ${idOrSlug}`);
        const result = deleteRoot(root.id, { detachWorkspaces: opts.detachWorkspaces });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(chalk.yellow(`✓ Root deleted: ${result.root.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("match")
    .option("--path <path>", "Path to match")
    .option("--kind <kind>", `Project kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--tags <tags>", "Comma-separated tags")
    .option("--github-org <org>", "GitHub organization")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const matches = scoreRoots({
          path: opts.path,
          kind: parseKind(opts.kind),
          tags: splitList(opts.tags),
          github_org: opts.githubOrg,
        });
        if (wantsJson(opts)) { printObject(matches, opts); return; }
        const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
        const visible = matches.slice(0, limit);
        printRows(visible.map((item) => ({
          slug: item.root.slug,
          score: item.score,
          reasons: compactText(item.reasons.join(","), 60),
          path: compactText(item.root.base_path, 100),
        })), ["slug", "score", "reasons", "path"]);
        printDiscoveryHint(`Showing ${visible.length} of ${matches.length} root match(es). Use --limit <n> or --json for full records.`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerRecipesCommand(program: Command): void {
  const cmd = program.command("recipes").description("Manage project creation recipes");

  cmd
    .command("add")
    .requiredOption("--name <name>", "Recipe name")
    .option("--slug <slug>", "Recipe slug")
    .option("--description <text>", "Description")
    .option("--kind <kind>", `Recipe project kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--tags <tags>", "Default tags")
    .option("--step-json <json>", "Single JSON recipe step to append")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const steps = opts.stepJson ? [JSON.parse(opts.stepJson)] : [];
        const recipe = createRecipe({
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          kind: parseKind(opts.kind),
          default_tags: splitList(opts.tags),
          steps,
        });
        if (wantsJson(opts)) { printObject(recipe, opts); return; }
        console.log(chalk.green(`✓ Recipe created: ${recipe.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Show descriptions and recipe step counts")
    .option("--render-spec", "Output a JSON Render spec")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const recipes = listRecipes();
      if (wantsRenderSpec(opts)) { printRenderSpec(buildRecipesRender(recipes)); return; }
      if (wantsJson(opts)) { printObject(recipes, opts); return; }
      const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
      const visible = recipes.slice(0, limit);
      printRows(visible.map((recipe) => ({
        slug: recipe.slug,
        kind: recipe.kind ?? "",
        version: recipe.version,
        tags: compactText(recipe.default_tags.join(","), opts.verbose ? 120 : 40),
        ...(opts.verbose ? {
          steps: recipe.steps.length,
          description: compactText(recipe.description, 80),
        } : {}),
      })), opts.verbose ? ["slug", "kind", "version", "tags", "steps", "description"] : ["slug", "kind", "version", "tags"]);
      printDiscoveryHint(`Showing ${visible.length} of ${recipes.length} recipe(s). Use --limit <n>, --verbose, or --json for full records.`);
    });

  cmd
    .command("built-ins")
    .description("List built-in project recipes")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Show descriptions and recipe step counts")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const recipes = builtInWorkspaceRecipes();
      if (wantsJson(opts)) { printObject(recipes, opts); return; }
      const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
      const visible = recipes.slice(0, limit);
      printRows(visible.map((recipe) => ({
        slug: recipe.slug ?? "",
        kind: recipe.kind ?? "",
        tags: compactText(recipe.default_tags?.join(",") ?? "", opts.verbose ? 120 : 40),
        name: recipe.name,
        ...(opts.verbose ? {
          steps: recipe.steps?.length ?? 0,
          description: compactText(recipe.description, 80),
        } : {}),
      })), opts.verbose ? ["slug", "kind", "tags", "name", "steps", "description"] : ["slug", "kind", "tags", "name"]);
      printDiscoveryHint(`Showing ${visible.length} of ${recipes.length} built-in recipe(s). Use --limit <n>, --verbose, or --json for full definitions.`);
    });

  cmd
    .command("seed-defaults")
    .description("Create missing built-in project recipes")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const result = ensureBuiltInWorkspaceRecipes();
      if (wantsJson(opts)) { printObject(result, opts); return; }
      console.log(chalk.green(`✓ Created ${result.created.length} built-in recipe(s)`));
      if (result.existing.length) console.log(chalk.dim(`  existing: ${result.existing.length}`));
    });
}

function registerAgentsCommand(program: Command): void {
  const cmd = program.command("agents").description("Manage project agents");

  cmd
    .command("add")
    .requiredOption("--name <name>", "Agent name")
    .requiredOption("--kind <kind>", "Agent kind: human, ai, service, cli")
    .option("--slug <slug>", "Agent slug")
    .option("--provider <provider>", "Provider, e.g. openrouter")
    .option("--model <model>", "Model name")
    .option("--role <role>", "Default role")
    .option("--permissions <permissions>", "Comma-separated permissions")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const kind = opts.kind as AgentKind;
        if (!["human", "ai", "service", "cli"].includes(kind)) {
          throw new Error("Agent kind must be human, ai, service, or cli");
        }
        const agent = createAgent({
          name: opts.name,
          slug: opts.slug,
          kind,
          provider: opts.provider,
          model: opts.model,
          role: opts.role,
          permissions: splitList(opts.permissions),
        });
        if (wantsJson(opts)) { printObject(agent, opts); return; }
        console.log(chalk.green(`✓ Agent created: ${agent.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("--project <id-or-slug>", "List agents assigned to a project")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Show assignment timestamps and permission summaries")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      if (opts.project) {
        const project = resolveProjectTarget(opts.project);
        const assignments = listWorkspaceAgents(project.id);
        if (wantsJson(opts)) { printObject(assignments, opts); return; }
        const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
        const visible = assignments.slice(0, limit);
        printRows(visible.map((assignment) => ({
          agent: assignment.agent?.slug ?? assignment.agent_id,
          role: assignment.role,
          kind: assignment.agent?.kind ?? "",
          ...(opts.verbose ? {
            assigned_by: assignment.assigned_by ?? "",
            created_at: assignment.created_at,
            permissions: compactText(assignment.agent?.permissions.join(",") ?? "", 80),
          } : {}),
        })), opts.verbose ? ["agent", "role", "kind", "assigned_by", "created_at", "permissions"] : ["agent", "role", "kind"]);
        printDiscoveryHint(`Showing ${visible.length} of ${assignments.length} assignment(s). Use --limit <n>, --verbose, or --json for full records.`);
        return;
      }
      const agents = listAgents();
      if (wantsJson(opts)) { printObject(agents, opts); return; }
      const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
      const visible = agents.slice(0, limit);
      printRows(visible.map((agent) => ({
        slug: agent.slug,
        kind: agent.kind,
        provider: agent.provider ?? "",
        model: agent.model ?? "",
        role: agent.role ?? "",
        ...(opts.verbose ? { permissions: compactText(agent.permissions.join(","), 80) } : {}),
      })), opts.verbose ? ["slug", "kind", "provider", "model", "role", "permissions"] : ["slug", "kind", "provider", "model", "role"]);
      printDiscoveryHint(`Showing ${visible.length} of ${agents.length} agent(s). Use --limit <n>, --verbose, or --json for full records.`);
    });

  cmd
    .command("assign <project> <agent>")
    .description("Assign a registered agent to a project role")
    .option("--role <role>", `Project role (${PROJECT_AGENT_ROLES.join(", ")})`, "contributor")
    .option("--assigned-by <id-or-slug>", "Agent assigning the role; defaults to CLI agent")
    .option("--metadata-json <json>", "Assignment metadata JSON object")
    .option("-j, --json", "Output JSON")
    .action((projectIdOrSlug, agentIdOrSlug, opts) => {
      try {
        const project = resolveProjectTarget(projectIdOrSlug);
        const agent = getAgent(agentIdOrSlug) ?? getAgentBySlug(agentIdOrSlug);
        if (!agent) throw new Error(`Agent not found: ${agentIdOrSlug}`);
        const assignedBy = opts.assignedBy ? resolveAgentId(opts.assignedBy) : ensureCliAgent().id;
        const assignment = assignAgentToWorkspace(
          project.id,
          agent.id,
          parseProjectAgentRole(opts.role),
          assignedBy,
          parseJsonObject(opts.metadataJson, "--metadata-json"),
        );
        recordWorkspaceEvent({
          workspace_id: project.id,
          agent_id: assignedBy,
          event_type: "agent_assigned",
          source: "cli",
          command: process.argv.join(" "),
          after: {
            agent_id: agent.id,
            agent_slug: agent.slug,
            role: assignment.role,
            assignment_id: assignment.id,
          },
        });
        if (wantsJson(opts)) { printObject(assignment, opts); return; }
        console.log(chalk.green(`✓ Assigned ${agent.slug} to ${project.slug} as ${assignment.role}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerTmuxProfilesCommand(program: Command): void {
  const cmd = program.command("tmux-profiles").description("Manage project tmux profiles");

  cmd
    .command("add")
    .requiredOption("--name <name>", "Profile name")
    .option("--slug <slug>", "Profile slug")
    .option("--description <text>", "Description")
    .option("--session-template <template>", "Session template", "{slug}")
    .option("--attach", "Attach after applying")
    .option("--windows-json <json>", "JSON array of profile windows")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const profile = createTmuxProfile({
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          session_template: opts.sessionTemplate,
          attach: opts.attach,
          windows: parseTmuxProfileWindowsJson(opts.windowsJson),
        });
        const payload = { profile, windows: listTmuxProfileWindows(profile.id) };
        if (wantsJson(opts)) { printObject(payload, opts); return; }
        console.log(chalk.green(`✓ Tmux profile created: ${profile.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("window-add <profile>")
    .requiredOption("--name <template>", "Window name template")
    .option("--path-template <template>", "Window path template")
    .option("--command <command>", "Command template")
    .option("--index <n>", "Window index")
    .option("--attached", "Create focused rather than detached")
    .option("-j, --json", "Output JSON")
    .action((profileIdOrSlug, opts) => {
      try {
        const profile = resolveTmuxProfile(profileIdOrSlug);
        if (!profile) throw new Error(`Tmux profile not found: ${profileIdOrSlug}`);
        const window = addTmuxProfileWindow({
          profile_id: profile.id,
          window_name_template: opts.name,
          path_template: opts.pathTemplate,
          command: opts.command,
          window_index: opts.index ? Number.parseInt(opts.index, 10) : undefined,
          detached: !opts.attached,
        });
        if (wantsJson(opts)) { printObject(window, opts); return; }
        console.log(chalk.green(`✓ Window added: ${window.window_name_template}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("--limit <n>", `Max rows for terminal output (default ${DEFAULT_LIST_LIMIT}, max ${MAX_HUMAN_LIMIT})`)
    .option("--verbose", "Show description and window count")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const profiles = listTmuxProfiles();
      if (wantsJson(opts)) { printObject(profiles, opts); return; }
      const limit = parseHumanLimit(opts.limit, DEFAULT_LIST_LIMIT);
      const visible = profiles.slice(0, limit);
      printRows(visible.map((profile) => ({
        slug: profile.slug,
        session: compactText(profile.session_template, 80),
        attach: profile.attach ? "yes" : "no",
        ...(opts.verbose ? {
          windows: listTmuxProfileWindows(profile.id).length,
          description: compactText(profile.description, 80),
        } : {}),
      })), opts.verbose ? ["slug", "session", "attach", "windows", "description"] : ["slug", "session", "attach"]);
      printDiscoveryHint(`Showing ${visible.length} of ${profiles.length} tmux profile(s). Use --limit <n>, --verbose, --json, or 'projects tmux-profiles show <slug>' for details.`);
    });

  cmd
    .command("show <profile>")
    .option("-j, --json", "Output JSON")
    .action((profileIdOrSlug, opts) => {
      const profile = resolveTmuxProfile(profileIdOrSlug);
      if (!profile) {
        console.error(chalk.red(`Tmux profile not found: ${profileIdOrSlug}`));
        process.exit(1);
      }
      const payload = { profile, windows: listTmuxProfileWindows(profile.id) };
      if (wantsJson(opts)) { printObject(payload, opts); return; }
      console.log(`${chalk.bold(profile.name)} ${chalk.dim(`(${profile.slug})`)}`);
      for (const window of payload.windows) console.log(`  ${window.window_name_template}`);
    });

  cmd
    .command("apply <profile> <project>")
    .option("--dry-run", "Plan tmux changes without applying")
    .option("-j, --json", "Output JSON")
    .action((profileIdOrSlug, projectIdOrSlug, opts) => {
      try {
        const profile = resolveTmuxProfile(profileIdOrSlug);
        if (!profile) throw new Error(`Tmux profile not found: ${profileIdOrSlug}`);
        const workspace = resolveProjectTarget(projectIdOrSlug);
        const agentId = ensureCliAgent().id;
        const result = opts.dryRun
          ? applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), {
              dryRun: true,
              source: "cli",
              command: process.argv.join(" "),
            })
          : withWorkspaceLock(workspace, agentId, "tmux profile apply", () => applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), {
              source: "cli",
              command: process.argv.join(" "),
            }));
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(`${result.success ? chalk.green("✓") : chalk.red("✗")} ${result.session_action} ${result.session_name}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
