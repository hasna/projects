import { existsSync } from "node:fs";
import { listProjects } from "../db/projects.js";
import { getMachineId, listWorkdirs, removeWorkdir } from "../db/workdirs.js";
import type { Project } from "../types/index.js";
import { getTmuxSessionName, listSessions, findDeadWindows } from "./tmux.js";

export type StaleSeverity = "info" | "warn" | "error";

export interface StaleIssue {
  code: string;
  severity: StaleSeverity;
  message: string;
  project?: Pick<Project, "id" | "slug" | "name" | "status">;
  fixable: boolean;
  recommendedCommand?: string;
  data?: Record<string, unknown>;
}

export interface CleanupAction {
  code: string;
  message: string;
  changed: boolean;
  issue: StaleIssue;
}

export interface CleanupResult {
  dryRun: boolean;
  actions: CleanupAction[];
  remaining: StaleIssue[];
}

export function findStaleIssues(project?: Project): StaleIssue[] {
  const scoped = Boolean(project);
  const projects = project
    ? [project]
    : [
      ...listProjects({ status: "active", limit: 1000 }),
      ...listProjects({ status: "archived", limit: 1000 }),
    ];
  const issues: StaleIssue[] = [];
  const currentMachine = getMachineId();

  for (const p of projects) {
    if (p.status === "active" && !existsSync(p.path)) {
      issues.push({
        code: "PROJECT_PATH_MISSING",
        severity: "error",
        message: `Project path is missing on this machine: ${p.path}`,
        project: projectRef(p),
        fixable: false,
        recommendedCommand: `projects where ${p.slug}`,
      });
    }

    for (const workdir of listWorkdirs(p.id)) {
      if (workdir.machine_id === currentMachine && !existsSync(workdir.path)) {
        issues.push({
          code: "WORKDIR_PATH_MISSING",
          severity: "warn",
          message: `Local workdir path is missing: ${workdir.path}`,
          project: projectRef(p),
          fixable: true,
          recommendedCommand: `projects cleanup --apply`,
          data: { path: workdir.path, machine_id: workdir.machine_id },
        });
      }
    }
  }

  issues.push(...tmuxIssues(projects, scoped));
  return issues;
}

export function cleanupStaleIssues(options: { apply?: boolean } = {}): CleanupResult {
  const dryRun = options.apply !== true;
  const issues = findStaleIssues();
  const actions: CleanupAction[] = [];

  for (const issue of issues) {
    if (issue.code !== "WORKDIR_PATH_MISSING" || typeof issue.data?.["path"] !== "string" || !issue.project) {
      continue;
    }

    const path = issue.data["path"];
    let changed = false;
    if (!dryRun) {
      removeWorkdir(issue.project.id, path);
      changed = true;
    }
    actions.push({
      code: "REMOVE_STALE_WORKDIR",
      message: `${dryRun ? "Would remove" : "Removed"} stale workdir ${path} from ${issue.project.slug}`,
      changed,
      issue,
    });
  }

  return {
    dryRun,
    actions,
    remaining: dryRun ? issues : findStaleIssues(),
  };
}

function tmuxIssues(projects: Project[], scoped: boolean): StaleIssue[] {
  const issues: StaleIssue[] = [];
  let sessions: ReturnType<typeof listSessions> = [];
  try {
    sessions = listSessions();
  } catch {
    return issues;
  }

  const activeSessions = new Set(
    projects
      .filter((project) => project.status === "active")
      .map((project) => getTmuxSessionName(project)),
  );

  for (const p of projects.filter((project) => project.status === "archived")) {
    const sessionName = getTmuxSessionName(p);
    if (sessions.some((session) => session.name === sessionName)) {
      issues.push({
        code: "ARCHIVED_PROJECT_HAS_TMUX_SESSION",
        severity: "warn",
        message: `Archived project still has tmux session: ${sessionName}`,
        project: projectRef(p),
        fixable: false,
        recommendedCommand: `projects tmux kill ${sessionName}`,
      });
    }
  }

  if (!scoped) {
    for (const session of sessions) {
      if (session.name === "master" || activeSessions.has(session.name)) continue;
      if (!session.name.startsWith("open-") && !session.name.startsWith("project-")) continue;
      issues.push({
        code: "ORPHAN_TMUX_SESSION",
        severity: "info",
        message: `Tmux session does not match an active registered project: ${session.name}`,
        fixable: false,
        recommendedCommand: `projects tmux kill ${session.name}`,
        data: { session: session.name },
      });
    }
  }

  try {
    const windows = scoped && projects[0] ? findDeadWindows(getTmuxSessionName(projects[0])) : findDeadWindows();
    for (const window of windows) {
      issues.push({
        code: "DEAD_TMUX_WINDOW",
        severity: "warn",
        message: `Dead tmux window: ${window.session}:${window.name}`,
        fixable: false,
        recommendedCommand: `projects tmux revive-window ${window.session} ${window.name}`,
        data: { session: window.session, window: window.name, reason: window.reason },
      });
    }
  } catch {
    // tmux may not be running; stale checks should still be useful without it.
  }

  return issues;
}

function projectRef(project: Project): StaleIssue["project"] {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    status: project.status,
  };
}
