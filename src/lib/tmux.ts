import { execSync } from "node:child_process";
import type { Project } from "../types/index.js";
import { getConfig } from "./config.js";

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
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
  const groupName = config.default_tmux_group || "projectmaintain";
  const master = config.default_tmux_master || "master";
  const win = windowName || name;

  // Ensure master session exists in the group
  try {
    run(`tmux new-session -d -s ${master} -n main`);
    run(`tmux set-option -t ${master} session-group "${groupName}"`);
  } catch {
    // Master may already exist or group option may not apply — continue anyway
  }

  // Create session linked to master (creates a session group)
  try {
    run(`tmux new-session -d -s ${name} -t ${master} -n ${win}`);
  } catch {
    // Fallback: create standalone session then link to group
    run(`tmux new-session -d -s ${name} -n ${win}`);
    try {
      run(`tmux set-option -t ${name} session-group "${groupName}"`);
    } catch {
      // session-group option not available — session remains standalone
    }
  }

  if (projectPath) {
    run(`tmux send-keys -t ${name}:${win} "cd ${projectPath}" Enter`);
  }
}

export function createWindow(session: string, name: string, command?: string): void {
  run(`tmux new-window -t ${session} -n ${name}`);
  if (command) {
    run(`tmux send-keys -t ${session}:${name} "${command}" Enter`);
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
  const groupName = config.default_tmux_group || "projectmaintain";
  const masterSession = config.default_tmux_master || "master";
  const win = windowName || name;

  try {
    killSession(name);
  } catch {
    // ignore if doesn't exist
  }

  try {
    // Recreate within the master group for persistence
    run(`tmux new-session -d -s ${name} -t ${masterSession} -n ${win}`);
  } catch {
    // Master may not exist — create standalone
    createSession(name, projectPath, windowName);
  }

  if (projectPath) {
    run(`tmux send-keys -t ${name}:${win} "cd ${projectPath}" Enter`);
  }
  if (config.launch_takumi !== false && projectPath) {
    run(`tmux send-keys -t ${name}:${win} "takumi" Enter`);
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
    if (!s.attached && s.windows === 0) {
      dead.push(s.name);
      continue;
    }
    // Check for takumi crashes
    try {
      const output = run(`tmux capture-pane -t ${s.name}:0 -p`);
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
  const groupName = config.default_tmux_group || "projectmaintain";
  const masterSession = config.default_tmux_master || "master";
  const sessionName = `proj-${slug || name}`;
  const windowName = slug || name;

  try {
    const sessions = run("tmux list-sessions -F '#{session_name}:#{session_group}'");
    const lines = sessions.split("\n").filter(Boolean);
    const masterExists = lines.some((line) => {
      const [sName, sGroup] = line.split(":");
      return sName === masterSession && sGroup === groupName;
    });

    if (!masterExists) {
      run(`tmux new-session -d -s ${masterSession} -n main`);
      try {
        run(`tmux set-option -t ${masterSession} session-group "${groupName}"`);
      } catch {
        // group option not available — continue anyway
      }
    }

    const sessionLine = lines.find((line) => {
      const [sName] = line.split(":");
      return sName === sessionName;
    });
    const sessionExists = !!sessionLine;

    if (sessionExists) {
      // Check if a window with this name already exists
      const windows = listWindows(sessionName);
      const existingWindow = windows.find((w) => w.name === windowName);
      if (existingWindow) {
        // Window already exists — move to it instead of creating a duplicate
        run(`tmux select-window -t ${sessionName}:${windowName}`);
        return;
      }
      run(`tmux new-window -t ${sessionName} -n ${windowName}`);
    } else {
      run(
        `tmux new-session -d -s ${sessionName} -t ${masterSession} -n ${windowName}`,
      );
    }

    if (config.launch_takumi !== false) {
      run(`tmux send-keys -t ${sessionName}:${windowName} "cd ${path} && takumi" Enter`);
    }
  } catch {
    // Non-fatal — tmux may not be available
  }
}
