import chalk from "chalk";
import { listProjects } from "../../../db/projects.js";
import { getRecentProjects } from "../../../lib/status.js";
import type { ProjectFilter } from "../../../types/index.js";
import {
  parsePositiveIntOrExit,
  requireProject,
  exitProjectNotFound,
  printProject,
  timeAgo,
  wantsJsonOutput,
  type Command,
} from "./shared.js";

export function registerListCommands(cmd: Command) {
  cmd
    .command("list")
    .description("List projects")
    .option("--status <status>", "Filter by status (active|archived)")
    .option("--tags <tags>", "Filter by tags (comma-separated)")
    .option("--query <q>", "Fuzzy search by name or slug")
    .option("--limit <n>", "Max results", "50")
    .option("--json", "Output raw JSON")
    .action((opts) => {
      const filter: ProjectFilter = {
        status: opts.status,
        limit: parsePositiveIntOrExit(opts.limit, "--limit", 50),
        tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
      };
      let projects = listProjects(filter);
      if (opts.query) {
        const q = opts.query.toLowerCase();
        projects = projects.filter((p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
      }
      if (opts.json || process.env["PROJECTS_JSON"]) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }
      if (!projects.length) { console.log(chalk.dim("No projects found.")); return; }
      for (const p of projects) {
        const tags = p.tags.length ? chalk.dim(` [${p.tags.join(", ")}]`) : "";
        const status = p.status === "archived" ? chalk.yellow(" [archived]") : "";
        console.log(`${chalk.bold(p.name)}${status}${tags}`);
        console.log(`  ${chalk.dim(p.id)}  ${chalk.dim(p.path)}`);
      }
      console.log(chalk.dim(`\n${projects.length} project(s)`));
    });

  cmd
    .command("recent")
    .description("List recently opened projects")
    .option("--limit <n>", "Max results", "10")
    .option("--json", "Output raw JSON")
    .action((opts) => {
      const projects = getRecentProjects(parsePositiveIntOrExit(opts.limit, "--limit", 10));
      if (opts.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(projects, null, 2)); return; }
      if (!projects.length) { console.log(chalk.dim("No recently opened projects.")); return; }
      for (const p of projects) {
        console.log(`${chalk.bold(p.name)}  ${chalk.dim(p.path)}`);
        if (p.last_opened_at) console.log(`  ${chalk.dim("opened:")} ${timeAgo(p.last_opened_at)}`);
      }
    });
}

export function registerGetCommand(cmd: Command) {
  cmd
    .command("get [id-or-slug]")
    .description("Get project details (auto-detects from cwd if no arg given)")
    .option("--json", "Output raw JSON")
    .action((idOrSlug?: string, opts?: { json?: boolean }) => {
      const project = requireProject(idOrSlug);
      if (!project) {
        if (idOrSlug) exitProjectNotFound(idOrSlug);
        console.error(chalk.red("No project detected in current directory. Pass a project ID or slug."));
        process.exit(1);
      }
      if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(project, null, 2)); return; }
      printProject(project);
    });
}
