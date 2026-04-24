import chalk from "chalk";
import { listProjects, resolveProject } from "../../../db/projects.js";
import { getMachineId } from "../../../db/workdirs.js";
import { buildProjectContext, getProjectLocations, type ProjectContext } from "../../../lib/project-context.js";
import { setupMachineReport } from "../../../lib/setup-machine.js";
import { cleanupStaleIssues, findStaleIssues, type StaleIssue } from "../../../lib/stale.js";
import { detectCurrentProject } from "../../../lib/detect.js";
import type { Project } from "../../../types/index.js";
import { exitProjectNotFound, wantsJsonOutput, type Command } from "./shared.js";

export function registerQolCommands(cmd: Command) {
  cmd
    .command("context [id-or-slug]")
    .description("Show the full agent handoff context for a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug?: string, opts?: { json?: boolean }) => {
      const project = resolveProjectFromArgOrCwd(idOrSlug);
      const context = buildProjectContext(project);
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(context, null, 2));
        return;
      }
      printContext(context);
    });

  cmd
    .command("where [id-or-slug]")
    .description("Show where a project lives across machines")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug?: string, opts?: { json?: boolean }) => {
      if (idOrSlug) {
        const project = resolveProject(idOrSlug);
        if (!project) exitProjectNotFound(idOrSlug);
        const locations = getProjectLocations(project);
        if (wantsJsonOutput(opts)) {
          console.log(JSON.stringify({ project, currentMachine: getMachineId(), locations }, null, 2));
          return;
        }
        printLocations(project, locations);
        return;
      }

      const detected = detectCurrentProject();
      if (detected) {
        const locations = getProjectLocations(detected);
        if (wantsJsonOutput(opts)) {
          console.log(JSON.stringify({ project: detected, currentMachine: getMachineId(), locations }, null, 2));
          return;
        }
        printLocations(detected, locations);
        return;
      }

      const currentMachine = getMachineId();
      const all = listProjects({ status: "active", limit: 1000 })
        .map((project) => ({ project, locations: getProjectLocations(project).filter((location) => location.currentMachine) }))
        .filter((entry) => entry.locations.length > 0);
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify({ currentMachine, projects: all }, null, 2));
        return;
      }
      if (!all.length) {
        console.log(chalk.dim(`No project workdirs registered for ${currentMachine}.`));
        return;
      }
      for (const entry of all) printLocations(entry.project, entry.locations);
    });

  cmd
    .command("setup-machine")
    .description("Preflight this machine for open-projects usage")
    .option("--fix", "Create safe missing directories")
    .option("--dry-run", "Preview fixes without writing")
    .option("-j, --json", "Output raw JSON")
    .action((opts?: { fix?: boolean; dryRun?: boolean; json?: boolean }) => {
      const report = setupMachineReport({
        fix: opts?.fix === true,
        dryRun: opts?.fix === true ? opts?.dryRun === true : true,
      });
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(`${chalk.bold("Machine")} ${report.machine.hostname} ${chalk.dim(`(${report.machine.knownRole}, ${report.machine.platform})`)}`);
      console.log(`${chalk.dim("workspace:")} ${report.machine.workspaceRoot}`);
      console.log(`${chalk.dim("projects:")}  ${report.version}`);
      for (const check of report.checks) {
        const icon = check.status === "ok" ? chalk.green("✓") : check.status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
        const fixed = check.fixed ? chalk.cyan(" fixed") : "";
        console.log(`  ${icon} ${check.label.padEnd(18)} ${check.message}${fixed}`);
      }
      if (!report.ok) process.exitCode = 1;
    });

  cmd
    .command("stale [id-or-slug]")
    .description("Find stale project records, workdirs, and tmux sessions")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug?: string, opts?: { json?: boolean }) => {
      const project = idOrSlug ? resolveProject(idOrSlug) : null;
      if (idOrSlug && !project) exitProjectNotFound(idOrSlug);
      const issues = findStaleIssues(project ?? undefined);
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(issues, null, 2));
        if (issues.some((issue) => issue.severity === "error")) process.exitCode = 1;
        return;
      }
      printStaleIssues(issues);
      if (issues.some((issue) => issue.severity === "error")) process.exitCode = 1;
    });

  cmd
    .command("cleanup")
    .description("Preview or apply safe stale-record cleanup")
    .option("--dry-run", "Preview cleanup actions without writing")
    .option("--apply", "Apply safe cleanup actions")
    .option("-j, --json", "Output raw JSON")
    .action((opts?: { dryRun?: boolean; apply?: boolean; json?: boolean }) => {
      const result = cleanupStaleIssues({ apply: opts?.apply === true });
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.dryRun ? chalk.dim("[dry-run]") : chalk.yellow("[apply]"));
      if (!result.actions.length) {
        console.log(chalk.green("No safe cleanup actions available."));
      } else {
        for (const action of result.actions) {
          console.log(`  ${action.changed ? chalk.green("done") : chalk.cyan("plan")} ${action.message}`);
        }
      }
      if (result.remaining.length) {
        console.log(chalk.dim(`Remaining findings: ${result.remaining.length}`));
      }
    });
}

