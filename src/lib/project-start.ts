import type { Database } from "bun:sqlite";
import {
  listTmuxProfileWindows,
  recordWorkspaceEvent,
  resolveTmuxProfile,
} from "../db/workspaces.js";
import type { EventSource, JsonObject, TmuxProfile, Workspace } from "../types/workspace.js";
import {
  PROJECT_START_AGENTS,
  PROJECT_START_SESSION_POLICIES,
  projectManagementSummary,
  type ProjectStartAgent,
  type ProjectStartSessionPolicy,
} from "./project-management.js";
import {
  isProjectDirectory,
  isProjectPathLike,
  normalizeProjectPath,
  resolveRegisteredProjectTarget,
} from "./project-resolver.js";
import {
  ensureProjectChannel,
  shouldEnsureProjectChannel,
  type ConversationsChannelRunner,
  type ProjectChannelEnsureResult,
} from "./project-channel.js";
import { importWorkspace, planWorkspaceImport, type WorkspaceImportPreview } from "./workspace-import.js";
import { resolveProjectStore } from "../store/project-store.js";
import { applyWorkspaceTmux, tmuxProfileToSpec, type WorkspaceTmuxResult, type WorkspaceTmuxWindowSpec } from "./workspace-runtime.js";
import { attachSession } from "./tmux.js";
import { buildProjectStartRender, PROJECT_RENDER_SCHEMA_VERSION } from "./project-render.js";

export { PROJECT_START_AGENTS, PROJECT_START_SESSION_POLICIES, type ProjectStartAgent, type ProjectStartSessionPolicy } from "./project-management.js";

export interface ProjectStartResolution {
  target: string;
  source: "id-or-slug" | "name" | "path" | "marker" | "imported" | "planned-import";
  registered: boolean;
  preview?: WorkspaceImportPreview;
}

export interface ProjectStartOptions {
  agentTool?: ProjectStartAgent;
  toolCommand?: string;
  session?: string;
  sessionPolicy?: ProjectStartSessionPolicy;
  profile?: string;
  windowName?: string;
  requestedWindows?: WorkspaceTmuxWindowSpec[];
  extraWindows?: WorkspaceTmuxWindowSpec[];
  register?: boolean;
  importTags?: string[];
  importMetadata?: JsonObject;
  dryRun?: boolean;
  attach?: boolean;
  agentId?: string;
  source?: EventSource;
  auditCommand?: string;
  /** Ensure the project's conversations channel exists on start; defaults to shouldEnsureProjectChannel(). */
  ensureChannel?: boolean;
  /** Conversations CLI runner override (used by tests). */
  channelRunner?: ConversationsChannelRunner;
  db?: Database;
}

export interface ProjectStartResult {
  schema_version: typeof PROJECT_RENDER_SCHEMA_VERSION;
  kind: "projects.start";
  project: Workspace;
  resolution: ProjectStartResolution;
  agent_tool: ProjectStartAgent;
  tool_command?: string;
  rename_report: CodingSessionRenameReport[];
  session_policy: ProjectStartSessionPolicy;
  tmux_profile?: Pick<TmuxProfile, "id" | "slug" | "name">;
  launch_defaults: {
    agent_tool: string | null;
    tool_command: string | null;
    tmux_profile: string | null;
    session_policy: string | null;
    windows: WorkspaceTmuxWindowSpec[];
    used_agent_tool: boolean;
    used_tool_command: boolean;
    used_tmux_profile: boolean;
    used_session_policy: boolean;
    used_windows: boolean;
  };
  tmux: WorkspaceTmuxResult;
  channel: ProjectChannelEnsureResult | null;
  attached: boolean;
  render: JsonObject;
}

export interface CodingSessionRenameReport {
  agent_tool: ProjectStartAgent;
  desired_name: string;
  status: "configured" | "manual" | "unsupported" | "skipped";
  method: string | null;
  command_changed: boolean;
  message: string;
  manual_instruction?: string;
}

export function parseProjectStartAgent(value: string | undefined): ProjectStartAgent {
  const agent = value ?? "codewith";
  if ((PROJECT_START_AGENTS as readonly string[]).includes(agent)) return agent as ProjectStartAgent;
  throw new Error(`Invalid start agent: ${agent}. Expected one of: ${PROJECT_START_AGENTS.join(", ")}`);
}

