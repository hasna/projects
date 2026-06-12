import { execFileSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createSession,
  createWindow,
  execInWindow,
  listSessions,
  listWindows,
} from "./tmux.js";
import { recordWorkspaceEvent } from "../db/workspaces.js";
import type { EventSource, JsonObject, TmuxProfile, TmuxProfileWindow, Workspace } from "../types/workspace.js";

export const PROJECT_MARKER_FILENAME = ".project.json";
export const LEGACY_WORKSPACE_MARKER_FILENAME = ".workspace.json";

export interface WorkspaceRuntimeAction {
  type: string;
  target: string;
  status: "planned" | "completed" | "skipped" | "failed";
  message?: string;
  metadata?: JsonObject;
}

export interface PrepareWorkspaceOptions {
  createDirectory?: boolean;
  gitInit?: boolean;
  writeMarker?: boolean;
  recordEvents?: boolean;
  db?: Database;
  dryRun?: boolean;
  agentId?: string;
  prompt?: string;
  command?: string;
  source?: EventSource;
}

export interface WorkspaceMarker {
  schema_version: 1;
  id: string;
  slug: string;
  name: string;
  kind: string;
  root_id: string | null;
  recipe_id: string | null;
  primary_path: string | null;
  git_remote: string | null;
  tags: string[];
  integrations: JsonObject;
  generated_at: string;
}

export interface WorkspaceTmuxWindowSpec {
  name: string;
  path?: string;
  command?: string;
  index?: number;
  detached?: boolean;
}

export interface ApplyWorkspaceTmuxOptions {
  session?: string;
  sessionPolicy?: "reuse" | "new" | "error-if-running";
  windows?: WorkspaceTmuxWindowSpec[];
  runExistingWindowCommands?: boolean;
  recordEvents?: boolean;
  db?: Database;
  dryRun?: boolean;
  agentId?: string;
  prompt?: string;
  command?: string;
  source?: EventSource;
}

export interface WorkspaceTmuxResult {
  session_name: string;
  dry_run: boolean;
  session_action: "planned" | "created" | "reused" | "failed";
  windows: WorkspaceRuntimeAction[];
  errors: string[];
  success: boolean;
}

function workspacePath(workspace: Pick<Workspace, "primary_path" | "slug">): string {
  if (!workspace.primary_path) {
    throw new Error(`Workspace ${workspace.slug} does not have a primary path`);
  }
  return resolve(workspace.primary_path);
}

function renderTemplate(template: string, values: Record<string, string | null | undefined>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => values[key] ?? "");
}

export function workspaceMarkerPath(workspace: Pick<Workspace, "primary_path" | "slug">): string {
  return join(workspacePath(workspace), PROJECT_MARKER_FILENAME);
}

export function projectMarkerPath(workspace: Pick<Workspace, "primary_path" | "slug">): string {
  return workspaceMarkerPath(workspace);
}

export function buildWorkspaceMarker(workspace: Workspace): WorkspaceMarker {
  return {
    schema_version: 1,
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    kind: workspace.kind,
    root_id: workspace.root_id,
    recipe_id: workspace.recipe_id,
    primary_path: workspace.primary_path,
    git_remote: workspace.git_remote,
    tags: workspace.tags,
    integrations: workspace.integrations as JsonObject,
    generated_at: new Date().toISOString(),
  };
}

export function writeWorkspaceMarker(workspace: Workspace, options: PrepareWorkspaceOptions = {}): WorkspaceRuntimeAction {
  const path = workspacePath(workspace);
  const markerPath = workspaceMarkerPath(workspace);
  if (options.dryRun) {
    return { type: "workspace_marker", target: markerPath, status: "planned" };
  }
  mkdirSync(path, { recursive: true });
  writeFileSync(markerPath, JSON.stringify(buildWorkspaceMarker(workspace), null, 2) + "\n", "utf-8");
  const action: WorkspaceRuntimeAction = { type: "workspace_marker", target: markerPath, status: "completed" };
  if (options.recordEvents !== false) {
    recordRuntimeEvent(workspace, "workspace_marker_written", [action], options);
  }
  return action;
}

