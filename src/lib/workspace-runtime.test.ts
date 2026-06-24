import { describe, expect, test } from "bun:test";
import { applyWorkspaceTmux } from "./workspace-runtime.js";
import { createSession, restartSession, withTmuxCommandRunnerForTest } from "./tmux.js";
import type { Workspace } from "../types/workspace.js";

function workspace(slug = "runtime-project"): Workspace {
  return {
    id: `w_${slug}`,
    slug,
    name: "Runtime Project",
    description: null,
    kind: "project",
    status: "active",
    root_id: null,
    recipe_id: null,
    primary_path: "/tmp/runtime-project",
    git_remote: null,
    s3_bucket: null,
    s3_prefix: null,
    tags: [],
    integrations: {},
    metadata: {},
    last_opened_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    synced_at: null,
  };
}

function unquote(value: string): string {
  return value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replace(/'\\''/g, "'")
    : value;
}

function parseFlag(cmd: string, flag: string): string | null {
  const match = cmd.match(new RegExp(`${flag} ('[^']*'|\\S+)`));
  return match ? unquote(match[1]!) : null;
}

function createTmuxMock(initial: Record<string, string[]> = {}) {
  const sessions = new Map<string, string[]>(
    Object.entries(initial).map(([name, windows]) => [name, [...windows]]),
  );
  const commands: string[] = [];
  const runner = (cmd: string): string => {
    commands.push(cmd);
    if (cmd.startsWith("tmux list-sessions")) {
      return Array.from(sessions.entries())
        .map(([name, windows]) => `${name}::${windows.length}:0`)
        .join("\n");
    }
    if (cmd.startsWith("tmux new-session")) {
      const session = parseFlag(cmd, "-s");
      const window = parseFlag(cmd, "-n");
      if (session && !sessions.has(session)) sessions.set(session, [window || session]);
      return "";
    }
    if (cmd.includes("list-windows") && cmd.includes("#{window_id}:#{window_name}")) {
      const session = parseFlag(cmd, "-t");
      return (session ? sessions.get(session) ?? [] : [])
        .map((name, index) => `%${index}:${name}`)
        .join("\n");
    }
    if (cmd.includes("list-windows")) {
      const session = parseFlag(cmd, "-t");
      return (session ? sessions.get(session) ?? [] : [])
        .map((name, index) => `${session}:${index}:${name}:${index === 0 ? 1 : 0}`)
        .join("\n");
    }
    if (cmd.startsWith("tmux new-window")) {
      const target = parseFlag(cmd, "-t");
      const session = target?.split(":")[0] ?? "";
      const window = parseFlag(cmd, "-n");
      if (session && window) {
        const windows = sessions.get(session) ?? [];
        if (!windows.includes(window)) windows.push(window);
        sessions.set(session, windows);
      }
      return "";
    }
    if (cmd.startsWith("tmux send-keys")) return "";
    throw new Error(`Unexpected tmux command: ${cmd}`);
  };
  return { sessions, commands, runner };
}

describe("workspace tmux runtime", () => {
  test("creates a missing session with 01 and 02 windows", () => {
    const tmux = createTmuxMock();
    const result = withTmuxCommandRunnerForTest(tmux.runner, () => applyWorkspaceTmux(workspace(), {
      windows: [
        { name: "01", command: "codewith", detached: true },
        { name: "02", detached: true },
      ],
      recordEvents: false,
    }));

    expect(result.session_action).toBe("created");
    expect(result.windows.map((window) => window.target)).toEqual([
      "runtime-project:01",
      "runtime-project:02",
    ]);
    expect(result.windows.map((window) => window.status)).toEqual(["completed", "completed"]);
    expect(tmux.sessions.get("runtime-project")).toEqual(["01", "02"]);
    expect(tmux.commands.some((cmd) => cmd.includes("new-session") && cmd.includes("-n '01'"))).toBe(true);
    expect(tmux.commands.some((cmd) => cmd.includes("new-window") && cmd.includes("-n '02'"))).toBe(true);
  });

  test("reuses existing sessions and preserves unrelated windows", () => {
    const tmux = createTmuxMock({ "runtime-project": ["01", "custom"] });
    const result = withTmuxCommandRunnerForTest(tmux.runner, () => applyWorkspaceTmux(workspace(), {
      windows: [
        { name: "01", command: "codewith", detached: true },
        { name: "02", detached: true },
      ],
      runExistingWindowCommands: false,
      recordEvents: false,
    }));

    expect(result.session_action).toBe("reused");
    expect(result.windows.map((window) => [window.target, window.status])).toEqual([
      ["runtime-project:01", "skipped"],
      ["runtime-project:02", "completed"],
    ]);
    expect(tmux.sessions.get("runtime-project")).toEqual(["01", "custom", "02"]);
    expect(tmux.commands.some((cmd) => cmd.includes("kill-window"))).toBe(false);
    expect(tmux.commands.some((cmd) => cmd.includes("rename-window"))).toBe(false);
  });

  test("escapes project paths in tmux send-keys without outer double quotes", () => {
    const tmux = createTmuxMock();
    const projectPath = "/tmp/project-$(touch /tmp/owned)";

    withTmuxCommandRunnerForTest(tmux.runner, () => createSession("escape-project", projectPath, "01"));
    withTmuxCommandRunnerForTest(tmux.runner, () => restartSession("escape-project", projectPath, "01"));

    const sendKeys = tmux.commands.filter((cmd) => cmd.startsWith("tmux send-keys"));
    expect(sendKeys).toHaveLength(2);
    for (const cmd of sendKeys) {
      expect(cmd).toContain("'cd -- ");
      expect(cmd).toContain("/tmp/project-$(touch /tmp/owned)");
      expect(cmd).toContain("'\\''");
      expect(cmd).not.toContain('"cd ');
    }
  });

});
