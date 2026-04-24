import { execSync } from "node:child_process";
import type { Project } from "../types/index.js";
import { getConfig } from "./config.js";

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function findWindowId(session: string, windowName: string): string {
  const output = run(
    `tmux list-windows -t ${shellEscape(session)} -F '#{window_id}:#{window_name}'`,
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

export type TmuxWindowDeadReason = "alive" | "missing" | "no-panes" | "all-panes-dead";

export interface TmuxPaneStatus {
  session: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  command: string;
  currentPath: string;
  dead: boolean;
  deadStatus: number | null;
  active: boolean;
}

export interface TmuxWindowHealth extends TmuxWindow {
  exists: boolean;
  panes: TmuxPaneStatus[];
  dead: boolean;
  reason: TmuxWindowDeadReason;
}

export interface CreateWindowOptions {
  cwd?: string;
  detached?: boolean;
  index?: number;
}

export interface ReviveWindowOptions {
  command?: string;
  cwd?: string;
  force?: boolean;
}

export interface ReviveWindowResult {
  action: "alive" | "created" | "recreated";
  before: TmuxWindowHealth;
  after: TmuxWindowHealth;
}

export interface TmuxGroup {
  name: string;
  sessions: string[];
  windows: number;
}

export function getTmuxSessionName(project: Pick<Project, "name" | "path" | "slug">): string {
  const raw = project.slug || project.name;
  if (project.path?.includes("opensourcedev")) {
    const normalized = raw.replace(/^proj-/, "");
    return normalized.startsWith("open-") ? normalized : `open-${normalized}`;
  }
  return raw;
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
    run(`tmux new-session -d -s ${shellEscape(name)}`);
  } catch {
    // Group already exists
  }
}

export function destroyGroup(name: string): void {
  try {
    run(`tmux kill-session -t ${shellEscape(name)}`);
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
  const target = session ? `-t ${shellEscape(session)}` : "-a";
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

export function getWindowHealth(session: string, window: string): TmuxWindowHealth {
  let windows: TmuxWindow[] = [];
  try {
    windows = listWindows(session);
  } catch {
    return missingWindowHealth(session, window);
  }

  const target = windows.find((w) => w.name === window || String(w.index) === window);
  if (!target) return missingWindowHealth(session, window);

  let panes: TmuxPaneStatus[] = [];
  try {
    panes = listPanes(target.session, target.index);
  } catch {
    return missingWindowHealth(session, window);
  }
  return windowHealthFromPanes(target, panes);
}

export function listWindowHealth(session: string): TmuxWindowHealth[] {
  const windows = listWindows(session);
  const panes = groupPanesByWindow(listPanesForTarget(session), true);
  return windows.map((window) => windowHealthFromPanes(window, panes.get(windowKey(window.session, window.index)) || panes.get(windowIndexKey(window.index)) || []));
}

export function findDeadWindows(session?: string): TmuxWindowHealth[] {
  const windows = listWindows(session);
  const panes = groupPanesByWindow(listPanesForTarget(session), Boolean(session));
  return windows
    .map((window) => windowHealthFromPanes(window, panes.get(windowKey(window.session, window.index)) || (session ? panes.get(windowIndexKey(window.index)) : undefined) || []))
    .filter((window) => window.dead);
}

export function createSession(name: string, projectPath?: string, windowName?: string): void {
  const win = windowName || name;

  // Create standalone session with the desired window name directly (avoids duplicate default window)
  try {
    run(`tmux new-session -d -s ${shellEscape(name)} -n ${shellEscape(win)}`);
  } catch {
    // Session already exists
    return;
  }

  if (projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t ${shellEscape(winId)} "cd ${shellEscape(projectPath)}" Enter`);
  }
}

export function createWindow(session: string, name: string, command?: string, options: CreateWindowOptions = {}): void {
  const target = typeof options.index === "number" ? `${session}:${options.index}` : session;
  const detached = options.detached === true ? " -d" : "";
  const cwd = options.cwd ? ` -c ${shellEscape(options.cwd)}` : "";
  const initialCommand = command ? ` ${shellEscape(wrapInteractiveCommand(command))}` : "";
  run(`tmux new-window${detached} -t ${shellEscape(target)} -n ${shellEscape(name)}${cwd}${initialCommand}`);
}

export function killSession(name: string): void {
  run(`tmux kill-session -t ${shellEscape(name)}`);
}

export function killWindow(session: string, name: string): void {
  run(`tmux kill-window -t ${shellEscape(`${session}:${name}`)}`);
}

export function reviveWindow(session: string, window: string, options: ReviveWindowOptions = {}): ReviveWindowResult {
  const before = getWindowHealth(session, window);
  const focusBefore = captureLinkedSessionFocus(session);
  const windowName = before.exists ? before.name : window;
  const targetIndex = before.exists && before.index >= 0 ? before.index : parseWindowIndex(window);
  const cwd = options.cwd || firstPanePath(before);
  let action: ReviveWindowResult["action"] = "alive";

  if (!before.exists) {
    createWindow(session, windowName, options.command, {
      cwd,
      detached: true,
      index: targetIndex,
    });
    action = "created";
  } else if (before.dead || options.force === true) {
    const windows = listWindows(session);
    if (windows.length <= 1) {
      const tmpName = `projects-revive-${Date.now()}`;
      createWindow(session, tmpName, undefined, { cwd, detached: true });
      killWindow(session, before.name);
      createWindow(session, windowName, options.command, {
        cwd,
        detached: true,
        index: targetIndex,
      });
      killWindow(session, tmpName);
    } else {
      selectFallbackWindow(session, before.index);
      killWindow(session, before.name);
      createWindow(session, windowName, options.command, {
        cwd,
        detached: true,
        index: targetIndex,
      });
    }
    action = "recreated";
  } else {
    focusWindow(session, before.name);
  }

  const after = getWindowHealth(session, windowName);
  if (action !== "alive" && after.exists && !after.dead) {
    restoreLinkedSessionFocus(focusBefore);
  }

  return {
    action,
    before,
    after,
  };
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
    run(`tmux new-session -d -s ${shellEscape(name)} -n ${shellEscape(win)}`);
  } catch {
    return;
  }

  if (projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t ${shellEscape(winId)} "cd ${shellEscape(projectPath)}" Enter`);
  }
  if (config.launch_takumi !== false && projectPath) {
    const winId = findWindowId(name, win);
    run(`tmux send-keys -t ${shellEscape(winId)} "takumi" Enter`);
  }
}

export function reviveSession(name: string): boolean {
  const sessions = listSessions();
  const session = sessions.find((s) => s.name === name);
  if (!session) return false;

  const windows = listWindows(name);
  for (const w of windows) {
    try {
      const output = run(`tmux capture-pane -t ${shellEscape(`${name}:${w.index}`)} -p`);
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

export function createTmuxWindow(project: Project, windowName?: string): boolean {
  const { name, path, slug } = project;
  const config = getConfig();

  const sessionName = getTmuxSessionName(project);
  const winName = windowName || slug || name; // allow explicit window name override (e.g. iapp-takumi-01)

  try {
    // Check if session already exists
    const sessions = listSessions();
    const existingSession = sessions.find((session) => session.name === sessionName);
    const sessionExists = Boolean(existingSession);

    if (existingSession?.group) {
      // Older versions linked project sessions into shared groups, causing attach
      // to show unrelated windows. Recreate those sessions as isolated projects.
      killSession(sessionName);
    }

    if (sessionExists && !existingSession?.group) {
      // Check if a window with this name already exists
      const windows = listWindows(sessionName);
      const existingWindow = windows.find((w) => w.name === winName);
      if (existingWindow) {
        // Window already exists — just select it
        run(`tmux select-window -t ${shellEscape(`${sessionName}:${existingWindow.name}`)}`);
        return true;
      }
      // Session exists but with different windows — don't create duplicates
      // Just select the existing session's first window
      if (windows.length > 0) {
        run(`tmux select-window -t ${shellEscape(`${sessionName}:${windows[0]!.name}`)}`);
        return true;
      }
      // Session exists but has no windows (edge case) — add one
      run(`tmux new-window -t ${shellEscape(sessionName)} -n ${shellEscape(winName)}`);
    } else {
      // Create standalone session with the desired window name directly.
      // Project isolation is intentional; linked groups share windows across sessions.
      run(`tmux new-session -d -s ${shellEscape(sessionName)} -n ${shellEscape(winName)}`);
    }

    if (config.launch_takumi !== false) {
      const winId = findWindowId(sessionName, winName);
      run(`tmux send-keys -t ${shellEscape(winId)} "cd ${shellEscape(path)} && takumi" Enter`);
    }
    return true;
  } catch {
    // Non-fatal — tmux may not be available
    return false;
  }
}

export function attachSession(name: string): void {
  run(`tmux attach-session -t ${shellEscape(name)}`);
}

export function focusWindow(session: string, window: string): void {
  run(`tmux select-window -t ${shellEscape(`${session}:${window}`)}`);
}

export function renameWindow(session: string, oldName: string, newName: string): void {
  run(`tmux rename-window -t ${shellEscape(`${session}:${oldName}`)} ${shellEscape(newName)}`);
}

export function renameSession(oldName: string, newName: string): void {
  run(`tmux rename-session -t ${shellEscape(oldName)} ${shellEscape(newName)}`);
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function missingWindowHealth(session: string, window: string): TmuxWindowHealth {
  return {
    session,
    index: -1,
    name: window,
    active: false,
    exists: false,
    panes: [],
    dead: true,
    reason: "missing",
  };
}

function listPanes(session: string, windowIndex: number): TmuxPaneStatus[] {
  return parsePaneOutput(run(
    `tmux list-panes -t ${shellEscape(`${session}:${windowIndex}`)} -F ${shellEscape(paneFormat())}`,
  ));
}

function listPanesForTarget(session?: string): TmuxPaneStatus[] {
  const target = session ? `-s -t ${shellEscape(session)}` : "-a";
  return parsePaneOutput(run(`tmux list-panes ${target} -F ${shellEscape(paneFormat())}`));
}

function paneFormat(): string {
  const delimiter = "\t";
  return [
    "#{session_name}",
    "#{window_index}",
    "#{window_name}",
    "#{pane_index}",
    "#{pane_current_command}",
    "#{pane_current_path}",
    "#{pane_dead}",
    "#{pane_dead_status}",
    "#{pane_active}",
  ].join(delimiter);
}

function parsePaneOutput(output: string): TmuxPaneStatus[] {
  const delimiter = "\t";
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneSession, paneWindowIndex, paneWindowName, paneIndex, command, currentPath, dead, deadStatus, active] = line.split(delimiter);
      const parsedDeadStatus = deadStatus ? parseInt(deadStatus, 10) : null;
      return {
        session: paneSession || "",
        windowIndex: parseInt(paneWindowIndex || "0", 10),
        windowName: paneWindowName || "",
        paneIndex: parseInt(paneIndex || "0", 10),
        command: command || "",
        currentPath: currentPath || "",
        dead: dead === "1",
        deadStatus: Number.isNaN(parsedDeadStatus) ? null : parsedDeadStatus,
        active: active === "1",
      };
    });
}

function groupPanesByWindow(panes: TmuxPaneStatus[], includeIndexFallback = false): Map<string, TmuxPaneStatus[]> {
  const grouped = new Map<string, TmuxPaneStatus[]>();
  for (const pane of panes) {
    addGroupedPane(grouped, windowKey(pane.session, pane.windowIndex), pane);
    if (includeIndexFallback) addGroupedPane(grouped, windowIndexKey(pane.windowIndex), pane);
  }
  return grouped;
}

function windowHealthFromPanes(window: TmuxWindow, panes: TmuxPaneStatus[]): TmuxWindowHealth {
  if (panes.length === 0) {
    return { ...window, exists: true, panes, dead: true, reason: "no-panes" };
  }

  const allPanesDead = panes.every((pane) => pane.dead);
  return {
    ...window,
    exists: true,
    panes,
    dead: allPanesDead,
    reason: allPanesDead ? "all-panes-dead" : "alive",
  };
}

function windowKey(session: string, windowIndex: number): string {
  return `${session}:${windowIndex}`;
}

function windowIndexKey(windowIndex: number): string {
  return `index:${windowIndex}`;
}

function addGroupedPane(grouped: Map<string, TmuxPaneStatus[]>, key: string, pane: TmuxPaneStatus): void {
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key)!.push(pane);
}

function parseWindowIndex(window: string): number | undefined {
  if (!/^\d+$/.test(window)) return undefined;
  return parseInt(window, 10);
}

function firstPanePath(health: TmuxWindowHealth): string | undefined {
  return health.panes.find((pane) => pane.currentPath)?.currentPath;
}

function selectFallbackWindow(session: string, excludedIndex: number): void {
  const fallback = listWindows(session).find((window) => window.index !== excludedIndex);
  if (fallback) {
    run(`tmux select-window -t ${shellEscape(`${session}:${fallback.index}`)}`);
  }
}

interface SessionFocus {
  session: string;
  windowName: string;
  windowIndex: number;
}

function captureLinkedSessionFocus(session: string): SessionFocus[] {
  const sessions = relatedTmuxSessions(session);
  const focus: SessionFocus[] = [];
  for (const related of sessions) {
    try {
      const active = listWindows(related.name).find((window) => window.active);
      if (active) {
        focus.push({
          session: related.name,
          windowName: active.name,
          windowIndex: active.index,
        });
      }
    } catch {
      // Session may disappear during external tmux changes.
    }
  }
  return focus;
}

function restoreLinkedSessionFocus(focus: SessionFocus[]): void {
  for (const entry of focus) {
    try {
      focusWindow(entry.session, entry.windowName);
    } catch {
      try {
        focusWindow(entry.session, String(entry.windowIndex));
      } catch {
        // Non-fatal: the window was revived even if one linked session focus cannot be restored.
      }
    }
  }
}

function relatedTmuxSessions(session: string): TmuxSession[] {
  try {
    const sessions = listSessions();
    const current = sessions.find((candidate) => candidate.name === session);
    if (!current) return [{ name: session, group: "", windows: 0, attached: false }];
    const group = current.group || current.name;
    return sessions.filter((candidate) => (candidate.group || candidate.name) === group);
  } catch {
    return [{ name: session, group: "", windows: 0, attached: false }];
  }
}

function sendKeys(target: string, command: string): void {
  run(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(command)} Enter`);
}

function wrapInteractiveCommand(command: string): string {
  const fallbackShell = process.env.SHELL || "/bin/bash";
  return `sh -lc ${shellEscape(`${command}; exec ${shellEscape(fallbackShell)} -l`)}`;
}

export function execInWindow(session: string, window: string, command: string): void {
  sendKeys(`${session}:${window}`, command);
}

export function cleanupDeadSessions(): string[] {
  const dead = findDeadSessions();
  for (const name of dead) {
    try { killSession(name); } catch { /* ignore */ }
  }
  return dead;
}
