import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  acquireWorkspaceLock,
  createWorkspace,
  deleteWorkspace,
  generateWorkspaceId,
  getRecipe,
  getRoot,
  getWorkspaceBySlug,
  listTmuxProfileWindows,
  recordWorkspaceEvent,
  releaseWorkspaceLock,
  renderTemplate,
  resolveTmuxProfile,
  workspaceSlugify,
} from "../db/workspaces.js";
import { getDatabase } from "../db/database.js";
import type {
  CreateWorkspaceInput,
  EventSource,
  JsonObject,
  Recipe,
  Root,
  Workspace,
  WorkspaceIntegrations,
  WorkspaceKind,
  WorkspaceLock,
} from "../types/workspace.js";
import {
  deriveProjectChannel,
  ensureProjectChannel,
  shouldEnsureProjectChannel,
  type ConversationsChannelRunner,
  type ProjectChannelEnsureResult,
} from "./project-channel.js";
import {
  applyWorkspaceTmux,
  applyWorkspaceTmuxProfile,
  prepareWorkspaceDirectory,
  type WorkspaceRuntimeAction,
  type WorkspaceTmuxResult,
  type WorkspaceTmuxWindowSpec,
} from "./workspace-runtime.js";
import { assertProjectWorkspaceId, projectWorkspaceStorePath } from "./project-store-paths.js";

export interface WorkspaceCreationPlanInput extends CreateWorkspaceInput {
  createDirectory?: boolean;
  gitInit?: boolean;
  writeMarker?: boolean;
  tmux?: {
    session?: string;
    windows?: WorkspaceTmuxWindowSpec[];
  };
  tmux_profile?: string;
}

export interface WorkspaceCreationPlanAction {
  type: "db" | "file" | "command" | "tmux" | "github" | "verification" | "rollback";
  action: string;
  target: string;
  status: "planned";
  metadata?: JsonObject;
}

export interface WorkspaceCreationCleanupAction extends Omit<WorkspaceCreationPlanAction, "status"> {
  status: "planned" | "completed" | "skipped" | "failed";
  message?: string;
}

export interface WorkspaceCreationPlan {
  kind: "project_creation";
  created_at: string;
  can_execute: boolean;
  warnings: string[];
  workspace: Omit<Workspace, "created_at" | "updated_at" | "last_opened_at" | "synced_at"> & {
    created_at: null;
    updated_at: null;
    last_opened_at: null;
    synced_at: null;
  };
  workspace_input: CreateWorkspaceInput;
  locks: Array<{ key: string; reason: string }>;
  db_writes: WorkspaceCreationPlanAction[];
  runtime_actions: WorkspaceRuntimeAction[];
  tmux: WorkspaceTmuxResult | null;
  commands: WorkspaceCreationPlanAction[];
  github_operations: WorkspaceCreationPlanAction[];
  verification_steps: WorkspaceCreationPlanAction[];
  rollback_actions: WorkspaceCreationPlanAction[];
}

export interface WorkspaceCreationExecution {
  dry_run: boolean;
  runtime_dry_run: boolean;
  success: boolean;
  plan: WorkspaceCreationPlan;
  workspace: Workspace | null;
  prepare: WorkspaceRuntimeAction[];
  tmux: WorkspaceTmuxResult | null;
  channel: ProjectChannelEnsureResult | null;
  locks: WorkspaceLock[];
  released_locks: string[];
  rollback_actions: WorkspaceCreationPlanAction[];
}

export interface WorkspaceCreationCleanupTarget {
  workspace_slug: string;
  primary_path?: string | null;
  rollback_actions: WorkspaceCreationPlanAction[];
}

export interface WorkspaceCreationCleanup {
  dry_run: boolean;
  success: boolean;
  workspace_slug: string;
  primary_path: string | null;
  actions: WorkspaceCreationCleanupAction[];
  errors: string[];
}