export function projectStartCommand(agent: ProjectStartAgent, override?: string): string | undefined {
  if (override !== undefined) return override.trim() || undefined;
  switch (agent) {
    case "codewith": return "codewith";
    case "claude": return "claude";
    case "opencode": return "opencode";
    case "cursor": return "cursor .";
    case "none": return undefined;
  }
}

export function parseProjectStartSessionPolicy(value: string | undefined): ProjectStartSessionPolicy {
  const policy = value ?? "reuse";
  if ((PROJECT_START_SESSION_POLICIES as readonly string[]).includes(policy)) return policy as ProjectStartSessionPolicy;
  throw new Error(`Invalid start session policy: ${policy}. Expected one of: ${PROJECT_START_SESSION_POLICIES.join(", ")}`);
}

function previewToWorkspace(preview: WorkspaceImportPreview): Workspace {
  const generatedAt = new Date().toISOString();
  return {
    id: "planned",
    slug: preview.slug,
    name: preview.name,
    description: null,
    kind: preview.kind,
    status: "active",
    root_id: preview.root_id ?? null,
    recipe_id: null,
    primary_path: preview.path,
    git_remote: preview.git_remote ?? null,
    s3_bucket: null,
    s3_prefix: null,
    tags: preview.tags,
    integrations: {},
    metadata: {
      ...preview.metadata,
      import_signals: preview.signals,
      import_confidence: preview.confidence,
      planned_import: true,
    },
    last_opened_at: null,
    created_at: generatedAt,
    updated_at: generatedAt,
    synced_at: null,
  };
}

function mergeStartWindows(...groups: Array<Array<WorkspaceTmuxWindowSpec | undefined> | undefined>): WorkspaceTmuxWindowSpec[] {
  const windows: WorkspaceTmuxWindowSpec[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const window of group ?? []) {
      if (!window) continue;
      const name = window.name.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      windows.push({ ...window, name });
    }
  }
  return windows;
}

