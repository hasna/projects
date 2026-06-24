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

function parseFlag(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function createTmuxMock(initial: Record<string, string[]> = {}) {
  const sessions = new Map<string, string[]>(
    Object.entries(initial).map(([name, windows]) => [name, [...windows]]),
  );
  const commands: string[][] = [];
  const runner = (args: string[]): string => {
    commands.push(args);
    if (args[0] === "list-sessions") {
      return Array.from(sessions.entries())
        .map(([name, windows]) => `${name}::${windows.length}:0`)
        .join("\n");
    }
    if (args[0] === "new-session") {
      const session = parseFlag(args, "-s");
      const window = parseFlag(args, "-n");
      if (session && !sessions.has(session)) sessions.set(session, [window || session]);
      return "";
    }
    if (args[0] === "list-windows") {
      const session = parseFlag(args, "-t");
      return (session ? sessions.get(session) ?? [] : [])
        .map((name, index) => `${session}:${index}:${name}:${index === 0 ? 1 : 0}`)
        .join("\n");
    }
    if (args[0] === "new-window") {
      const target = parseFlag(args, "-t");
      const session = target?.split(":")[0] ?? "";
      const window = parseFlag(args, "-n");
      if (session && window) {
        const windows = sessions.get(session) ?? [];
        if (!windows.includes(window)) windows.push(window);
        sessions.set(session, windows);
      }
      return "";
    }
    if (args[0] === "kill-session") {
      const session = parseFlag(args, "-t");
      if (session) sessions.delete(session);
      return "";
    }
    if (args[0] === "send-keys") return "";
    throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
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
    expect(tmux.commands.some((args) => args[0] === "new-session" && parseFlag(args, "-n") === "01")).toBe(true);
    expect(tmux.commands.some((args) => args[0] === "new-window" && parseFlag(args, "-n") === "02")).toBe(true);
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
    expect(tmux.commands.some((args) => args[0] === "kill-window")).toBe(false);
    expect(tmux.commands.some((args) => args[0] === "rename-window")).toBe(false);
  });

  test("passes project paths through tmux cwd arguments without shell evaluation", () => {
    const tmux = createTmuxMock();
    const projectPath = "/tmp/project-$(touch /tmp/owned)";

    withTmuxCommandRunnerForTest(tmux.runner, () => createSession("escape-project", projectPath, "01"));
    withTmuxCommandRunnerForTest(tmux.runner, () => restartSession("escape-project", projectPath, "01"));

    const sessions = tmux.commands.filter((args) => args[0] === "new-session");
    expect(sessions.map((args) => parseFlag(args, "-c"))).toEqual([projectPath, projectPath]);
    expect(tmux.commands.some((args) => args[0] === "send-keys" && args.some((arg) => arg.includes("cd --")))).toBe(false);
  });

});
