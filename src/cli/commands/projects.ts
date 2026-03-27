import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  createProject,
  listProjects,
  updateProject,
  archiveProject,
  unarchiveProject,
  resolveProject,
  listSyncLogs,
} from "../../db/projects.js";
import { gitPassthrough } from "../../lib/git.js";
import { syncProject } from "../../lib/sync.js";
import type { ProjectFilter } from "../../types/index.js";

function printProject(p: ReturnType<typeof resolveProject>) {
  if (!p) return;
  console.log(`${chalk.bold(p.name)} ${chalk.dim(`(${p.slug})`)} ${p.status === "archived" ? chalk.yellow("[archived]") : chalk.green("[active]")}`);
  console.log(`  ${chalk.dim("id:")}     ${p.id}`);
  console.log(`  ${chalk.dim("path:")}   ${p.path}`);
  if (p.description) console.log(`  ${chalk.dim("desc:")}   ${p.description}`);
  if (p.tags.length) console.log(`  ${chalk.dim("tags:")}   ${p.tags.join(", ")}`);
  if (p.git_remote) console.log(`  ${chalk.dim("remote:")} ${p.git_remote}`);
  if (p.s3_bucket) console.log(`  ${chalk.dim("s3:")}     s3://${p.s3_bucket}/${p.s3_prefix ?? ""}`);
  console.log(`  ${chalk.dim("created:")} ${p.created_at}`);
}

export function registerProjectCommands(program: Command): void {
  const cmd = program;

  // projects create
  cmd
    .command("create")
    .description("Register a new project")
    .requiredOption("--name <name>", "Project name")
    .option("--path <path>", "Project path (default: cwd)")
    .option("--slug <slug>", "Custom slug (auto-generated from name if omitted)")
    .option("--description <desc>", "Description")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--s3-bucket <bucket>", "S3 bucket for sync")
    .option("--s3-prefix <prefix>", "S3 prefix")
    .option("--git-remote <remote>", "Git remote URL")
    .option("--no-git-init", "Skip auto git init")
    .action((opts) => {
      try {
        const path = opts.path ? resolve(opts.path) : process.cwd();
        const project = createProject({
          name: opts.name,
          path,
          description: opts.description,
          slug: opts.slug,
          tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
          s3_bucket: opts.s3Bucket,
          s3_prefix: opts.s3Prefix,
          git_remote: opts.gitRemote,
          git_init: opts.gitInit !== false,
        });
        console.log(chalk.green("✓ Project created"));
        printProject(project);
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // projects list
  cmd
    .command("list")
    .description("List projects")
    .option("--status <status>", "Filter by status (active|archived)")
    .option("--tags <tags>", "Filter by tags (comma-separated)")
    .option("--limit <n>", "Max results", "50")
    .action((opts) => {
      const filter: ProjectFilter = {
        status: opts.status,
        limit: parseInt(opts.limit, 10),
      };
      const projects = listProjects(filter);
      if (!projects.length) {
        console.log(chalk.dim("No projects found."));
        return;
      }
      for (const p of projects) {
        const tags = p.tags.length ? chalk.dim(` [${p.tags.join(", ")}]`) : "";
        const status = p.status === "archived" ? chalk.yellow(" [archived]") : "";
        console.log(`${chalk.bold(p.name)}${status}${tags}`);
        console.log(`  ${chalk.dim(p.id)}  ${chalk.dim(p.path)}`);
      }
      console.log(chalk.dim(`\n${projects.length} project(s)`));
    });

  // projects get
  cmd
    .command("get <id-or-slug>")
    .description("Get project details")
    .action((idOrSlug) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      printProject(project);
    });

  // projects update
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
    .action((idOrSlug, opts) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      const updated = updateProject(project.id, {
        name: opts.name,
        description: opts.description,
        path: opts.path ? resolve(opts.path) : undefined,
        tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
        s3_bucket: opts.s3Bucket,
        s3_prefix: opts.s3Prefix,
        git_remote: opts.gitRemote,
      });
      console.log(chalk.green("✓ Project updated"));
      printProject(updated);
    });

  // projects archive
  cmd
    .command("archive <id-or-slug>")
    .description("Archive a project")
    .action((idOrSlug) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      archiveProject(project.id);
      console.log(chalk.yellow(`✓ Archived: ${project.name}`));
    });

  // projects unarchive
  cmd
    .command("unarchive <id-or-slug>")
    .description("Unarchive a project")
    .action((idOrSlug) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      unarchiveProject(project.id);
      console.log(chalk.green(`✓ Unarchived: ${project.name}`));
    });

  // projects open
  cmd
    .command("open <id-or-slug>")
    .description("Print the path of a project (for use with cd)")
    .action((idOrSlug) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      if (!existsSync(project.path)) {
        console.error(chalk.red(`Path does not exist on this machine: ${project.path}`));
        process.exit(1);
      }
      console.log(project.path);
    });

  // projects sync
  cmd
    .command("sync <id-or-slug>")
    .description("Sync project files to/from S3")
    .option("--direction <dir>", "push, pull, or both (default: both)", "both")
    .option("--dry-run", "Show what would be synced without doing it")
    .option("--region <region>", "AWS region")
    .action(async (idOrSlug, opts) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
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

  // projects git — passthrough to git in project directory
  cmd
    .command("git <id-or-slug> [git-args...]")
    .description("Run a git command inside the project directory")
    .allowUnknownOption()
    .action((idOrSlug, gitArgs) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      try {
        gitPassthrough(project.path, gitArgs as string[]);
      } catch (err: unknown) {
        process.exit(err instanceof Error && "status" in err ? (err as NodeJS.ErrnoException & { status: number }).status ?? 1 : 1);
      }
    });

  // projects sync-log
  cmd
    .command("sync-log <id-or-slug>")
    .description("Show sync history for a project")
    .option("--limit <n>", "Max entries", "10")
    .action((idOrSlug, opts) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      const logs = listSyncLogs(project.id, parseInt(opts.limit, 10));
      if (!logs.length) {
        console.log(chalk.dim("No sync history."));
        return;
      }
      for (const log of logs) {
        const statusColor = log.status === "completed" ? chalk.green : log.status === "failed" ? chalk.red : chalk.yellow;
        console.log(`${statusColor(log.status)} ${chalk.dim(log.direction)} ${log.files_synced} files ${log.bytes}B — ${log.started_at}`);
        if (log.error) console.log(`  ${chalk.red(log.error)}`);
      }
    });
}
