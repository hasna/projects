// Unified projects registry Store seam.
//
// ONE interface (`ProjectStore`) with two transports behind it:
//   - LocalProjectStore  -> on-box sqlite (src/db/workspaces.ts)
//   - ApiProjectStore    -> HTTP `<API_URL>/v1` + bearer key (src/http/client.ts)
//
// `resolveProjectStore()` picks the transport from the environment: presence of
// HASNA_PROJECTS_API_URL + HASNA_PROJECTS_API_KEY (and/or
// HASNA_PROJECTS_STORAGE_MODE) => api transport; else local. `self_hosted` and
// `cloud` BOTH resolve to the ApiProjectStore (identical client code; only the
// URL/key differ — that distinction is server-side tenancy, not the client).
//
// This eliminates the per-command `if (cloud) {...} else {...local...}`
// split-brain branching: every registry command/tool/method calls the same
// Store methods. Machine-local runtime side effects (tmux, git, directory
// creation, rendering) are NOT shared state and stay local by design; callers
// gate those on `store.mode === "local"`.
//
// SAFETY: the api transport carries a bearer key ONLY (never a DB DSN). The key
// value is never logged or embedded in output.

import {
  acquireWorkspaceLock,
  addWorkspaceLocation as dbAddWorkspaceLocation,
  archiveWorkspace as dbArchiveWorkspace,
  assignAgentToWorkspace as dbAssignAgentToWorkspace,
  createAgent as dbCreateAgent,
  createRecipe as dbCreateRecipe,
  createRoot as dbCreateRoot,
  createWorkspace as dbCreateWorkspace,
  deleteRoot as dbDeleteRoot,
  deleteWorkspace as dbDeleteWorkspace,
  getAgent as dbGetAgent,
  getAgentBySlug as dbGetAgentBySlug,
  getRecipe as dbGetRecipe,
  getRecipeBySlug as dbGetRecipeBySlug,
  getRoot as dbGetRoot,
  getRootBySlug as dbGetRootBySlug,
  addTmuxProfileWindow as dbAddTmuxProfileWindow,
  createTmuxProfile as dbCreateTmuxProfile,
  listAgentRuns as dbListAgentRuns,
  listAgents as dbListAgents,
  listRecipes as dbListRecipes,
  listRoots as dbListRoots,
  listTmuxProfileWindows as dbListTmuxProfileWindows,
  listTmuxProfiles as dbListTmuxProfiles,
  resolveTmuxProfile as dbResolveTmuxProfile,
  listWorkspaceAgents as dbListWorkspaceAgents,
  listWorkspaceEvents as dbListWorkspaceEvents,
  listWorkspaceLocations as dbListWorkspaceLocations,
  listWorkspaceLocks as dbListWorkspaceLocks,
  listWorkspaces as dbListWorkspaces,
  rankRoots,
  recordWorkspaceEvent as dbRecordWorkspaceEvent,
  releaseWorkspaceLock,
  resolveWorkspace as dbResolveWorkspace,
  scoreRoots as dbScoreRoots,
  unarchiveWorkspace as dbUnarchiveWorkspace,
  updateRoot as dbUpdateRoot,
  updateWorkspace as dbUpdateWorkspace,
  type RootMatchInput,
  type RootMatchResult,
  type WorkspaceFilter,
} from "../db/workspaces.js";
import {
  resolveStorageClient,
  type Env,
  type StorageClient,
  type QueryParams,
} from "../http/client.js";
import { resolveRegisteredProjectTargetOrThrow, type ProjectResolverOptions } from "../lib/project-resolver.js";
import {
  createProjectCanvas as dbCreateProjectCanvas,
  createProjectDataModel as dbCreateProjectDataModel,
  createProjectDataRecord as dbCreateProjectDataRecord,
  ensureDefaultProjectCanvas as dbEnsureDefaultProjectCanvas,
  getProjectCanvas as dbGetProjectCanvas,
  getProjectStorePaths,
  inspectProjectStore as dbInspectProjectStore,
  inspectProjectStoreWithLoops as dbInspectProjectStoreWithLoops,
  linkProjectLoop as dbLinkProjectLoop,
  listProjectCanvases as dbListProjectCanvases,
  listProjectDataModels as dbListProjectDataModels,
  listProjectDataRecords as dbListProjectDataRecords,
  listProjectLoopLinks as dbListProjectLoopLinks,
  listProjectLoopSummaries as dbListProjectLoopSummaries,
  PROJECT_STORE_SCHEMA_VERSION,
  type CreateProjectCanvasInput,
  type CreateProjectDataModelInput,
  type CreateProjectDataRecordInput,
  type LinkProjectLoopInput,
  type ProjectCanvas,
  type ProjectDataModel,
  type ProjectDataRecord,
  type ProjectLoopLink,
  type ProjectLoopSummary,
  type ProjectStoreProject,
  type ProjectStoreSummary,
} from "../db/project-store.js";
import {
  createProjectBudget as dbCreateProjectBudget,
  getProjectBudgetStatuses as dbGetProjectBudgetStatuses,
  listProjectBudgets as dbListProjectBudgets,
  recordProjectSpend as dbRecordProjectSpend,
  resetProjectBudget as dbResetProjectBudget,
  type CreateProjectBudgetInput,
  type ProjectBudget,
  type ProjectBudgetContext,
  type ProjectBudgetSpend,
  type ProjectBudgetStatus,
  type ProjectSpendInput,
} from "../lib/budget.js";
import {
  ensureProjectChannelViaStore,
  type ProjectChannelEnsureResult,
  type StoreEnsureChannelOptions,
} from "../lib/project-channel.js";
import type {
  Agent,
  AgentRun,
  CreateAgentInput,
  CreateRecipeInput,
  CreateRootInput,
  CreateWorkspaceInput,
  EventSource,
  JsonObject,
  CreateTmuxProfileInput,
  CreateTmuxProfileWindowInput,
  Recipe,
  Root,
  TmuxProfile,
  TmuxProfileWindow,
  UpdateRootInput,
  UpdateWorkspaceInput,
  Workspace,
  WorkspaceAgentAssignment,
  WorkspaceEvent,
  WorkspaceLocation,
  WorkspaceLock,
} from "../types/workspace.js";

