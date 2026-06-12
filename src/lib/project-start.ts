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
import { importWorkspace, planWorkspaceImport, type WorkspaceImportPreview } from "./workspace-import.js";
import { applyWorkspaceTmux, tmuxProfileToSpec, type WorkspaceTmuxResult, type WorkspaceTmuxWindowSpec } from "./workspace-runtime.js";
import { attachSession } from "./tmux.js";

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
  extraWindows?: WorkspaceTmuxWindowSpec[];
  register?: boolean;
  importTags?: string[];
  importMetadata?: JsonObject;
  dryRun?: boolean;
  attach?: boolean;
  agentId?: string;
  source?: EventSource;
  auditCommand?: string;
  db?: Database;
}

export interface ProjectStartResult {
  project: Workspace;
  resolution: ProjectStartResolution;
  agent_tool: ProjectStartAgent;
  tool_command?: string;
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
  attached: boolean;
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

    if (options.dryRun) {
      const preview = planWorkspaceImport(path, {
        tags: options.importTags,
        metadata: options.importMetadata,
        agent_id: options.agentId,
        db: options.db,
      });
      return {
        project: previewToWorkspace(preview),
        resolution: { target: normalizedTarget, source: "planned-import", registered: false, preview },
      };
    }

    const imported = await importWorkspace(path, {
      tags: options.importTags,
      metadata: options.importMetadata,
      agent_id: options.agentId,
      source: options.source,
      command: options.auditCommand,
      db: options.db,
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
  const command = projectStartCommand(agentTool, options.toolCommand ?? defaults.start_command ?? undefined);
  const profileRef = options.profile ?? defaults.launch_profile ?? undefined;
  const profile = profileRef ? resolveTmuxProfile(profileRef, options.db) : null;
  if (profileRef && !profile) throw new Error(`Tmux profile not found: ${profileRef}`);
  const profileSpec = profile
    ? tmuxProfileToSpec(project, profile, listTmuxProfileWindows(profile.id, options.db))
    : null;
  const windowName = options.windowName?.trim() || (agentTool === "none" ? project.slug : agentTool);
  const primaryWindow = !profileSpec || command !== undefined || options.windowName
    ? {
      name: windowName,
      path: project.primary_path ?? undefined,
      command,
      detached: true,
    } satisfies WorkspaceTmuxWindowSpec
    : undefined;
  const windows = mergeStartWindows(
    primaryWindow ? [primaryWindow] : undefined,
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
        attached,
      } as unknown as JsonObject,
    }, options.db);
  }

  return {
    project,
    resolution,
    agent_tool: agentTool,
    tool_command: command,
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
      used_windows: defaultWindows.length > 0,
    },
    tmux,
    attached,
  };
}
