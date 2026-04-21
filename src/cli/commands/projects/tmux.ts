import chalk from "chalk";
import {
  listSessions,
  listWindows,
  createSession,
  createWindow,
  killSession,
  killWindow,
  restartSession,
  reviveSession,
  findDeadSessions,
  createTmuxWindow,
  attachSession,
  focusWindow,
  renameWindow as renameTmuxWindow,
  renameSession as renameTmuxSession,
  execInWindow,
  cleanupDeadSessions,
  listGroups,
  createGroup,
  destroyGroup,
} from "../../../lib/tmux.js";
import {
  wantsJsonOutput,
  requireProject,
  type Command,
} from "./shared.js";
import { resolveProject, listProjects } from "../../../db/projects.js";
import { execSync } from "node:child_process";

export function registerTmuxCommands(cmd: Command) {
  const tmuxCmd = cmd
    .command("tmux")
    .description("Manage tmux sessions and windows for projects");

  tmuxCmd
    .command("open")
    .alias("o")
    .description("Open a tmux window for a project (auto-detects from cwd)")
    .option("-n, --name <name>", "Project name (auto-detected if omitted)")
    .option("-w, --window <name>", "Window name")
    .option("-c, --command <cmd>", "Initial command to run")
    .action((opts) => {
      let project = requireProject(opts.name);
      if (!project) {
        console.error(chalk.red("Project not found. Use --name or run from a project directory."));
        process.exit(1);
      }
      createTmuxWindow(project, opts.window);
      console.log(chalk.green(`✓ Opened tmux window for ${project.name}`));
    });

  tmuxCmd
    .command("create-all")
    .alias("all")
    .description("Create tmux windows for all registered projects")
    .option("-j, --json", "Output as JSON")
    .action((opts) => {
      const projects = listProjects();
      let created = 0;
      let skipped = 0;
      const errors: string[] = [];
      for (const p of projects) {
        try {
          createTmuxWindow(p);
          created++;
        } catch (err: unknown) {
          skipped++;
          errors.push(`${p.name}: ${(err as Error).message}`);
        }
      }
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify({ created, skipped, errors }, null, 2));
        return;
      }
      console.log(chalk.green(`✓ Created tmux windows for ${created} project(s)`));
      if (skipped > 0) {
        console.log(chalk.yellow(`  Skipped ${skipped} (may already exist)`));
      }
      if (errors.length > 0 && errors.length <= 5) {
        for (const e of errors) {
          console.log(chalk.dim(`  - ${e}`));
        }
      }
    });

  tmuxCmd
    .command("status")
    .alias("s")
    .description("Show tmux health for all registered projects")
    .option("-j, --json", "Output as JSON")
    .action((opts) => {
      const projects = listProjects();
      const sessions = listSessions();
      const sessionNames = new Set(sessions.map((s) => s.name));
      const windows = listWindows();
      const windowMap = new Map<string, string[]>();
      for (const w of windows) {
        if (!windowMap.has(w.session)) windowMap.set(w.session, []);
        windowMap.get(w.session)!.push(w.name);
      }
      const results = projects.map((p) => {
        const hasSession = sessionNames.has(p.name);
        const session = sessions.find((s) => s.name === p.name);
        return {
          name: p.name,
          hasWindow: hasSession,
          windows: session?.windows || 0,
          attached: session?.attached || false,
          group: session?.group || "",
        };
      });
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      const alive = results.filter((r) => r.hasWindow);
      const dead = results.filter((r) => !r.hasWindow);
      console.log(chalk.green(`✓ ${alive.length} project(s) with tmux windows`));
      if (dead.length > 0) {
        console.log(chalk.yellow(`⚠ ${dead.length} project(s) without windows:`));
        for (const d of dead.slice(0, 20)) {
          console.log(chalk.dim(`  - ${d.name}`));
        }
        if (dead.length > 20) {
          console.log(chalk.dim(`  ... and ${dead.length - 20} more`));
        }
      }
    });

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
          createTmuxWindow(project, opts.window);
          console.log(chalk.green(`✓ Created tmux window for ${project.name}`));
          return;
        }
      } catch {
        // Not a registered project — create standalone session
      }
      createSession(name, undefined, opts.window);
      if (opts.command) {
        const winName = opts.window || name;
        execInWindow(name, winName, opts.command);
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

  tmuxCmd
    .command("attach")
    .alias("a")
    .description("Attach to a tmux session")
    .argument("<name>", "Session name")
    .action((name) => {
      try {
        attachSession(name);
      } catch {
        console.error(chalk.red(`Session not found: ${name}`));
        process.exit(1);
      }
    });

  tmuxCmd
    .command("focus")
    .alias("f")
    .description("Focus a window in the master group")
    .argument("<session>", "Session name")
    .argument("[window]", "Window name (first if omitted)")
    .action((session, window) => {
      try {
        if (!window) {
          // Use the first project-specific window
          const windows = listWindows(session);
          const projWindow = windows.find((w) => !w.name.startsWith("main") && w.name !== "0");
          if (!projWindow) {
            console.error(chalk.red(`No suitable window found in ${session}`));
            process.exit(1);
          }
          window = projWindow.name;
        }
        focusWindow(session, window);
        console.log(chalk.green(`✓ Focused ${session}:${window}`));
      } catch (err: unknown) {
        console.error(chalk.red(`Window not found: ${session}:${window}`));
        process.exit(1);
      }
    });

  tmuxCmd
    .command("rename-window")
    .alias("rnw")
    .description("Rename a tmux window")
    .argument("<session>", "Session name")
    .argument("<old-name>", "Current window name")
    .argument("<new-name>", "New window name")
    .action((session, oldName, newName) => {
      try {
        renameTmuxWindow(session, oldName, newName);
        console.log(chalk.green(`✓ Renamed ${session}:${oldName} → ${newName}`));
      } catch {
        console.error(chalk.red(`Window not found: ${session}:${oldName}`));
        process.exit(1);
      }
    });

  tmuxCmd
    .command("rename-session")
    .alias("rns")
    .description("Rename a tmux session")
    .argument("<old-name>", "Current session name")
    .argument("<new-name>", "New session name")
    .action((oldName, newName) => {
      try {
        renameTmuxSession(oldName, newName);
        console.log(chalk.green(`✓ Renamed session ${oldName} → ${newName}`));
      } catch {
        console.error(chalk.red(`Session not found: ${oldName}`));
        process.exit(1);
      }
    });

  tmuxCmd
    .command("exec")
    .alias("x")
    .description("Execute a command in a tmux window")
    .argument("<session>", "Session name")
    .argument("<window>", "Window name")
    .argument("<command...>", "Command to run")
    .action((session, window, command: string[]) => {
      try {
        execInWindow(session, window, command.join(" "));
        console.log(chalk.green(`✓ Sent command to ${session}:${window}`));
      } catch {
        console.error(chalk.red(`Window not found: ${session}:${window}`));
        process.exit(1);
      }
    });

  tmuxCmd
    .command("cleanup")
    .alias("clean")
    .description("Kill all dead sessions in the master group")
    .option("-j, --json", "Output as JSON")
    .action((opts) => {
      const killed = cleanupDeadSessions();
      if (killed.length === 0) {
        console.log(chalk.green("✓ No dead sessions to clean up"));
        return;
      }
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify({ cleaned: killed }, null, 2));
        return;
      }
      console.log(chalk.yellow(`Cleaned ${killed.length} dead session(s): ${killed.join(", ")}`));
    });

  // Group management subcommand
  const groupCmd = tmuxCmd
    .command("group")
    .alias("g")
    .description("Manage tmux session groups");

  groupCmd
    .command("list")
    .alias("ls")
    .description("List all tmux groups")
    .option("-j, --json", "Output as JSON")
    .action((opts) => {
      const groups = listGroups();
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(groups, null, 2));
        return;
      }
      for (const g of groups) {
        console.log(`  ${chalk.green(g.name)} — ${g.sessions.length} session(s), ${g.windows} window(s)`);
      }
    });

  groupCmd
    .command("create")
    .alias("c")
    .description("Create a new tmux group")
    .argument("<name>", "Group name")
    .action((name) => {
      createGroup(name);
      console.log(chalk.green(`✓ Created group: ${name}`));
    });

  groupCmd
    .command("destroy")
    .alias("rm")
    .description("Destroy a tmux group and all its sessions")
    .argument("<name>", "Group name")
    .action((name) => {
      // Get all sessions in this group
      const sessions = listSessions();
      const groupSessions = sessions.filter((s) => s.group === name);
      for (const s of groupSessions) {
        try { killSession(s.name); } catch { /* ignore */ }
      }
      destroyGroup(name);
      console.log(chalk.green(`✓ Destroyed group: ${name} (${groupSessions.length} sessions removed)`));
    });

  groupCmd
    .command("move")
    .alias("mv")
    .description("Move a session to a different group")
    .argument("<session>", "Session name")
    .argument("<group>", "Target group name")
    .action((session, group) => {
      // Get current windows
      const windows = listWindows(session);
      const windowNames = windows.map((w) => w.name);

      // Kill old session
      killSession(session);

      // Create group if needed
      try { createGroup(group); } catch { /* exists */ }

      // Recreate session in new group
      try {
        run(`tmux new-session -d -s ${session} -t ${group}`);
        for (const wn of windowNames) {
          if (wn === "0") continue;
          try { run(`tmux new-window -t ${session} -n ${wn}`); } catch { /* ignore */ }
        }
      } catch {
        run(`tmux new-session -d -s ${session}`);
      }
      console.log(chalk.green(`✓ Moved ${session} to group: ${group}`));
    });
}

// Helper for move command
function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}