export interface ExecuteWorkspaceCreationOptions {
  db?: Database;
  dryRun?: boolean;
  runtimeDryRun?: boolean;
  lockTtlSeconds?: number;
  /** Ensure the project's conversations channel exists after creation; defaults to shouldEnsureProjectChannel(). */
  ensureChannel?: boolean;
  /** Conversations CLI runner override (used by tests). */
  channelRunner?: ConversationsChannelRunner;
  /** Registry write seam; machine-local runtime steps remain in this module. */
  createProject?: (input: CreateWorkspaceInput) => Promise<Workspace>;
}

export interface CleanupWorkspaceCreationOptions {
  db?: Database;
  dryRun?: boolean;
  agentId?: string;
  source?: EventSource;
  prompt?: string;
  command?: string;
}

function normalizeList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function uniqueWorkspaceSlug(base: string, db?: Database): string {
  const safeBase = base || "workspace";
  let candidate = safeBase;
  let suffix = 1;
  while (getWorkspaceBySlug(candidate, db)) {
    suffix++;
    candidate = `${safeBase}-${suffix}`;
  }
  return candidate;
}

function deriveWorkspacePath(input: CreateWorkspaceInput, root: Root | null, slug: string, id: string, kind: WorkspaceKind): string | null {
  if (input.primary_path) return resolve(input.primary_path);
  if (!root && kind !== "remote-only") return projectWorkspaceStorePath(id);
  if (!root) return null;
  const rendered = renderTemplate(root.path_template || root.name_template || "{slug}", {
    slug,
    name: input.name,
    kind,
    root: root.slug,
    org: root.github_org,
  });
  return isAbsolute(rendered) ? resolve(rendered) : resolve(join(root.base_path, rendered));
}

function plannedWorkspace(input: WorkspaceCreationPlanInput, db?: Database): {
  workspace: WorkspaceCreationPlan["workspace"];
  workspace_input: CreateWorkspaceInput;
  root: Root | null;
  recipe: Recipe | null;
} {
  const root = input.root_id ? getRoot(input.root_id, db) : null;
  if (input.root_id && !root) throw new Error(`Root not found: ${input.root_id}`);
  const recipe = input.recipe_id ? getRecipe(input.recipe_id, db) : null;
  if (input.recipe_id && !recipe) throw new Error(`Recipe not found: ${input.recipe_id}`);

  const id = input.id ? assertProjectWorkspaceId(input.id) : generateWorkspaceId();
  const slug = uniqueWorkspaceSlug(input.slug ?? workspaceSlugify(input.name), db);
  const kind = input.kind ?? recipe?.kind ?? root?.default_kind ?? "generic";
  const primaryPath = deriveWorkspacePath(input, root, slug, id, kind);
  const tags = normalizeList([
    ...(root?.tags ?? []),
    ...(recipe?.default_tags ?? []),
    ...(input.tags ?? []),
  ]);
  const integrations: WorkspaceIntegrations = { ...(input.integrations ?? {}) };
  if (!integrations.conversations_channel?.trim()) {
    try {
      integrations.conversations_channel = deriveProjectChannel({
        slug,
        kind: kind as WorkspaceKind,
        integrations,
      }).channel;
    } catch {
      // Slug does not produce a valid channel name; leave the integration unset.
      delete integrations.conversations_channel;
    }
  }

  const workspace = {
    id,
    slug,
    name: input.name,
    description: input.description ?? null,
    kind,
    status: "active" as const,
    root_id: root?.id ?? null,
    recipe_id: recipe?.id ?? null,
    primary_path: primaryPath,
    git_remote: input.git_remote ?? null,
    s3_bucket: input.s3_bucket ?? null,
    s3_prefix: input.s3_prefix ?? null,
    tags,
    integrations,
    metadata: input.metadata ?? {},
    last_opened_at: null,
    created_at: null,
    updated_at: null,
    synced_at: null,
  };

  return {
    workspace,
    workspace_input: {
      id,
      name: input.name,
      slug,
      description: input.description,
      kind: kind as WorkspaceKind,
      root_id: root?.id,
      recipe_id: recipe?.id,
      primary_path: primaryPath ?? undefined,
      git_remote: input.git_remote,
      s3_bucket: input.s3_bucket,
      s3_prefix: input.s3_prefix,
      tags: input.tags,
      integrations,
      metadata: input.metadata,
      agent_id: input.agent_id,
      source: input.source,
      prompt: input.prompt,
      command: input.command,
    },
    root,
    recipe,
  };
}