const APP = "projects";
const RESOURCE = "projects";

export type ProjectStoreMode = "local" | "api";

/** Mutation provenance carried on every write (agent + audit trail). */
export interface MutationContext {
  agentId?: string;
  source?: EventSource;
  command?: string;
  prompt?: string;
  reason?: string;
}

export interface DeleteProjectResult {
  /** The deleted project row when the transport can return it (always local). */
  workspace: Workspace | null;
  hard: boolean;
  /** Stable identifier for the deleted project (id or slug). */
  id: string;
}

export interface DeleteRootResult {
  root: Root;
  detached_workspaces: number;
}

/** Explicit audit-event write (routes through the Store, never raw sqlite). */
export interface RecordEventInput {
  event_type: string;
  source: EventSource;
  agentId?: string;
  prompt?: string;
  command?: string;
  before?: JsonObject | null;
  after?: JsonObject | null;
  metadata?: JsonObject;
}

/** Filter for the prompt-agent run ledger read (on-box sub-resource). */
export interface AgentRunFilter {
  workspace_id?: string;
  agent_id?: string;
  status?: AgentRun["status"];
  limit?: number;
}

/** Assign a registered agent to a project role (on-box sub-resource). */
export interface AssignAgentInput {
  /** Already-resolved agent id. */
  agentId: string;
  role?: string;
  assignedBy?: string;
  metadata?: JsonObject;
  source?: EventSource;
  command?: string;
}

/** Register another on-disk location for a project (on-box sub-resource). */
export interface AddLocationInput {
  path: string;
  label?: string;
  kind?: string;
  isPrimary?: boolean;
  metadata?: JsonObject;
  agentId?: string;
  source?: EventSource;
  command?: string;
}

export interface AddLocationResult {
  project: Workspace;
  location: WorkspaceLocation;
}

/** Acquire a project mutation lock (machine-local coordination primitive). */
export interface AcquireLockInput {
  key: string;
  workspaceId?: string;
  agentId?: string;
  reason?: string;
  ttlSeconds?: number;
}

/**
 * Operations that only exist on-box (agent assignments, extra disk locations,
 * mutation locks). The api transport does not model them; calling a write in
 * api mode throws this rather than silently writing local sqlite (split-brain).
 */
class LocalOnlyOperationError extends Error {
  constructor(operation: string) {
    super(`${operation} is a local-only operation and is not available in api/cloud mode.`);
    this.name = "LocalOnlyOperationError";
  }
}

export interface ProjectStore {
  readonly mode: ProjectStoreMode;
  /** Base `<url>/v1` for api mode; null for local. Never contains the key. */
  readonly baseUrl: string | null;
  listProjects(filter?: WorkspaceFilter): Promise<Workspace[]>;
  getProject(idOrSlug: string): Promise<Workspace | null>;
  /**
   * Resolve a caller-supplied target to a single project, throwing if none
   * matches. Local resolves by id/slug/name and — as a machine-local
   * convenience — by on-disk path/marker. Api resolves by id/slug server-side.
   */
  resolveTarget(target: string | undefined, options?: ProjectResolverOptions): Promise<Workspace>;
  createProject(input: CreateWorkspaceInput): Promise<Workspace>;
  updateProject(id: string, patch: UpdateWorkspaceInput): Promise<Workspace>;
  archiveProject(id: string, ctx?: MutationContext): Promise<Workspace>;
  unarchiveProject(id: string, ctx?: MutationContext): Promise<Workspace>;
  deleteProject(id: string, opts: { hard?: boolean }, ctx?: MutationContext): Promise<DeleteProjectResult>;
  listEvents(idOrSlug: string, limit?: number): Promise<WorkspaceEvent[]>;
  /** Record an explicit audit event. Local writes sqlite; api POSTs to /projects/:id/events. */
  recordEvent(idOrSlug: string, input: RecordEventInput): Promise<WorkspaceEvent>;
  /**
   * Per-project agent assignments. This is an on-box sub-resource; the api
   * transport does not model it server-side and returns an empty list.
   */
  getProjectAgents(id: string): Promise<WorkspaceAgentAssignment[]>;
  /** Assign a registered agent to a project role. Local-only (throws in api mode). */
  assignAgent(idOrSlug: string, input: AssignAgentInput): Promise<WorkspaceAgentAssignment>;
  /**
   * Per-project registered locations. On-box sub-resource; the api transport
   * does not model it server-side and returns an empty list.
   */
  getProjectLocations(id: string): Promise<WorkspaceLocation[]>;
  /** Register another on-disk location for a project. Local-only (throws in api mode). */
  addLocation(idOrSlug: string, input: AddLocationInput): Promise<AddLocationResult>;