function recordRuntimeEvent(
  workspace: Workspace,
  eventType: string,
  actions: WorkspaceRuntimeAction[] | WorkspaceTmuxResult,
  options: Pick<PrepareWorkspaceOptions, "agentId" | "prompt" | "command" | "source" | "db">,
): void {
  recordWorkspaceEvent({
    workspace_id: workspace.id,
    agent_id: options.agentId,
    event_type: eventType,
    source: options.source ?? "cli",
    prompt: options.prompt,
    command: options.command,
    after: actions as unknown as JsonObject,
  }, options.db);
}

export function prepareWorkspaceDirectory(
  workspace: Workspace,
  options: PrepareWorkspaceOptions = {},
): WorkspaceRuntimeAction[] {
  const actions: WorkspaceRuntimeAction[] = [];
  if (!options.createDirectory && !options.gitInit && !options.writeMarker) return actions;

  const path = workspacePath(workspace);

  if (options.createDirectory || options.gitInit || options.writeMarker) {
    if (options.dryRun) {
      actions.push({ type: "mkdir", target: path, status: "planned" });
    } else if (existsSync(path)) {
      actions.push({ type: "mkdir", target: path, status: "skipped", message: "Directory already exists" });
    } else {
      mkdirSync(path, { recursive: true });
      actions.push({ type: "mkdir", target: path, status: "completed" });
    }
  }

  if (options.gitInit) {
    const gitDir = join(path, ".git");
    if (options.dryRun) {
      actions.push({ type: "git_init", target: path, status: "planned" });
    } else if (existsSync(gitDir)) {
      actions.push({ type: "git_init", target: path, status: "skipped", message: "Git repository already exists" });
    } else {
      execFileSync("git", ["init"], { cwd: path, stdio: "pipe" });
      actions.push({ type: "git_init", target: path, status: "completed" });
    }
  }

  if (options.writeMarker) {
    actions.push(writeWorkspaceMarker(workspace, options));
  }

  if (!options.dryRun && actions.length > 0 && options.recordEvents !== false) {
    recordRuntimeEvent(workspace, "workspace_prepared", actions, options);
  }

  return actions;
}

function defaultTmuxWindows(workspace: Workspace): WorkspaceTmuxWindowSpec[] {
  return [{ name: workspace.slug, path: workspace.primary_path ?? undefined }];
}

function normalizeTmuxWindows(windows: WorkspaceTmuxWindowSpec[] | undefined, workspace: Workspace): WorkspaceTmuxWindowSpec[] {
  const source = windows && windows.length > 0 ? windows : defaultTmuxWindows(workspace);
  return source.map((window) => ({
    ...window,
    name: window.name.trim() || workspace.slug,
    path: window.path ? resolve(window.path) : workspace.primary_path ?? undefined,
  }));
}

