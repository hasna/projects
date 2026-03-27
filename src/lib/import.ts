import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createProject, getProjectByPath } from "../db/projects.js";
import type { Project } from "../types/index.js";

export interface ImportResult {
  imported: Project[];
  skipped: { path: string; reason: string }[];
  errors: { path: string; error: string }[];
}

export interface ImportOptions {
  move?: boolean;   // reserved for future: physically move files
  link?: boolean;   // reserved for future: symlink to new location
  dryRun?: boolean;
  defaultTags?: string[];
  onProgress?: (msg: string) => void;
}

function inferProjectName(projectPath: string): string {
  // Try reading package.json name
  const pkgPath = join(projectPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
      if (pkg.name) return pkg.name.replace(/^@[^/]+\//, ""); // strip @scope/
    } catch {
      // fall through
    }
  }

  // Try reading .project.json name
  const projPath = join(projectPath, ".project.json");
  if (existsSync(projPath)) {
    try {
      const p = JSON.parse(readFileSync(projPath, "utf-8")) as { name?: string };
      if (p.name) return p.name;
    } catch {
      // fall through
    }
  }

  // Fall back to directory name
  return basename(projectPath);
}

function inferGitRemote(projectPath: string): string | undefined {
  const gitConfigPath = join(projectPath, ".git", "config");
  if (!existsSync(gitConfigPath)) return undefined;
  try {
    const config = readFileSync(gitConfigPath, "utf-8");
    const match = config.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export async function importProject(
  projectPath: string,
  options: ImportOptions = {},
): Promise<{ project?: Project; skipped?: string; error?: string }> {
  const absPath = resolve(projectPath);
  const log = options.onProgress ?? (() => {});

  if (!existsSync(absPath)) {
    return { error: `Path does not exist: ${absPath}` };
  }

  const stat = statSync(absPath);
  if (!stat.isDirectory()) {
    return { error: `Not a directory: ${absPath}` };
  }

  // Skip if already registered
  const existing = getProjectByPath(absPath);
  if (existing) {
    return { skipped: `Already registered as "${existing.name}" (${existing.id})` };
  }

  const name = inferProjectName(absPath);
  const gitRemote = inferGitRemote(absPath);

  if (options.dryRun) {
    log(`[dry-run] would import: ${name} from ${absPath}`);
    return { skipped: "dry-run" };
  }

  try {
    const project = createProject({
      name,
      path: absPath,
      git_remote: gitRemote,
      tags: options.defaultTags ?? [],
      git_init: false, // don't re-init existing repos
    });
    log(`imported: ${name} → ${project.id}`);
    return { project };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function importBulk(
  dirPath: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const absDir = resolve(dirPath);
  const result: ImportResult = { imported: [], skipped: [], errors: [] };
  const log = options.onProgress ?? (() => {});

  if (!existsSync(absDir)) {
    result.errors.push({ path: absDir, error: "Directory does not exist" });
    return result;
  }

  const entries = readdirSync(absDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));

  log(`Found ${dirs.length} subdirectories in ${absDir}`);

  for (const entry of dirs) {
    const subPath = join(absDir, entry.name);
    const res = await importProject(subPath, options);
    if (res.project) {
      result.imported.push(res.project);
    } else if (res.skipped) {
      result.skipped.push({ path: subPath, reason: res.skipped });
    } else if (res.error) {
      result.errors.push({ path: subPath, error: res.error });
    }
  }

  return result;
}
