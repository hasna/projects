// Public SDK exports
export * from "./types/workspace.js";
export { getDatabase } from "./db/database.js";
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
  createWorkspace,
  updateWorkspace,
  archiveWorkspace,
  unarchiveWorkspace,
  deleteWorkspace,
  getWorkspace,
  getWorkspaceBySlug,
  getWorkspaceByPath,
  listWorkspaces,
  resolveWorkspace,
  addWorkspaceLocation,
  listWorkspaceLocations,
  assignAgentToWorkspace,
  recordWorkspaceEvent,
  listWorkspaceEvents,
  startAgentRun,
  completeAgentRun,
  listAgentRuns,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  listWorkspaceLocks,
  linkWorkspaceIntegrations,
  inferWorkspaceKind,
  migrateLegacyProjectsToWorkspaces,
  renderTemplate,
  workspaceSlugify,
} from "./db/workspaces.js";
export {
  applyWorkspaceTmux,
  applyWorkspaceTmuxProfile,
  buildWorkspaceMarker,
  prepareWorkspaceDirectory,
  tmuxProfileToSpec,
  workspaceMarkerPath,
  writeWorkspaceMarker,
} from "./lib/workspace-runtime.js";
export { doctorWorkspace, doctorWorkspaces } from "./lib/workspace-doctor.js";
export { builtInWorkspaceRecipes, ensureBuiltInWorkspaceRecipes } from "./lib/workspace-defaults.js";
export {
  importWorkspaceFromGitHub,
  linkWorkspaceExternalIntegrations,
  normalizeWorkspaceIntegrations,
  parseGitHubRepo,
  planWorkspaceGitHubImport,
  planWorkspaceGitHubPublish,
  publishWorkspaceToGitHub,
  unpublishWorkspaceFromGitHub,
} from "./lib/workspace-github.js";
export type {
  GitHubRemoteProtocol,
  GitHubVisibility,
  WorkspaceGitHubImportOptions,
  WorkspaceGitHubImportResult,
  WorkspaceGitHubPublishOptions,
  WorkspaceGitHubPublishResult,
  WorkspaceGitHubUnpublishOptions,
  WorkspaceGitHubUnpublishResult,
} from "./lib/workspace-github.js";
export { importRegisteredRoots, importWorkspace, importWorkspaceBulk, planWorkspaceImport } from "./lib/workspace-import.js";
export { runWorkspaceLegacyMigration } from "./lib/workspace-migration.js";
export type { WorkspaceMigrationChecklistItem, WorkspaceMigrationOptions, WorkspaceMigrationReport } from "./lib/workspace-migration.js";
export {
  cleanupWorkspaceCreation,
  cleanupWorkspaceCreationTarget,
  executeWorkspaceCreation,
  planWorkspaceCreation,
} from "./lib/workspace-plan.js";
export {
  DEFAULT_WORKSPACE_AGENT_MODEL,
  resolveOpenRouterApiKey,
  runWorkspaceAgentPrompt,
} from "./lib/workspace-agent.js";
export {
  WORKSPACE_AGENT_EVAL_CASE_IDS,
  parseWorkspaceAgentEvalCaseIds,
  runWorkspaceAgentEval,
} from "./lib/workspace-agent-eval.js";