function projectDisplayName(project: Workspace): string {
  return project.name.trim() || project.slug;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandStartsWith(command: string, executable: string): boolean {
  return command === executable || command.startsWith(`${executable} `);
}

function commandHasNameFlag(command: string): boolean {
  return /(^|\s)(--name(=|\s)|-n(\s|$))/.test(command);
}

function withClaudeSessionName(command: string, name: string): { command: string; changed: boolean; alreadyNamed: boolean } {
  const trimmed = command.trim();
  if (!commandStartsWith(trimmed, "claude")) return { command, changed: false, alreadyNamed: false };
  if (commandHasNameFlag(trimmed)) return { command, changed: false, alreadyNamed: true };
  const rest = trimmed.slice("claude".length).trim();
  return {
    command: `claude --name ${shellQuote(name)}${rest ? ` ${rest}` : ""}`,
    changed: true,
    alreadyNamed: false,
  };
}

export function prepareCodingSessionRename(
  project: Workspace,
  agentTool: ProjectStartAgent,
  command: string | undefined,
): { command: string | undefined; report: CodingSessionRenameReport[] } {
  const desiredName = projectDisplayName(project);
  if (!command || agentTool === "none") {
    return {
      command,
      report: [{
        agent_tool: agentTool,
        desired_name: desiredName,
        status: "skipped",
        method: null,
        command_changed: false,
        message: "No coding-agent command is launched for this start.",
      }],
    };
  }

  if (agentTool === "claude") {
    const named = withClaudeSessionName(command, desiredName);
    if (named.changed) {
      return {
        command: named.command,
        report: [{
          agent_tool: agentTool,
          desired_name: desiredName,
          status: "configured",
          method: "claude --name",
          command_changed: true,
          message: "Claude supports launch-time display names, so the start command was annotated with --name.",
        }],
      };
    }
    if (named.alreadyNamed) {
      return {
        command,
        report: [{
          agent_tool: agentTool,
          desired_name: desiredName,
          status: "configured",
          method: "claude --name",
          command_changed: false,
          message: "Claude command already includes a session name flag.",
        }],
      };
    }
    return {
      command,
      report: [{
        agent_tool: agentTool,
        desired_name: desiredName,
        status: "manual",
        method: null,
        command_changed: false,
        message: "The configured Claude command does not start with `claude`, so Open Projects did not rewrite it.",
        manual_instruction: `Start Claude with --name ${shellQuote(desiredName)} when this wrapper supports it.`,
      }],
    };
  }

  if (agentTool === "codewith") {
    return {
      command,
      report: [{
        agent_tool: agentTool,
        desired_name: desiredName,
        status: "manual",
        method: null,
        command_changed: false,
        message: "No stable Codewith CLI rename option was detected, so Open Projects will not inject text into the pane.",
        manual_instruction: `Rename the Codewith session to ${desiredName} from the host UI or supported slash command when available.`,
      }],
    };
  }

  return {
    command,
    report: [{
      agent_tool: agentTool,
      desired_name: desiredName,
      status: "unsupported",
      method: null,
      command_changed: false,
      message: `${agentTool} does not expose a safe programmatic rename path in this environment.`,
      manual_instruction: `Rename the ${agentTool} session to ${desiredName} manually if the tool supports it.`,
    }],
  };
}

export function skippedExactWindowsRenameReport(project: Workspace, agentTool: ProjectStartAgent): CodingSessionRenameReport[] {
  return [{
    agent_tool: agentTool,
    desired_name: projectDisplayName(project),
    status: "skipped",
    method: null,
    command_changed: false,
    message: "Exact tmux windows were requested, so Open Projects did not manage a primary coding-agent command.",
  }];
}

function defaultStartWindows(
  project: Workspace,
  command: string | undefined,
  windowName: string | undefined,
): WorkspaceTmuxWindowSpec[] {
  const primaryName = windowName?.trim() || "01";
  return mergeStartWindows([
    {
      name: primaryName,
      path: project.primary_path ?? undefined,
      command,
      detached: true,
    },
    {
      name: "02",
      path: project.primary_path ?? undefined,
      detached: true,
    },
  ]);
}

export async function resolveProjectStartTarget(
  target: string | undefined,
  options: Pick<ProjectStartOptions, "register" | "dryRun" | "agentId" | "db" | "importTags" | "importMetadata" | "source" | "auditCommand"> = {},
): Promise<{ project: Workspace; resolution: ProjectStartResolution }> {
  const normalizedTarget = target?.trim() || ".";
  const existing = resolveRegisteredProjectTarget(normalizedTarget, { db: options.db });
  if (existing) {
    return {
      project: existing.project,
      resolution: {
        target: existing.target,
        source: existing.source,
        registered: true,
      },
    };
  }

  const path = normalizeProjectPath(normalizedTarget);
  if (isProjectPathLike(normalizedTarget) || isProjectDirectory(path)) {
    if (options.register === false) {
      throw new Error(`Project is not registered: ${path}`);
    }

    const store = resolveProjectStore();
    if (options.dryRun) {
      const preview = await planWorkspaceImport(store, path, {
        tags: options.importTags,
        metadata: options.importMetadata,
        agent_id: options.agentId,
      });
      return {
        project: previewToWorkspace(preview),
        resolution: { target: normalizedTarget, source: "planned-import", registered: false, preview },
      };
    }

    const imported = await importWorkspace(store, path, {
      tags: options.importTags,
      metadata: options.importMetadata,
      agent_id: options.agentId,
      source: options.source,
      command: options.auditCommand,
    });
    if (imported.workspace) {
      return {
        project: imported.workspace,
        resolution: { target: normalizedTarget, source: "imported", registered: false, preview: imported.preview },
      };
    }
    throw new Error(imported.error ?? imported.skipped ?? `Could not register project path: ${path}`);
  }

  throw new Error(`Project not found: ${normalizedTarget}`);
}

export async function startProject(
  target: string | undefined,
  options: ProjectStartOptions = {},
): Promise<ProjectStartResult> {
  const { project, resolution } = await resolveProjectStartTarget(target, options);
  const defaults = projectManagementSummary(project);
  const defaultWindows = defaults.start_windows;
  const agentTool = parseProjectStartAgent(options.agentTool ?? defaults.start_agent ?? undefined);
  const sessionPolicy = parseProjectStartSessionPolicy(options.sessionPolicy ?? defaults.start_session_policy ?? undefined);
  const baseCommand = projectStartCommand(agentTool, options.toolCommand ?? defaults.start_command ?? undefined);
  const preparedRename = options.requestedWindows
    ? { command: baseCommand, report: skippedExactWindowsRenameReport(project, agentTool) }
    : prepareCodingSessionRename(project, agentTool, baseCommand);
  const command = preparedRename.command;
  const renameReport = preparedRename.report;
  const profileRef = options.profile ?? defaults.launch_profile ?? undefined;
  const profile = profileRef ? resolveTmuxProfile(profileRef, options.db) : null;
  if (profileRef && !profile) throw new Error(`Tmux profile not found: ${profileRef}`);
  const profileSpec = profile
    ? tmuxProfileToSpec(project, profile, listTmuxProfileWindows(profile.id, options.db))
    : null;
  if (options.requestedWindows && options.requestedWindows.length === 0) {
    throw new Error("Requested start windows must include at least one window");
  }
  const baseWindows = defaultStartWindows(project, command, options.windowName);
  const windows = options.requestedWindows
    ? mergeStartWindows(options.requestedWindows)
    : mergeStartWindows(
      baseWindows,
      profileSpec?.windows,
      defaultWindows,
      options.extraWindows,
    );
  const tmux = applyWorkspaceTmux(project, {
    session: options.session ?? profileSpec?.session,
    sessionPolicy,
    windows,
    runExistingWindowCommands: false,
    dryRun: options.dryRun,
    agentId: options.agentId,
    source: options.source ?? "cli",
    command: options.auditCommand,
    db: options.db,
  });

  let channel: ProjectChannelEnsureResult | null = null;
  if (options.ensureChannel ?? shouldEnsureProjectChannel()) {
    channel = ensureProjectChannel(project, {
      db: options.db,
      agentId: options.agentId,
      source: options.source ?? "cli",
      command: options.auditCommand,
      dryRun: options.dryRun,
      runner: options.channelRunner,
    });
  }
  const startedProject = channel?.persisted ? channel.project : project;

  let attached = false;
  if (options.attach && !options.dryRun && tmux.success) {
    attachSession(tmux.session_name);
    attached = true;
  }

  if (!options.dryRun) {
    recordWorkspaceEvent({
      workspace_id: project.id,
      agent_id: options.agentId,
      event_type: "started",
      source: options.source ?? "cli",
      command: options.auditCommand,
      after: {
        resolution,
        agent_tool: agentTool,
        tool_command: command,
        rename_report: renameReport,
        tmux_profile: profile ? { id: profile.id, slug: profile.slug, name: profile.name } : undefined,
        launch_defaults: {
          agent_tool: defaults.start_agent,
          tool_command: defaults.start_command,
          tmux_profile: defaults.launch_profile,
          session_policy: defaults.start_session_policy,
          windows: defaultWindows,
        },
        session_policy: sessionPolicy,
        tmux,
        channel,
        attached,
      } as unknown as JsonObject,
    }, options.db);
  }

  const resultWithoutRender = {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.start" as const,
    project: startedProject,
    resolution,
    agent_tool: agentTool,
    tool_command: command,
    rename_report: renameReport,
    session_policy: sessionPolicy,
    tmux_profile: profile ? { id: profile.id, slug: profile.slug, name: profile.name } : undefined,
    launch_defaults: {
      agent_tool: defaults.start_agent,
      tool_command: defaults.start_command,
      tmux_profile: defaults.launch_profile,
      session_policy: defaults.start_session_policy,
      windows: defaultWindows,
      used_agent_tool: options.agentTool === undefined && Boolean(defaults.start_agent),
      used_tool_command: options.toolCommand === undefined && Boolean(defaults.start_command),
      used_tmux_profile: options.profile === undefined && Boolean(defaults.launch_profile),
      used_session_policy: options.sessionPolicy === undefined && Boolean(defaults.start_session_policy),
      used_windows: options.requestedWindows === undefined && defaultWindows.length > 0,
    },
    tmux,
    channel,
    attached,
  };
  return {
    ...resultWithoutRender,
    render: buildProjectStartRender({
      project: startedProject,
      tmux,
      sessionPolicy,
      agentTool,
      toolCommand: command,
      renameReport: renameReport as unknown as JsonObject[],
      resolutionSource: resolution.source,
    }),
  };
}