function resolveProjectFromArgOrCwd(idOrSlug?: string): Project {
  if (idOrSlug) {
    const project = resolveProject(idOrSlug);
    if (!project) exitProjectNotFound(idOrSlug);
    return project;
  }
  const detected = detectCurrentProject();
  if (detected) return detected;
  exitProjectNotFound("(current directory)");
}

function printContext(context: ProjectContext): void {
  const project = context.project;
  console.log(`${chalk.bold(project.name)} ${chalk.dim(`(${project.slug})`)} ${project.status === "active" ? chalk.green("[active]") : chalk.yellow("[archived]")}`);
  console.log(`  ${chalk.dim("id:")}       ${project.id}`);
  console.log(`  ${chalk.dim("path:")}     ${project.path} ${context.status.path_exists ? chalk.green("[exists]") : chalk.red("[missing]")}`);
  console.log(`  ${chalk.dim("machine:")}  ${context.machine.hostname} ${chalk.dim(context.machine.workspaceRoot)}`);
  console.log(`  ${chalk.dim("git:")}      ${context.git.isRepo ? `${context.git.branch ?? "detached"} (${context.git.dirtyCount ?? "?"} dirty)` : "not a repo"}`);
  console.log(`  ${chalk.dim("tmux:")}     ${context.tmux.available ? `${context.tmux.session} (${context.tmux.deadWindows.length} dead windows)` : `unavailable: ${context.tmux.error}`}`);
  console.log(`  ${chalk.dim("sync:")}     ${context.sync.recent.length ? `${context.sync.recent.length} recent entr${context.sync.recent.length === 1 ? "y" : "ies"}` : "no sync history"}`);
  if (Object.keys(context.integrations).length) {
    console.log(`  ${chalk.dim("links:")}    ${Object.keys(context.integrations).join(", ")}`);
  }
  console.log(chalk.bold("\nLocations"));
  printLocationRows(context.locations);
  console.log(chalk.bold("\nNext commands"));
  for (const command of context.nextCommands) console.log(`  ${chalk.dim("$")} ${command}`);
}

function printLocations(project: Project, locations: ReturnType<typeof getProjectLocations>): void {
  console.log(`\n${chalk.bold(project.name)} ${chalk.dim(project.slug)}`);
  printLocationRows(locations);
}

function printLocationRows(locations: ReturnType<typeof getProjectLocations>): void {
  if (!locations.length) {
    console.log(chalk.dim("  No workdirs registered."));
    return;
  }
  for (const location of locations) {
    const exists = location.exists ? chalk.green("exists") : chalk.red("missing");
    const machine = location.currentMachine ? chalk.cyan(location.machine_id) : location.machine_id;
    const primary = location.is_primary ? chalk.dim(" primary") : "";
    console.log(`  ${exists} ${chalk.bold(location.label)}${primary} ${chalk.dim(machine)} ${location.path}`);
  }
}

function printStaleIssues(issues: StaleIssue[]): void {
  if (!issues.length) {
    console.log(chalk.green("No stale project records found."));
    return;
  }
  for (const issue of issues) {
    const icon = issue.severity === "error" ? chalk.red("✗") : issue.severity === "warn" ? chalk.yellow("⚠") : chalk.dim("i");
    const project = issue.project ? chalk.dim(` ${issue.project.slug}`) : "";
    console.log(`${icon} ${issue.code}${project}: ${issue.message}`);
    if (issue.recommendedCommand) console.log(chalk.dim(`  ${issue.recommendedCommand}`));
  }
}
