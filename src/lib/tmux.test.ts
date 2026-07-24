import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createGroup, createSession, createWindow, restartSession, withTmuxCommandRunnerForTest } from "./tmux.js";

function installFakeTmux(dir: string): string {
  const logPath = join(dir, "tmux-argv.jsonl");
  const fakeTmux = join(dir, "tmux");
  writeFileSync(fakeTmux, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`, "utf-8");
  chmodSync(fakeTmux, 0o755);
  return logPath;
}

function readTmuxCalls(logPath: string): string[][] {
  return readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function withFakeTmux(run: (dir: string, logPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "projects-tmux-test-"));
  const logPath = installFakeTmux(dir);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${originalPath || ""}`;
  try {
    run(dir, logPath);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("tmux shell safety", () => {
  test("createSession passes projectPath as a tmux argument without outer-shell evaluation", () => {
    withFakeTmux((dir, logPath) => {
      const sentinel = join(dir, "create-session-pwned");
      const projectPath = join(dir, `$(touch ${sentinel})`);

      createSession("shell-safe-session", projectPath, "main");

      expect(existsSync(sentinel)).toBe(false);
      expect(readTmuxCalls(logPath)).toEqual([
        ["new-session", "-d", "-s", "shell-safe-session", "-n", "main", "-c", projectPath],
      ]);
    });
  });

  test("restartSession passes projectPath as a tmux argument without outer-shell evaluation", () => {
    withFakeTmux((dir, logPath) => {
      const sentinel = join(dir, "restart-session-pwned");
      const projectPath = join(dir, `$(touch ${sentinel})`);

      restartSession("shell-safe-restart", projectPath, "main");

      expect(existsSync(sentinel)).toBe(false);
      expect(readTmuxCalls(logPath)).toEqual([
        ["kill-session", "-t", "shell-safe-restart"],
        ["new-session", "-d", "-s", "shell-safe-restart", "-n", "main", "-c", projectPath],
      ]);
    });
  });

  test("createWindow passes cwd as a tmux argument without outer-shell evaluation", () => {
    withFakeTmux((dir, logPath) => {
      const sentinel = join(dir, "create-window-pwned");
      const cwd = join(dir, `$(touch ${sentinel})`);

      createWindow("shell-safe-session", "editor", undefined, { cwd, detached: true, index: 3 });

      expect(existsSync(sentinel)).toBe(false);
      expect(readTmuxCalls(logPath)).toEqual([
        ["new-window", "-d", "-t", "shell-safe-session:3", "-n", "editor", "-c", cwd],
      ]);
    });
  });

  test("createSession escapes tmux format command substitution in projectPath", () => {
    withFakeTmux((dir, logPath) => {
      const sentinel = join(dir, "create-session-format-pwned");
      const projectPath = join(dir, `#(touch ${sentinel})`);

      createSession("format-safe-session", projectPath, "main");

      expect(existsSync(sentinel)).toBe(false);
      expect(readTmuxCalls(logPath)).toEqual([
        ["new-session", "-d", "-s", "format-safe-session", "-n", "main", "-c", projectPath.replace(/#/g, "##")],
      ]);
    });
  });

  test("restartSession escapes tmux format command substitution in projectPath", () => {
    withFakeTmux((dir, logPath) => {
      const sentinel = join(dir, "restart-session-format-pwned");
      const projectPath = join(dir, `#(touch ${sentinel})`);

      restartSession("format-safe-restart", projectPath, "main");

      expect(existsSync(sentinel)).toBe(false);
      expect(readTmuxCalls(logPath)).toEqual([
        ["kill-session", "-t", "format-safe-restart"],
        ["new-session", "-d", "-s", "format-safe-restart", "-n", "main", "-c", projectPath.replace(/#/g, "##")],
      ]);
    });
  });

  test("createWindow escapes tmux format command substitution in cwd", () => {
    withFakeTmux((dir, logPath) => {
      const sentinel = join(dir, "create-window-format-pwned");
      const cwd = join(dir, `#(touch ${sentinel})`);

      createWindow("format-safe-session", "editor", undefined, { cwd, detached: true, index: 3 });

      expect(existsSync(sentinel)).toBe(false);
      expect(readTmuxCalls(logPath)).toEqual([
        ["new-window", "-d", "-t", "format-safe-session:3", "-n", "editor", "-c", cwd.replace(/#/g, "##")],
      ]);
    });
  });
});

describe("tmux project working directory", () => {
  test("createGroup anchors the group session in the project directory", () => {
    const commands: string[][] = [];
    withTmuxCommandRunnerForTest((args) => {
      commands.push(args);
      return "";
    }, () => createGroup("opensource", { cwd: "/home/hasna/workspace/hasna/opensource", windowName: "opensource" }));

    expect(commands).toEqual([
      ["new-session", "-d", "-s", "opensource", "-n", "opensource", "-c", "/home/hasna/workspace/hasna/opensource"],
    ]);
  });

  test("createGroup joins an existing tmux group with the project directory and without -n", () => {
    const commands: string[][] = [];
    withTmuxCommandRunnerForTest((args) => {
      commands.push(args);
      return "";
    }, () => createGroup("open-todos", {
      group: "opensource",
      cwd: "/home/hasna/workspace/hasna/opensource/open-todos",
      windowName: "open-todos",
    }));

    // tmux rejects "-n" together with "-t" ("command or window name given with target").
    expect(commands).toEqual([
      ["new-session", "-d", "-s", "open-todos", "-t", "opensource", "-c", "/home/hasna/workspace/hasna/opensource/open-todos"],
    ]);
  });

  test("createWindow without an explicit cwd falls back to the session start directory", () => {
    const projectPath = "/home/hasna/workspace/hasna/opensource/open-todos";
    const commands: string[][] = [];
    withTmuxCommandRunnerForTest((args) => {
      commands.push(args);
      if (args[0] === "display-message") return projectPath;
      return "";
    }, () => createWindow("opensource", "open-todos", undefined, { detached: true }));

    expect(commands).toEqual([
      ["display-message", "-p", "-t", "opensource", "#{session_path}"],
      ["new-window", "-d", "-t", "opensource", "-n", "open-todos", "-c", projectPath],
    ]);
  });

  test("createWindow keeps working when the session start directory cannot be resolved", () => {
    const commands: string[][] = [];
    withTmuxCommandRunnerForTest((args) => {
      commands.push(args);
      if (args[0] === "display-message") throw new Error("no server running on /tmp/tmux-1000/default");
      return "";
    }, () => createWindow("opensource", "open-todos", undefined, { detached: true }));

    expect(commands).toEqual([
      ["display-message", "-p", "-t", "opensource", "#{session_path}"],
      ["new-window", "-d", "-t", "opensource", "-n", "open-todos"],
    ]);
  });

  test("createWindow escapes a session start directory containing tmux format syntax", () => {
    const commands: string[][] = [];
    withTmuxCommandRunnerForTest((args) => {
      commands.push(args);
      if (args[0] === "display-message") return "/tmp/proj#(touch /tmp/pwned)";
      return "";
    }, () => createWindow("opensource", "open-todos", undefined, { detached: true }));

    expect(commands[1]).toEqual([
      "new-window", "-d", "-t", "opensource", "-n", "open-todos", "-c", "/tmp/proj##(touch /tmp/pwned)",
    ]);
  });
});
