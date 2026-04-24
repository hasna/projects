import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { listProjects, updateProject } from "../db/projects.js";
import { addWorkdir, getMachineId, listWorkdirs, removeWorkdir } from "../db/workdirs.js";
import type { Project } from "../types/index.js";
import { createTmuxWindow, getTmuxSessionName, listSessions } from "./tmux.js";

export type CheckStatus = "ok" | "warn" | "error";

export interface ProjectCheck {
  code: string;
  name: string;
  status: CheckStatus;
  message: string;
  fixable?: boolean;
}

export interface DoctorResult {
  project: Project;
  checks: ProjectCheck[];
  ok: boolean;
}

export interface ProjectFix {
  code: string;
  message: string;
  changed: boolean;
  dryRun: boolean;
}

export interface FixProjectOptions {
  dryRun?: boolean;
}

function checkPath(project: Project): ProjectCheck {
  if (existsSync(project.path)) return { code: "PATH_OK", name: "path", status: "ok", message: project.path };
  return { code: "PROJECT_PATH_MISSING", name: "path", status: "error", message: `Path missing on this machine: ${project.path}` };
}

function checkProjectJson(project: Project): ProjectCheck {
  if (!existsSync(project.path)) return { code: "PROJECT_JSON_SKIPPED", name: ".project.json", status: "warn", message: "skipped (path missing)" };
  const p = join(project.path, ".project.json");
  if (!existsSync(p)) return { code: "PROJECT_JSON_MISSING", name: ".project.json", status: "warn", message: "missing", fixable: true };
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as { id?: string };
    if (data.id !== project.id) {
      return { code: "PROJECT_JSON_ID_MISMATCH", name: ".project.json", status: "warn", message: `ID mismatch: ${data.id} vs ${project.id}`, fixable: true };
    }
    return { code: "PROJECT_JSON_OK", name: ".project.json", status: "ok", message: "present and valid" };
  } catch {
    return { code: "PROJECT_JSON_MALFORMED", name: ".project.json", status: "warn", message: "malformed JSON", fixable: true };
  }
}

function checkGit(project: Project): ProjectCheck {
  if (!existsSync(project.path)) return { code: "GIT_SKIPPED", name: "git", status: "warn", message: "skipped (path missing)" };
  if (!existsSync(join(project.path, ".git"))) return { code: "GIT_NOT_REPO", name: "git", status: "warn", message: "not a git repo" };
  try {
    execSync("git rev-parse HEAD", { cwd: project.path, stdio: "pipe" });
    const dirty = execSync("git status --porcelain", { cwd: project.path, stdio: "pipe", encoding: "utf-8" }).trim();
    if (dirty) {
      const n = dirty.split("\n").length;
      return { code: "GIT_DIRTY", name: "git", status: "warn", message: `${n} uncommitted change(s)` };
    }
    return { code: "GIT_CLEAN", name: "git", status: "ok", message: "clean" };
  } catch {
    return { code: "GIT_ERROR", name: "git", status: "error", message: "git error — possibly corrupted" };
  }
}

function checkGitRemote(project: Project): ProjectCheck {
  if (!existsSync(join(project.path, ".git"))) {
    return { code: "GIT_REMOTE_SKIPPED", name: "git remote", status: "warn", message: "skipped (not a git repo)" };
  }

  const origin = gitOrigin(project.path);
  if (!project.git_remote && origin) {
    return { code: "GIT_REMOTE_DB_MISSING", name: "git remote", status: "warn", message: `origin exists but DB git_remote is empty: ${origin}`, fixable: true };
  }
  if (project.git_remote && !origin) {
    return { code: "GIT_REMOTE_ORIGIN_MISSING", name: "git remote", status: "warn", message: `DB remote set but git origin is missing: ${project.git_remote}` };
  }
  if (project.git_remote && origin && project.git_remote !== origin) {
    return { code: "GIT_REMOTE_MISMATCH", name: "git remote", status: "warn", message: `DB remote differs from origin: ${project.git_remote} vs ${origin}` };
  }
  return { code: "GIT_REMOTE_OK", name: "git remote", status: "ok", message: origin || "no origin configured" };
}

async function checkS3(project: Project): Promise<ProjectCheck> {
  if (!project.s3_bucket) return { code: "S3_NOT_CONFIGURED", name: "s3", status: "ok", message: "no S3 configured" };
  try {
    const client = new S3Client({ region: process.env["AWS_DEFAULT_REGION"] ?? "us-east-1" });
    await client.send(new HeadBucketCommand({ Bucket: project.s3_bucket }));
    return { code: "S3_OK", name: "s3", status: "ok", message: `s3://${project.s3_bucket} reachable` };
  } catch {
    return { code: "S3_UNREACHABLE", name: "s3", status: "warn", message: `s3://${project.s3_bucket} — not reachable (check AWS credentials)` };
  }
}

