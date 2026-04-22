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

export interface TmuxGroup {
  name: string;
  sessions: string[];
  windows: number;
}

function getGroupForProject(name: string, path?: string): string {
  if (path?.includes("opensourcedev")) return "open";
  return name;
}

export function listGroups(): TmuxGroup[] {
  const sessions = listSessions();
  const groupMap = new Map<string, TmuxGroup>();
  for (const s of sessions) {
    const group = s.group || s.name;
    if (!groupMap.has(group)) {
      groupMap.set(group, { name: group, sessions: [], windows: 0 });
    }
    const g = groupMap.get(group)!;
    g.sessions.push(s.name);
    g.windows = Math.max(g.windows, s.windows);
  }
  return Array.from(groupMap.values());
}

export function createGroup(name: string): void {
  try {
    run(`tmux new-session -d -s ${name}`);
  } catch {
    // Group already exists
  }
}

export function destroyGroup(name: string): void {
  try {
    run(`tmux kill-session -t ${name}`);
  } catch {
    // ignore
  }
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
  const win = windowName || name;

  // Create standalone session with the desired window name directly (avoids duplicate default window)
  try {
    run(`tmux new-session -d -s ${name} -n ${win}`);
  } catch {
    // Session already exists
    return;
  }

  if (projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t "${winId}" "cd ${shellEscape(projectPath)}" Enter`);
  }
}

export function createWindow(session: string, name: string, command?: string): void {
  run(`tmux new-window -t ${session} -n ${name}`);
  if (command) {
    const winId = findWindowId(session, name);
    run(`tmux send-keys -t "${winId}" "${shellEscape(command)}" Enter`);
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
  const win = windowName || name;

  try {
    killSession(name);
  } catch {
    // ignore if doesn't exist
  }

  // Create standalone session with the desired window name directly
  try {
    run(`tmux new-session -d -s ${name} -n ${win}`);
  } catch {
    return;
  }

  if (projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t "${winId}" "cd ${shellEscape(projectPath)}" Enter`);
  }
  if (config.launch_takumi !== false && projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t "${winId}" "takumi" Enter`);
  }
}

export function reviveSession(name: string): boolean {
  const sessions = listSessions();
  const session = sessions.find((s) => s.name === name);
  if (!session) return false;

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

export function findDeadSessions(sessions?: TmuxSession[]): string[] {
  const list = sessions || listSessions();
  const dead: string[] = [];
  for (const s of list) {
    if (s.name === "master") continue;
    // Sessions with 0 windows are dead
    if (!s.attached && s.windows === 0) {
      dead.push(s.name);
    }
  }
  return dead;
}

export function createTmuxWindow(project: Project, windowName?: string): void {
  const { name, path, slug } = project;
  const config = getConfig();

  // For open-* projects in opensourcedev, use open- prefix; otherwise use raw slug/name
  const raw = slug || name;
  const sessionName = path?.includes("opensourcedev")
    ? raw.replace(/^proj-/, "").startsWith("open-")
      ? raw.replace(/^proj-/, "")
      : `open-${raw}`.replace(/^proj-/, "")
    : raw;

  const winName = windowName || slug || name; // allow explicit window name override (e.g. iapp-takumi-01)

  try {
    // Check if session already exists
    const sessions = run("tmux list-sessions -F '#{session_name}'");
    const sessionExists = sessions.split("\n").filter(Boolean).includes(sessionName);

    if (sessionExists) {
      // Check if a window with this name already exists
      const windows = listWindows(sessionName);
      const existingWindow = windows.find((w) => w.name === winName);
      if (existingWindow) {
        // Window already exists — just select it
        run(`tmux select-window -t ${sessionName}:${existingWindow.name}`);
        return;
      }
      // Session exists but with different windows — don't create duplicates
      // Just select the existing session's first window
      if (windows.length > 0) {
        run(`tmux select-window -t ${sessionName}:${windows[0]!.name}`);
        return;
      }
      // Session exists but has no windows (edge case) — add one
      run(`tmux new-window -t ${sessionName} -n ${winName}`);
    } else {
      // Create standalone session with the desired window name directly
      run(`tmux new-session -d -s ${sessionName} -n ${winName}`);
    }

    if (config.launch_takumi !== false) {
      const winId = findWindowId(sessionName, winName);
      run(`tmux send-keys -t "${winId}" "cd ${shellEscape(path)} && takumi" Enter`);
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

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function execInWindow(session: string, window: string, command: string): void {
  run(`tmux send-keys -t ${session}:${window} "${shellEscape(command)}" Enter`);
}

export function cleanupDeadSessions(): string[] {
  const dead = findDeadSessions();
  for (const name of dead) {
    try { killSession(name); } catch { /* ignore */ }
  }
  return dead;
}
