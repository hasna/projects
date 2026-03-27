/**
 * Auto-detect the current project from cwd by walking up looking for .project.json
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getProject } from "../db/projects.js";
import type { Project } from "../types/index.js";

interface ProjectJson {
  id?: string;
}

function findProjectJson(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".project.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function detectCurrentProject(): Project | null {
  const jsonPath = findProjectJson(process.cwd());
  if (!jsonPath) return null;
  try {
    const data = JSON.parse(readFileSync(jsonPath, "utf-8")) as ProjectJson;
    if (data.id) return getProject(data.id);
  } catch {
    // malformed .project.json
  }
  return null;
}