function nextAvailableSessionName(base: string, existingNames: Set<string>): string {
  if (!existingNames.has(base)) return base;
  let index = 2;
  while (existingNames.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function applyWorkspaceTmux(workspace: Workspace, options: ApplyWorkspaceTmuxOptions = {}): WorkspaceTmuxResult {
  const requestedSessionName = options.session?.trim() || workspace.slug;
  const sessionPolicy = options.sessionPolicy ?? "reuse";
  let sessions: ReturnType<typeof listSessions> = [];
  try {
    sessions = listSessions();
  } catch {
    sessions = [];
  }
  const existingSessionNames = new Set(sessions.map((session) => session.name));
  const requestedSessionExists = existingSessionNames.has(requestedSessionName);
  const sessionName = sessionPolicy === "new"
    ? nextAvailableSessionName(requestedSessionName, existingSessionNames)
    : requestedSessionName;
  const windows = normalizeTmuxWindows(options.windows, workspace);
  const result: WorkspaceTmuxResult = {
    session_name: sessionName,
    dry_run: Boolean(options.dryRun),
    session_action: options.dryRun ? "planned" : "reused",
    windows: [],
    errors: [],
    success: true,
  };

  if (sessionPolicy === "error-if-running" && requestedSessionExists) {
    result.session_action = "failed";
    result.success = false;
    result.errors.push(`Tmux session already exists: ${requestedSessionName}`);
    result.windows = windows.map((window) => ({
      type: "tmux_window",
      target: `${requestedSessionName}:${window.name}`,
      status: "failed",
      message: "Session already exists",
      metadata: {
        path: window.path,
        command: window.command,
        index: window.index,
        detached: window.detached ?? true,
      },
    }));
    return result;
  }

  if (options.dryRun) {
    result.windows = windows.map((window) => ({
      type: "tmux_window",
      target: `${sessionName}:${window.name}`,
      status: "planned",
      metadata: {
        path: window.path,
        command: window.command,
        index: window.index,
        detached: window.detached ?? true,
      },
    }));
    return result;
  }

  try {
    const exists = existingSessionNames.has(sessionName);
    const first = windows[0] ?? { name: workspace.slug, path: workspace.primary_path ?? undefined };

    if (!exists) {
      createSession(sessionName, first.path, first.name);
      result.session_action = "created";
      result.windows.push({ type: "tmux_window", target: `${sessionName}:${first.name}`, status: "completed" });
      if (first.command) execInWindow(sessionName, first.name, first.command);
    }

    const existingWindows = new Set(listWindows(sessionName).map((window) => window.name));
    for (const [index, window] of windows.entries()) {
      if (index === 0 && result.session_action === "created") continue;
      if (existingWindows.has(window.name)) {
        result.windows.push({
          type: "tmux_window",
          target: `${sessionName}:${window.name}`,
          status: "skipped",
          message: "Window already exists",
        });
        if (window.command && options.runExistingWindowCommands !== false) execInWindow(sessionName, window.name, window.command);
        continue;
      }

      createWindow(sessionName, window.name, window.command, {
        cwd: window.path,
        index: window.index,
        detached: window.detached ?? true,
      });
      result.windows.push({ type: "tmux_window", target: `${sessionName}:${window.name}`, status: "completed" });
    }
  } catch (err) {
    result.session_action = "failed";
    result.success = false;
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  if (options.recordEvents !== false) {
    recordRuntimeEvent(workspace, "tmux_applied", result, options);
  }
  return result;
}

export function tmuxProfileToSpec(
  workspace: Workspace,
  profile: TmuxProfile,
  windows: TmuxProfileWindow[],
): { session: string; windows: WorkspaceTmuxWindowSpec[] } {
  const values = {
    slug: workspace.slug,
    name: workspace.name,
    kind: workspace.kind,
    path: workspace.primary_path,
    root_id: workspace.root_id,
    recipe_id: workspace.recipe_id,
    profile: profile.slug,
  };
  const session = renderTemplate(profile.session_template || "{slug}", values);
  const specs = (windows.length ? windows : [{
    window_name_template: "{slug}",
    path_template: "{path}",
    command: null,
    window_index: null,
    detached: true,
  } as TmuxProfileWindow]).map((window) => ({
    name: renderTemplate(window.window_name_template, values),
    path: window.path_template ? renderTemplate(window.path_template, values) : workspace.primary_path ?? undefined,
    command: window.command ? renderTemplate(window.command, values) : undefined,
    index: window.window_index ?? undefined,
    detached: window.detached,
  }));
  return { session, windows: specs };
}

export function applyWorkspaceTmuxProfile(
  workspace: Workspace,
  profile: TmuxProfile,
  windows: TmuxProfileWindow[],
  options: Omit<ApplyWorkspaceTmuxOptions, "session" | "windows"> = {},
): WorkspaceTmuxResult {
  const spec = tmuxProfileToSpec(workspace, profile, windows);
  return applyWorkspaceTmux(workspace, {
    ...options,
    session: spec.session,
    windows: spec.windows,
  });
}
