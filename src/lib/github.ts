import { execSync } from "node:child_process";
import { isGitRepo } from "./git.js";

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

function gh(args: string, cwd?: string): string {
  return execSync(`gh ${args}`, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
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
  const descFlag = options.description
    ? `--description ${JSON.stringify(options.description)}`
    : "";

  gh(`repo create ${fullName} ${visibilityFlag} ${descFlag}`);

  const remote = `https://github.com/${fullName}.git`;

  // If it's a git repo, add remote and push
  let pushed = false;
  if (isGitRepo(path)) {
    try {
      // Check if origin already set
      const remotes = execSync("git remote", { cwd: path, stdio: "pipe", encoding: "utf-8" });
      if (remotes.includes("origin")) {
        execSync("git remote set-url origin " + remote, { cwd: path, stdio: "pipe" });
      } else {
        execSync("git remote add origin " + remote, { cwd: path, stdio: "pipe" });
      }
      execSync("git push -u origin main --quiet", { cwd: path, stdio: "pipe" });
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
    execSync("git remote remove origin", { cwd: path, stdio: "pipe" });
  } catch {
    // No remote to remove
  }
}

export function getGitHubUrl(path: string): string | null {
  if (!isGitRepo(path)) return null;
  try {
    const remote = execSync("git remote get-url origin", { cwd: path, stdio: "pipe", encoding: "utf-8" }).trim();
    if (remote.includes("github.com")) return remote.replace(/\.git$/, "").replace("git@github.com:", "https://github.com/");
    return null;
  } catch {
    return null;
  }
}
