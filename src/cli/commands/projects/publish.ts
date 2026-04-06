import chalk from "chalk";
import { resolveProjectOrExit, type Command } from "./shared.js";
import { publishProject, unpublishProject } from "../../../lib/github.js";

export function registerPublishCommands(cmd: Command) {
  cmd
    .command("publish <id-or-slug>")
    .description("Publish project to GitHub")
    .option("--org <org>", "GitHub org (default: hasnaxyz)")
    .option("--public", "Make repo public (default: private)")
    .action((idOrSlug, opts) => {
      const project = resolveProjectOrExit(idOrSlug);
      try {
        const result = publishProject(project.name, project.path, {
          org: opts.org,
          private: !opts.public,
          description: project.description ?? undefined,
        });
        console.log(chalk.green(`✓ Published: ${result.url}`));
        if (result.pushed) console.log(chalk.dim("  pushed to origin"));
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command("unpublish <id-or-slug>")
    .description("Remove GitHub remote from project (does not delete the repo)")
    .action((idOrSlug) => {
      const project = resolveProjectOrExit(idOrSlug);
      unpublishProject(project.path);
      console.log(chalk.yellow(`✓ Removed origin remote from ${project.name}`));
    });
}
