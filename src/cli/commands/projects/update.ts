import chalk from "chalk";
import { resolve } from "node:path";
import { updateProject } from "../../../db/projects.js";
import {
  resolveProjectOrExit,
  printProject,
  wantsJsonOutput,
  type Command,
} from "./shared.js";

export function registerUpdateCommand(cmd: Command) {
  cmd
    .command("update <id-or-slug>")
    .description("Update a project")
    .option("--name <name>", "New name")
    .option("--description <desc>", "New description")
    .option("--path <path>", "New path")
    .option("--tags <tags>", "New tags (comma-separated, replaces existing)")
    .option("--s3-bucket <bucket>", "S3 bucket")
    .option("--s3-prefix <prefix>", "S3 prefix")
    .option("--git-remote <remote>", "Git remote URL")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts) => {
      const project = resolveProjectOrExit(idOrSlug);
      const updated = updateProject(project.id, {
        name: opts.name,
        description: opts.description,
        path: opts.path ? resolve(opts.path) : undefined,
        tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
        s3_bucket: opts.s3Bucket,
        s3_prefix: opts.s3Prefix,
        git_remote: opts.gitRemote,
      });
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(chalk.green("✓ Project updated"));
      printProject(updated);
    });
}
