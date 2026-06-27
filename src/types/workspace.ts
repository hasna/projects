export const WORKSPACE_STATUSES = ["active", "archived", "deleted"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export const WORKSPACE_KINDS = [
  "open-source",
  "internal-app",
  "platform",
  "company-website",
  "scaffold",
  "community",
  "project",
  "experiment",
  "docs",
  "remote-only",
  "generic",
] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export const AGENT_KINDS = ["human", "ai", "service", "cli"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const PROJECT_AGENT_ROLES = ["owner", "maintainer", "contributor", "service", "prompt-agent", "creator"] as const;
export type ProjectAgentRole = (typeof PROJECT_AGENT_ROLES)[number];

export const EVENT_SOURCES = ["cli", "mcp", "agent", "migration", "system"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const AGENT_RUN_STATUSES = ["planned", "running", "completed", "failed"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface JsonObject {
  [key: string]: unknown;
}

export interface Root {
  id: string;
  slug: string;
  name: string;
  base_path: string;
  tags: string[];
  default_kind: WorkspaceKind | null;
  default_recipe_id: string | null;
  default_tmux_profile_id: string | null;
  github_org: string | null;
  repo_visibility: "public" | "private" | null;
  path_template: string | null;
  name_template: string | null;
  allowed_recipes: string[];
  allowed_agents: string[];
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface RootRow {
  id: string;
  slug: string;
  name: string;
  base_path: string;
  tags: string;
  default_kind: string | null;
  default_recipe_id: string | null;
  default_tmux_profile_id: string | null;
  github_org: string | null;
  repo_visibility: string | null;
  path_template: string | null;
  name_template: string | null;
  allowed_recipes: string;
  allowed_agents: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface CreateRootInput {
  slug?: string;
  name: string;
  base_path: string;
  tags?: string[];
  default_kind?: WorkspaceKind;
  default_recipe_id?: string;
  default_tmux_profile_id?: string;
  github_org?: string;
  repo_visibility?: "public" | "private";
  path_template?: string;
  name_template?: string;
  allowed_recipes?: string[];
  allowed_agents?: string[];
  metadata?: JsonObject;
}

export interface UpdateRootInput {
  slug?: string;
  name?: string;
  base_path?: string;
  tags?: string[];
  default_kind?: WorkspaceKind | null;
  default_recipe_id?: string | null;
  default_tmux_profile_id?: string | null;
  github_org?: string | null;
  repo_visibility?: "public" | "private" | null;
  path_template?: string | null;
  name_template?: string | null;
  allowed_recipes?: string[];
  allowed_agents?: string[];
  metadata?: JsonObject;
}

export interface Agent {
  id: string;
  slug: string;
  name: string;
  kind: AgentKind;
  provider: string | null;
  model: string | null;
  role: string | null;
  permissions: string[];
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  provider: string | null;
  model: string | null;
  role: string | null;
  permissions: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentInput {
  slug?: string;
  name: string;
  kind: AgentKind;
  provider?: string;
  model?: string;
  role?: string;
  permissions?: string[];
  metadata?: JsonObject;
}

export interface Recipe {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: WorkspaceKind | null;
  version: number;
  steps: JsonObject[];
  variables: JsonObject;
  default_tags: string[];
  default_tmux_profile_id: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface RecipeRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: string | null;
  version: number;
  steps: string;
  variables: string;
  default_tags: string;
  default_tmux_profile_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface CreateRecipeInput {
  slug?: string;
  name: string;
  description?: string;
  kind?: WorkspaceKind;
  version?: number;
  steps?: JsonObject[];
  variables?: JsonObject;
  default_tags?: string[];
  default_tmux_profile_id?: string;
  metadata?: JsonObject;
}

export interface WorkspaceIntegrations {
  github_repo?: string;
  github_url?: string;
  todos_project_id?: string;
  mementos_project_id?: string;
  conversations_space?: string;
  files_index_id?: string;
  [key: string]: string | undefined;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: WorkspaceKind;
  status: WorkspaceStatus;
  root_id: string | null;
  recipe_id: string | null;
  primary_path: string | null;
  git_remote: string | null;
  s3_bucket: string | null;
  s3_prefix: string | null;
  tags: string[];
  integrations: WorkspaceIntegrations;
  metadata: JsonObject;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  status: string;
  root_id: string | null;
  recipe_id: string | null;
  primary_path: string | null;
  git_remote: string | null;
  s3_bucket: string | null;
  s3_prefix: string | null;
  tags: string;
  integrations: string;
  metadata: string;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface CreateWorkspaceInput {
  id?: string;
  name: string;
  slug?: string;
  description?: string;
  kind?: WorkspaceKind;
  root_id?: string;
  recipe_id?: string;
  primary_path?: string;
  git_remote?: string;
  s3_bucket?: string;
  s3_prefix?: string;
  tags?: string[];
  integrations?: WorkspaceIntegrations;
  metadata?: JsonObject;
  agent_id?: string;
  source?: EventSource;
  prompt?: string;
  command?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  description?: string | null;
  kind?: WorkspaceKind;
  status?: WorkspaceStatus;
  root_id?: string | null;
  recipe_id?: string | null;
  primary_path?: string | null;
  git_remote?: string | null;
  s3_bucket?: string | null;
  s3_prefix?: string | null;
  tags?: string[];
  integrations?: WorkspaceIntegrations;
  metadata?: JsonObject;
  agent_id?: string;
  source?: EventSource;
  prompt?: string;
  command?: string;
}

export interface WorkspaceLocation {
  id: string;
  workspace_id: string;
  path: string;
  machine_id: string;
  label: string;
  kind: string;
  is_primary: boolean;
  exists_at_create: boolean;
  metadata: JsonObject;
  created_at: string;
}

export interface WorkspaceLocationRow {
  id: string;
  workspace_id: string;
  path: string;
  machine_id: string;
  label: string;
  kind: string;
  is_primary: number;
  exists_at_create: number;
  metadata: string;
  created_at: string;
}

export interface WorkspaceAgentAssignment {
  id: string;
  workspace_id: string;
  agent_id: string;
  role: string;
  assigned_by: string | null;
  metadata: JsonObject;
  created_at: string;
  agent: Agent | null;
}

export interface WorkspaceAgentAssignmentRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  role: string;
  assigned_by: string | null;
  metadata: string;
  created_at: string;
}

export interface WorkspaceEvent {
  id: string;
  workspace_id: string | null;
  agent_id: string | null;
  event_type: string;
  source: EventSource;
  prompt: string | null;
  command: string | null;
  before_json: JsonObject | null;
  after_json: JsonObject | null;
  metadata: JsonObject;
  created_at: string;
}

export interface WorkspaceEventRow {
  id: string;
  workspace_id: string | null;
  agent_id: string | null;
  event_type: string;
  source: string;
  prompt: string | null;
  command: string | null;
  before_json: string | null;
  after_json: string | null;
  metadata: string;
  created_at: string;
}

export interface RecordWorkspaceEventInput {
  workspace_id?: string;
  agent_id?: string;
  event_type: string;
  source: EventSource;
  prompt?: string;
  command?: string;
  before?: JsonObject | null;
  after?: JsonObject | null;
  metadata?: JsonObject;
}

export interface AgentRun {
  id: string;
  agent_id: string | null;
  workspace_id: string | null;
  provider: string | null;
  model: string | null;
  prompt: string;
  status: AgentRunStatus;
  plan_json: JsonObject | null;
  tool_calls_json: JsonObject[];
  result_json: JsonObject | null;
  error: string | null;
  metadata: JsonObject;
  started_at: string;
  completed_at: string | null;
}

export interface AgentRunRow {
  id: string;
  agent_id: string | null;
  workspace_id: string | null;
  provider: string | null;
  model: string | null;
  prompt: string;
  status: string;
  plan_json: string | null;
  tool_calls_json: string;
  result_json: string | null;
  error: string | null;
  metadata: string;
  started_at: string;
  completed_at: string | null;
}

export interface TmuxProfile {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  session_template: string;
  attach: boolean;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface TmuxProfileRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  session_template: string;
  attach: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface CreateTmuxProfileInput {
  slug?: string;
  name: string;
  description?: string;
  session_template?: string;
  attach?: boolean;
  metadata?: JsonObject;
  windows?: CreateTmuxProfileWindowInput[];
}

export interface TmuxProfileWindow {
  id: string;
  profile_id: string;
  window_name_template: string;
  path_template: string | null;
  command: string | null;
  window_index: number | null;
  detached: boolean;
  env: Record<string, string>;
  revive: boolean;
  created_at: string;
}

export interface TmuxProfileWindowRow {
  id: string;
  profile_id: string;
  window_name_template: string;
  path_template: string | null;
  command: string | null;
  window_index: number | null;
  detached: number;
  env: string;
  revive: number;
  created_at: string;
}

export interface CreateTmuxProfileWindowInput {
  profile_id?: string;
  window_name_template: string;
  path_template?: string;
  command?: string;
  window_index?: number;
  detached?: boolean;
  env?: Record<string, string>;
  revive?: boolean;
}

export interface WorkspaceLock {
  id: string;
  lock_key: string;
  workspace_id: string | null;
  agent_id: string | null;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface WorkspaceLockRow {
  id: string;
  lock_key: string;
  workspace_id: string | null;
  agent_id: string | null;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
}
