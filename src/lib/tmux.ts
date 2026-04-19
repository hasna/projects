import { execSync } from "node:child_process";
import type { Project } from "../types/index.js";
import { getConfig } from "./config.js";

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function findWindowId(session: string, windowName: string): string {
  const output = run(
    `tmux list-windows -t ${session} -F '#{window_id}:#{window_name}'`,
  );
  for (const line of output.split("\n").filter(Boolean)) {
    const colonPos = line.indexOf(":");
    if (colonPos === -1) continue;
    const id = line.substring(0, colonPos);
    const name = line.substring(colonPos + 1);
    if (name === windowName) return id;
  }
  return "";
}

export interface TmuxSession {
  name: string;
  group: string;
  windows: number;
  attached: boolean;
}

export interface TmuxWindow {
  session: string;
  index: number;
  name: string;
  active: boolean;
}

export function listSessions(): TmuxSession[] {
  const output = run(
    "tmux list-sessions -F '#{session_name}:#{session_group}:#{session_windows}:#{session_attached}'",
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, group, windows, attached] = line.split(":");
      return {
        name: name || "",
        group: group || "",
        windows: parseInt(windows || "0", 10),
        attached: (parseInt(attached || "0", 10)) > 0,
      };
    });
}

export function listWindows(session?: string): TmuxWindow[] {
  const target = session ? `-t ${session}` : "";
  const output = run(
    `tmux list-windows ${target} -F '#{session_name}:#{window_index}:#{window_name}:#{window_active}'`,
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [s, i, name, active] = line.split(":");
      return { session: s || "", index: parseInt(i || "0", 10), name: name || "", active: (parseInt(active || "0", 10)) > 0 };
    });
}

export function createSession(name: string, projectPath?: string, windowName?: string): void {
  const config = getConfig();
  const master = config.default_tmux_master || "master";
  const win = windowName || name;

  // Ensure master session exists
  try {
    run(`tmux new-session -d -s ${master}`);
  } catch {
    // Master already exists
  }

  // Create session linked to master group (no -n flag — shares master's window list)
  try {
    run(`tmux new-session -d -s ${name} -t ${master}`);
  } catch {
    // Fallback: create standalone session
    run(`tmux new-session -d -s ${name}`);
  }

  // Add a project-specific window to the session
  run(`tmux new-window -t ${name} -n ${win}`);

  if (projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t "${winId}" "cd ${projectPath}" Enter`);
  }
}

export function createWindow(session: string, name: string, command?: string): void {
  run(`tmux new-window -t ${session} -n ${name}`);
  if (command) {
    const winId = findWindowId(session, name);
    run(`tmux send-keys -t "${winId}" "${command}" Enter`);
  }
}

export function killSession(name: string): void {
  run(`tmux kill-session -t ${name}`);
}

export function killWindow(session: string, name: string): void {
  run(`tmux kill-window -t ${session}:${name}`);
}

export function restartSession(name: string, projectPath?: string, windowName?: string): void {
  const config = getConfig();
  const masterSession = config.default_tmux_master || "master";
  const win = windowName || name;

  try {
    killSession(name);
  } catch {
    // ignore if doesn't exist
  }

  try {
    // Recreate linked to master (no -n flag — shares master's window list)
    run(`tmux new-session -d -s ${name} -t ${masterSession}`);
  } catch {
    // Master may not exist — create standalone
    createSession(name, projectPath, windowName);
    return;
  }

  // Add a project-specific window
  run(`tmux new-window -t ${name} -n ${win}`);

  if (projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t "${winId}" "cd ${projectPath}" Enter`);
  }
  if (config.launch_takumi !== false && projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t "${winId}" "takumi" Enter`);
  }
}

export function reviveSession(name: string): boolean {
  // Check if session exists and has activity
  const sessions = listSessions();
  const session = sessions.find((s) => s.name === name);
  if (!session) return false;

  // Check if any window has takumi running
  const windows = listWindows(name);
  for (const w of windows) {
    try {
      const output = run(`tmux capture-pane -t ${name}:${w.index} -p`);
      if (output.includes("Takumi") || output.includes("takumi") || output.includes("$ ")) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

export function findDeadSessions(): string[] {
  const sessions = listSessions();
  const dead: string[] = [];
  for (const s of sessions) {
    if (s.name === "master") continue;
    // In linked sessions, windows are shared — only check standalone sessions
    if (s.group === "master") continue;
    if (!s.attached && s.windows === 0) {
      dead.push(s.name);
      continue;
    }
    // Check for takumi crashes
    try {
      const output = run(`tmux capture-pane -t ${s.name} -p`);
      if (output.includes("ERR_") || output.includes("Error [ERR")) {
        dead.push(s.name);
      }
    } catch {
      // ignore
    }
  }
  return dead;
}

export function createTmuxWindow(project: Project): void {
  const { name, path, slug } = project;
  const config = getConfig();
  const masterSession = config.default_tmux_master || "master";
  const sessionName = `proj-${slug || name}`;
  const windowName = slug || name;

  try {
    const sessions = run("tmux list-sessions -F '#{session_name}:#{session_group}'");
    const lines = sessions.split("\n").filter(Boolean);
    const masterExists = lines.some((line) => {
      const [sName, sGroup] = line.split(":");
      return sName === masterSession;
    });

    if (!masterExists) {
      run(`tmux new-session -d -s ${masterSession}`);
    }

    const sessionExists = lines.some((line) => {
      const [sName] = line.split(":");
      return sName === sessionName;
    });

    if (sessionExists) {
      // Check if a window with this name already exists
      const windows = listWindows(sessionName);
      const existingWindow = windows.find((w) => w.name === windowName);
      if (existingWindow) {
        // Window already exists — move to it instead of creating a duplicate
        run(`tmux select-window -t "${existingWindow.name}"`);
        return;
      }
      run(`tmux new-window -t ${sessionName} -n ${windowName}`);
    } else {
      // Create session linked to master (no -n flag — shares master's window list)
      run(`tmux new-session -d -s ${sessionName} -t ${masterSession}`);
      run(`tmux new-window -t ${sessionName} -n ${windowName}`);
    }

    if (config.launch_takumi !== false) {
      const winId = findWindowId(sessionName, windowName);
      run(`tmux send-keys -t "${winId}" "cd ${path} && takumi" Enter`);
    }
  } catch {
    // Non-fatal — tmux may not be available
  }
}

export function attachSession(name: string): void {
  run(`tmux attach-session -t ${name}`);
}

export function focusWindow(session: string, window: string): void {
  run(`tmux select-window -t ${session}:${window}`);
}

export function renameWindow(session: string, oldName: string, newName: string): void {
  run(`tmux rename-window -t ${session}:${oldName} ${newName}`);
}

export function renameSession(oldName: string, newName: string): void {
  run(`tmux rename-session -t ${oldName} ${newName}`);
}

export function execInWindow(session: string, window: string, command: string): void {
  run(`tmux send-keys -t ${session}:${window} "${command}" Enter`);
}

export function cleanupDeadSessions(): string[] {
  const dead = findDeadSessions();
  for (const name of dead) {
    try { killSession(name); } catch { /* ignore */ }
  }
  return dead;
}
