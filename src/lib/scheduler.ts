/**
 * Scheduler for auto-syncing projects.
 *
 * Config is stored in ~/.hasna/projects/scheduler.json
 * Cron integration uses the system crontab via `crontab -l` / `crontab`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { listProjects, getProject } from "../db/projects.js";
import { syncProject } from "./sync.js";

export interface ScheduleConfig {
  enabled: boolean;
  interval: "hourly" | "daily" | "weekly";
  direction: "push" | "pull" | "both";
  last_run?: string;
  next_run?: string;
}

const CONFIG_PATH = join(
  process.env["HOME"] || "~",
  ".hasna",
  "projects",
  "scheduler.json",
);

const CRON_TAG = "# open-projects auto-sync";

export function getScheduleConfig(): ScheduleConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { enabled: false, interval: "daily", direction: "both" };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ScheduleConfig;
}

export function saveScheduleConfig(config: ScheduleConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function intervalToCron(interval: ScheduleConfig["interval"]): string {
  switch (interval) {
    case "hourly": return "0 * * * *";
    case "daily":  return "0 2 * * *";   // 2 AM daily
    case "weekly": return "0 2 * * 0";   // 2 AM Sunday
  }
}

function projectsBin(): string {
  // Find the CLI binary
  try {
    return execSync("which project", { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch {
    return "project";
  }
}

export function installCron(config: ScheduleConfig): void {
  const cron = intervalToCron(config.interval);
  const bin = projectsBin();
  const cronLine = `${cron} ${bin} sync --all --direction ${config.direction} ${CRON_TAG}`;

  // Read existing crontab, remove old open-projects lines, add new one
  let existing = "";
  try {
    existing = execSync("crontab -l 2>/dev/null", { stdio: "pipe", encoding: "utf-8" });
  } catch {
    existing = "";
  }

  const cleaned = existing
    .split("\n")
    .filter((line) => !line.includes(CRON_TAG))
    .join("\n")
    .trimEnd();

  const newCrontab = (cleaned ? cleaned + "\n" : "") + cronLine + "\n";
  execSync(`echo ${JSON.stringify(newCrontab)} | crontab -`, { stdio: "pipe" });
}

export function removeCron(): void {
  try {
    const existing = execSync("crontab -l 2>/dev/null", { stdio: "pipe", encoding: "utf-8" });
    const cleaned = existing
      .split("\n")
      .filter((line) => !line.includes(CRON_TAG))
      .join("\n")
      .trimEnd();
    if (cleaned) {
      execSync(`echo ${JSON.stringify(cleaned + "\n")} | crontab -`, { stdio: "pipe" });
    } else {
      execSync("crontab -r 2>/dev/null || true", { stdio: "pipe" });
    }
  } catch {
    // No crontab to remove
  }
}

export interface SyncAllResult {
  synced: string[];
  skipped: string[];
  errors: { name: string; error: string }[];
}

export async function syncAll(
  direction: "push" | "pull" | "both" = "both",
  onProgress?: (msg: string) => void,
): Promise<SyncAllResult> {
  const log = onProgress ?? (() => {});
  const projects = listProjects({ status: "active" });
  const result: SyncAllResult = { synced: [], skipped: [], errors: [] };

  for (const project of projects) {
    if (!project.s3_bucket) {
      result.skipped.push(project.name);
      continue;
    }
    try {
      log(`syncing ${project.name}...`);
      await syncProject(project, { direction, onProgress: log });
      result.synced.push(project.name);
    } catch (err) {
      result.errors.push({
        name: project.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Update last_run
  const config = getScheduleConfig();
  saveScheduleConfig({ ...config, last_run: new Date().toISOString() });

  return result;
}
