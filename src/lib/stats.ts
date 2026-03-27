import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { listProjects } from "../db/projects.js";
import { getDatabase } from "../db/database.js";

export interface ProjectStats {
  project_id: string;
  name: string;
  file_count: number;
  disk_bytes: number;
  sync_count: number;
  synced_bytes: number;
  last_synced: string | null;
  workdir_count: number;
}

export interface GlobalStats {
  total: number;
  active: number;
  archived: number;
  total_disk_bytes: number;
  total_synced_bytes: number;
  total_syncs: number;
  projects: ProjectStats[];
}

function countFiles(dir: string): { count: number; bytes: number } {
  if (!existsSync(dir)) return { count: 0, bytes: 0 };
  try {
    const count = parseInt(execSync(`find "${dir}" -type f 2>/dev/null | wc -l`, { stdio: "pipe", encoding: "utf-8" }).trim(), 10);
    const bytesOut = execSync(`du -sb "${dir}" 2>/dev/null || du -sk "${dir}" 2>/dev/null`, { stdio: "pipe", encoding: "utf-8" }).trim();
    const bytes = parseInt(bytesOut.split("\t")[0] ?? "0", 10);
    return { count: isNaN(count) ? 0 : count, bytes: isNaN(bytes) ? 0 : bytes };
  } catch { return { count: 0, bytes: 0 }; }
}

export function getProjectStats(projectId: string): ProjectStats | null {
  const db = getDatabase();
  const project = db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as { id: string; name: string; path: string } | null;
  if (!project) return null;

  const { count, bytes } = countFiles(project.path);

  const syncRow = db.query(
    "SELECT COUNT(*) as n, COALESCE(SUM(bytes),0) as total FROM sync_log WHERE project_id = ? AND status = 'completed'"
  ).get(project.id) as { n: number; total: number };

  const lastSync = (db.query(
    "SELECT completed_at FROM sync_log WHERE project_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1"
  ).get(project.id) as { completed_at: string } | null)?.completed_at ?? null;

  const wdCount = (db.query("SELECT COUNT(*) as n FROM project_workdirs WHERE project_id = ?").get(project.id) as { n: number }).n;

  return {
    project_id: project.id,
    name: project.name,
    file_count: count,
    disk_bytes: bytes,
    sync_count: syncRow.n,
    synced_bytes: syncRow.total,
    last_synced: lastSync,
    workdir_count: wdCount,
  };
}

export function getGlobalStats(): GlobalStats {
  const db = getDatabase();
  const all = listProjects({});
  const active = all.filter((p) => p.status === "active");
  const archived = all.filter((p) => p.status === "archived");

  const projects = active.map((p) => getProjectStats(p.id)!).filter(Boolean);
  const totalDisk = projects.reduce((s, p) => s + p.disk_bytes, 0);
  const totalSynced = projects.reduce((s, p) => s + p.synced_bytes, 0);
  const totalSyncs = projects.reduce((s, p) => s + p.sync_count, 0);

  return {
    total: all.length,
    active: active.length,
    archived: archived.length,
    total_disk_bytes: totalDisk,
    total_synced_bytes: totalSynced,
    total_syncs: totalSyncs,
    projects,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
