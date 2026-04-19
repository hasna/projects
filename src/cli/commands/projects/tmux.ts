import chalk from "chalk";
import {
  listSessions,
  listWindows,
  createSession,
  createWindow,
  killSession,
  restartSession,
  reviveSession,
  findDeadSessions,
  createTmuxWindow,
} from "../../../lib/tmux.js";
import {
  wantsJsonOutput,
  type Command,
} from "./shared.js";
import { resolveProject } from "../../../db/projects.js";

export function registerTmuxCommands(cmd: Command) {
  const tmuxCmd = cmd
    .command("tmux")
    .description("Manage tmux sessions and windows for projects");

  tmuxCmd
    .command("list")
    .alias("ls")
    .description("List all tmux sessions")
    .option("-j, --json", "Output as JSON")
    .action((opts) => {
      const sessions = listSessions();
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }
      for (const s of sessions) {
        const attached = s.attached ? chalk.green("●") : chalk.dim("○");
        console.log(`  ${attached} ${s.name} ${chalk.dim(`(${s.group})`)} — ${s.windows} windows`);
      }
    });

  tmuxCmd
    .command("windows")
    .alias("win")
    .description("List windows in a session")
    .argument("[session]", "Session name (all if omitted)")
    .option("-j, --json", "Output as JSON")
    .action((session, opts) => {
      const windows = listWindows(session);
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(windows, null, 2));
        return;
      }
      const currentSession = "";
      for (const w of windows) {
        const active = w.active ? chalk.green("▶") : " ";
        const label = w.session !== currentSession ? `${w.session}:` : "";
        console.log(`  ${active} ${label}${w.index} ${w.name}`);
      }
    });

  tmuxCmd
    .command("create")
    .description("Create a new tmux session for a project")
    .argument("<name>", "Project name or slug")
    .option("-w, --window <name>", "Window name")
    .option("-c, --command <cmd>", "Initial command to run")
    .option("-j, --json", "Output as JSON")
    .action((name, opts) => {
      try {
        const project = resolveProject(name);
        if (project) {
          createTmuxWindow(project);
          console.log(chalk.green(`✓ Created tmux window for ${project.name}`));
          return;
        }
      } catch {
        // Not a registered project — create standalone session
      }
      createSession(name, undefined, opts.window);
      if (opts.command) {
        createWindow(name, opts.window || "main", opts.command);
      }
      console.log(chalk.green(`✓ Created session: ${name}`));
    });

  tmuxCmd
    .command("kill")
    .description("Kill a tmux session")
    .argument("<name>", "Session name")
    .action((name) => {
      try {
        killSession(name);
        console.log(chalk.green(`✓ Killed session: ${name}`));
      } catch {
        console.error(chalk.red(`Session not found: ${name}`));
        process.exit(1);
      }
    });

  tmuxCmd
    .command("restart")
    .description("Restart a tmux session (kill + recreate)")
    .argument("<name>", "Session name")
    .option("-w, --window <name>", "Window name")
    .action((name, opts) => {
      restartSession(name, undefined, opts.window);
      console.log(chalk.green(`✓ Restarted session: ${name}`));
    });

  tmuxCmd
    .command("revive")
    .description("Check if a session is alive and responsive")
    .argument("[name]", "Session name (all if omitted)")
    .action((name) => {
      if (name) {
        const alive = reviveSession(name);
        if (alive) {
          console.log(chalk.green(`✓ ${name} is alive`));
        } else {
          console.log(chalk.yellow(`⚠ ${name} appears dead`));
        }
        return;
      }
      const dead = findDeadSessions();
      if (dead.length === 0) {
        console.log(chalk.green("✓ All sessions healthy"));
        return;
      }
      console.log(chalk.yellow(`Dead sessions: ${dead.join(", ")}`));
      console.log(chalk.dim("  Run: project tmux restart <session>"));
    });
}
