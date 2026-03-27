// Project statuses
export const PROJECT_STATUSES = ["active", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// Sync directions
export const SYNC_DIRECTIONS = ["push", "pull", "both"] as const;
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number];

// Sync log statuses
export const SYNC_LOG_STATUSES = ["running", "completed", "failed"] as const;
export type SyncLogStatus = (typeof SYNC_LOG_STATUSES)[number];

// Project
export interface Project {
  id: string; // prj_ + nanoid(12)
  slug: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  path: string;
  s3_bucket: string | null;
  s3_prefix: string | null;
  git_remote: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  path: string;
  s3_bucket: string | null;
  s3_prefix: string | null;
  git_remote: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  description?: string;
  slug?: string;
  tags?: string[];
  s3_bucket?: string;
  s3_prefix?: string;
  git_remote?: string;
  git_init?: boolean; // auto-init git repo (default: true if path exists and is not already a repo)
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  path?: string;
  tags?: string[];
  s3_bucket?: string | null;
  s3_prefix?: string | null;
  git_remote?: string | null;
}

export interface ProjectFilter {
  status?: ProjectStatus;
  tags?: string[];
  limit?: number;
  offset?: number;
}

// Project file (tracked for sync)
export interface ProjectFile {
  id: string;
  project_id: string;
  relative_path: string;
  size: number;
  hash: string | null;
  synced_at: string | null;
}

// Sync log entry
export interface SyncLog {
  id: string;
  project_id: string;
  direction: SyncDirection;
  status: SyncLogStatus;
  files_synced: number;
  bytes: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface SyncLogRow {
  id: string;
  project_id: string;
  direction: string;
  status: string;
  files_synced: number;
  bytes: number;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

// Errors
export class ProjectNotFoundError extends Error {
  static readonly code = "PROJECT_NOT_FOUND";
  static readonly suggestion = "Use `projects list` to see available projects.";
  constructor(public projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectSlugConflictError extends Error {
  static readonly code = "SLUG_CONFLICT";
  static readonly suggestion = "Choose a different name or provide an explicit --slug.";
  constructor(public slug: string) {
    super(`A project with slug "${slug}" already exists`);
    this.name = "ProjectSlugConflictError";
  }
}

export class ProjectPathConflictError extends Error {
  static readonly code = "PATH_CONFLICT";
  static readonly suggestion = "Use `projects get` to find the existing project at this path.";
  constructor(public path: string) {
    super(`A project is already registered at path: ${path}`);
    this.name = "ProjectPathConflictError";
  }
}
