import { execFileSync } from "node:child_process";
import { isGitRepo } from "./git.js";
import type { Project } from "../types/index.js";

export interface PublishOptions {
  org?: string;       // default: hasnaxyz
  private?: boolean;  // default: true
  description?: string;
}

export interface PublishResult {
  url: string;
  remote: string;
  pushed: boolean;
}

function gh(args: string[], cwd?: string): string {
  return execFileSync("gh", args, { cwd, stdio: "pipe", encoding: "utf-8", env: process.env }).trim();
}

export function publishProject(
  name: string,
  path: string,
  options: PublishOptions = {},
): PublishResult {
  const org = options.org ?? "hasnaxyz";
  const isPrivate = options.private !== false;
  const repoName = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const fullName = `${org}/${repoName}`;

  // Create GitHub repo
  const visibilityFlag = isPrivate ? "--private" : "--public";
  const args = ["repo", "create", fullName, visibilityFlag];
  if (options.description) args.push("--description", options.description);

  gh(args);

  const remote = `https://github.com/${fullName}.git`;

  // If it's a git repo, add remote and push
  let pushed = false;
  if (isGitRepo(path)) {
    try {
      // Check if origin already set
      const remotes = execFileSync("git", ["remote"], { cwd: path, stdio: "pipe", encoding: "utf-8", env: process.env });
      if (remotes.includes("origin")) {
        execFileSync("git", ["remote", "set-url", "origin", remote], { cwd: path, stdio: "pipe", env: process.env });
      } else {
        execFileSync("git", ["remote", "add", "origin", remote], { cwd: path, stdio: "pipe", env: process.env });
      }
      execFileSync("git", ["push", "-u", "origin", "main", "--quiet"], { cwd: path, stdio: "pipe", env: process.env });
      pushed = true;
    } catch {
      // Push failed — repo created but not pushed
    }
  }

  return { url: `https://github.com/${fullName}`, remote, pushed };
}

export function unpublishProject(path: string): void {
  if (!isGitRepo(path)) return;
  try {
    execFileSync("git", ["remote", "remove", "origin"], { cwd: path, stdio: "pipe", env: process.env });
  } catch {
    // No remote to remove
  }
}

export function createGithubRepo(project: Project, org = "hasnaxyz"): string | null {
  const slug = project.slug || project.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const fullName = `${org}/${slug}`;
  const args = ["repo", "create", fullName, "--private"];
  if (project.description) args.push("--description", project.description);

  execFileSync("gh", args, { stdio: "pipe", env: process.env });

  const remote = `git@github.com:${fullName}.git`;

  if (isGitRepo(project.path)) {
    try {
      const remotes = execFileSync("git", ["remote"], { cwd: project.path, stdio: "pipe", encoding: "utf-8", env: process.env });
      if (remotes.includes("origin")) {
        execFileSync("git", ["remote", "set-url", "origin", remote], { cwd: project.path, stdio: "pipe", env: process.env });
      } else {
        execFileSync("git", ["remote", "add", "origin", remote], { cwd: project.path, stdio: "pipe", env: process.env });
      }
    } catch {
      // ignore
    }
  }

  return remote;
}

export function getGitHubUrl(path: string): string | null {
  if (!isGitRepo(path)) return null;
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: path, stdio: "pipe", encoding: "utf-8", env: process.env }).trim();
    if (remote.includes("github.com")) return remote.replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
    return null;
  } catch {
    return null;
  }
}
