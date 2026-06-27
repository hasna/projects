import { join, resolve } from "node:path";

export const PROJECTS_HOME_ENV = "HASNA_PROJECTS_HOME";
export const PROJECT_WORKSPACE_ID_PATTERN = /^wks_[A-Za-z0-9_-]{1,80}$/;

export function assertProjectWorkspaceId(workspaceId: string): string {
  if (!PROJECT_WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(`Invalid workspace id for project store path: ${workspaceId}`);
  }
  return workspaceId;
}

export function getProjectsHome(): string {
  const configured = process.env[PROJECTS_HOME_ENV]?.trim();
  if (configured) return resolve(configured);
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  return resolve(join(home, ".hasna", "projects"));
}

export function projectWorkspaceStorePath(workspaceId: string): string {
  return resolve(join(getProjectsHome(), "workspaces", assertProjectWorkspaceId(workspaceId)));
}

export function projectDataStorePath(workspaceId: string): string {
  return resolve(join(getProjectsHome(), "data", assertProjectWorkspaceId(workspaceId)));
}

export function isProjectWorkspaceStorePath(workspaceId: string, path: string | null | undefined): boolean {
  return Boolean(path && resolve(path) === projectWorkspaceStorePath(workspaceId));
}
