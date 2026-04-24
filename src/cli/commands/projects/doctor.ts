import chalk from "chalk";
import { resolveProject, listSyncLogs } from "../../../db/projects.js";
import { resolveProjectOrExit, exitProjectNotFound, wantsJsonOutput, parsePositiveIntOrExit, timeAgo, type Command } from "./shared.js";
import { doctorAll, doctorProject, fixProject } from "../../../lib/doctor.js";
import { getAllStatus, getProjectStatus } from "../../../lib/status.js";
import { getGlobalStats, getProjectStats, formatBytes } from "../../../lib/stats.js";

export function registerDoctorCommands(cmd: Command) {
  cmd
    .command("doctor [id-or-slug]")
    .description("Health-check all registered projects")
    .option("--fix", "Auto-repair what can be fixed")
    .option("--dry-run", "Preview repairs without writing")
    .option("--json", "Output raw JSON")
    .action(async (idOrSlug?: string, opts?: { fix?: boolean; dryRun?: boolean; json?: boolean }) => {
      const target = idOrSlug ? resolveProject(idOrSlug) : null;
      if (idOrSlug && !target) exitProjectNotFound(idOrSlug);
      const results = target ? [await doctorProject(target)] : await doctorAll();
      const fixedResults = results.map((result) => ({
        ...result,
        fixes: opts?.fix ? fixProject(result.project, { dryRun: opts.dryRun === true }) : [],
      }));
      if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(fixedResults, null, 2)); return; }
      let hasError = false;
      for (const r of fixedResults) {
        console.log(`\n${chalk.bold(r.project.name)} ${chalk.dim(r.project.slug)}`);
        for (const c of r.checks) {
          const icon = c.status === "ok" ? chalk.green("✓") : c.status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
          const code = c.fixable ? chalk.cyan(` [${c.code}]`) : chalk.dim(` [${c.code}]`);
          console.log(`  ${icon} ${c.name.padEnd(14)} ${c.message}${code}`);
          if (c.status === "error") hasError = true;
        }
        if (r.fixes.length) {
          r.fixes.forEach((f) => {
            const prefix = f.dryRun ? "would fix" : "fixed";
            console.log(chalk.cyan(`  → ${prefix}: ${f.message}`));
          });
        }
      }
      if (hasError) process.exit(1);
    });

  cmd
    .command("status [id-or-slug]")
    .description("Show project health at a glance")
    .option("--json", "Output raw JSON")
    .action(async (idOrSlug?: string, opts?: { json?: boolean }) => {
      if (idOrSlug) {
        const project = resolveProjectOrExit(idOrSlug);
        const s = getProjectStatus(project);
        if (opts?.json || process.env["PROJECTS_JSON"]) { console.log(JSON.stringify(s, null, 2)); return; }
        console.log(`${chalk.bold(project.name)} ${chalk.dim(`(${project.slug})`)} ${project.status === "archived" ? chalk.yellow("[archived]") : chalk.green("[active]")}`);
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

  cmd
    .command("stats [id-or-slug]")
    .description("Show storage and sync statistics")
    .option("--json", "Output raw JSON")
    .action((idOrSlug?: string, opts?: { json?: boolean }) => {
      if (idOrSlug) {
        const project = resolveProjectOrExit(idOrSlug);
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
}

export function registerSyncLogCommand(cmd: Command) {
  cmd
    .command("sync-log <id-or-slug>")
    .description("Show sync history for a project")
    .option("--limit <n>", "Max entries", "10")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts?: { limit?: string; json?: boolean }) => {
      const project = resolveProjectOrExit(idOrSlug);
      const logs = listSyncLogs(project.id, parsePositiveIntOrExit(opts?.limit, "--limit", 10));
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
