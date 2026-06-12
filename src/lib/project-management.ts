import { existsSync } from "node:fs";
import type { JsonObject, Workspace, WorkspaceIntegrations } from "../types/workspace.js";
import type { WorkspaceTmuxWindowSpec } from "./workspace-runtime.js";

export const PROJECT_STAGES = ["idea", "planned", "active", "paused", "shipped", "maintenance"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const PROJECT_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];

export const PROJECT_START_AGENTS = ["codewith", "claude", "opencode", "cursor", "none"] as const;
export type ProjectStartAgent = (typeof PROJECT_START_AGENTS)[number];
export const PROJECT_START_SESSION_POLICIES = ["reuse", "new", "error-if-running"] as const;
export type ProjectStartSessionPolicy = (typeof PROJECT_START_SESSION_POLICIES)[number];
export type ProjectIntegrationUnlinkGroup = "github" | "todos" | "brief" | "mementos" | "conversations" | "files";

export const PROJECT_MANAGEMENT_TAXONOMY = {
  stages: PROJECT_STAGES,
  priorities: PROJECT_PRIORITIES,
  start_agents: PROJECT_START_AGENTS,
  start_session_policies: PROJECT_START_SESSION_POLICIES,
  integration_keys: ["todos_project_id", "todos_task_list_id", "brief_id", "brief_path"] as const,
} as const;

export interface ProjectManagementMetadataInput {
  stage?: string | null;
  priority?: string | null;
  owner?: string | null;
  launch_profile?: string | null;
  start_agent?: string | null;
  start_command?: string | null;
  start_session_policy?: string | null;
  start_windows?: WorkspaceTmuxWindowSpec[] | null;
}

export interface ProjectIntegrationInput {
  todos_project_id?: string | null;
  todos_task_list_id?: string | null;
  brief_id?: string | null;
  brief_path?: string | null;
}

export interface ProjectManagementSummary {
  stage: string | null;
  priority: string | null;
  owner: string | null;
  launch_profile: string | null;
  start_agent: string | null;
  start_command: string | null;
  start_session_policy: string | null;
  start_windows: WorkspaceTmuxWindowSpec[];
  todos_project_id: string | null;
  todos_task_list_id: string | null;
  brief_id: string | null;
  brief_path: string | null;
}

export interface ProjectExternalLinksSummary {
  todos: {
    linked: boolean;
    status: "linked" | "unlinked";
    project_id: string | null;
    task_list_id: string | null;
  };
  brief: {
    linked: boolean;
    status: "linked" | "unlinked";
    id: string | null;
    path: string | null;
    path_exists: boolean | null;
  };
}

function cleanProjectTag(value: string): string | null {
  const tag = value.trim();
  return tag ? tag : null;
}

export function mergeProjectTags(existing: string[], tags: string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of [...existing, ...tags]) {
    const tag = cleanProjectTag(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    next.push(tag);
  }
  return next;
}

export function removeProjectTags(existing: string[], tags: string[]): string[] {
  const removals = new Set(tags.map(cleanProjectTag).filter((tag): tag is string => Boolean(tag)));
  if (removals.size === 0) return mergeProjectTags(existing, []);
  return mergeProjectTags(existing, []).filter((tag) => !removals.has(tag));
}

export function expandProjectIntegrationUnlinkKey(key: string): string[] {
  const normalized = key.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!normalized) return [];
  switch (normalized) {
    case "github":
      return ["github_repo", "github_url"];
    case "repo":
    case "github_repo":
    case "github_full_name":
      return ["github_repo"];
    case "github_url":
      return ["github_url"];
    case "todos":
    case "todo":
      return ["todos_project_id", "todos_task_list_id"];
    case "todos_project":
    case "todos_project_id":
      return ["todos_project_id"];
    case "todos_task_list":
    case "todos_task_list_id":
      return ["todos_task_list_id"];
    case "brief":
    case "spec":
      return ["brief_id", "brief_path"];
    case "brief_id":
    case "spec_id":
      return ["brief_id"];
    case "brief_path":
    case "spec_path":
      return ["brief_path"];
    case "mementos":
    case "memento":
    case "mementos_project":
    case "mementos_project_id":
      return ["mementos_project_id"];
    case "conversations":
    case "conversation":
    case "conversations_space":
      return ["conversations_space"];
    case "files":
    case "file_index":
    case "files_index":
    case "files_index_id":
      return ["files_index_id"];
    default:
      return [normalized];
  }
}