function checkWorkdirs(project: Project): ProjectCheck {
  const workdirs = listWorkdirs(project.id);
  const currentMachine = getMachineId();
  if (!workdirs.length) return { code: "WORKDIRS_MISSING", name: "workdirs", status: "warn", message: "no workdirs registered", fixable: existsSync(project.path) };
  const local = workdirs.filter((w) => w.machine_id === currentMachine);
  const missingLocal = local.filter((w) => !existsSync(w.path));
  if (!local.length) return { code: "WORKDIRS_LOCAL_MISSING", name: "workdirs", status: "warn", message: `no workdir registered for ${currentMachine}`, fixable: existsSync(project.path) };
  if (missingLocal.length) return { code: "WORKDIRS_STALE_LOCAL", name: "workdirs", status: "warn", message: `${missingLocal.length} local workdir path(s) missing`, fixable: true };
  return { code: "WORKDIRS_OK", name: "workdirs", status: "ok", message: `${workdirs.length} workdir(s), ${local.length} local` };
}

function checkTmux(project: Project): ProjectCheck {
  const sessionName = getTmuxSessionName(project);
  try {
    const session = listSessions().find((candidate) => candidate.name === sessionName);
    if (!session) {
      return { code: "TMUX_SESSION_MISSING", name: "tmux", status: "warn", message: `missing session: ${sessionName}`, fixable: existsSync(project.path) };
    }
    if (session.group) {
      return { code: "TMUX_LINKED_SESSION", name: "tmux", status: "warn", message: `session is linked to group ${session.group}`, fixable: true };
    }
    return { code: "TMUX_SESSION_OK", name: "tmux", status: "ok", message: sessionName };
  } catch {
    return { code: "TMUX_UNAVAILABLE", name: "tmux", status: "warn", message: "tmux unavailable or no server running" };
  }
}

export async function doctorProject(project: Project): Promise<DoctorResult> {
  const checks: ProjectCheck[] = [
    checkPath(project),
    checkProjectJson(project),
    checkGit(project),
    checkGitRemote(project),
    await checkS3(project),
    checkWorkdirs(project),
    checkTmux(project),
  ];
  return { project, checks, ok: checks.every((c) => c.status !== "error") };
}

export async function doctorAll(): Promise<DoctorResult[]> {
  return Promise.all(listProjects({ status: "active" }).map(doctorProject));
}

export function fixProject(project: Project, options: FixProjectOptions = {}): ProjectFix[] {
  const dryRun = options.dryRun === true;
  const fixes: ProjectFix[] = [];
  const jsonCheck = checkProjectJson(project);
  if (jsonCheck.fixable && existsSync(project.path)) {
    if (!dryRun) writeProjectJson(project);
    fixes.push({ code: "FIX_PROJECT_JSON", message: `${dryRun ? "Would regenerate" : "Regenerated"} .project.json in ${project.path}`, changed: !dryRun, dryRun });
  }

  const workdirs = listWorkdirs(project.id);
  const currentMachine = getMachineId();
  const localWorkdirs = workdirs.filter((workdir) => workdir.machine_id === currentMachine);
  if (existsSync(project.path) && localWorkdirs.length === 0) {
    if (!dryRun) addWorkdir({ project_id: project.id, path: project.path, label: "main", is_primary: true });
    fixes.push({ code: "FIX_LOCAL_WORKDIR", message: `${dryRun ? "Would add" : "Added"} local primary workdir ${project.path}`, changed: !dryRun, dryRun });
  }

  for (const workdir of localWorkdirs.filter((candidate) => !existsSync(candidate.path))) {
    if (!dryRun) removeWorkdir(project.id, workdir.path);
    fixes.push({ code: "FIX_STALE_WORKDIR", message: `${dryRun ? "Would remove" : "Removed"} stale local workdir ${workdir.path}`, changed: !dryRun, dryRun });
  }

  const origin = gitOrigin(project.path);
  if (!project.git_remote && origin) {
    if (!dryRun) updateProject(project.id, { git_remote: origin });
    fixes.push({ code: "FIX_GIT_REMOTE", message: `${dryRun ? "Would store" : "Stored"} git origin in project metadata: ${origin}`, changed: !dryRun, dryRun });
  }

  const tmuxCheck = checkTmux(project);
  if (tmuxCheck.fixable) {
    if (!dryRun) createTmuxWindow(project);
    fixes.push({ code: "FIX_TMUX_SESSION", message: `${dryRun ? "Would repair" : "Repaired"} tmux session ${getTmuxSessionName(project)}`, changed: !dryRun, dryRun });
  }

  return fixes;
}

function writeProjectJson(project: Project): void {
  writeFileSync(
    join(project.path, ".project.json"),
    JSON.stringify({
      id: project.id,
      slug: project.slug,
      name: project.name,
      created_at: project.created_at,
      integrations: project.integrations ?? {},
    }, null, 2) + "\n",
    "utf-8",
  );
}

function gitOrigin(path: string): string | null {
  if (!existsSync(join(path, ".git"))) return null;
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd: path, encoding: "utf-8", stdio: "pipe" }).trim() || null;
  } catch {
    return null;
  }
}
