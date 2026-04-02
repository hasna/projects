import type { Command } from "commander";
import chalk from "chalk";
import { resolve, join } from "node:path";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
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
import { syncProject, cloneProject } from "../../lib/sync.js";
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
import { detectCurrentProject } from "../../lib/detect.js";
import { doctorAll, doctorProject, fixProject } from "../../lib/doctor.js";
import { getAllStatus, getProjectStatus, getRecentProjects, touchLastOpened } from "../../lib/status.js";
import { loadProjectEnv, printExportStatements, listEnvKeys } from "../../lib/env.js";
import { watchProject } from "../../lib/watch.js";
import { getGlobalStats, getProjectStats, formatBytes } from "../../lib/stats.js";
import type { ProjectFilter, Project } from "../../types/index.js";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function suppressSslWarnings(): void {
  const orig = process.emitWarning.bind(process);
  process.emitWarning = (msg: string | Error, ...args: unknown[]) => {
    const text = typeof msg === "string" ? msg : msg.message;
    if (text?.includes("SSL modes")) return;
    return (orig as (...a: unknown[]) => void)(msg, ...args);
  };
}

function wantsJsonOutput(opts?: { json?: boolean }): boolean {
  return Boolean(opts?.json || process.env["PROJECTS_JSON"]);
}

