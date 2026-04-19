import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface ProjectsConfig {
  default_path?: string;         // base dir for new projects
  default_github_org?: string;   // org for repo creation
  default_tmux_group?: string;   // tmux session group
  default_tmux_master?: string;  // master session name
  default_repo_visibility?: "private" | "public";
  scaffold_dirs?: string[];      // dirs to create on project init
  launch_takumi?: boolean;       // auto-start takumi in tmux
  [key: string]: unknown;
}

const CONFIG_PATH = join(homedir(), ".hasna", "projects", "config.json");

const DEFAULTS: ProjectsConfig = {
  default_path: process.cwd(),
  default_github_org: "hasnaxyz",
  default_tmux_group: "projectmaintain",
  default_tmux_master: "master",
  default_repo_visibility: "private",
  scaffold_dirs: ["data", "scripts", "assets", "docs"],
  launch_takumi: true,
};

export function getConfig(): ProjectsConfig {
  if (existsSync(CONFIG_PATH)) {
    try {
      const user = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProjectsConfig;
      return { ...DEFAULTS, ...user };
    } catch {
      return { ...DEFAULTS };
    }
  }
  return { ...DEFAULTS };
}

export function saveConfig(config: Partial<ProjectsConfig>): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const existing = getConfig();
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...config }, null, 2) + "\n", "utf-8");
}

export function resolveProjectPath(providedPath?: string): string {
  if (providedPath) return providedPath;
  const config = getConfig();
  return config.default_path ?? process.cwd();
}

import { execSync } from "node:child_process";

export function resolveProjectName(name: string, config?: ProjectsConfig): { name: string; suggested?: string } {
  const cfg = config || getConfig();
  const org = cfg.default_github_org || "hasnaxyz";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  try {
    execSync(`gh repo view ${org}/${slug}`, { stdio: "pipe", timeout: 3000 });
    const alt = `${slug}-2`;
    return { name, suggested: alt };
  } catch {
    // gh CLI not available or repo doesn't exist — name is fine
    return { name };
  }
}

export function resolvePathConflict(path: string): string | null {
  if (!existsSync(path)) return null;
  const base = path.replace(/\/+$/, "");
  let i = 1;
  let candidate = `${base}-${i}`;
  while (existsSync(candidate)) {
    i++;
    candidate = `${base}-${i}`;
  }
  return candidate;
}
