import chalk from "chalk";
import { existsSync } from "node:fs";
import { requireProject, resolveProjectOrExit, type Command } from "./shared.js";
import { touchLastOpened } from "../../../lib/status.js";

export function registerOpenCommand(cmd: Command) {
  cmd
    .command("open [id-or-slug]")
    .description("Print the path of a project (for use with cd, auto-detects from cwd)")
    .action((idOrSlug?: string) => {
      const project = requireProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      if (!existsSync(project.path)) {
        console.error(chalk.red(`Path does not exist on this machine: ${project.path}`));
        process.exit(1);
      }
      touchLastOpened(project.id);
      console.log(project.path);
    });
}