function asRuntimeWorkspace(workspace: WorkspaceCreationPlan["workspace"]): Workspace {
  const ts = new Date().toISOString();
  return {
    ...workspace,
    created_at: ts,
    updated_at: ts,
  };
}

function lockPlan(workspace: WorkspaceCreationPlan["workspace"], root: Root | null): Array<{ key: string; reason: string }> {
  const locks = [{ key: `workspace-slug:${workspace.slug}`, reason: `Reserve workspace slug ${workspace.slug}` }];
  if (workspace.primary_path) locks.push({ key: `workspace-path:${workspace.primary_path}`, reason: `Reserve workspace path ${workspace.primary_path}` });
  if (root) locks.push({ key: `root-path:${root.id}:${workspace.slug}`, reason: `Reserve root path segment for ${workspace.slug}` });
  return locks;
}

function dbWrites(workspace: WorkspaceCreationPlan["workspace"], input: WorkspaceCreationPlanInput): WorkspaceCreationPlanAction[] {
  const writes: WorkspaceCreationPlanAction[] = [
    { type: "db", action: "insert", target: "workspaces", status: "planned", metadata: { slug: workspace.slug, kind: workspace.kind } },
    { type: "db", action: "insert", target: "workspace_events", status: "planned", metadata: { event_type: "created", source: input.source ?? "cli" } },
  ];
  if (workspace.primary_path) writes.push({ type: "db", action: "insert", target: "workspace_locations", status: "planned", metadata: { path: workspace.primary_path, primary: true } });
  if (input.agent_id) writes.push({ type: "db", action: "insert", target: "workspace_agents", status: "planned", metadata: { agent_id: input.agent_id, role: "creator" } });
  return writes;
}

function runtimePlan(workspace: Workspace, input: WorkspaceCreationPlanInput): { actions: WorkspaceRuntimeAction[]; warnings: string[] } {
  const warnings: string[] = [];
  try {
    return {
      actions: prepareWorkspaceDirectory(workspace, {
        createDirectory: input.createDirectory || input.gitInit,
        gitInit: input.gitInit,
        writeMarker: input.writeMarker,
        dryRun: true,
        recordEvents: false,
      }),
      warnings,
    };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
    return { actions: [], warnings };
  }
}

function tmuxPlan(workspace: Workspace, input: WorkspaceCreationPlanInput, db?: Database): { result: WorkspaceTmuxResult | null; warnings: string[] } {
  const warnings: string[] = [];
  try {
    if (input.tmux_profile) {
      const profile = resolveTmuxProfile(input.tmux_profile, db);
      if (!profile) throw new Error(`Tmux profile not found: ${input.tmux_profile}`);
      return {
        result: applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id, db), { dryRun: true, recordEvents: false }),
        warnings,
      };
    }
    if (input.tmux?.session || input.tmux?.windows) {
      return {
        result: applyWorkspaceTmux(workspace, {
          session: input.tmux.session,
          windows: input.tmux.windows,
          dryRun: true,
          recordEvents: false,
        }),
        warnings,
      };
    }
    return { result: null, warnings };
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
    return { result: null, warnings };
  }
}

