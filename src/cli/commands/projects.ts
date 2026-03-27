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
import { importProject, importBulk } from "../../lib/import.js";
import { publishProject, unpublishProject } from "../../lib/github.js";
import {
  getScheduleConfig,
  saveScheduleConfig,
  installCron,
  removeCron,
  syncAll,
} from "../../lib/scheduler.js";
import { addWorkdir, listWorkdirs, removeWorkdir } from "../../db/workdirs.js";
import { generateForWorkdir, generateAllWorkdirs } from "../../lib/generate.js";
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

  // projects sync --all
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

  // projects schedule
  const scheduleCmd = cmd.command("schedule").description("Manage auto-sync schedule");

  scheduleCmd
    .command("set")
    .description("Enable scheduled sync")
    .option("--interval <n>", "hourly, daily, or weekly (default: daily)", "daily")
    .option("--direction <dir>", "push, pull, or both (default: both)", "both")
    .action((opts) => {
      const config = { enabled: true, interval: opts.interval, direction: opts.direction };
      saveScheduleConfig(config);
      try {
        installCron(config);
        console.log(chalk.green(`✓ Scheduled: ${opts.interval} sync (${opts.direction})`));
      } catch (err: unknown) {
        console.log(chalk.yellow("Config saved, but crontab install failed:"), err instanceof Error ? err.message : String(err));
      }
    });

  scheduleCmd
    .command("remove")
    .description("Disable scheduled sync")
    .action(() => {
      const config = getScheduleConfig();
      saveScheduleConfig({ ...config, enabled: false });
      removeCron();
      console.log(chalk.yellow("✓ Schedule removed"));
    });

  scheduleCmd
    .command("status")
    .description("Show schedule configuration")
    .action(() => {
      const config = getScheduleConfig();
      console.log(`enabled:  ${config.enabled ? chalk.green("yes") : chalk.dim("no")}`);
      console.log(`interval: ${config.interval}`);
      console.log(`direction: ${config.direction}`);
      if (config.last_run) console.log(`last run: ${config.last_run}`);
    });

  // projects workdir
  const workdirCmd = cmd.command("workdir").description("Manage working directories for a project");

  workdirCmd
    .command("add <id-or-slug> <path>")
    .description("Add a working directory to a project")
    .option("--label <label>", "Label for this directory (e.g. frontend, backend)", "main")
    .option("--primary", "Set as the primary working directory")
    .option("--generate", "Generate CLAUDE.md + AGENTS.md immediately")
    .action((idOrSlug, path, opts) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      const absPath = resolve(path);
      const workdir = addWorkdir({ project_id: project.id, path: absPath, label: opts.label, is_primary: opts.primary });
      console.log(chalk.green(`✓ Added workdir: ${workdir.label} → ${workdir.path}`));
      if (opts.generate) {
        const allDirs = listWorkdirs(project.id);
        const result = generateForWorkdir(project, workdir, allDirs);
        console.log(chalk.dim(`  CLAUDE.md → ${result.path}/CLAUDE.md`));
        console.log(chalk.dim(`  AGENTS.md → ${result.path}/AGENTS.md`));
      }
    });

  workdirCmd
    .command("list <id-or-slug>")
    .description("List all working directories for a project")
    .action((idOrSlug) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      const workdirs = listWorkdirs(project.id);
      if (!workdirs.length) { console.log(chalk.dim("No workdirs registered.")); return; }
      for (const w of workdirs) {
        const primary = w.is_primary ? chalk.cyan(" [primary]") : "";
        const gen = w.claude_md_generated ? chalk.dim(" ✓ CLAUDE.md") : "";
        console.log(`${chalk.bold(w.label)}${primary}  ${chalk.dim(w.path)}${gen}`);
        console.log(`  ${chalk.dim("machine:")} ${w.machine_id}`);
      }
    });

  workdirCmd
    .command("remove <id-or-slug> <path>")
    .description("Remove a working directory from a project")
    .action((idOrSlug, path) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      removeWorkdir(project.id, resolve(path));
      console.log(chalk.yellow(`✓ Removed workdir: ${path}`));
    });

  workdirCmd
    .command("generate <id-or-slug>")
    .description("Generate CLAUDE.md + AGENTS.md in all working directories")
    .option("--path <path>", "Only generate for a specific workdir path")
    .option("--dry-run", "Show what would be generated without writing")
    .option("--force", "Overwrite existing CLAUDE.md even if not generated by open-projects")
    .action((idOrSlug, opts) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      const allDirs = listWorkdirs(project.id);

      if (opts.path) {
        const absPath = resolve(opts.path);
        const workdir = allDirs.find((w) => w.path === absPath);
        if (!workdir) { console.error(chalk.red(`Workdir not found: ${absPath}`)); process.exit(1); }
        const result = generateForWorkdir(project, workdir, allDirs, { dryRun: opts.dryRun, force: opts.force });
        console.log(opts.dryRun ? chalk.dim("[dry-run]") : chalk.green("✓"), result.path);
      } else {
        const results = generateAllWorkdirs(project, { dryRun: opts.dryRun, force: opts.force });
        for (const r of results) {
          console.log(opts.dryRun ? chalk.dim("[dry-run]") : chalk.green("✓"), `${r.path}/CLAUDE.md + AGENTS.md`);
        }
        if (!opts.dryRun) console.log(chalk.green(`✓ Generated for ${results.length} workdir(s)`));
      }
    });

  // projects publish
  cmd
    .command("publish <id-or-slug>")
    .description("Publish project to GitHub")
    .option("--org <org>", "GitHub org (default: hasnaxyz)")
    .option("--public", "Make repo public (default: private)")
    .action((idOrSlug, opts) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
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

  // projects unpublish
  cmd
    .command("unpublish <id-or-slug>")
    .description("Remove GitHub remote from project (does not delete the repo)")
    .action((idOrSlug) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      unpublishProject(project.path);
      console.log(chalk.yellow(`✓ Removed origin remote from ${project.name}`));
    });

  // projects import
  cmd
    .command("import <path>")
    .description("Import an existing directory as a project")
    .option("--tags <tags>", "Tags (comma-separated)")
    .option("--dry-run", "Show what would be imported without doing it")
    .action(async (path, opts) => {
      const { project, skipped, error } = await importProject(path, {
        dryRun: opts.dryRun,
        defaultTags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
        onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
      });
      if (error) { console.error(chalk.red(`Error: ${error}`)); process.exit(1); }
      if (skipped) { console.log(chalk.yellow(`Skipped: ${skipped}`)); return; }
      if (project) { console.log(chalk.green("✓ Imported")); printProject(project); }
    });

  // projects import-bulk
  cmd
    .command("import-bulk <dir>")
    .description("Import all subdirectories of a directory as projects")
    .option("--tags <tags>", "Tags to apply to all imported projects (comma-separated)")
    .option("--dry-run", "Show what would be imported without doing it")
    .action(async (dir, opts) => {
      const result = await importBulk(dir, {
        dryRun: opts.dryRun,
        defaultTags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
        onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
      });
      console.log(chalk.green(`✓ imported: ${result.imported.length}`));
      if (result.skipped.length) console.log(chalk.dim(`  skipped: ${result.skipped.length}`));
      if (result.errors.length) {
        console.log(chalk.red(`  errors: ${result.errors.length}`));
        result.errors.forEach((e) => console.log(`    ${chalk.red(e.error)} — ${e.path}`));
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
