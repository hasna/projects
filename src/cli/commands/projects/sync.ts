import chalk from "chalk";
import { resolve, join } from "node:path";
import { syncProject } from "../../../lib/sync.js";
import { cloneProject } from "../../../lib/sync.js";
import { syncAll } from "../../../lib/scheduler.js";
import { watchProject } from "../../../lib/watch.js";
import { resolveProjectOrExit, requireProject, type Command } from "./shared.js";
import { addWorkdir, listWorkdirs } from "../../../db/workdirs.js";
import { generateForWorkdir } from "../../../lib/generate.js";

export function registerSyncCommands(cmd: Command) {
  cmd
    .command("sync [id-or-slug]")
    .description("Sync project files to/from S3 (auto-detects from cwd)")
    .option("--direction <dir>", "push, pull, or both (default: both)", "both")
    .option("--dry-run", "Show what would be synced without doing it")
    .option("--region <region>", "AWS region")
    .action(async (idOrSlug: string | undefined, opts) => {
      const project = requireProject(idOrSlug);
      if (!project) {
        console.error(chalk.red("No project detected in current directory."));
        process.exit(1);
      }
      try {
        console.log(chalk.dim(`Syncing ${project.name} (${opts.direction})...`));
        const result = await syncProject(project, {
          direction: opts.direction,
          dryRun: opts.dryRun,
          region: opts.region,
          onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
        });
        console.log(chalk.green(`✓ Sync complete`));
        console.log(`  pushed: ${result.pushed}, pulled: ${result.pulled}, skipped: ${result.skipped}, bytes: ${result.bytes}`);
        if (result.errors.length) {
          console.log(chalk.yellow(`  warnings (${result.errors.length}):`));
          result.errors.forEach((e) => console.log(`    ${chalk.yellow(e)}`));
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Sync failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  cmd
    .command("sync-all")
    .description("Sync all active projects that have S3 configured")
    .option("--direction <dir>", "push, pull, or both (default: both)", "both")
    .action(async (opts) => {
      console.log(chalk.dim("Syncing all active projects..."));
      const result = await syncAll(opts.direction, (msg) => console.log(chalk.dim(`  ${msg}`)));
      console.log(chalk.green(`✓ synced: ${result.synced.length}`));
      if (result.skipped.length) console.log(chalk.dim(`  skipped (no S3): ${result.skipped.join(", ")}`));
      if (result.errors.length) {
        result.errors.forEach((e) => console.log(chalk.red(`  ${e.name}: ${e.error}`)));
      }
    });

  cmd
    .command("watch [id-or-slug]")
    .description("Watch project files and push changes to S3 in real time")
    .option("--region <region>", "AWS region")
    .action(async (idOrSlug?: string, opts?: { region?: string }) => {
      const project = requireProject(idOrSlug);
      if (!project) { console.error(chalk.red("No project found.")); process.exit(1); }
      await watchProject(project, { region: opts?.region });
    });

  cmd
    .command("clone <id-or-slug> [target-path]")
    .description("Pull a project from S3 to a new local path and register as workdir")
    .option("--region <region>", "AWS region")
    .option("--label <label>", "Workdir label", "clone")
    .action(async (idOrSlug, targetPath: string | undefined, opts) => {
      const project = resolveProjectOrExit(idOrSlug);
      const dest = resolve(targetPath ?? join(process.cwd(), project.slug));
      console.log(chalk.dim(`Cloning ${project.name} → ${dest}...`));
      try {
        const result = await cloneProject(project, dest, {
          region: opts.region,
          onProgress: (m) => console.log(chalk.dim(`  ${m}`)),
        });
        const workdir = addWorkdir({ project_id: project.id, path: dest, label: opts.label });
        const allDirs = listWorkdirs(project.id);
        generateForWorkdir(project, workdir, allDirs);
        console.log(chalk.green(`✓ Cloned: pulled ${result.pulled} files (${result.bytes}B)`));
        console.log(chalk.dim(`  CLAUDE.md + AGENTS.md generated`));
        console.log(dest);
      } catch (err: unknown) {
        console.error(chalk.red(`Clone failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
