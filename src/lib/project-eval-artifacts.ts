import type { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";
import { deleteWorkspace, listWorkspaces } from "../db/workspaces.js";
import type { EventSource, JsonObject, Workspace } from "../types/workspace.js";

export interface ProjectEvalArtifactCleanupOptions {
  dryRun?: boolean;
  agentId?: string;
  source?: EventSource;
  command?: string;
  db?: Database;
}

export interface ProjectEvalArtifactCleanupItem {
  id: string;
  slug: string;
  name: string;
  kind: string;
}

export interface ProjectEvalArtifactCleanupResult {
  dry_run: boolean;
  projects: ProjectEvalArtifactCleanupItem[];
  supporting: {
    roots: ProjectEvalArtifactCleanupItem[];
    recipes: ProjectEvalArtifactCleanupItem[];
    agents: ProjectEvalArtifactCleanupItem[];
    tmux_profiles: ProjectEvalArtifactCleanupItem[];
  };
  deleted: {
    projects: number;
    roots: number;
    recipes: number;
    agents: number;
    tmux_profiles: number;
  };
}

interface SlugNameRow {
  id: string;
  slug: string;
  name: string;
}

export function isProjectEvalArtifact(project: Workspace): boolean {
  const metadata = project.metadata as JsonObject;
  return project.slug.startsWith("eval-")
    || project.name.startsWith("Eval ")
    || project.tags.some((tag) => tag === "eval" || tag.startsWith("eval-"))
    || metadata["eval_fixture"] === true
    || metadata["agent_eval_fixture"] === true;
}

export function filterProjectEvalArtifacts<T extends Workspace>(projects: T[], includeEvals = false): T[] {
  return includeEvals ? projects : projects.filter((project) => !isProjectEvalArtifact(project));
}

function rows(table: string, db: Database): ProjectEvalArtifactCleanupItem[] {
  const result = db
    .query(`SELECT id, slug, name FROM ${table} WHERE slug LIKE 'eval-%' OR name LIKE 'Eval %' ORDER BY name ASC`)
    .all() as SlugNameRow[];
  return result.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: table,
  }));
}

function deleteRows(table: string, items: ProjectEvalArtifactCleanupItem[], db: Database): number {
  let deleted = 0;
  for (const item of items) {
    deleted += db.run(`DELETE FROM ${table} WHERE id = ?`, [item.id]).changes;
  }
  return deleted;
}

function projectItem(project: Workspace): ProjectEvalArtifactCleanupItem {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    kind: project.kind,
  };
}

export function cleanupProjectEvalArtifacts(options: ProjectEvalArtifactCleanupOptions = {}): ProjectEvalArtifactCleanupResult {
  const db = options.db ?? getDatabase();
  const projects = listWorkspaces({ limit: 10_000 }, db).filter(isProjectEvalArtifact);
  const supporting = {
    roots: rows("roots", db),
    recipes: rows("recipes", db),
    agents: rows("agents", db),
    tmux_profiles: rows("tmux_profiles", db),
  };

  if (options.dryRun) {
    return {
      dry_run: true,
      projects: projects.map(projectItem),
      supporting,
      deleted: {
        projects: 0,
        roots: 0,
        recipes: 0,
        agents: 0,
        tmux_profiles: 0,
      },
    };
  }

  let deletedProjects = 0;
  for (const project of projects) {
    deleteWorkspace(project.id, {
      hard: true,
      agent_id: options.agentId,
      source: options.source ?? "cli",
      command: options.command,
    }, db);
    deletedProjects += 1;
  }

  return {
    dry_run: false,
    projects: projects.map(projectItem),
    supporting,
    deleted: {
      projects: deletedProjects,
      roots: deleteRows("roots", supporting.roots, db),
      recipes: deleteRows("recipes", supporting.recipes, db),
      agents: deleteRows("agents", supporting.agents, db),
      tmux_profiles: deleteRows("tmux_profiles", supporting.tmux_profiles, db),
    },
  };
}
