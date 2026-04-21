import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { listProjects } from "../db/projects.js";
import { getDatabase } from "../db/database.js";
import { listWorkdirs } from "../db/workdirs.js";
import type { Project, ProjectRow } from "../types/index.js";

export interface ProjectStatus {
  project: Project;
  path_exists: boolean;
  git_status: string | null;   // "clean" | "N dirty" | "not a repo" | null
  last_synced: string | null;
  workdir_count: number;
  disk_bytes: number | null;
}

function gitStatus(path: string): string | null {
  if (!existsSync(join(path, ".git"))) return "not a repo";
  try {
    const out = execSync("git status --porcelain", { cwd: path, stdio: "pipe", encoding: "utf-8" }).trim();
    if (!out) return "clean";
    const n = out.split("\n").length;
    return `${n} dirty`;
  } catch { return null; }
}

function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const out = execSync(`du -sb -- "${path}" 2>/dev/null || du -sk -- "${path}" 2>/dev/null`, { stdio: "pipe", encoding: "utf-8" }).trim();
    return parseInt(out.split("\t")[0] ?? "0", 10);
  } catch { return 0; }
}

export function getProjectStatus(project: Project): ProjectStatus {
  const pathExists = existsSync(project.path);
  const workdirs = listWorkdirs(project.id);
  const lastSync = (getDatabase().query(
    "SELECT completed_at FROM sync_log WHERE project_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1"
  ).get(project.id) as { completed_at: string | null } | null)?.completed_at ?? null;

  return {
    project,
    path_exists: pathExists,
    git_status: pathExists ? gitStatus(project.path) : null,
    last_synced: lastSync,
    workdir_count: workdirs.length,
    disk_bytes: pathExists ? dirSize(project.path) : null,
  };
}

export function getAllStatus(): ProjectStatus[] {
  return listProjects({ status: "active" }).map(getProjectStatus);
}

export function touchLastOpened(projectId: string): void {
  getDatabase().run("UPDATE projects SET last_opened_at = ? WHERE id = ?", [new Date().toISOString(), projectId]);
}

export function getRecentProjects(limit = 10): Project[] {
  return getDatabase()
    .query("SELECT * FROM projects WHERE last_opened_at IS NOT NULL ORDER BY last_opened_at DESC LIMIT ?")
    .all(limit)
    .map((r: unknown) => {
      const row = r as ProjectRow;
      return {
        ...row,
        status: row.status as Project["status"],
        tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
        integrations: row.integrations ? (JSON.parse(row.integrations) as Project["integrations"]) : {},
        last_opened_at: row.last_opened_at ?? null,
      };
    });
}
