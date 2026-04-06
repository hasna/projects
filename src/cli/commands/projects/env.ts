import chalk from "chalk";
import { requireProject, type Command } from "./shared.js";
import { loadProjectEnv, printExportStatements, listEnvKeys } from "../../../lib/env.js";

export function registerEnvCommand(cmd: Command) {
  cmd
    .command("env [id-or-slug]")
    .description("Print export statements for a project's .env (eval to load into shell)")
    .option("--list", "Only list key names, no values")
    .action((idOrSlug?: string, opts?: { list?: boolean }) => {
      const project = requireProject(idOrSlug);
      if (!project) { console.error(chalk.red("No project found.")); process.exit(1); }
      const vars = loadProjectEnv(project);
      if (!Object.keys(vars).length) { console.error(chalk.red(`No .env found in ${project.path}`)); process.exit(1); }
      if (opts?.list) { listEnvKeys(vars); } else { printExportStatements(vars); }
    });
}
