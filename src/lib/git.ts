import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Project } from "../types/index.js";

const GITIGNORE_TEMPLATE = `# Dependencies
node_modules/
.pnp
.pnp.js

# Build outputs
dist/
build/
out/
.next/
.nuxt/

# Environment files
.env
.env.local
.env.*.local

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# OS files
.DS_Store
Thumbs.db

# Editor directories
.vscode/
.idea/
*.swp
*.swo

# Test coverage
coverage/
.nyc_output/

# Cache
.cache/
.turbo/
`;

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

export function gitInit(project: Project): void {
  const { path, name, id, slug } = project;

  // Skip if already a git repo
  if (isGitRepo(path)) return;

  // git init
  execSync("git init", { cwd: path, stdio: "pipe" });

  // Write .gitignore if it doesn't exist
  const gitignorePath = join(path, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_TEMPLATE, "utf-8");
  }

  // Write .project.json
  const projectJson = {
    id,
    slug,
    name,
    created_at: project.created_at,
  };
  writeFileSync(join(path, ".project.json"), JSON.stringify(projectJson, null, 2) + "\n", "utf-8");

  // Initial commit
  execSync("git add .gitignore .project.json", { cwd: path, stdio: "pipe" });
  execSync(`git commit -m "chore: init project ${name}"`, {
    cwd: path,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "open-projects", GIT_COMMITTER_NAME: "open-projects" },
  });
}

export function gitPassthrough(projectPath: string, args: string[]): void {
  execSync(`git ${args.join(" ")}`, { cwd: projectPath, stdio: "inherit" });
}