export function expandProjectIntegrationUnlinkKeys(keys: string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const key of keys.flatMap(expandProjectIntegrationUnlinkKey)) {
    if (seen.has(key)) continue;
    seen.add(key);
    expanded.push(key);
  }
  return expanded;
}

export function unlinkProjectIntegrationFields(integrations: WorkspaceIntegrations, keys: string[]): WorkspaceIntegrations {
  const next: WorkspaceIntegrations = { ...integrations };
  for (const key of expandProjectIntegrationUnlinkKeys(keys)) {
    delete next[key];
  }
  return next;
}

export interface ProjectPathHealth {
  status: "ok" | "missing" | "remote-only" | "unknown";
  path: string | null;
  exists: boolean | null;
}

export interface ProjectDashboardSummary {
  management: ProjectManagementSummary;
  external_links: ProjectExternalLinksSummary;
  path_health: ProjectPathHealth;
  launch: {
    default_agent: string | null;
    default_command: string | null;
    default_profile: string | null;
    default_session_policy: string | null;
    default_windows: WorkspaceTmuxWindowSpec[];
    last_opened_at: string | null;
  };
}

function cleanString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeStage(value: string | null | undefined): string | null | undefined {
  const cleaned = cleanString(value);
  if (cleaned === undefined || cleaned === null) return cleaned;
  const normalized = cleaned.toLowerCase();
  if ((PROJECT_STAGES as readonly string[]).includes(normalized)) return normalized;
  throw new Error(`Invalid project stage: ${cleaned}. Expected one of: ${PROJECT_STAGES.join(", ")}`);
}

function normalizePriority(value: string | null | undefined): string | null | undefined {
  const cleaned = cleanString(value);
  if (cleaned === undefined || cleaned === null) return cleaned;
  const normalized = cleaned.toLowerCase();
  if ((PROJECT_PRIORITIES as readonly string[]).includes(normalized)) return normalized;
  throw new Error(`Invalid project priority: ${cleaned}. Expected one of: ${PROJECT_PRIORITIES.join(", ")}`);
}

function normalizeStartAgent(value: string | null | undefined): string | null | undefined {
  const cleaned = cleanString(value);
  if (cleaned === undefined || cleaned === null) return cleaned;
  const normalized = cleaned.toLowerCase();
  if ((PROJECT_START_AGENTS as readonly string[]).includes(normalized)) return normalized;
  throw new Error(`Invalid project start_agent: ${cleaned}. Expected one of: ${PROJECT_START_AGENTS.join(", ")}`);
}

function normalizeStartSessionPolicy(value: string | null | undefined): string | null | undefined {
  const cleaned = cleanString(value);
  if (cleaned === undefined || cleaned === null) return cleaned;
  const normalized = cleaned.toLowerCase();
  if ((PROJECT_START_SESSION_POLICIES as readonly string[]).includes(normalized)) return normalized;
  throw new Error(`Invalid project start_session_policy: ${cleaned}. Expected one of: ${PROJECT_START_SESSION_POLICIES.join(", ")}`);
}

function normalizeStartWindows(value: WorkspaceTmuxWindowSpec[] | null | undefined): WorkspaceTmuxWindowSpec[] | null | undefined {
  if (value === undefined || value === null) return value;
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Project start_windows entries must be objects");
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) throw new Error("Project start_windows entries need a non-empty name");
    return {
      name,
      path: typeof item.path === "string" && item.path.trim() ? item.path.trim() : undefined,
      command: typeof item.command === "string" && item.command.trim() ? item.command.trim() : undefined,
      index: typeof item.index === "number" ? item.index : undefined,
      detached: typeof item.detached === "boolean" ? item.detached : undefined,
    };
  });
}

export function hasProjectManagementFields(input: ProjectManagementMetadataInput): boolean {
  return Object.values(input).some((value) => value !== undefined);
}

export function hasProjectIntegrationFields(input: ProjectIntegrationInput): boolean {
  return Object.values(input).some((value) => value !== undefined);
}

export function mergeProjectManagementMetadata(
  base: JsonObject | undefined,
  input: ProjectManagementMetadataInput,
): JsonObject | undefined {
  if (!hasProjectManagementFields(input)) return undefined;
  const metadata: JsonObject = { ...(base ?? {}) };
  const fields: Record<string, unknown> = {
    stage: normalizeStage(input.stage),
    priority: normalizePriority(input.priority),
    owner: cleanString(input.owner),
    launch_profile: cleanString(input.launch_profile),
    start_agent: normalizeStartAgent(input.start_agent),
    start_command: cleanString(input.start_command),
    start_session_policy: normalizeStartSessionPolicy(input.start_session_policy),
    start_windows: normalizeStartWindows(input.start_windows),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) delete metadata[key];
    else metadata[key] = value;
  }
  return metadata;
}