/** Resolve project from arg or cwd. Prints hint if auto-detected. */
function requireProject(idOrSlug: string | undefined): ReturnType<typeof resolveProject> {
  if (idOrSlug) return resolveProject(idOrSlug);
  const detected = detectCurrentProject();
  if (detected) {
    console.log(chalk.dim(`[detected: ${detected.slug}]`));
    return detected;
  }
  return null;
}

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
    .option("-j, --json", "Output raw JSON")
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
        if (wantsJsonOutput(opts)) {
          console.log(JSON.stringify(project, null, 2));
          return;
        }
        console.log(chalk.green("✓ Project created"));
        printProject(project);
        if (!existsSync(project.path)) {
          console.log(chalk.yellow(`  ⚠ Path does not exist yet: ${project.path}`));
          console.log(chalk.dim(`    Create it to enable git init and workdir generation.`));
        }
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
    .option("--json", "Output raw JSON")
    .action((opts) => {
      const filter: ProjectFilter = {
        status: opts.status,
        limit: parseInt(opts.limit, 10),
        tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
      };
      const projects = listProjects(filter);
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

  // projects get
  cmd
    .command("get [id-or-slug]")
    .description("Get project details (auto-detects from cwd if no arg given)")
    .option("--json", "Output raw JSON")
    .action((idOrSlug?: string, opts?: { json?: boolean }) => {
      const project = requireProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(idOrSlug ? `Project not found: ${idOrSlug}` : "No project detected in current directory. Pass a project ID or slug."));
        process.exit(1);
      }
      if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(project, null, 2)); return; }
      printProject(project);
    });

  // projects rename
  cmd
    .command("rename <id-or-slug> <new-name>")
    .description("Rename a project and update slug + .project.json in all workdirs")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, newName, opts?: { json?: boolean }) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      const updated = updateProject(project.id, { name: newName });
      const workdirs = listWorkdirs(project.id);
      for (const w of workdirs) {
        try {
          const jsonPath = join(w.path, ".project.json");
          if (existsSync(jsonPath)) {
            const existing = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
            writeFileSync(jsonPath, JSON.stringify({ ...existing, name: newName, slug: updated.slug }, null, 2) + "\n");
          }
        } catch { /* non-fatal */ }
      }
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(chalk.green(`✓ Renamed: ${project.name} → ${updated.name} (slug: ${updated.slug})`));
    });

  // projects tag / untag
  cmd
    .command("tag <id-or-slug> [tags...]")
    .description("Add tags to a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, tags: string[], opts?: { json?: boolean }) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      const merged = [...new Set([...project.tags, ...tags])];
      const updated = updateProject(project.id, { tags: merged });
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(chalk.green(`✓ Tags: ${merged.join(", ")}`));
    });

  cmd
    .command("untag <id-or-slug> [tags...]")
    .description("Remove tags from a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, tags: string[], opts?: { json?: boolean }) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      const remaining = project.tags.filter((t) => !tags.includes(t));
      const updated = updateProject(project.id, { tags: remaining });
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(chalk.green(`✓ Tags: ${remaining.length ? remaining.join(", ") : "(none)"}`));
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
    .option("-j, --json", "Output raw JSON")
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
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(chalk.green("✓ Project updated"));
      printProject(updated);
    });

  // projects archive
  cmd
    .command("archive <id-or-slug>")
    .description("Archive a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts?: { json?: boolean }) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      const archived = archiveProject(project.id);
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(archived, null, 2)); return; }
      console.log(chalk.yellow(`✓ Archived: ${project.name}`));
    });

  // projects unarchive
  cmd
    .command("unarchive <id-or-slug>")
    .description("Unarchive a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts?: { json?: boolean }) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      const unarchived = unarchiveProject(project.id);
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(unarchived, null, 2)); return; }
      console.log(chalk.green(`✓ Unarchived: ${project.name}`));
    });

  // projects open
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

  // projects recent
  cmd
    .command("recent")
    .description("List recently opened projects")
    .option("--limit <n>", "Max results", "10")
    .option("--json", "Output raw JSON")
    .action((opts) => {
      const projects = getRecentProjects(parseInt(opts.limit, 10));
      if (opts.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(projects, null, 2)); return; }
      if (!projects.length) { console.log(chalk.dim("No recently opened projects.")); return; }
      for (const p of projects) {
        console.log(`${chalk.bold(p.name)}  ${chalk.dim(p.path)}`);
        if (p.last_opened_at) console.log(`  ${chalk.dim("opened:")} ${timeAgo(p.last_opened_at)}`);
      }
    });

  // projects status
  cmd
    .command("status [id-or-slug]")
    .description("Show project health at a glance")
    .option("--json", "Output raw JSON")
    .action(async (idOrSlug?: string, opts?: { json?: boolean }) => {
      if (idOrSlug) {
        const project = resolveProject(idOrSlug);
        if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
        const s = getProjectStatus(project);
        if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(s, null, 2)); return; }
        printProject(project);
        const icon = (st: string | null) => st === "clean" ? chalk.green("✓") : chalk.yellow("⚠");
        console.log(`  git:       ${icon(s.git_status)} ${s.git_status ?? "n/a"}`);
        console.log(`  last sync: ${s.last_synced ? chalk.dim(timeAgo(s.last_synced)) : chalk.dim("never")}`);
        console.log(`  workdirs:  ${s.workdir_count}`);
        if (s.disk_bytes !== null) console.log(`  disk:      ${formatBytes(s.disk_bytes)}`);
      } else {
        const all = getAllStatus();
        if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(all, null, 2)); return; }
        if (!all.length) { console.log(chalk.dim("No active projects.")); return; }
        for (const s of all) {
          const pathIcon = s.path_exists ? chalk.green("✓") : chalk.red("✗");
          const gitStr = s.git_status === "clean" ? chalk.green("clean") : s.git_status ? chalk.yellow(s.git_status) : chalk.dim("n/a");
          const syncStr = s.last_synced ? chalk.dim(timeAgo(s.last_synced)) : chalk.dim("never");
          console.log(`${pathIcon} ${chalk.bold(s.project.slug.padEnd(28))} git:${gitStr}  sync:${syncStr}  dirs:${s.workdir_count}`);
        }
      }
    });

  // projects doctor
  cmd
    .command("doctor [id-or-slug]")
    .description("Health-check all registered projects")
    .option("--fix", "Auto-repair what can be fixed")
    .option("--json", "Output raw JSON")
    .action(async (idOrSlug?: string, opts?: { fix?: boolean; json?: boolean }) => {
      const target = idOrSlug ? resolveProject(idOrSlug) : null;
      if (idOrSlug && !target) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      const results = target ? [await doctorProject(target)] : await doctorAll();
      if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(results, null, 2)); return; }
      let hasError = false;
      for (const r of results) {
        console.log(`\n${chalk.bold(r.project.name)} ${chalk.dim(r.project.slug)}`);
        for (const c of r.checks) {
          const icon = c.status === "ok" ? chalk.green("✓") : c.status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
          console.log(`  ${icon} ${c.name.padEnd(14)} ${c.message}`);
          if (c.status === "error") hasError = true;
        }
        if (opts?.fix) {
          const fixes = fixProject(r.project);
          fixes.forEach((f) => console.log(chalk.cyan(`  → fixed: ${f}`)));
        }
      }
      if (hasError) process.exit(1);
    });

  // projects stats
  cmd
    .command("stats [id-or-slug]")
    .description("Show storage and sync statistics")
    .option("--json", "Output raw JSON")
    .action((idOrSlug?: string, opts?: { json?: boolean }) => {
      if (idOrSlug) {
        const project = resolveProject(idOrSlug);
        if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
        const s = getProjectStats(project.id);
        if (!s) { console.error(chalk.red("Stats not available")); process.exit(1); }
        if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(s, null, 2)); return; }
        console.log(`${chalk.bold(s.name)}`);
        console.log(`  files:      ${s.file_count}  (${formatBytes(s.disk_bytes)})`);
        console.log(`  syncs:      ${s.sync_count}  (${formatBytes(s.synced_bytes)} total)`);
        console.log(`  last sync:  ${s.last_synced ? chalk.dim(timeAgo(s.last_synced)) : chalk.dim("never")}`);
        console.log(`  workdirs:   ${s.workdir_count}`);
      } else {
        const g = getGlobalStats();
        if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(g, null, 2)); return; }
        console.log(`projects:  ${g.active} active, ${g.archived} archived`);
        console.log(`disk:      ${formatBytes(g.total_disk_bytes)}`);
        console.log(`synced:    ${formatBytes(g.total_synced_bytes)} across ${g.total_syncs} sync(s)`);
      }
    });

  // projects env
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

  // projects clone
  cmd
    .command("clone <id-or-slug> [target-path]")
    .description("Pull a project from S3 to a new local path and register as workdir")
    .option("--region <region>", "AWS region")
    .option("--label <label>", "Workdir label", "clone")
    .action(async (idOrSlug, targetPath: string | undefined, opts) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
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

  // projects sync --watch
  cmd
    .command("watch [id-or-slug]")
    .description("Watch project files and push changes to S3 in real time")
    .option("--region <region>", "AWS region")
    .action(async (idOrSlug?: string, opts?: { region?: string }) => {
      const project = requireProject(idOrSlug);
      if (!project) { console.error(chalk.red("No project found.")); process.exit(1); }
      await watchProject(project, { region: opts?.region });
    });

  // projects sync
  cmd
    .command("sync [id-or-slug]")
    .description("Sync project files to/from S3 (auto-detects from cwd)")
    .option("--direction <dir>", "push, pull, or both (default: both)", "both")
    .option("--dry-run", "Show what would be synced without doing it")
    .option("--region <region>", "AWS region")
    .action(async (idOrSlug: string | undefined, opts) => {
      const project = requireProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(idOrSlug ? `Project not found: ${idOrSlug}` : "No project detected in current directory."));
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
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts?: { json?: boolean }) => {
      const project = resolveProject(idOrSlug);
      if (!project) { console.error(chalk.red(`Project not found: ${idOrSlug}`)); process.exit(1); }
      const workdirs = listWorkdirs(project.id);
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(workdirs, null, 2)); return; }
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
    .option("-j, --json", "Output raw JSON")
    .action(async (path, opts) => {
      const { project, skipped, error } = await importProject(path, {
        dryRun: opts.dryRun,
        defaultTags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
        onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
      });
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify({ project: project ?? null, skipped: skipped ?? null, error: error ?? null }, null, 2));
        if (error) process.exit(1);
        return;
      }
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
    .option("-j, --json", "Output raw JSON")
    .action(async (dir, opts) => {
      const result = await importBulk(dir, {
        dryRun: opts.dryRun,
        defaultTags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
        onProgress: (msg) => console.log(chalk.dim(`  ${msg}`)),
      });
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(result, null, 2)); return; }
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

  // projects cloud
  const cloudCmd = cmd.command("cloud").description("Cloud sync — push/pull between local SQLite and RDS PostgreSQL");

  cloudCmd
    .command("status")
    .description("Show cloud configuration and connection health")
    .action(async () => {
      process.env["NODE_NO_WARNINGS"] = "1";
      suppressSslWarnings(); const { getCloudConfig, getConnectionString, PgAdapterAsync } = await import("@hasna/cloud");
      const config = getCloudConfig();
      console.log(`mode:    ${config.mode}`);
      console.log(`service: projects`);
      console.log(`host:    ${config.rds?.host ?? chalk.red("(not configured)")}`);
      if (config.rds?.host) {
        try {
          const pg = new PgAdapterAsync(getConnectionString("postgres"));
          await (pg as { get: (s: string) => Promise<unknown> }).get("SELECT 1");
          console.log(`pg:      ${chalk.green("connected")}`);
          await (pg as { close: () => Promise<void> }).close();
        } catch (err: unknown) {
          console.log(`pg:      ${chalk.red((err instanceof Error ? err.message : String(err)))}`);
        }
      }
    });

  cloudCmd
    .command("pull")
    .description("Pull data from cloud PostgreSQL to local SQLite")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .action(async (opts) => {
      console.log(chalk.dim("Pulling from cloud..."));
      try {
        suppressSslWarnings(); const { syncPull, getCloudConfig, getConnectionString, PgAdapterAsync, SqliteAdapter } = await import("@hasna/cloud");
        const config = getCloudConfig();
        if (!((config.rds as unknown) as Record<string, unknown>)?.host) { console.error(chalk.red("Cloud not configured. Set HASNA_RDS_HOST.")); process.exit(1); }
        const tables = opts.tables ? opts.tables.split(",").map((t: string) => t.trim()) : ["projects", "project_workdirs", "project_files", "sync_log"];
        const localPath = process.env["HASNA_PROJECTS_DB_PATH"] ?? `${process.env["HOME"]}/.hasna/projects/projects.db`;
        const local = new SqliteAdapter(localPath);
        const remote = new PgAdapterAsync(getConnectionString("postgres"));
        const results = await syncPull(remote, local, { tables });
        remote.close(); local.close();
        const total = results.reduce((s, r) => s + r.rowsWritten, 0);
        console.log(chalk.green(`✓ Pulled ${total} rows`));
        results.forEach((r) => console.log(chalk.dim(`  ${r.table}: ${r.rowsWritten}`)));
      } catch (err: unknown) { console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`)); process.exit(1); }
    });

  cloudCmd
    .command("push")
    .description("Push local SQLite data to cloud PostgreSQL")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .action(async (opts) => {
      console.log(chalk.dim("Pushing to cloud..."));
      try {
        suppressSslWarnings(); const { syncPush, getCloudConfig, getConnectionString, PgAdapterAsync, SqliteAdapter } = await import("@hasna/cloud");
        const { runPgMigrations } = await import("../../db/pg-migrations.js");
        const config = getCloudConfig();
        if (!((config.rds as unknown) as Record<string, unknown>)?.host) { console.error(chalk.red("Cloud not configured. Set HASNA_RDS_HOST.")); process.exit(1); }
        const localPath = process.env["HASNA_PROJECTS_DB_PATH"] ?? `${process.env["HOME"]}/.hasna/projects/projects.db`;
        const local = new SqliteAdapter(localPath);
        const remote = new PgAdapterAsync(getConnectionString("postgres"));
        await runPgMigrations(remote);
        const tables = opts.tables ? opts.tables.split(",").map((t: string) => t.trim()) : ["projects", "project_workdirs", "project_files", "sync_log"];
        const results = await syncPush(local, remote, { tables });
        remote.close(); local.close();
        const total = results.reduce((s, r) => s + r.rowsWritten, 0);
        console.log(chalk.green(`✓ Pushed ${total} rows`));
        results.forEach((r) => console.log(chalk.dim(`  ${r.table}: ${r.rowsWritten}`)));
      } catch (err: unknown) { console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`)); process.exit(1); }
    });

  // projects sync-log
  cmd
    .command("sync-log <id-or-slug>")
    .description("Show sync history for a project")
    .option("--limit <n>", "Max entries", "10")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts?: { limit?: string; json?: boolean }) => {
      const project = resolveProject(idOrSlug);
      if (!project) {
        console.error(chalk.red(`Project not found: ${idOrSlug}`));
        process.exit(1);
      }
      const logs = listSyncLogs(project.id, parseInt(opts?.limit ?? "10", 10));
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(logs, null, 2)); return; }
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
