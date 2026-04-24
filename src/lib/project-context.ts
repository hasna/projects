import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listSyncLogs } from "../db/projects.js";
import { getMachineId, listWorkdirs } from "../db/workdirs.js";
import type { Project, ProjectWorkdir, SyncLog } from "../types/index.js";
import { getMachineProfile } from "./machine.js";
import { getProjectStatus, type ProjectStatus } from "./status.js";
import { getTmuxSessionName, listWindowHealth, type TmuxWindowHealth } from "./tmux.js";

export interface ProjectLocation extends ProjectWorkdir {
  exists: boolean;
  currentMachine: boolean;
  recommended: boolean;
}

export interface GitContext {
  isRepo: boolean;
  branch: string | null;
  dirtyCount: number | null;
  remote: string | null;
}

export interface ProjectContext {
  project: Project;
  machine: ReturnType<typeof getMachineProfile>;
  status: ProjectStatus;
  locations: ProjectLocation[];
  git: GitContext;
  tmux: {
    session: string;
    available: boolean;
    windows: TmuxWindowHealth[];
    deadWindows: TmuxWindowHealth[];
    error: string | null;
  };
  sync: {
    recent: SyncLog[];
  };
  integrations: Project["integrations"];
  nextCommands: string[];
}

export function getProjectLocations(project: Project): ProjectLocation[] {
  const currentMachine = getMachineId();
  return listWorkdirs(project.id).map((workdir) => ({
    ...workdir,
    exists: existsSync(workdir.path),
    currentMachine: workdir.machine_id === currentMachine,
    recommended: workdir.is_primary || workdir.path === project.path,
  }));
}

export function buildProjectContext(project: Project): ProjectContext {
  const session = getTmuxSessionName(project);
  let tmuxWindows: TmuxWindowHealth[] = [];
  let tmuxAvailable = true;
  let tmuxError: string | null = null;

  try {
    tmuxWindows = listWindowHealth(session);
  } catch (err) {
    tmuxAvailable = false;
    tmuxError = err instanceof Error ? err.message : String(err);
  }

  return {
    project,
    machine: getMachineProfile(),
    status: getProjectStatus(project),
    locations: getProjectLocations(project),
    git: getGitContext(project.path),
    tmux: {
      session,
      available: tmuxAvailable,
      windows: tmuxWindows,
      deadWindows: tmuxWindows.filter((window) => window.dead),
      error: tmuxError,
    },
    sync: {
      recent: listSyncLogs(project.id, 5),
    },
    integrations: project.integrations,
    nextCommands: buildNextCommands(project, session),
  };
}

function getGitContext(path: string): GitContext {
  if (!existsSync(join(path, ".git"))) {
    return { isRepo: false, branch: null, dirtyCount: null, remote: null };
  }

  return {
    isRepo: true,
    branch: git(path, ["branch", "--show-current"]) || null,
    dirtyCount: countDirty(path),
    remote: git(path, ["remote", "get-url", "origin"]) || null,
  };
}

function countDirty(path: string): number | null {
  const output = git(path, ["status", "--porcelain"]);
  if (output === null) return null;
  if (!output) return 0;
  return output.split("\n").filter(Boolean).length;
}

function git(path: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: path, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

function buildNextCommands(project: Project, session: string): string[] {
  const commands = [
    `cd $(projects open ${project.slug})`,
    `projects doctor ${project.slug} --fix --dry-run`,
    `projects where ${project.slug}`,
    `projects tmux window-status ${session}`,
  ];

  if (project.s3_bucket) {
    commands.push(`projects sync ${project.slug} --dry-run`);
  }

  return commands;
}
