import type { Database } from "bun:sqlite";
import {
  listTmuxProfileWindows,
  resolveTmuxProfile,
} from "../db/workspaces.js";
import type { TmuxProfile, Workspace } from "../types/workspace.js";
import { listSessions, listWindowHealth, type TmuxSession, type TmuxWindowHealth } from "./tmux.js";
import { tmuxProfileToSpec, type WorkspaceTmuxWindowSpec } from "./workspace-runtime.js";
import {
  parseProjectStartAgent,
  prepareCodingSessionRename,
  projectStartCommand,
  resolveProjectStartTarget,
  skippedExactWindowsRenameReport,
  type CodingSessionRenameReport,
  type ProjectStartAgent,
} from "./project-start.js";
import { projectManagementSummary } from "./project-management.js";
import { buildProjectStatusRender, PROJECT_RENDER_SCHEMA_VERSION } from "./project-render.js";

export interface ProjectTmuxStatusOptions {
  profile?: string;
  session?: string;
  agentTool?: ProjectStartAgent;
  command?: string;
  windowName?: string;
  requestedWindows?: WorkspaceTmuxWindowSpec[];
  extraWindows?: WorkspaceTmuxWindowSpec[];
  db?: Database;
}

export interface ProjectTmuxStatusResult {
  schema_version: typeof PROJECT_RENDER_SCHEMA_VERSION;
  kind: "projects.tmux_status";
  project: Workspace;
  expected: {
    session_name: string;
    profile?: Pick<TmuxProfile, "id" | "slug" | "name">;
    windows: WorkspaceTmuxWindowSpec[];
  };
  rename_report: CodingSessionRenameReport[];
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
  tmux_available: boolean;
  exists: boolean;
  session: TmuxSession | null;
  related_sessions: TmuxSession[];
  windows: TmuxWindowHealth[];
  errors: string[];
  render: Record<string, unknown>;
}

function mergeWindows(...groups: Array<Array<WorkspaceTmuxWindowSpec | undefined> | undefined>): WorkspaceTmuxWindowSpec[] {
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

function relatedSessions(project: Workspace, expectedSession: string, sessions: TmuxSession[]): TmuxSession[] {
  return sessions.filter((session) => (
    session.name === expectedSession
    || session.name === project.slug
    || session.name.startsWith(`${project.slug}-`)
  ));
}

function defaultExpectedWindows(
  project: Workspace,
  command: string | undefined,
  windowName: string | undefined,
): WorkspaceTmuxWindowSpec[] {
  return mergeWindows([
    {
      name: windowName?.trim() || "01",
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

export async function projectTmuxStatus(
  target: string | undefined,
  options: ProjectTmuxStatusOptions = {},
): Promise<ProjectTmuxStatusResult> {
  const { project } = await resolveProjectStartTarget(target, {
    register: false,
    dryRun: true,
    db: options.db,
  });
  const defaults = projectManagementSummary(project);
  const defaultWindows = defaults.start_windows;
  const agentTool = parseProjectStartAgent(options.agentTool ?? defaults.start_agent ?? undefined);
  const baseCommand = projectStartCommand(agentTool, options.command ?? defaults.start_command ?? undefined);
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
  const baseWindows = defaultExpectedWindows(project, command, options.windowName);
  const expectedWindows = options.requestedWindows
    ? mergeWindows(options.requestedWindows)
    : mergeWindows(
      baseWindows,
      profileSpec?.windows,
      defaultWindows,
      options.extraWindows,
    );
  const expectedSession = options.session?.trim() || profileSpec?.session || project.slug;
  const baseResult = {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.tmux_status" as const,
    project,
    expected: {
      session_name: expectedSession,
      profile: profile ? { id: profile.id, slug: profile.slug, name: profile.name } : undefined,
      windows: expectedWindows,
    },
    rename_report: renameReport,
    launch_defaults: {
      agent_tool: defaults.start_agent,
      tool_command: defaults.start_command,
      tmux_profile: defaults.launch_profile,
      session_policy: defaults.start_session_policy,
      windows: defaultWindows,
      used_agent_tool: options.agentTool === undefined && Boolean(defaults.start_agent),
      used_tool_command: options.command === undefined && Boolean(defaults.start_command),
      used_tmux_profile: options.profile === undefined && Boolean(defaults.launch_profile),
      used_session_policy: Boolean(defaults.start_session_policy),
      used_windows: options.requestedWindows === undefined && defaultWindows.length > 0,
    },
    errors: [],
  };

  let sessions: TmuxSession[] = [];
  try {
    sessions = listSessions();
  } catch (err) {
    return {
      ...baseResult,
      tmux_available: false,
      exists: false,
      session: null,
      related_sessions: [],
      windows: [],
      errors: [err instanceof Error ? err.message : String(err)],
      render: buildProjectStatusRender({
        project,
        sessionName: expectedSession,
        exists: false,
        tmuxAvailable: false,
        expectedWindows,
        currentWindows: [],
        errors: [err instanceof Error ? err.message : String(err)],
      }),
    };
  }

  const session = sessions.find((item) => item.name === expectedSession) ?? null;
  let windows: TmuxWindowHealth[] = [];
  const errors: string[] = [];
  if (session) {
    try {
      windows = listWindowHealth(expectedSession);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    ...baseResult,
    tmux_available: true,
    exists: Boolean(session),
    session,
    related_sessions: relatedSessions(project, expectedSession, sessions),
    windows,
    errors,
    render: buildProjectStatusRender({
      project,
      sessionName: expectedSession,
      exists: Boolean(session),
      tmuxAvailable: true,
      expectedWindows,
      currentWindows: windows,
      errors,
    }),
  };
}