function commandPlan(runtimeActions: WorkspaceRuntimeAction[], tmux: WorkspaceTmuxResult | null): WorkspaceCreationPlanAction[] {
  const commands: WorkspaceCreationPlanAction[] = [];
  for (const action of runtimeActions) {
    if (action.type === "git_init") {
      commands.push({ type: "command", action: "run", target: "git init", status: "planned", metadata: { cwd: action.target } });
    }
  }
  if (tmux) {
    commands.push({ type: "tmux", action: "ensure_session", target: tmux.session_name, status: "planned" });
    for (const window of tmux.windows) {
      commands.push({ type: "tmux", action: "ensure_window", target: window.target, status: "planned", metadata: window.metadata });
    }
  }
  return commands;
}

function rollbackPlan(workspace: WorkspaceCreationPlan["workspace"], runtimeActions: WorkspaceRuntimeAction[], tmux: WorkspaceTmuxResult | null): WorkspaceCreationPlanAction[] {
  const rollback: WorkspaceCreationPlanAction[] = [
    { type: "rollback", action: "delete", target: `workspaces:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
    { type: "rollback", action: "delete", target: `workspace_events:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
  ];
  if (workspace.primary_path) {
    rollback.push({ type: "rollback", action: "delete", target: `workspace_locations:${workspace.primary_path}`, status: "planned", metadata: { automatic: false } });
  }
  for (const action of runtimeActions) {
    if (action.type === "workspace_marker") rollback.push({ type: "rollback", action: "remove_file", target: action.target, status: "planned", metadata: { automatic: false } });
    if (action.type === "git_init") rollback.push({ type: "rollback", action: "remove_git_dir", target: join(action.target, ".git"), status: "planned", metadata: { automatic: false } });
    if (action.type === "mkdir" && !existsSync(action.target)) rollback.push({ type: "rollback", action: "remove_empty_directory", target: action.target, status: "planned", metadata: { automatic: false } });
  }
  if (tmux) rollback.push({ type: "rollback", action: "review_tmux_session", target: tmux.session_name, status: "planned", metadata: { automatic: false } });
  return rollback;
}

function verificationPlan(workspace: WorkspaceCreationPlan["workspace"], tmux: WorkspaceTmuxResult | null): WorkspaceCreationPlanAction[] {
  const checks: WorkspaceCreationPlanAction[] = [
    { type: "verification", action: "run", target: `projects show ${workspace.slug} --json`, status: "planned" },
  ];
  if (workspace.primary_path) {
    checks.push({ type: "verification", action: "check_path", target: workspace.primary_path, status: "planned" });
    checks.push({ type: "verification", action: "run", target: `projects doctor ${workspace.slug} --json`, status: "planned" });
  }
  if (tmux) checks.push({ type: "verification", action: "run", target: `tmux list-windows -t ${tmux.session_name}`, status: "planned" });
  return checks;
}

export function planWorkspaceCreation(input: WorkspaceCreationPlanInput, options: { db?: Database } = {}): WorkspaceCreationPlan {
  const createdAt = new Date().toISOString();
  const { workspace, workspace_input, root } = plannedWorkspace(input, options.db);
  const runtimeWorkspace = asRuntimeWorkspace(workspace);
  const runtime = runtimePlan(runtimeWorkspace, input);
  const tmux = tmuxPlan(runtimeWorkspace, input, options.db);
  const warnings = [...runtime.warnings, ...tmux.warnings];
  const commands = commandPlan(runtime.actions, tmux.result);

  return {
    kind: "project_creation",
    created_at: createdAt,
    can_execute: warnings.length === 0,
    warnings,
    workspace,
    workspace_input,
    locks: lockPlan(workspace, root),
    db_writes: dbWrites(workspace, input),
    runtime_actions: runtime.actions,
    tmux: tmux.result,
    commands,
    github_operations: [],
    verification_steps: verificationPlan(workspace, tmux.result),
    rollback_actions: rollbackPlan(workspace, runtime.actions, tmux.result),
  };
}

function releaseLocks(acquired: WorkspaceLock[], db?: Database): string[] {
  const released: string[] = [];
  for (const lock of acquired.slice().reverse()) {
    if (releaseWorkspaceLock(lock.lock_key, db)) released.push(lock.lock_key);
  }
  return released;
}

function isInsidePath(target: string, base: string | null): boolean {
  if (!base) return false;
  const absTarget = resolve(target);
  const absBase = resolve(base);
  return absTarget === absBase || absTarget.startsWith(`${absBase}${sep}`);
}

function cleanupActionOrder(action: WorkspaceCreationPlanAction): number {
  if (action.action === "remove_file") return 10;
  if (action.action === "remove_git_dir") return 20;
  if (action.action === "remove_empty_directory") return 30;
  if (action.target.startsWith("workspace_locations:")) return 40;
  if (action.target.startsWith("workspace_events:")) return 50;
  if (action.target.startsWith("workspaces:")) return 60;
  return 100;
}

function cleanupResult(
  action: WorkspaceCreationPlanAction,
  status: WorkspaceCreationCleanupAction["status"],
  message?: string,
): WorkspaceCreationCleanupAction {
  return { ...action, status, message };
}

function deleteCreationEvents(workspaceId: string, db?: Database): number {
  const d = db || getDatabase();
  const result = d.run(
    `DELETE FROM workspace_events
     WHERE workspace_id = ?
       AND event_type IN (
         'created',
         'workspace_marker_written',
         'workspace_prepared',
         'tmux_applied',
         'creation_runtime_planned',
         'creation_executed',
         'creation_failed'
       )`,
    [workspaceId],
  );
  return result.changes;
}

function deleteWorkspaceLocation(workspaceId: string, path: string, db?: Database): number {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM workspace_locations WHERE workspace_id = ? AND path = ?", [workspaceId, resolve(path)]);
  return result.changes;
}

function applyCleanupAction(
  target: WorkspaceCreationCleanupTarget,
  action: WorkspaceCreationPlanAction,
  options: CleanupWorkspaceCreationOptions,
): WorkspaceCreationCleanupAction {
  const primaryPath = target.primary_path ? resolve(target.primary_path) : null;
  const workspace = getWorkspaceBySlug(target.workspace_slug, options.db);

  try {
    if (action.action === "remove_file") {
      const filePath = resolve(action.target);
      if (!isInsidePath(filePath, primaryPath)) return cleanupResult(action, "failed", "Refusing to remove a file outside the planned workspace path.");
      if (options.dryRun) return cleanupResult(action, "planned");
      if (!existsSync(filePath)) return cleanupResult(action, "skipped", "File does not exist.");
      const stat = lstatSync(filePath);
      if (stat.isDirectory()) return cleanupResult(action, "failed", "Target is a directory, not a file.");
      unlinkSync(filePath);
      return cleanupResult(action, "completed");
    }

    if (action.action === "remove_git_dir") {
      const gitPath = resolve(action.target);
      if (basename(gitPath) !== ".git") return cleanupResult(action, "failed", "Refusing to remove a non-.git target.");
      if (!isInsidePath(dirname(gitPath), primaryPath)) return cleanupResult(action, "failed", "Refusing to remove .git outside the planned workspace path.");
      if (options.dryRun) return cleanupResult(action, "planned");
      if (!existsSync(gitPath)) return cleanupResult(action, "skipped", ".git target does not exist.");
      rmSync(gitPath, { recursive: true, force: true });
      return cleanupResult(action, "completed");
    }

    if (action.action === "remove_empty_directory") {
      const dirPath = resolve(action.target);
      if (!isInsidePath(dirPath, primaryPath)) return cleanupResult(action, "failed", "Refusing to remove a directory outside the planned workspace path.");
      if (options.dryRun) return cleanupResult(action, "planned");
      if (!existsSync(dirPath)) return cleanupResult(action, "skipped", "Directory does not exist.");
      const stat = lstatSync(dirPath);
      if (!stat.isDirectory()) return cleanupResult(action, "failed", "Target is not a directory.");
      if (readdirSync(dirPath).length > 0) return cleanupResult(action, "skipped", "Directory is not empty.");
      rmdirSync(dirPath);
      return cleanupResult(action, "completed");
    }

    if (action.target.startsWith("workspace_locations:")) {
      if (!workspace) return cleanupResult(action, "skipped", "Workspace row is already absent.");
      const path = action.target.slice("workspace_locations:".length);
      if (options.dryRun) return cleanupResult(action, "planned");
      const changes = deleteWorkspaceLocation(workspace.id, path, options.db);
      return changes > 0 ? cleanupResult(action, "completed") : cleanupResult(action, "skipped", "Location row was not present.");
    }

    if (action.target.startsWith("workspace_events:")) {
      if (!workspace) return cleanupResult(action, "skipped", "Workspace row is already absent.");
      if (options.dryRun) return cleanupResult(action, "planned");
      const changes = deleteCreationEvents(workspace.id, options.db);
      return changes > 0 ? cleanupResult(action, "completed", `Deleted ${changes} creation event(s).`) : cleanupResult(action, "skipped", "No creation events were present.");
    }

    if (action.target.startsWith("workspaces:")) {
      if (!workspace) return cleanupResult(action, "skipped", "Workspace row is already absent.");
      if (options.dryRun) return cleanupResult(action, "planned");
      deleteWorkspace(workspace.id, {
        hard: true,
        agent_id: options.agentId,
        source: options.source ?? "cli",
        prompt: options.prompt,
        command: options.command,
      }, options.db);
      return cleanupResult(action, "completed");
    }

    if (action.action === "review_tmux_session") {
      return cleanupResult(action, "skipped", "Tmux session cleanup is manual; review before killing sessions.");
    }

    return cleanupResult(action, "skipped", "Cleanup action is informational.");
  } catch (err) {
    return cleanupResult(action, "failed", err instanceof Error ? err.message : String(err));
  }
}

export function cleanupWorkspaceCreationTarget(
  target: WorkspaceCreationCleanupTarget,
  options: CleanupWorkspaceCreationOptions = {},
): WorkspaceCreationCleanup {
  const actions = [...target.rollback_actions]
    .sort((a, b) => cleanupActionOrder(a) - cleanupActionOrder(b))
    .map((action) => applyCleanupAction(target, action, options));
  const errors = actions.filter((action) => action.status === "failed").map((action) => `${action.action} ${action.target}: ${action.message ?? "failed"}`);

  if (!options.dryRun) {
    recordWorkspaceEvent({
      workspace_id: getWorkspaceBySlug(target.workspace_slug, options.db)?.id,
      agent_id: options.agentId,
      event_type: "creation_cleanup_applied",
      source: options.source ?? "cli",
      prompt: options.prompt,
      command: options.command,
      after: { target, actions } as unknown as JsonObject,
    }, options.db);
  }

  return {
    dry_run: Boolean(options.dryRun),
    success: errors.length === 0,
    workspace_slug: target.workspace_slug,
    primary_path: target.primary_path ? resolve(target.primary_path) : null,
    actions,
    errors,
  };
}

export function cleanupWorkspaceCreation(
  plan: WorkspaceCreationPlan,
  options: CleanupWorkspaceCreationOptions = {},
): WorkspaceCreationCleanup {
  return cleanupWorkspaceCreationTarget({
    workspace_slug: plan.workspace.slug,
    primary_path: plan.workspace.primary_path,
    rollback_actions: plan.rollback_actions,
  }, options);
}

export async function executeWorkspaceCreation(
  input: WorkspaceCreationPlanInput,
  options: ExecuteWorkspaceCreationOptions = {},
): Promise<WorkspaceCreationExecution> {
  const plan = planWorkspaceCreation(input, { db: options.db });
  if (options.dryRun) {
    return {
      dry_run: true,
      runtime_dry_run: true,
      success: plan.can_execute,
      plan,
      workspace: null,
      prepare: plan.runtime_actions,
      tmux: plan.tmux,
      channel: null,
      locks: [],
      released_locks: [],
      rollback_actions: plan.rollback_actions,
    };
  }
  if (!plan.can_execute) {
    throw new Error(`Workspace creation plan is not executable: ${plan.warnings.join("; ")}`);
  }

  const acquired: WorkspaceLock[] = [];
  let released: string[] = [];
  let workspace: Workspace | null = null;
  const source = (input.source ?? "cli") as EventSource;

  try {
    for (const lock of plan.locks) {
      acquired.push(acquireWorkspaceLock({
        lock_key: lock.key,
        agent_id: input.agent_id,
        reason: lock.reason,
        ttl_seconds: options.lockTtlSeconds,
      }, options.db));
    }

    workspace = options.createProject
      ? await options.createProject(plan.workspace_input)
      : createWorkspace(plan.workspace_input, options.db);
    const runtimeDryRun = Boolean(options.runtimeDryRun);
    const prepare = prepareWorkspaceDirectory(workspace, {
      createDirectory: input.createDirectory || input.gitInit,
      gitInit: input.gitInit,
      writeMarker: input.writeMarker,
      dryRun: runtimeDryRun,
      db: options.db,
      agentId: input.agent_id,
      source,
      prompt: input.prompt,
      command: input.command,
    });

    let tmux: WorkspaceTmuxResult | null = null;
    if (input.tmux_profile) {
      const profile = resolveTmuxProfile(input.tmux_profile, options.db);
      if (!profile) throw new Error(`Tmux profile not found: ${input.tmux_profile}`);
      tmux = applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id, options.db), {
        dryRun: runtimeDryRun,
        db: options.db,
        agentId: input.agent_id,
        source,
        prompt: input.prompt,
        command: input.command,
      });
    } else if (input.tmux?.session || input.tmux?.windows) {
      tmux = applyWorkspaceTmux(workspace, {
        session: input.tmux.session,
        windows: input.tmux.windows,
        dryRun: runtimeDryRun,
        db: options.db,
        agentId: input.agent_id,
        source,
        prompt: input.prompt,
        command: input.command,
      });
    }

    let channel: ProjectChannelEnsureResult | null = null;
    if (options.ensureChannel ?? shouldEnsureProjectChannel()) {
      channel = ensureProjectChannel(workspace, {
        db: options.db,
        agentId: input.agent_id,
        source,
        command: input.command,
        dryRun: runtimeDryRun,
        runner: options.channelRunner,
      });
      if (channel.persisted) workspace = channel.project;
    }

    recordWorkspaceEvent({
      workspace_id: workspace.id,
      agent_id: input.agent_id,
      event_type: runtimeDryRun ? "creation_runtime_planned" : "creation_executed",
      source,
      prompt: input.prompt,
      command: input.command,
      after: { plan, prepare, tmux, channel } as unknown as JsonObject,
      metadata: { rollback_actions: plan.rollback_actions },
    }, options.db);

    released = releaseLocks(acquired, options.db);
    return {
      dry_run: false,
      runtime_dry_run: runtimeDryRun,
      success: true,
      plan,
      workspace,
      prepare,
      tmux,
      channel,
      locks: acquired,
      released_locks: released,
      rollback_actions: plan.rollback_actions,
    };
  } catch (err) {
    recordWorkspaceEvent({
      workspace_id: workspace?.id,
      agent_id: input.agent_id,
      event_type: "creation_failed",
      source,
      prompt: input.prompt,
      command: input.command,
      after: { plan, error: err instanceof Error ? err.message : String(err) } as unknown as JsonObject,
      metadata: { rollback_actions: plan.rollback_actions },
    }, options.db);
    throw err;
  } finally {
    if (released.length === 0) releaseLocks(acquired, options.db);
  }
}