export function mergeProjectIntegrationFields(
  base: WorkspaceIntegrations | undefined,
  input: ProjectIntegrationInput,
): WorkspaceIntegrations | undefined {
  if (!hasProjectIntegrationFields(input)) return undefined;
  const integrations: WorkspaceIntegrations = { ...(base ?? {}) };
  for (const [key, rawValue] of Object.entries(input)) {
    const value = cleanString(rawValue);
    if (value === undefined) continue;
    if (value === null) delete integrations[key];
    else integrations[key] = value;
  }
  return integrations;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function startWindowsValue(value: unknown): WorkspaceTmuxWindowSpec[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const window = item as Record<string, unknown>;
    const name = typeof window.name === "string" ? window.name.trim() : "";
    if (!name) return [];
    return [{
      name,
      path: typeof window.path === "string" && window.path.trim() ? window.path.trim() : undefined,
      command: typeof window.command === "string" && window.command.trim() ? window.command.trim() : undefined,
      index: typeof window.index === "number" ? window.index : undefined,
      detached: typeof window.detached === "boolean" ? window.detached : undefined,
    }];
  });
}

export function projectManagementSummary(project: Workspace): ProjectManagementSummary {
  return {
    stage: stringValue(project.metadata.stage),
    priority: stringValue(project.metadata.priority),
    owner: stringValue(project.metadata.owner),
    launch_profile: stringValue(project.metadata.launch_profile),
    start_agent: stringValue(project.metadata.start_agent),
    start_command: stringValue(project.metadata.start_command),
    start_session_policy: stringValue(project.metadata.start_session_policy),
    start_windows: startWindowsValue(project.metadata.start_windows),
    todos_project_id: project.integrations.todos_project_id ?? null,
    todos_task_list_id: project.integrations.todos_task_list_id ?? null,
    brief_id: project.integrations.brief_id ?? null,
    brief_path: project.integrations.brief_path ?? null,
  };
}

export function projectExternalLinksSummary(project: Workspace): ProjectExternalLinksSummary {
  const todosProjectId = project.integrations.todos_project_id ?? null;
  const todosTaskListId = project.integrations.todos_task_list_id ?? null;
  const briefId = project.integrations.brief_id ?? null;
  const briefPath = project.integrations.brief_path ?? null;
  const briefLinked = Boolean(briefId || briefPath);

  return {
    todos: {
      linked: Boolean(todosProjectId || todosTaskListId),
      status: todosProjectId || todosTaskListId ? "linked" : "unlinked",
      project_id: todosProjectId,
      task_list_id: todosTaskListId,
    },
    brief: {
      linked: briefLinked,
      status: briefLinked ? "linked" : "unlinked",
      id: briefId,
      path: briefPath,
      path_exists: briefPath ? existsSync(briefPath) : null,
    },
  };
}

export function projectPathHealth(project: Workspace): ProjectPathHealth {
  if (!project.primary_path) {
    return {
      status: project.kind === "remote-only" ? "remote-only" : "unknown",
      path: null,
      exists: null,
    };
  }
  const exists = existsSync(project.primary_path);
  return {
    status: exists ? "ok" : "missing",
    path: project.primary_path,
    exists,
  };
}

export function projectDashboardSummary(project: Workspace): ProjectDashboardSummary {
  const management = projectManagementSummary(project);
  return {
    management,
    external_links: projectExternalLinksSummary(project),
    path_health: projectPathHealth(project),
    launch: {
      default_agent: management.start_agent,
      default_command: management.start_command,
      default_profile: management.launch_profile,
      default_session_policy: management.start_session_policy,
      default_windows: management.start_windows,
      last_opened_at: project.last_opened_at,
    },
  };
}

export function projectWithManagement(project: Workspace): Workspace & { management: ProjectManagementSummary; external_links: ProjectExternalLinksSummary; dashboard: ProjectDashboardSummary } {
  return {
    ...project,
    management: projectManagementSummary(project),
    external_links: projectExternalLinksSummary(project),
    dashboard: projectDashboardSummary(project),
  };
}
