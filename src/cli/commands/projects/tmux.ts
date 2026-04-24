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
  getTmuxSessionName,
} from "../../../lib/tmux.js";
import {
  wantsJsonOutput,
  requireProject,
  type Command,
} from "./shared.js";
import { resolveProject, listProjects } from "../../../db/projects.js";
import {
  createSavedGroup,
  getSavedGroup,
  listSavedGroups,
  deleteSavedGroup,
  addSessionToGroup,
  updateSavedGroupDescription,
} from "../../../db/tmux-groups.js";
import { getDatabase } from "../../../db/database.js";
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
      if (!createTmuxWindow(project, opts.window)) {
        console.error(chalk.red("tmux unavailable or failed to create the project session."));
        process.exit(1);
      }
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
          if (createTmuxWindow(p)) {
            created++;
          } else {
            skipped++;
            errors.push(`${p.name}: tmux unavailable or failed`);
          }
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
        const sessionName = getTmuxSessionName(p);
        const hasSession = sessionNames.has(sessionName);
        const session = sessions.find((s) => s.name === sessionName);
        return {
          name: p.name,
          session: sessionName,
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
          if (!createTmuxWindow(project, opts.window)) {
            console.error(chalk.red("tmux unavailable or failed to create the project session."));
            process.exit(1);
          }
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
    .command("setup")
    .description("Create a master session + one linked session per window (spark01 pattern)")
    .argument("<name>", "Group/session name")
    .option("-p, --project <slug>", "Project slug (creates windows for registered project)")
    .option("-w, --windows <list>", "Comma-separated window names")
    .action((name, opts) => {
      const windows = opts.windows
        ? opts.windows.split(",").map((w: string) => w.trim())
        : [];

      // If a project is specified, use its default window names
      if (opts.project) {
        const project = resolveProject(opts.project);
        if (project) {
          // Create the master session with project windows
          const winNames = windows.length > 0 ? windows : [project.slug || project.name];
          const safeMaster = shellEscape(name);

          // Create master session
          try {
            run(`tmux new-session -d -s ${safeMaster} -n ${shellEscape(winNames[0]!)}`);
            if (project.path) {
              run(`tmux send-keys -t ${safeMaster} "cd ${shellEscape(project.path)}" Enter`);
            }
          } catch {
            console.log(chalk.dim(`  Master session "${name}" already exists`));
          }

          // Add remaining windows
          for (const wn of winNames.slice(1)) {
            try {
              run(`tmux new-window -t ${safeMaster} -n ${shellEscape(wn)}`);
              if (project.path) {
                run(`tmux send-keys -t ${safeMaster} "cd ${shellEscape(project.path)}" Enter`);
              }
            } catch { /* window may already exist */ }
          }

          // Create linked sessions — one per window, each focused on its window
          for (const wn of winNames) {
            const linkedName = `${name}-${wn}`;
            const safeLinked = shellEscape(linkedName);
            try {
              run(`tmux new-session -d -s ${safeLinked} -t ${safeMaster}`);
              run(`tmux select-window -t ${safeLinked}:${shellEscape(wn)}`);
              console.log(chalk.green(`  ✓ Linked session: ${linkedName} (focused on ${wn})`));
            } catch {
              console.log(chalk.dim(`  Linked session "${linkedName}" already exists, skipping`));
            }
          }

          console.log(chalk.green(`✓ Setup group "${name}" with ${winNames.length} window(s), ${winNames.length} linked session(s)`));
          return;
        }
        console.error(chalk.red(`Project "${opts.project}" not found`));
        return;
      }

      // Generic setup with explicit window names
      if (windows.length === 0) {
        console.error(chalk.red("Provide --windows <list> or --project <slug>"));
        return;
      }

      const safeMaster = shellEscape(name);

      // Create master session
      try {
        run(`tmux new-session -d -s ${safeMaster} -n ${shellEscape(windows[0]!)}`);
      } catch {
        console.log(chalk.dim(`  Master session "${name}" already exists`));
      }

      for (const wn of windows.slice(1)) {
        try {
          run(`tmux new-window -t ${safeMaster} -n ${shellEscape(wn)}`);
        } catch { /* window may already exist */ }
      }

      // Create linked sessions
      for (const wn of windows) {
        const linkedName = `${name}-${wn}`;
        const safeLinked = shellEscape(linkedName);
        try {
          run(`tmux new-session -d -s ${safeLinked} -t ${safeMaster}`);
          run(`tmux select-window -t ${safeLinked}:${shellEscape(wn)}`);
          console.log(chalk.green(`  ✓ Linked session: ${linkedName} (focused on ${wn})`));
        } catch {
          console.log(chalk.dim(`  Linked session "${linkedName}" already exists, skipping`));
        }
      }

      console.log(chalk.green(`✓ Setup "${name}" with ${windows.length} window(s), ${windows.length} linked session(s)`));
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
      const safeSession = shellEscape(session);
      const safeGroup = shellEscape(group);
      try {
        run(`tmux new-session -d -s ${safeSession} -t ${safeGroup}`);
        for (const wn of windowNames) {
          if (wn === "0") continue;
          try { run(`tmux new-window -t ${safeSession} -n ${shellEscape(wn)}`); } catch { /* ignore */ }
        }
      } catch {
        run(`tmux new-session -d -s ${safeSession}`);
      }
      console.log(chalk.green(`✓ Moved ${session} to group: ${group}`));
    });

  groupCmd
    .command("save")
    .alias("s")
    .description("Save current live group definition for later restore")
    .argument("<name>", "Group name")
    .option("-d, --description <desc>", "Group description")
    .action((name, opts) => {
      const db = getDatabase();
      const sessions = listSessions();
      const groupSessions = sessions.filter((s) => s.group === name);
      if (groupSessions.length === 0) {
        console.error(chalk.red(`No live sessions in group "${name}". Create sessions first, or use "tmux group create"`));
        return;
      }

      // Save the group definition
      const group = createSavedGroup(name, opts.description, db);
      for (const s of groupSessions) {
        addSessionToGroup(group.id, s.name, undefined, db);
      }
      if (opts.description) {
        updateSavedGroupDescription(name, opts.description, db);
      }

      console.log(chalk.green(`✓ Saved group "${name}" with ${groupSessions.length} session(s)`));
      for (const s of groupSessions) {
        console.log(`  - ${s.name} (${s.windows} windows)`);
      }
    });

  groupCmd
    .command("saved")
    .alias("show")
    .description("List all saved group definitions")
    .option("-j, --json", "Output as JSON")
    .action((opts) => {
      const db = getDatabase();
      const groups = listSavedGroups(db);
      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(groups, null, 2));
        return;
      }
      if (groups.length === 0) {
        console.log(chalk.dim("No saved groups."));
        return;
      }
      for (const g of groups) {
        console.log(chalk.green(`  ${g.name}`));
        if (g.description) console.log(chalk.dim(`    "${g.description}"`));
        console.log(chalk.dim(`    ${g.sessions.length} session(s)`));
      }
    });

  groupCmd
    .command("start")
    .description("Start a saved group — recreate all sessions and windows")
    .argument("<name>", "Saved group name")
    .action((name) => {
      const db = getDatabase();
      const group = getSavedGroup(name, db);
      if (!group) {
        console.error(chalk.red(`Saved group "${name}" not found.`));
        return;
      }

      // Create the group anchor
      try { createGroup(name); } catch { /* exists */ }

      for (const s of group.sessions) {
        const safeSession = shellEscape(s.session_name);
        const safeGroup = shellEscape(name);
        try {
          run(`tmux new-session -d -s ${safeSession} -t ${safeGroup}`);
        } catch {
          // Session may already exist — skip
          console.log(chalk.dim(`  Session "${s.session_name}" already exists, skipping`));
        }
      }

      console.log(chalk.green(`✓ Started group "${name}" with ${group.sessions.length} session(s)`));
    });

  groupCmd
    .command("restore")
    .description("Start a saved group and open tmux windows for all associated projects")
    .argument("<name>", "Saved group name")
    .action((name) => {
      const db = getDatabase();
      const group = getSavedGroup(name, db);
      if (!group) {
        console.error(chalk.red(`Saved group "${name}" not found.`));
        return;
      }

      // Create the group anchor
      try { createGroup(name); } catch { /* exists */ }

      let started = 0;
      for (const s of group.sessions) {
        if (s.project_id) {
          // Restore a registered project
          const project = resolveProject(s.project_id);
          if (project) {
            try {
              if (createTmuxWindow(project)) {
                started++;
              } else {
                console.log(chalk.dim(`  Could not create window for ${project.name}, tmux may be unavailable`));
              }
            } catch {
              console.log(chalk.dim(`  Could not create window for ${project.name}, may already exist`));
            }
          }
        } else {
          // Generic session
          const safeSession = shellEscape(s.session_name);
          const safeGroup = shellEscape(name);
          try {
            run(`tmux new-session -d -s ${safeSession} -t ${safeGroup}`);
            started++;
          } catch {
            console.log(chalk.dim(`  Session "${s.session_name}" already exists, skipping`));
          }
        }
      }

      console.log(chalk.green(`✓ Restored group "${name}" — ${started} session(s) started`));
    });

  groupCmd
    .command("delete")
    .description("Delete a saved group definition (does not kill live sessions)")
    .argument("<name>", "Saved group name")
    .action((name) => {
      const db = getDatabase();
      const group = getSavedGroup(name, db);
      if (!group) {
        console.error(chalk.red(`Saved group "${name}" not found.`));
        return;
      }
      deleteSavedGroup(name, db);
      console.log(chalk.green(`✓ Deleted saved group "${name}"`));
    });
}

// Helper for move command
function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
