import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { listSessions, listWindows, type TmuxSession, type TmuxWindow } from "./tmux.js";

export const OSS_PROJECT_MATRIX_SCHEMA_VERSION = 1 as const;
export const DEFAULT_OSS_MATRIX_LIMIT = 25;
export const MAX_OSS_MATRIX_LIMIT = 200;

export interface OssMatrixCommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type OssMatrixCommandRunner = (
  command: string,
  args: string[],
  options?: OssMatrixCommandOptions,
) => string;

export interface OssProjectMatrixOptions {
  root: string;
  prefix?: string;
  limit?: number;
  taskLimit?: number;
  prLimit?: number;
  timeoutMs?: number;
  includeTasks?: boolean;
  includePullRequests?: boolean;
  includeTmux?: boolean;
  commandRunner?: OssMatrixCommandRunner;
  tmuxSessions?: TmuxSession[];
  tmuxWindows?: TmuxWindow[];
  generatedAt?: string;
}

export interface OssPackageMetadata {
  path: string | null;
  name: string | null;
  version: string | null;
  private: boolean | null;
  bins: string[];
}

export interface OssGitStatus {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  changed_files: number;
  remote: string | null;
  github_repo: string | null;
}

export interface OssTmuxHint {
  suggested_session: string;
  sessions: Array<{
    name: string;
    match: "exact" | "prefix";
    windows: number;
    attached: boolean;
    window_names: string[];
  }>;
}

export interface OssTaskRef {
  id: string;
  title: string;
  status: string | null;
  priority: string | null;
  assigned_to: string | null;
  locked_by: string | null;
  updated_at: string | null;
}

export interface OssPullRequestRef {
  number: number;
  title: string;
  state: string;
  url: string;
  updated_at: string | null;
  head_ref: string | null;
}

export interface OssProjectMatrixRow {
  name: string;
  path: string;
  package: OssPackageMetadata | null;
  git: OssGitStatus;
  tmux: OssTmuxHint | null;
  task_refs: OssTaskRef[];
  pr_refs: OssPullRequestRef[];
  warnings: string[];
}

export interface OssProjectMatrix {
  schema_version: typeof OSS_PROJECT_MATRIX_SCHEMA_VERSION;
  kind: "projects.oss_matrix";
  generated_at: string;
  root: string;
  prefix: string;
  limit: number;
  total_candidates: number;
  returned: number;
  truncated: boolean;
  rows: OssProjectMatrixRow[];
}

function defaultCommandRunner(command: string, args: string[], options: OssMatrixCommandOptions = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
  }).trim();
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error("Matrix limits must be positive integers");
  if (value > max) throw new Error(`Matrix limit must be ${max} or less`);
  return value;
}