  // ---- Mutation locks (machine-local coordination) ----
  listLocks(): Promise<WorkspaceLock[]>;
  acquireLock(input: AcquireLockInput): Promise<WorkspaceLock>;
  releaseLock(key: string): Promise<boolean>;

  // ---- Roots (shared registry: /v1/roots) ----
  listRoots(): Promise<Root[]>;
  getRoot(idOrSlug: string): Promise<Root | null>;
  createRoot(input: CreateRootInput): Promise<Root>;
  updateRoot(idOrSlug: string, patch: UpdateRootInput): Promise<Root>;
  deleteRoot(idOrSlug: string, opts?: { detachProjects?: boolean }): Promise<DeleteRootResult>;
  /** Score registered roots by path/kind/tags/github_org (behaves identically in both transports). */
  matchRoots(input: RootMatchInput): Promise<RootMatchResult[]>;

  // ---- Agents (shared registry: /v1/agents) ----
  listAgents(): Promise<Agent[]>;
  getAgent(idOrSlug: string): Promise<Agent | null>;
  createAgent(input: CreateAgentInput): Promise<Agent>;

  // ---- Recipes (shared registry: /v1/recipes) ----
  listRecipes(): Promise<Recipe[]>;
  getRecipe(idOrSlug: string): Promise<Recipe | null>;
  createRecipe(input: CreateRecipeInput): Promise<Recipe>;

  // ---- Prompt-agent run ledger (on-box sub-resource) ----
  // Agent runs are recorded on-box during local prompt-agent execution; the
  // projects API server does not model them, so the api transport returns an
  // empty list rather than reading a local sqlite file the cloud project does
  // not own. This keeps the runs/handoff surfaces from split-brain reads.
  listAgentRuns(filter?: AgentRunFilter): Promise<AgentRun[]>;

  // ---- Per-project React Flow canvases (on-box project.db sub-resource) ----
  // The api transport does not model the per-project store server-side: reads
  // return empty, writes throw LocalOnlyOperationError. This is what stops the
  // silent local-sqlite write when the project itself lives in the cloud.
  listCanvases(project: Workspace): Promise<ProjectCanvas[]>;
  getCanvas(project: Workspace, idOrSlug: string): Promise<ProjectCanvas | null>;
  createCanvas(project: Workspace, input: CreateProjectCanvasInput, ctx?: MutationContext): Promise<ProjectCanvas>;
  ensureDefaultCanvas(project: ProjectStoreProject): Promise<ProjectCanvas>;

  // ---- Per-project data models & records (on-box project.db sub-resource) ----
  listDataModels(project: Workspace): Promise<ProjectDataModel[]>;
  createDataModel(project: Workspace, input: CreateProjectDataModelInput, ctx?: MutationContext): Promise<ProjectDataModel>;
  listDataRecords(project: Workspace, modelId: string): Promise<ProjectDataRecord[]>;
  createDataRecord(project: Workspace, input: CreateProjectDataRecordInput, ctx?: MutationContext): Promise<ProjectDataRecord>;

  // ---- Project <-> OpenLoops links (on-box project.db sub-resource) ----
  listLoopLinks(project: Workspace): Promise<ProjectLoopLink[]>;
  linkLoop(project: Workspace, input: LinkProjectLoopInput, ctx?: MutationContext): Promise<ProjectLoopLink>;
  listLoopSummaries(project: Workspace, options?: { includeRuns?: boolean; runLimit?: number }): Promise<ProjectLoopSummary[]>;
  inspectAppStore(project: Workspace): Promise<ProjectStoreSummary>;
  inspectAppStoreWithLoops(project: Workspace, options?: { includeRuns?: boolean }): Promise<ProjectStoreSummary>;

  // ---- Project/run budgets & audited spend (on-box governance sub-resource) ----
  createBudget(input: CreateProjectBudgetInput): Promise<ProjectBudget>;
  listBudgets(context?: ProjectBudgetContext): Promise<ProjectBudget[]>;
  getBudgetStatuses(context?: ProjectBudgetContext): Promise<ProjectBudgetStatus[]>;
  resetBudget(id: string): Promise<ProjectBudget>;
  recordSpend(input: ProjectSpendInput): Promise<ProjectBudgetSpend>;

  // ---- tmux profiles (machine-local runtime resource) ----
  // tmux is a machine-local construct: a tmux server runs on THIS box, so saved
  // window-layout profiles live on the box that runs tmux and resolve against
  // local sqlite in BOTH transports. They are deliberately NOT part of the
  // shared cloud registry (there is no `/v1/tmux-profiles` endpoint), but every
  // command still routes through the Store so nothing touches sqlite directly.
  listTmuxProfiles(): Promise<TmuxProfile[]>;
  getTmuxProfile(idOrSlug: string): Promise<TmuxProfile | null>;
  createTmuxProfile(input: CreateTmuxProfileInput): Promise<TmuxProfile>;
  addTmuxProfileWindow(input: CreateTmuxProfileWindowInput & { profile_id: string }): Promise<TmuxProfileWindow>;
  listTmuxProfileWindows(profileId: string): Promise<TmuxProfileWindow[]>;

  // ---- Conversations channel link (works in BOTH transports) ----
  // Channel derivation is pure and channel creation is a machine-local side
  // effect, but the integration link + audit event persist through the Store so
  // they land on the project record wherever it lives (local or cloud).
  ensureChannel(project: Workspace, options?: StoreEnsureChannelOptions): Promise<ProjectChannelEnsureResult>;
}

