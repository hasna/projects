import chalk from "chalk";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createProject, getProjectByPath, slugify } from "../../../db/projects.js";
import { wantsJsonOutput, type Command } from "./shared.js";
import { getConfig } from "../../../lib/config.js";
import { gitInit, isGitRepo } from "../../../lib/git.js";

function readPackageJson(path: string): { name?: string; description?: string } | null {
  const pkgPath = resolve(path, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return { name: pkg.name, description: pkg.description };
  } catch {
    return null;
  }
}

export function registerInitCommand(cmd: Command) {
  cmd
    .command("init")
    .description("Register the current directory as a project (auto-detects name from package.json)")
    .option("--name <name>", "Project name (auto-detected from package.json if omitted)")
    .option("--slug <slug>", "Custom slug")
    .option("--description <desc>", "Description (auto from package.json)")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--no-git-init", "Skip git init if not already a repo")
    .option("-j, --json", "Output raw JSON")
    .action((opts) => {
      const cwd = process.cwd();
      const config = getConfig();

      if (getProjectByPath(cwd)) {
        console.error(chalk.red("A project already exists at this path."));
        process.exit(1);
      }

      const pkgInfo = readPackageJson(cwd);
      const name = opts.name || pkgInfo?.name || resolve(cwd, "..").split("/").pop() || "untitled";
      const description = opts.description || pkgInfo?.description || null;
      const slug = opts.slug || slugify(name);

      const shouldGitInit = opts.gitInit !== false && !isGitRepo(cwd);

      const project = createProject({
        name,
        path: cwd,
        description,
        slug,
        tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
        git_init: shouldGitInit,
      });

      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(project, null, 2));
        return;
      }
      console.log(chalk.green("✓ Project initialized"));
      console.log(`  ${chalk.bold(project.name)} ${chalk.dim(`(${project.slug})`)}`);
      console.log(`  ${chalk.dim("path:")} ${project.path}`);
    });
}