function safeRun(
  runner: OssMatrixCommandRunner,
  command: string,
  args: string[],
  options: OssMatrixCommandOptions,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return { ok: true, value: runner(command, args, options).trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readPackageMetadata(repoPath: string, warnings: string[]): OssPackageMetadata | null {
  const packagePath = join(repoPath, "package.json");
  if (!existsSync(packagePath)) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(packagePath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    warnings.push(`package.json parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const bin = parsed.bin;
  const bins = typeof bin === "string"
    ? [typeof parsed.name === "string" ? parsed.name : basename(repoPath)]
    : bin && typeof bin === "object" && !Array.isArray(bin)
      ? Object.keys(bin)
      : [];
  return {
    path: packagePath,
    name: typeof parsed.name === "string" ? parsed.name : null,
    version: typeof parsed.version === "string" ? parsed.version : null,
    private: typeof parsed.private === "boolean" ? parsed.private : null,
    bins: bins.sort(),
  };
}

function parseGitHubRepo(remote: string | null): string | null {
  if (!remote) return null;
  const normalized = remote.trim().replace(/\.git$/, "");
  const https = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  if (https?.[1]) return https[1];
  const ssh = normalized.match(/^git@github\.com:([^/]+\/[^/]+)$/);
  if (ssh?.[1]) return ssh[1];
  const sshUrl = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/);
  if (sshUrl?.[1]) return sshUrl[1];
  return null;
}

function parseBranchHeader(header: string): Pick<OssGitStatus, "branch" | "upstream" | "ahead" | "behind"> {
  const clean = header.replace(/^##\s+/, "").trim();
  const aheadBehind = clean.match(/\[(?<meta>[^\]]+)\]$/);
  const meta = aheadBehind?.groups?.meta ?? "";
  const branchPart = aheadBehind ? clean.slice(0, aheadBehind.index).trim() : clean;
  const [branchRaw, upstreamRaw] = branchPart.split("...");
  const aheadMatch = meta.match(/ahead (\d+)/);
  const behindMatch = meta.match(/behind (\d+)/);
  return {
    branch: branchRaw && branchRaw !== "HEAD (no branch)" ? branchRaw : null,
    upstream: upstreamRaw || null,
    ahead: aheadMatch?.[1] ? Number.parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch?.[1] ? Number.parseInt(behindMatch[1], 10) : 0,
  };
}

function inspectGit(repoPath: string, runner: OssMatrixCommandRunner, timeoutMs: number, warnings: string[]): OssGitStatus {
  const base: OssGitStatus = {
    is_repo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    changed_files: 0,
    remote: null,
    github_repo: null,
  };
  const inside = safeRun(runner, "git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath, timeoutMs });
  if (!inside.ok || inside.value !== "true") return base;

  const status = safeRun(runner, "git", ["status", "--short", "--branch"], { cwd: repoPath, timeoutMs });
  if (!status.ok) {
    warnings.push(`git status unavailable: ${status.error}`);
    return { ...base, is_repo: true };
  }
  const lines = status.value.split(/\r?\n/).filter(Boolean);
  const header = lines.find((line) => line.startsWith("## "));
  const changedFiles = lines.filter((line) => !line.startsWith("## ")).length;
  const parsed = header ? parseBranchHeader(header) : { branch: null, upstream: null, ahead: 0, behind: 0 };

  let branch = parsed.branch;
  if (!branch) {
    const detached = safeRun(runner, "git", ["rev-parse", "--short", "HEAD"], { cwd: repoPath, timeoutMs });
    if (detached.ok && detached.value) branch = detached.value;
  }
  const remote = safeRun(runner, "git", ["remote", "get-url", "origin"], { cwd: repoPath, timeoutMs });
  const remoteValue = remote.ok && remote.value ? remote.value : null;
  return {
    is_repo: true,
    branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    dirty: changedFiles > 0,
    changed_files: changedFiles,
    remote: remoteValue,
    github_repo: parseGitHubRepo(remoteValue),
  };
}

function loadTmuxSessions(includeTmux: boolean, provided: TmuxSession[] | undefined): TmuxSession[] {
  if (!includeTmux) return [];
  if (provided) return provided;
  try {
    return listSessions();
  } catch {
    return [];
  }
}

function loadTmuxWindows(includeTmux: boolean, provided: TmuxWindow[] | undefined): TmuxWindow[] {
  if (!includeTmux) return [];
  if (provided) return provided;
  try {
    return listWindows();
  } catch {
    return [];
  }
}

function tmuxHint(repoName: string, sessions: TmuxSession[], windows: TmuxWindow[]): OssTmuxHint {
  const matches = sessions
    .filter((session) => session.name === repoName || session.name.startsWith(`${repoName}-`))
    .map((session) => ({
      name: session.name,
      match: session.name === repoName ? "exact" as const : "prefix" as const,
      windows: session.windows,
      attached: session.attached,
      window_names: windows
        .filter((window) => window.session === session.name)
        .map((window) => window.name),
    }));
  return {
    suggested_session: repoName,
    sessions: matches,
  };
}

function taskRefs(repoPath: string, limit: number, runner: OssMatrixCommandRunner, timeoutMs: number, warnings: string[]): OssTaskRef[] {
  const result = safeRun(runner, "todos", ["--project", repoPath, "list", "--format", "json", "--all", "--sort", "updated", "--limit", String(limit)], { timeoutMs });
  if (!result.ok || !result.value) {
    if (!result.ok) warnings.push(`todos unavailable: ${result.error}`);
    return [];
  }
  try {
    const parsed = JSON.parse(result.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, limit).map((item) => {
      const task = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        id: String(task.id ?? ""),
        title: String(task.title ?? ""),
        status: typeof task.status === "string" ? task.status : null,
        priority: typeof task.priority === "string" ? task.priority : null,
        assigned_to: typeof task.assigned_to === "string" ? task.assigned_to : null,
        locked_by: typeof task.locked_by === "string" ? task.locked_by : null,
        updated_at: typeof task.updated_at === "string" ? task.updated_at : null,
      };
    }).filter((task) => task.id && task.title);
  } catch (err) {
    warnings.push(`todos JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function prRefs(githubRepo: string | null, limit: number, runner: OssMatrixCommandRunner, timeoutMs: number, warnings: string[]): OssPullRequestRef[] {
  if (!githubRepo) return [];
  const result = safeRun(runner, "gh", [
    "pr",
    "list",
    "-R",
    githubRepo,
    "--state",
    "all",
    "--search",
    "sort:updated-desc",
    "--limit",
    String(limit),
    "--json",
    "number,title,state,url,updatedAt,headRefName",
  ], { timeoutMs });
  if (!result.ok || !result.value) {
    if (!result.ok) warnings.push(`gh pr list unavailable: ${result.error}`);
    return [];
  }
  try {
    const parsed = JSON.parse(result.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice()
      .sort((a, b) => {
        const aUpdated = a && typeof a === "object" && typeof (a as Record<string, unknown>).updatedAt === "string"
          ? Date.parse((a as Record<string, unknown>).updatedAt as string)
          : 0;
        const bUpdated = b && typeof b === "object" && typeof (b as Record<string, unknown>).updatedAt === "string"
          ? Date.parse((b as Record<string, unknown>).updatedAt as string)
          : 0;
        return bUpdated - aUpdated;
      })
      .slice(0, limit)
      .map((item) => {
      const pr = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        number: typeof pr.number === "number" ? pr.number : Number(pr.number ?? 0),
        title: String(pr.title ?? ""),
        state: String(pr.state ?? ""),
        url: String(pr.url ?? ""),
        updated_at: typeof pr.updatedAt === "string" ? pr.updatedAt : null,
        head_ref: typeof pr.headRefName === "string" ? pr.headRefName : null,
      };
    }).filter((pr) => Number.isInteger(pr.number) && pr.number > 0 && pr.title);
  } catch (err) {
    warnings.push(`gh JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function buildOssProjectMatrix(options: OssProjectMatrixOptions): OssProjectMatrix {
  const root = resolve(options.root);
  const prefix = options.prefix ?? "open-";
  const limit = boundedPositiveInteger(options.limit, DEFAULT_OSS_MATRIX_LIMIT, MAX_OSS_MATRIX_LIMIT);
  const taskLimit = boundedPositiveInteger(options.taskLimit, 1, 10);
  const prLimit = boundedPositiveInteger(options.prLimit, 1, 10);
  const timeoutMs = boundedPositiveInteger(options.timeoutMs, 1500, 30000);
  const includeTasks = options.includeTasks !== false;
  const includePullRequests = options.includePullRequests !== false;
  const includeTmux = options.includeTmux !== false;
  const runner = options.commandRunner ?? defaultCommandRunner;

  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => ({ name: entry.name, path: join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = candidates.slice(0, limit);
  const tmuxSessions = loadTmuxSessions(includeTmux, options.tmuxSessions);
  const tmuxWindows = loadTmuxWindows(includeTmux, options.tmuxWindows);

  const rows = selected.map((candidate): OssProjectMatrixRow => {
    const warnings: string[] = [];
    const packageMetadata = readPackageMetadata(candidate.path, warnings);
    const git = inspectGit(candidate.path, runner, timeoutMs, warnings);
    return {
      name: candidate.name,
      path: candidate.path,
      package: packageMetadata,
      git,
      tmux: includeTmux ? tmuxHint(candidate.name, tmuxSessions, tmuxWindows) : null,
      task_refs: includeTasks ? taskRefs(candidate.path, taskLimit, runner, timeoutMs, warnings) : [],
      pr_refs: includePullRequests ? prRefs(git.github_repo, prLimit, runner, timeoutMs, warnings) : [],
      warnings,
    };
  });

  return {
    schema_version: OSS_PROJECT_MATRIX_SCHEMA_VERSION,
    kind: "projects.oss_matrix",
    generated_at: options.generatedAt ?? new Date().toISOString(),
    root,
    prefix,
    limit,
    total_candidates: candidates.length,
    returned: rows.length,
    truncated: candidates.length > rows.length,
    rows,
  };
}
