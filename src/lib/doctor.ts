import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { listProjects } from "../db/projects.js";
import { listWorkdirs } from "../db/workdirs.js";
import type { Project } from "../types/index.js";

export type CheckStatus = "ok" | "warn" | "error";

export interface ProjectCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export interface DoctorResult {
  project: Project;
  checks: ProjectCheck[];
  ok: boolean;
}

function checkPath(project: Project): ProjectCheck {
  if (existsSync(project.path)) return { name: "path", status: "ok", message: project.path };
  return { name: "path", status: "error", message: `Path missing on this machine: ${project.path}` };
}

function checkProjectJson(project: Project): ProjectCheck {
  if (!existsSync(project.path)) return { name: ".project.json", status: "warn", message: "skipped (path missing)" };
  const p = join(project.path, ".project.json");
  if (!existsSync(p)) return { name: ".project.json", status: "warn", message: "missing — run: projects workdir generate" };
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as { id?: string };
    if (data.id !== project.id) return { name: ".project.json", status: "warn", message: `ID mismatch: ${data.id} vs ${project.id}` };
    return { name: ".project.json", status: "ok", message: "present and valid" };
  } catch {
    return { name: ".project.json", status: "warn", message: "malformed JSON" };
  }
}

function checkGit(project: Project): ProjectCheck {
  if (!existsSync(project.path)) return { name: "git", status: "warn", message: "skipped (path missing)" };
  if (!existsSync(join(project.path, ".git"))) return { name: "git", status: "warn", message: "not a git repo" };
  try {
    execSync("git rev-parse HEAD", { cwd: project.path, stdio: "pipe" });
    const dirty = execSync("git status --porcelain", { cwd: project.path, stdio: "pipe", encoding: "utf-8" }).trim();
    if (dirty) {
      const n = dirty.split("\n").length;
      return { name: "git", status: "warn", message: `${n} uncommitted change(s)` };
    }
    return { name: "git", status: "ok", message: "clean" };
  } catch {
    return { name: "git", status: "error", message: "git error — possibly corrupted" };
  }
}

async function checkS3(project: Project): Promise<ProjectCheck> {
  if (!project.s3_bucket) return { name: "s3", status: "ok", message: "no S3 configured" };
  try {
    const client = new S3Client({ region: process.env["AWS_DEFAULT_REGION"] ?? "us-east-1" });
    await client.send(new HeadBucketCommand({ Bucket: project.s3_bucket }));
    return { name: "s3", status: "ok", message: `s3://${project.s3_bucket} reachable` };
  } catch {
    return { name: "s3", status: "warn", message: `s3://${project.s3_bucket} — not reachable (check AWS credentials)` };
  }
}

function checkWorkdirs(project: Project): ProjectCheck {
  const workdirs = listWorkdirs(project.id);
  if (!workdirs.length) return { name: "workdirs", status: "warn", message: "no workdirs registered" };
  const missing = workdirs.filter((w) => !existsSync(w.path));
  if (missing.length) return { name: "workdirs", status: "warn", message: `${missing.length} workdir path(s) missing on this machine` };
  return { name: "workdirs", status: "ok", message: `${workdirs.length} workdir(s)` };
}

export async function doctorProject(project: Project): Promise<DoctorResult> {
  const checks: ProjectCheck[] = [
    checkPath(project),
    checkProjectJson(project),
    checkGit(project),
    await checkS3(project),
    checkWorkdirs(project),
  ];
  return { project, checks, ok: checks.every((c) => c.status !== "error") };
}

export async function doctorAll(): Promise<DoctorResult[]> {
  return Promise.all(listProjects({ status: "active" }).map(doctorProject));
}

export function fixProject(project: Project): string[] {
  const fixes: string[] = [];
  const jsonPath = join(project.path, ".project.json");
  if (existsSync(project.path) && !existsSync(jsonPath)) {
    writeFileSync(jsonPath, JSON.stringify({ id: project.id, slug: project.slug, name: project.name, created_at: project.created_at }, null, 2) + "\n");
    fixes.push(`regenerated .project.json in ${project.path}`);
  }
  return fixes;
}