// --------------------------------------------------------------------------
// Local transport (on-box sqlite)
// --------------------------------------------------------------------------

function withLock<T>(workspaceId: string, ctx: MutationContext | undefined, reason: string, fn: () => T): T {
  const key = `workspace:${workspaceId}`;
  try {
    acquireWorkspaceLock({ lock_key: key, workspace_id: workspaceId, agent_id: ctx?.agentId, reason, ttl_seconds: 600 });
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

/**
 * tmux profiles are a machine-local runtime resource. tmux always runs on THIS
 * box, so its saved window-layout profiles resolve against local sqlite in
 * BOTH transports (local and api/cloud) — they are not shared cloud state.
 * Both Store transports delegate here so the "route through the Store"
 * invariant holds (no command touches sqlite directly) without pretending
 * profiles live in the cloud.
 */
const machineLocalTmuxProfiles = {
  listTmuxProfiles: async (): Promise<TmuxProfile[]> => dbListTmuxProfiles(),
  getTmuxProfile: async (idOrSlug: string): Promise<TmuxProfile | null> => dbResolveTmuxProfile(idOrSlug),
  createTmuxProfile: async (input: CreateTmuxProfileInput): Promise<TmuxProfile> => dbCreateTmuxProfile(input),
  addTmuxProfileWindow: async (input: CreateTmuxProfileWindowInput & { profile_id: string }): Promise<TmuxProfileWindow> =>
    dbAddTmuxProfileWindow(input),
  listTmuxProfileWindows: async (profileId: string): Promise<TmuxProfileWindow[]> => dbListTmuxProfileWindows(profileId),
} as const;

function mutationFields(ctx?: MutationContext): Pick<UpdateWorkspaceInput, "agent_id" | "source" | "command" | "prompt"> {
  return {
    agent_id: ctx?.agentId,
    source: ctx?.source ?? "cli",
    command: ctx?.command,
    prompt: ctx?.prompt,
  };
}

class LocalProjectStore implements ProjectStore {
  readonly mode = "local" as const;
  readonly baseUrl = null;

  async listProjects(filter?: WorkspaceFilter): Promise<Workspace[]> {
    return dbListWorkspaces(filter ?? {});
  }

  async getProject(idOrSlug: string): Promise<Workspace | null> {
    return dbResolveWorkspace(idOrSlug);
  }

  async resolveTarget(target: string | undefined, options?: ProjectResolverOptions): Promise<Workspace> {
    return resolveRegisteredProjectTargetOrThrow(target, options).project;
  }

  async createProject(input: CreateWorkspaceInput): Promise<Workspace> {
    return dbCreateWorkspace(input);
  }

  async updateProject(id: string, patch: UpdateWorkspaceInput): Promise<Workspace> {
    return withLock(id, { agentId: patch.agent_id, source: patch.source, command: patch.command }, "project update", () =>
      dbUpdateWorkspace(id, patch),
    );
  }

  async archiveProject(id: string, ctx?: MutationContext): Promise<Workspace> {
    return withLock(id, ctx, "project archive", () => dbArchiveWorkspace(id, mutationFields(ctx)));
  }

  async unarchiveProject(id: string, ctx?: MutationContext): Promise<Workspace> {
    return withLock(id, ctx, "project unarchive", () => dbUnarchiveWorkspace(id, mutationFields(ctx)));
  }

  async deleteProject(id: string, opts: { hard?: boolean }, ctx?: MutationContext): Promise<DeleteProjectResult> {
    const res = withLock(id, ctx, "project delete", () => dbDeleteWorkspace(id, { ...mutationFields(ctx), hard: opts.hard }));
    return { workspace: res.workspace, hard: res.hard, id: res.workspace.id };
  }

  async listEvents(idOrSlug: string, _limit?: number): Promise<WorkspaceEvent[]> {
    const project = dbResolveWorkspace(idOrSlug);
    if (!project) throw new Error(`Project not found: ${idOrSlug}`);
    return dbListWorkspaceEvents(project.id);
  }

  async recordEvent(idOrSlug: string, input: RecordEventInput): Promise<WorkspaceEvent> {
    const project = dbResolveWorkspace(idOrSlug);
    if (!project) throw new Error(`Project not found: ${idOrSlug}`);
    return dbRecordWorkspaceEvent({
      workspace_id: project.id,
      agent_id: input.agentId,
      event_type: input.event_type,
      source: input.source,
      prompt: input.prompt,
      command: input.command,
      before: input.before,
      after: input.after,
      metadata: input.metadata,
    });
  }

  async getProjectAgents(id: string): Promise<WorkspaceAgentAssignment[]> {
    return dbListWorkspaceAgents(id);
  }

  async assignAgent(idOrSlug: string, input: AssignAgentInput): Promise<WorkspaceAgentAssignment> {
    const project = dbResolveWorkspace(idOrSlug);
    if (!project) throw new Error(`Project not found: ${idOrSlug}`);
    const role = input.role ?? "contributor";
    return withLock(project.id, { agentId: input.assignedBy, source: input.source, command: input.command }, "project agent assign", () => {
      const assignment = dbAssignAgentToWorkspace(project.id, input.agentId, role, input.assignedBy, input.metadata);
      dbRecordWorkspaceEvent({
        workspace_id: project.id,
        agent_id: input.assignedBy,
        event_type: "agent_assigned",
        source: input.source ?? "cli",
        command: input.command,
        after: {
          agent_id: input.agentId,
          role: assignment.role,
          assignment_id: assignment.id,
        },
      });
      return assignment;
    });
  }

  async getProjectLocations(id: string): Promise<WorkspaceLocation[]> {
    return dbListWorkspaceLocations(id);
  }

  async addLocation(idOrSlug: string, input: AddLocationInput): Promise<AddLocationResult> {
    const project = dbResolveWorkspace(idOrSlug);
    if (!project) throw new Error(`Project not found: ${idOrSlug}`);
    return withLock(project.id, { agentId: input.agentId, source: input.source, command: input.command }, "project location add", () => {
      const location = dbAddWorkspaceLocation({
        workspace_id: project.id,
        path: input.path,
        label: input.label,
        kind: input.kind,
        is_primary: input.isPrimary,
        metadata: input.metadata,
        agent_id: input.agentId,
        source: input.source ?? "cli",
        command: input.command,
      });
      const updated = dbResolveWorkspace(project.id) ?? project;
      return { project: updated, location };
    });
  }

  async listLocks(): Promise<WorkspaceLock[]> {
    return dbListWorkspaceLocks();
  }

  async acquireLock(input: AcquireLockInput): Promise<WorkspaceLock> {
    return acquireWorkspaceLock({
      lock_key: input.key,
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      reason: input.reason,
      ttl_seconds: input.ttlSeconds,
    });
  }

  async releaseLock(key: string): Promise<boolean> {
    return releaseWorkspaceLock(key);
  }

  async listRoots(): Promise<Root[]> {
    return dbListRoots();
  }

  async getRoot(idOrSlug: string): Promise<Root | null> {
    return dbGetRoot(idOrSlug) ?? dbGetRootBySlug(idOrSlug);
  }

  async createRoot(input: CreateRootInput): Promise<Root> {
    return dbCreateRoot(input);
  }

  async updateRoot(idOrSlug: string, patch: UpdateRootInput): Promise<Root> {
    const root = await this.getRoot(idOrSlug);
    if (!root) throw new Error(`Root not found: ${idOrSlug}`);
    return dbUpdateRoot(root.id, patch);
  }

  async deleteRoot(idOrSlug: string, opts?: { detachProjects?: boolean }): Promise<DeleteRootResult> {
    const root = await this.getRoot(idOrSlug);
    if (!root) throw new Error(`Root not found: ${idOrSlug}`);
    return dbDeleteRoot(root.id, { detachWorkspaces: opts?.detachProjects });
  }

  async matchRoots(input: RootMatchInput): Promise<RootMatchResult[]> {
    return dbScoreRoots(input);
  }

  async listAgents(): Promise<Agent[]> {
    return dbListAgents();
  }

  async getAgent(idOrSlug: string): Promise<Agent | null> {
    return dbGetAgent(idOrSlug) ?? dbGetAgentBySlug(idOrSlug);
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    return dbCreateAgent(input);
  }

  async listRecipes(): Promise<Recipe[]> {
    return dbListRecipes();
  }

  async getRecipe(idOrSlug: string): Promise<Recipe | null> {
    return dbGetRecipe(idOrSlug) ?? dbGetRecipeBySlug(idOrSlug);
  }

  async createRecipe(input: CreateRecipeInput): Promise<Recipe> {
    return dbCreateRecipe(input);
  }

  async listAgentRuns(filter?: AgentRunFilter): Promise<AgentRun[]> {
    return dbListAgentRuns(filter ?? {});
  }

  // ---- Canvases ----
  async listCanvases(project: Workspace): Promise<ProjectCanvas[]> {
    return dbListProjectCanvases(project);
  }

  async getCanvas(project: Workspace, idOrSlug: string): Promise<ProjectCanvas | null> {
    return dbGetProjectCanvas(project, idOrSlug);
  }

  async createCanvas(project: Workspace, input: CreateProjectCanvasInput, ctx?: MutationContext): Promise<ProjectCanvas> {
    return withLock(project.id, ctx, "project canvas create", () => dbCreateProjectCanvas(project, input));
  }

  async ensureDefaultCanvas(project: ProjectStoreProject): Promise<ProjectCanvas> {
    return dbEnsureDefaultProjectCanvas(project);
  }

  // ---- Data models & records ----
  async listDataModels(project: Workspace): Promise<ProjectDataModel[]> {
    return dbListProjectDataModels(project);
  }

  async createDataModel(project: Workspace, input: CreateProjectDataModelInput, ctx?: MutationContext): Promise<ProjectDataModel> {
    return withLock(project.id, ctx, "project data model create", () => dbCreateProjectDataModel(project, input));
  }

  async listDataRecords(project: Workspace, modelId: string): Promise<ProjectDataRecord[]> {
    return dbListProjectDataRecords(project, modelId);
  }

  async createDataRecord(project: Workspace, input: CreateProjectDataRecordInput, ctx?: MutationContext): Promise<ProjectDataRecord> {
    return withLock(project.id, ctx, "project data record create", () => dbCreateProjectDataRecord(project, input));
  }

  // ---- Loop links ----
  async listLoopLinks(project: Workspace): Promise<ProjectLoopLink[]> {
    return dbListProjectLoopLinks(project);
  }

  async linkLoop(project: Workspace, input: LinkProjectLoopInput, ctx?: MutationContext): Promise<ProjectLoopLink> {
    return withLock(project.id, ctx, "project OpenLoops link", () => dbLinkProjectLoop(project, input));
  }

  async listLoopSummaries(project: Workspace, options?: { includeRuns?: boolean; runLimit?: number }): Promise<ProjectLoopSummary[]> {
    return dbListProjectLoopSummaries(project, options);
  }

  async inspectAppStore(project: Workspace): Promise<ProjectStoreSummary> {
    return dbInspectProjectStore(project);
  }

  async inspectAppStoreWithLoops(project: Workspace, options?: { includeRuns?: boolean }): Promise<ProjectStoreSummary> {
    return dbInspectProjectStoreWithLoops(project, options);
  }

  // ---- Budgets & spend ----
  async createBudget(input: CreateProjectBudgetInput): Promise<ProjectBudget> {
    return dbCreateProjectBudget(input);
  }

  async listBudgets(context?: ProjectBudgetContext): Promise<ProjectBudget[]> {
    return dbListProjectBudgets(context);
  }

  async getBudgetStatuses(context?: ProjectBudgetContext): Promise<ProjectBudgetStatus[]> {
    return dbGetProjectBudgetStatuses(context);
  }

  async resetBudget(id: string): Promise<ProjectBudget> {
    return dbResetProjectBudget(id);
  }

  async recordSpend(input: ProjectSpendInput): Promise<ProjectBudgetSpend> {
    return dbRecordProjectSpend(input);
  }

  // ---- tmux profiles (machine-local runtime resource; see shared impl) ----
  listTmuxProfiles = machineLocalTmuxProfiles.listTmuxProfiles;
  getTmuxProfile = machineLocalTmuxProfiles.getTmuxProfile;
  createTmuxProfile = machineLocalTmuxProfiles.createTmuxProfile;
  addTmuxProfileWindow = machineLocalTmuxProfiles.addTmuxProfileWindow;
  listTmuxProfileWindows = machineLocalTmuxProfiles.listTmuxProfileWindows;

  // ---- Channel ----
  async ensureChannel(project: Workspace, options?: StoreEnsureChannelOptions): Promise<ProjectChannelEnsureResult> {
    return ensureProjectChannelViaStore(this, project, options);
  }
}

// --------------------------------------------------------------------------
// Api transport (HTTP /v1 + bearer key)
// --------------------------------------------------------------------------

function listQuery(filter?: WorkspaceFilter): QueryParams {
  if (!filter) return {};
  return {
    kind: filter.kind,
    status: filter.status,
    query: filter.query,
    root_id: filter.root_id,
    tag: filter.tags && filter.tags.length > 0 ? filter.tags[0] : undefined,
    limit: filter.limit,
    offset: filter.offset,
  };
}

/**
 * The shared cloud registry resolves a project only by id or slug. Path,
 * marker and relative targets (".", "..", "/abs", "~/x", "a/b") are a
 * machine-local concept the cloud does not model — and, worse, sending "." or
 * ".." lets the URL parser collapse the dot-segment so `/projects/.` becomes
 * the collection route `/projects/`, returning a LIST payload that then
 * masquerades as a single project (and crashes renderers that read
 * `project.metadata`). We never send those to the API; callers fall back to
 * their local path/marker handling when this returns false.
 */
function isCloudResolvableId(idOrSlug: string): boolean {
  const target = idOrSlug.trim();
  if (!target) return false;
  if (target === "." || target === "..") return false;
  if (target.startsWith("~")) return false;
  if (target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) return false;
  if (target.includes("/") || target.includes("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(target)) return false; // windows absolute path
  return true;
}

/**
 * Guarantee the shape the LocalStore always produces: `metadata`/`integrations`
 * are objects and `tags` is an array. The projects API returns these
 * populated, but normalizing at the transport boundary keeps every downstream
 * renderer (`projectManagementSummary` et al.) safe even if a row ever comes
 * back with a null column. Rejects non-object payloads (e.g. a list wrapper)
 * so a malformed response can never masquerade as a single project.
 */
function normalizeApiWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const ws = raw as Partial<Workspace>;
  if (typeof ws.id !== "string" || typeof ws.slug !== "string") return null;
  return {
    ...(ws as Workspace),
    tags: Array.isArray(ws.tags) ? ws.tags : [],
    integrations: (ws.integrations ?? {}) as Workspace["integrations"],
    metadata: (ws.metadata ?? {}) as JsonObject,
  };
}

class ApiProjectStore implements ProjectStore {
  readonly mode = "api" as const;
  readonly baseUrl: string;
  private readonly client: StorageClient;

  constructor(client: StorageClient) {
    this.client = client;
    this.baseUrl = client.baseUrl;
  }

  async listProjects(filter?: WorkspaceFilter): Promise<Workspace[]> {
    const raw = await this.client.transport.get<{ workspaces?: Workspace[]; projects?: Workspace[] }>("/projects", {
      query: listQuery(filter),
    });
    const rows = raw.workspaces ?? raw.projects ?? [];
    return rows.map((row) => normalizeApiWorkspace(row) ?? (row as Workspace));
  }

  async getProject(idOrSlug: string): Promise<Workspace | null> {
    // Path/marker/relative targets are machine-local and not resolvable by the
    // cloud registry; never send them to the API (see isCloudResolvableId).
    if (!isCloudResolvableId(idOrSlug)) return null;
    return normalizeApiWorkspace(await this.client.get<Workspace>(RESOURCE, idOrSlug));
  }

  async resolveTarget(target: string | undefined): Promise<Workspace> {
    const idOrSlug = target?.trim();
    if (!idOrSlug) throw new Error("Project not found: (no target provided)");
    const project = await this.getProject(idOrSlug);
    if (!project) throw new Error(`Project not found: ${idOrSlug}`);
    return project;
  }

  async createProject(input: CreateWorkspaceInput): Promise<Workspace> {
    const created = await this.client.create<Workspace>(RESOURCE, input);
    return normalizeApiWorkspace(created) ?? created;
  }

  async updateProject(id: string, patch: UpdateWorkspaceInput): Promise<Workspace> {
    const updated = await this.client.update<Workspace>(RESOURCE, id, patch);
    return normalizeApiWorkspace(updated) ?? updated;
  }

  async archiveProject(id: string): Promise<Workspace> {
    const ws = await this.client.transport.post<Workspace>(`/projects/${encodeURIComponent(id)}/archive`);
    return normalizeApiWorkspace(ws) ?? ws;
  }

  async unarchiveProject(id: string): Promise<Workspace> {
    const ws = await this.client.transport.post<Workspace>(`/projects/${encodeURIComponent(id)}/unarchive`);
    return normalizeApiWorkspace(ws) ?? ws;
  }

  async deleteProject(id: string, opts: { hard?: boolean }): Promise<DeleteProjectResult> {
    const q = opts.hard ? "?hard=true" : "";
    const res = await this.client.transport.del<{
      workspace?: Workspace;
      project?: Workspace;
      hard?: boolean;
      id?: string;
    }>(`/projects/${encodeURIComponent(id)}${q}`);
    const workspace = normalizeApiWorkspace(res?.workspace ?? res?.project);
    return { workspace, hard: Boolean(res?.hard), id: res?.id ?? workspace?.id ?? id };
  }

  async listEvents(idOrSlug: string, limit?: number): Promise<WorkspaceEvent[]> {
    const raw = await this.client.transport.get<{ events?: WorkspaceEvent[] }>(
      `/projects/${encodeURIComponent(idOrSlug)}/events`,
      { query: limit ? { limit } : {} },
    );
    return raw.events ?? [];
  }

  async recordEvent(idOrSlug: string, input: RecordEventInput): Promise<WorkspaceEvent> {
    const raw = await this.client.transport.post<{ event?: WorkspaceEvent } | WorkspaceEvent>(
      `/projects/${encodeURIComponent(idOrSlug)}/events`,
      {
        event_type: input.event_type,
        source: input.source,
        agent_id: input.agentId,
        prompt: input.prompt,
        command: input.command,
        before: input.before,
        after: input.after,
        metadata: input.metadata,
      },
    );
    return (raw as { event?: WorkspaceEvent }).event ?? (raw as WorkspaceEvent);
  }

  // Per-project agents/locations are on-box sub-resources that the projects
  // API server does not model; the cloud detail view omits them by design.
  async getProjectAgents(): Promise<WorkspaceAgentAssignment[]> {
    return [];
  }

  async assignAgent(): Promise<WorkspaceAgentAssignment> {
    throw new LocalOnlyOperationError("assign agent to project");
  }

  async getProjectLocations(): Promise<WorkspaceLocation[]> {
    return [];
  }

  async addLocation(): Promise<AddLocationResult> {
    throw new LocalOnlyOperationError("add project location");
  }

  // Mutation locks are a machine-local coordination primitive; cloud writes are
  // atomic server-side so there is no shared lock table to expose.
  async listLocks(): Promise<WorkspaceLock[]> {
    return [];
  }

  async acquireLock(): Promise<WorkspaceLock> {
    throw new LocalOnlyOperationError("acquire project lock");
  }

  async releaseLock(): Promise<boolean> {
    return false;
  }

  async listRoots(): Promise<Root[]> {
    const raw = await this.client.transport.get<{ roots?: Root[] }>("/roots");
    return raw.roots ?? [];
  }

  async getRoot(idOrSlug: string): Promise<Root | null> {
    return this.client.get<Root>("roots", idOrSlug);
  }

  async createRoot(input: CreateRootInput): Promise<Root> {
    return this.client.create<Root>("roots", input);
  }

  async updateRoot(idOrSlug: string, patch: UpdateRootInput): Promise<Root> {
    return this.client.update<Root>("roots", idOrSlug, patch);
  }

  async deleteRoot(idOrSlug: string, opts?: { detachProjects?: boolean }): Promise<DeleteRootResult> {
    const root = await this.getRoot(idOrSlug);
    if (!root) throw new Error(`Root not found: ${idOrSlug}`);
    const q = opts?.detachProjects ? "?detach=true" : "";
    const res = await this.client.transport.del<{ detached_workspaces?: number }>(
      `/roots/${encodeURIComponent(root.id)}${q}`,
    );
    return { root, detached_workspaces: res?.detached_workspaces ?? 0 };
  }

  async matchRoots(input: RootMatchInput): Promise<RootMatchResult[]> {
    return rankRoots(await this.listRoots(), input);
  }

  async listAgents(): Promise<Agent[]> {
    const raw = await this.client.transport.get<{ agents?: Agent[] }>("/agents");
    return raw.agents ?? [];
  }

  async getAgent(idOrSlug: string): Promise<Agent | null> {
    return this.client.get<Agent>("agents", idOrSlug);
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    return this.client.create<Agent>("agents", input);
  }

  async listRecipes(): Promise<Recipe[]> {
    const raw = await this.client.transport.get<{ recipes?: Recipe[] }>("/recipes");
    return raw.recipes ?? [];
  }

  async getRecipe(idOrSlug: string): Promise<Recipe | null> {
    return this.client.get<Recipe>("recipes", idOrSlug);
  }

  async createRecipe(input: CreateRecipeInput): Promise<Recipe> {
    return this.client.create<Recipe>("recipes", input);
  }

  // Agent runs are an on-box ledger the projects API server does not model;
  // returning empty avoids reading a local sqlite file the cloud project does
  // not own (the split-brain the runs/handoff surfaces would otherwise hit).
  async listAgentRuns(): Promise<AgentRun[]> {
    return [];
  }

  // The per-project React Flow store, custom data models/records, OpenLoops
  // links and budgets/spend are on-box sub-resources under
  // $HASNA_PROJECTS_HOME/data/<id>; the projects API server does not model
  // them. Reads return empty and writes throw rather than silently reading or
  // writing a local sqlite file that does not hold the cloud project's data.
  async listCanvases(): Promise<ProjectCanvas[]> {
    return [];
  }

  async getCanvas(): Promise<ProjectCanvas | null> {
    return null;
  }

  async createCanvas(): Promise<ProjectCanvas> {
    throw new LocalOnlyOperationError("create project canvas");
  }

  async ensureDefaultCanvas(): Promise<ProjectCanvas> {
    throw new LocalOnlyOperationError("ensure default project canvas");
  }

  async listDataModels(): Promise<ProjectDataModel[]> {
    return [];
  }

  async createDataModel(): Promise<ProjectDataModel> {
    throw new LocalOnlyOperationError("create project data model");
  }

  async listDataRecords(): Promise<ProjectDataRecord[]> {
    return [];
  }

  async createDataRecord(): Promise<ProjectDataRecord> {
    throw new LocalOnlyOperationError("create project data record");
  }

  async listLoopLinks(): Promise<ProjectLoopLink[]> {
    return [];
  }

  async linkLoop(): Promise<ProjectLoopLink> {
    throw new LocalOnlyOperationError("link project OpenLoops loop");
  }

  async listLoopSummaries(): Promise<ProjectLoopSummary[]> {
    return [];
  }

  async inspectAppStore(project: Workspace): Promise<ProjectStoreSummary> {
    return emptyAppStoreSummary(project);
  }

  async inspectAppStoreWithLoops(project: Workspace): Promise<ProjectStoreSummary> {
    return { ...emptyAppStoreSummary(project), loops: [] };
  }

  async createBudget(): Promise<ProjectBudget> {
    throw new LocalOnlyOperationError("create project budget");
  }

  async listBudgets(): Promise<ProjectBudget[]> {
    return [];
  }

  async getBudgetStatuses(): Promise<ProjectBudgetStatus[]> {
    return [];
  }

  async resetBudget(): Promise<ProjectBudget> {
    throw new LocalOnlyOperationError("reset project budget");
  }

  async recordSpend(): Promise<ProjectBudgetSpend> {
    throw new LocalOnlyOperationError("record project spend");
  }

  // tmux profiles are a machine-local runtime resource (tmux runs on THIS box),
  // so even in api/cloud mode they resolve against local sqlite rather than a
  // nonexistent cloud endpoint. See machineLocalTmuxProfiles.
  listTmuxProfiles = machineLocalTmuxProfiles.listTmuxProfiles;
  getTmuxProfile = machineLocalTmuxProfiles.getTmuxProfile;
  createTmuxProfile = machineLocalTmuxProfiles.createTmuxProfile;
  addTmuxProfileWindow = machineLocalTmuxProfiles.addTmuxProfileWindow;
  listTmuxProfileWindows = machineLocalTmuxProfiles.listTmuxProfileWindows;

  // Channel derivation is pure; persistence routes through this same api
  // transport (updateProject/recordEvent) so the link lands on the cloud
  // project record.
  async ensureChannel(project: Workspace, options?: StoreEnsureChannelOptions): Promise<ProjectChannelEnsureResult> {
    return ensureProjectChannelViaStore(this, project, options);
  }
}

/** Empty on-box store summary reported by the api transport (nothing local). */
function emptyAppStoreSummary(project: Workspace): ProjectStoreSummary {
  const paths = getProjectStorePaths(project);
  return {
    project_id: paths.project_id,
    paths,
    exists: false,
    schema_version: PROJECT_STORE_SCHEMA_VERSION,
    counts: { canvases: 0, data_models: 0, data_records: 0, loop_links: 0 },
  };
}

// --------------------------------------------------------------------------
// Resolver
// --------------------------------------------------------------------------

let cached: ProjectStore | null = null;

/**
 * Resolve the active projects Store from the environment. Returns an
 * ApiProjectStore when the flip resolves to cloud (mode=self_hosted/cloud +
 * API_URL + API_KEY), else a LocalProjectStore. Throws if cloud was requested
 * but is misconfigured (so callers never silently read the wrong dataset).
 */
export function resolveProjectStore(
  env: Env = process.env,
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>,
): ProjectStore {
  if (env === process.env && cached) return cached;
  const resolved = resolveStorageClient(APP, env, fetchImpl);
  const store: ProjectStore =
    resolved.transport === "cloud-http" ? new ApiProjectStore(resolved.client) : new LocalProjectStore();
  if (env === process.env) cached = store;
  return store;
}

/** Test/di seam: clear the process-env cached store. */
export function __resetProjectStore(): void {
  cached = null;
}
