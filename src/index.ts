// Public SDK exports. Internal modules still use storage-layer workspace names;
// the package boundary exposes the project domain.
export {
  AGENT_KINDS,
  AGENT_RUN_STATUSES,
  EVENT_SOURCES,
  PROJECT_AGENT_ROLES,
  WORKSPACE_KINDS as PROJECT_KINDS,
  WORKSPACE_STATUSES as PROJECT_STATUSES,
} from "./types/workspace.js";
export type {
  Agent,
  AgentKind,
  AgentRun,
  AgentRunStatus,
  CreateAgentInput,
  CreateRecipeInput,
  CreateRootInput,
  CreateTmuxProfileInput,
  CreateTmuxProfileWindowInput,
  CreateWorkspaceInput as CreateProjectInput,
  EventSource,
  JsonObject,
  ProjectAgentRole,
  Recipe,
  RecordWorkspaceEventInput as RecordProjectEventInput,
  Root,
  TmuxProfile,
  TmuxProfileWindow,
  UpdateRootInput,
  UpdateWorkspaceInput as UpdateProjectInput,
  Workspace as Project,
  WorkspaceAgentAssignment as ProjectAgentAssignment,
  WorkspaceEvent as ProjectEvent,
  WorkspaceIntegrations as ProjectIntegrations,
  WorkspaceKind as ProjectKind,
  WorkspaceLocation as ProjectLocation,
  WorkspaceLock as ProjectLock,
  WorkspaceStatus as ProjectStatus,
} from "./types/workspace.js";
export { getDatabase } from "./db/database.js";
export * from "./db/storage-sync.js";
export * from "./db/remote-storage.js";
export * from "./db/pg-migrations.js";
export {
  createRoot,
  getRoot,
  getRootBySlug,
  listRoots,
  updateRoot,
  deleteRoot,
  scoreRoots,
  matchRoot,
  matchRootForPath,
  createAgent,
  getAgent,
  getAgentBySlug,
  listAgents,
  ensureCliAgent,
  mergeAgentPermissions,
  createRecipe,
  getRecipe,
  getRecipeBySlug,
  listRecipes,
  createTmuxProfile,
  getTmuxProfile,
  getTmuxProfileBySlug,
  resolveTmuxProfile,
  listTmuxProfiles,
  addTmuxProfileWindow,
  listTmuxProfileWindows,
  createWorkspace as createProject,
  updateWorkspace as updateProject,
  archiveWorkspace as archiveProject,
  unarchiveWorkspace as unarchiveProject,
  deleteWorkspace as deleteProject,
  getWorkspace as getProject,
  getWorkspaceBySlug as getProjectBySlug,
  getWorkspaceByPath as getProjectByPath,
  listWorkspacesByPath as listProjectsByPath,
  listWorkspaces as listProjects,
  resolveWorkspace as resolveProject,
  addWorkspaceLocation as addProjectLocation,
  listWorkspaceLocations as listProjectLocations,
  getWorkspaceLocationByPath as getProjectLocationByPath,
  assignAgentToWorkspace as assignAgentToProject,
  listWorkspaceAgents as listProjectAgents,
  recordWorkspaceEvent as recordProjectEvent,
  listWorkspaceEvents as listProjectEvents,
  startAgentRun,
  completeAgentRun,
  listAgentRuns,
  acquireWorkspaceLock as acquireProjectLock,
  releaseWorkspaceLock as releaseProjectLock,
  listWorkspaceLocks as listProjectLocks,
  linkWorkspaceIntegrations as linkProjectIntegrations,
  inferWorkspaceKind as inferProjectKind,
  migrateLegacyProjectsToWorkspaces as migrateLegacyProjects,
  renderTemplate,
  workspaceSlugify as projectSlugify,
  generateWorkspaceId as generateProjectId,
  generateWorkspaceEventId as generateProjectEventId,
  generateWorkspaceLockId as generateProjectLockId,
} from "./db/workspaces.js";
export {
  applyWorkspaceTmux as applyProjectTmux,
  applyWorkspaceTmuxProfile as applyProjectTmuxProfile,
  buildWorkspaceMarker as buildProjectMarker,
  prepareWorkspaceDirectory as prepareProjectDirectory,
  projectMarkerPath,
  tmuxProfileToSpec,
  writeWorkspaceMarker as writeProjectMarker,
} from "./lib/workspace-runtime.js";
export type {
  ApplyWorkspaceTmuxOptions as ApplyProjectTmuxOptions,
  PrepareWorkspaceOptions as PrepareProjectOptions,
  WorkspaceMarker as ProjectMarker,
  WorkspaceRuntimeAction as ProjectRuntimeAction,
  WorkspaceTmuxResult as ProjectTmuxResult,
  WorkspaceTmuxWindowSpec as ProjectTmuxWindowSpec,
} from "./lib/workspace-runtime.js";
export { doctorWorkspace as doctorProject, doctorWorkspaces as doctorProjects } from "./lib/workspace-doctor.js";
export { builtInWorkspaceRecipes as builtInProjectRecipes, ensureBuiltInWorkspaceRecipes as ensureBuiltInProjectRecipes } from "./lib/workspace-defaults.js";
export {
  importWorkspaceFromGitHub as importProjectFromGitHub,
  linkWorkspaceExternalIntegrations as linkProjectExternalIntegrations,
  normalizeWorkspaceIntegrations as normalizeProjectIntegrations,
  parseGitHubRepo,
  planWorkspaceGitHubImport as planProjectGitHubImport,
  planWorkspaceGitHubPublish as planProjectGitHubPublish,
  publishWorkspaceToGitHub as publishProjectToGitHub,
  unpublishWorkspaceFromGitHub as unpublishProjectFromGitHub,
} from "./lib/workspace-github.js";
export type {
  GitHubRemoteProtocol,
  GitHubVisibility,
  WorkspaceGitHubImportOptions as ProjectGitHubImportOptions,
  WorkspaceGitHubImportResult as ProjectGitHubImportResult,
  WorkspaceGitHubPublishOptions as ProjectGitHubPublishOptions,
  WorkspaceGitHubPublishResult as ProjectGitHubPublishResult,
  WorkspaceGitHubUnpublishOptions as ProjectGitHubUnpublishOptions,
  WorkspaceGitHubUnpublishResult as ProjectGitHubUnpublishResult,
} from "./lib/workspace-github.js";
export { importRegisteredRoots, importWorkspace as importProject, importWorkspaceBulk as importProjectBulk, planWorkspaceImport as planProjectImport } from "./lib/workspace-import.js";
export {
  PROJECT_START_AGENTS,
  PROJECT_START_SESSION_POLICIES,
  parseProjectStartAgent,
  parseProjectStartSessionPolicy,
  projectStartCommand,
  resolveProjectStartTarget,
  startProject,
} from "./lib/project-start.js";
export type {
  ProjectStartAgent,
  ProjectStartOptions,
  ProjectStartResolution,
  ProjectStartResult,
  ProjectStartSessionPolicy,
} from "./lib/project-start.js";
export { projectTmuxStatus } from "./lib/project-tmux-status.js";
export type { ProjectTmuxStatusOptions, ProjectTmuxStatusResult } from "./lib/project-tmux-status.js";
export {
  isProjectDirectory,
  isProjectPathLike,
  normalizeProjectPath,
  readProjectMarker,
  resolveRegisteredProjectTarget,
  resolveRegisteredProjectTargetOrThrow,
} from "./lib/project-resolver.js";
export type {
  ProjectMarkerReference,
  ProjectResolverOptions,
  ProjectResolverSource,
  ProjectTargetResolution,
} from "./lib/project-resolver.js";
export {
  PROJECT_MANAGEMENT_TAXONOMY,
  PROJECT_PRIORITIES,
  PROJECT_STAGES,
  expandProjectIntegrationUnlinkKey,
  expandProjectIntegrationUnlinkKeys,
  hasProjectIntegrationFields,
  hasProjectManagementFields,
  mergeProjectIntegrationFields,
  mergeProjectManagementMetadata,
  mergeProjectTags,
  projectDashboardSummary,
  projectExternalLinksSummary,
  projectManagementSummary,
  projectPathHealth,
  projectWithManagement,
  removeProjectTags,
  unlinkProjectIntegrationFields,
} from "./lib/project-management.js";
export type {
  ProjectDashboardSummary,
  ProjectExternalLinksSummary,
  ProjectIntegrationUnlinkGroup,
  ProjectIntegrationInput,
  ProjectManagementMetadataInput,
  ProjectManagementSummary,
  ProjectPathHealth,
  ProjectPriority,
  ProjectStage,
} from "./lib/project-management.js";
export { runWorkspaceLegacyMigration as runLegacyProjectMigration } from "./lib/workspace-migration.js";
export type {
  WorkspaceMigrationChecklistItem as LegacyProjectMigrationChecklistItem,
  WorkspaceMigrationOptions as LegacyProjectMigrationOptions,
  WorkspaceMigrationReport as LegacyProjectMigrationReport,
} from "./lib/workspace-migration.js";
export {
  cleanupWorkspaceCreation as cleanupProjectCreation,
  cleanupWorkspaceCreationTarget as cleanupProjectCreationTarget,
  executeWorkspaceCreation as executeProjectCreation,
  planWorkspaceCreation as planProjectCreation,
} from "./lib/workspace-plan.js";
export type {
  WorkspaceCreationCleanup as ProjectCreationCleanup,
  WorkspaceCreationCleanupAction as ProjectCreationCleanupAction,
  WorkspaceCreationCleanupTarget as ProjectCreationCleanupTarget,
  WorkspaceCreationExecution as ProjectCreationExecution,
  WorkspaceCreationPlan as ProjectCreationPlan,
  WorkspaceCreationPlanAction as ProjectCreationPlanAction,
  WorkspaceCreationPlanInput as ProjectCreationPlanInput,
} from "./lib/workspace-plan.js";
export {
  DEFAULT_WORKSPACE_AGENT_MODEL as DEFAULT_PROJECT_AGENT_MODEL,
  PROJECT_AGENT_DESTRUCTIVE_TOOLS,
  PROJECT_AGENT_MUTATION_TOOLS,
  PROJECT_AGENT_READ_TOOLS,
  auditProjectAgentToolCalls,
  buildProjectAgentToolCatalog,
  buildWorkspaceAgentSystemPrompt as buildProjectAgentSystemPrompt,
  buildWorkspaceInventoryContext as buildProjectInventoryContext,
  resolveOpenRouterApiKey,
  runWorkspaceAgentPrompt as runProjectAgentPrompt,
  shouldRunProjectCreateFallback,
} from "./lib/workspace-agent.js";
export type {
  ProjectAgentMutationAudit,
  WorkspaceAgentPromptOptions as ProjectAgentPromptOptions,
  WorkspaceAgentPromptResult as ProjectAgentPromptResult,
} from "./lib/workspace-agent.js";
export {
  BudgetExceededError,
  assertProjectBudgets,
  assertProjectBudgetsAfterSpend,
  createProjectBudget,
  estimateProjectCostUsd,
  getProjectBudget,
  getProjectBudgetStatuses,
  listProjectBudgets,
  modelPricing,
  normalizeProjectUsage,
  openRouterCostFromMetadata,
  recordProjectSpend,
  resetProjectBudget,
} from "./lib/budget.js";
export type {
  CreateProjectBudgetInput,
  ProjectBudget,
  ProjectBudgetContext,
  ProjectBudgetMode,
  ProjectBudgetScopeType,
  ProjectBudgetSpend,
  ProjectBudgetStatus,
  ProjectBudgetTotals,
  ProjectBudgetWindow,
  ProjectSpendInput,
  ProjectUsage,
} from "./lib/budget.js";
export {
  WORKSPACE_AGENT_EVAL_CASE_IDS as PROJECT_AGENT_EVAL_CASE_IDS,
  parseWorkspaceAgentEvalCaseIds as parseProjectAgentEvalCaseIds,
  runWorkspaceAgentEval as runProjectAgentEval,
} from "./lib/workspace-agent-eval.js";
export {
  cleanupProjectEvalArtifacts,
  filterProjectEvalArtifacts,
  isProjectEvalArtifact,
} from "./lib/project-eval-artifacts.js";
