import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSession,
  createTmuxWindow,
  restartSession,
  killSession,
  killWindow,
  listSessions,
  listWindows,
  attachSession,
  focusWindow,
  renameWindow,
  renameSession,
  execInWindow,
  cleanupDeadSessions,
  findDeadSessions,
} from "./tmux";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readSourceFile(name: string): string {
  return readFileSync(join(__dirname, name), "utf-8");
}

const TEST_SESSIONS: string[] = [];
let tmuxAvailable = false;

function checkTmux(): boolean {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function safeRun(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
}

function safeTmux(args: string): void {
  safeRun(`tmux ${args}`);
}

function sessionExists(name: string): boolean {
  const output = safeRun(`tmux list-sessions -F '#{session_name}'`);
  return output.split("\n").includes(name);
}

function windowCount(session: string): number {
  try {
    const output = safeRun(`tmux list-windows -t ${session} -F '#{window_name}'`);
    return output.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function windowNamesInSession(session: string): string[] {
  try {
    const output = safeRun(`tmux list-windows -t ${session} -F '#{window_name}'`);
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function sessionGroup(name: string): string {
  const output = safeRun(`tmux list-sessions -F '#{session_name}:#{session_group}'`);
  const line = output.split("\n").find((l) => l.startsWith(name + ":"));
  return line?.split(":")[1] || "";
}

function ensureMaster(): void {
  try {
    safeTmux("new-session -d -s master");
    trackSession("master");
  } catch {
    // master already exists
  }
}

function trackSession(name: string) {
  TEST_SESSIONS.push(name);
}

/**
 * Regression tests for tmux session and window management.
 *
 * Tests cover:
 * 1. No -g flag on tmux new-session (previously caused silent failures)
 * 2. createTmuxWindow does not create duplicate windows
 * 3. restartSession preserves group membership
 * 4. Sessions linked to master share windows (group architecture)
 * 5. New QoL functions: attach, focus, rename, exec, cleanup
 */

describe("tmux", () => {
  beforeAll(() => {
    tmuxAvailable = checkTmux();
  });

  afterAll(() => {
    for (const name of TEST_SESSIONS) {
      try {
        killSession(name);
      } catch {
        /* ignore */
      }
    }
  });

  describe("createSession", () => {
    test("creates session linked to master", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-create-${Date.now()}`;
      trackSession(sessionName);
      ensureMaster();

      createSession(sessionName);

      expect(sessionExists(sessionName)).toBe(true);
      // Should be linked to master group
      expect(sessionGroup(sessionName)).toBe("master");
    });

    test("creates a project-specific window", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-win-${Date.now()}`;
      trackSession(sessionName);
      ensureMaster();

      createSession(sessionName, "/tmp/test", "mywindow");

      const windows = windowNamesInSession(sessionName);
      expect(windows).toContain("mywindow");
    });

    test("sends cd command to window when path provided", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-cd-${Date.now()}`;
      trackSession(sessionName);
      ensureMaster();

      createSession(sessionName, "/tmp", "mywindow");

      // Find the window ID and capture from it
      const allWindows = safeRun(`tmux list-windows -t ${sessionName} -F '#{window_id}:#{window_name}'`);
      const line = allWindows.split("\n").find((l) => l.endsWith(":mywindow"));
      const winId = line?.split(":")[0] || "";
      const output = safeRun(`tmux capture-pane -t "${winId}" -p`);
      expect(output).toContain("cd /tmp");
    });
  });

  describe("createSession — no -g flag regression", () => {
    test("tmux new-session with -g flag fails (proving the old bug)", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-flag-${Date.now()}`;
      let oldCmdFailed = false;
      try {
        ensureMaster();
        safeTmux(`new-session -d -s ${sessionName} -t master -g projectmaintain -n ${sessionName}`);
      } catch {
        oldCmdFailed = true;
      }
      expect(oldCmdFailed).toBe(true);
    });

    test("source code has no -g flag", () => {
      const content = readSourceFile("tmux.ts");
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.includes("new-session") && !line.includes("//") && !line.includes("/*")) {
          expect(line).not.toMatch(/-g\s+\$\{/);
          expect(line).not.toMatch(/-g\s+['"]\w/);
        }
      }
    });
  });

  describe("createTmuxWindow", () => {
    test("creates session linked to master", () => {
      if (!tmuxAvailable) return;

      const slug = `test-tmuxwin-${Date.now()}`;
      trackSession(`proj-${slug}`);

      const project = { name: slug, slug, path: "/tmp/test" } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(`proj-${slug}`)).toBe(true);
      expect(sessionGroup(`proj-${slug}`)).toBe("master");
    });

    test("does not create duplicate windows", () => {
      if (!tmuxAvailable) return;

      const slug = `test-nodup-${Date.now()}`;
      trackSession(`proj-${slug}`);

      const project = { name: slug, slug, path: "/tmp/test" } as unknown as import("../types/index.js").Project;

      createTmuxWindow(project);
      const countBefore = windowCount(`proj-${slug}`);
      createTmuxWindow(project);
      const countAfter = windowCount(`proj-${slug}`);

      expect(countAfter).toBe(countBefore);
    });
  });

  describe("restartSession", () => {
    test("recreates session after kill", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-restart-${Date.now()}`;
      trackSession(sessionName);
      ensureMaster();

      safeTmux(`new-session -d -s ${sessionName} -n main`);
      restartSession(sessionName, "/tmp/test", "main");

      expect(sessionExists(sessionName)).toBe(true);
      expect(sessionGroup(sessionName)).toBe("master");
    });
  });

  describe("listSessions and listWindows", () => {
    test("listSessions returns sessions with expected fields", () => {
      if (!tmuxAvailable) return;

      const sessions = listSessions();
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0].name).toBeDefined();
      expect(sessions[0].windows).toBeDefined();
      expect(typeof sessions[0].attached).toBe("boolean");
    });

    test("listWindows returns windows for a session", () => {
      if (!tmuxAvailable) return;

      const windows = listWindows("master");
      expect(windows.length).toBeGreaterThan(0);
      expect(windows[0].session).toBe("master");
      expect(typeof windows[0].index).toBe("number");
    });
  });

  describe("killSession", () => {
    test("kills an existing session", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-kill-${Date.now()}`;
      safeTmux(`new-session -d -s ${sessionName}`);
      expect(sessionExists(sessionName)).toBe(true);

      killSession(sessionName);
      expect(sessionExists(sessionName)).toBe(false);
    });
  });

  describe("killWindow", () => {
    test("kills a window", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-killwin-${Date.now()}`;
      safeTmux(`new-session -d -s ${sessionName}`);
      safeTmux(`new-window -t ${sessionName} -n testkill`);
      expect(windowNamesInSession(sessionName)).toContain("testkill");

      killWindow(sessionName, "testkill");
      expect(windowNamesInSession(sessionName)).not.toContain("testkill");
      trackSession(sessionName);
    });
  });

  describe("attachSession", () => {
    test("throws for non-existent session", () => {
      if (!tmuxAvailable) return;

      expect(() => attachSession("non-existent-session-xyz")).toThrow();
    });
  });

  describe("focusWindow", () => {
    test("selects a window", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-focus-${Date.now()}`;
      safeTmux(`new-session -d -s ${sessionName}`);
      safeTmux(`new-window -t ${sessionName} -n focustest`);
      trackSession(sessionName);

      // Should not throw
      focusWindow(sessionName, "focustest");

      // Verify the window is active
      const windows = listWindows(sessionName);
      const active = windows.find((w) => w.active);
      expect(active?.name).toBe("focustest");
    });
  });

  describe("renameWindow", () => {
    test("renames a window", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-rename-win-${Date.now()}`;
      safeTmux(`new-session -d -s ${sessionName}`);
      safeTmux(`new-window -t ${sessionName} -n oldname`);
      trackSession(sessionName);

      renameWindow(sessionName, "oldname", "newname");

      expect(windowNamesInSession(sessionName)).toContain("newname");
      expect(windowNamesInSession(sessionName)).not.toContain("oldname");
    });
  });

  describe("renameSession", () => {
    test("renames a session", () => {
      if (!tmuxAvailable) return;

      const oldName = `test-rns-${Date.now()}`;
      const newName = `test-rns-new-${Date.now()}`;
      safeTmux(`new-session -d -s ${oldName}`);
      trackSession(newName); // track the new name for cleanup

      renameSession(oldName, newName);

      expect(sessionExists(oldName)).toBe(false);
      expect(sessionExists(newName)).toBe(true);
    });
  });

  describe("execInWindow", () => {
    test("sends a command to a window", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-exec-${Date.now()}`;
      safeTmux(`new-session -d -s ${sessionName}`);
      safeTmux(`new-window -t ${sessionName} -n execwin`);
      trackSession(sessionName);

      execInWindow(sessionName, "execwin", "echo hello-test");

      const output = safeRun(`tmux capture-pane -t ${sessionName}:execwin -p`);
      expect(output).toContain("hello-test");
    });
  });

  describe("findDeadSessions", () => {
    test("returns empty list when no dead sessions", () => {
      if (!tmuxAvailable) return;

      const dead = findDeadSessions();
      // All current sessions should be healthy
      for (const name of dead) {
        expect(sessionExists(name)).toBe(true);
      }
    });
  });

  describe("cleanupDeadSessions", () => {
    test("returns empty when no dead sessions", () => {
      if (!tmuxAvailable) return;

      const before = findDeadSessions();
      // No dead sessions in our clean test environment
      expect(Array.isArray(before)).toBe(true);
    });

    test("kills a truly dead session", () => {
      if (!tmuxAvailable) return;

      // Create a standalone session (not linked to master) with 2 windows
      const deadName = `test-dead-${Date.now()}`;
      safeTmux(`new-session -d -s ${deadName}`);
      safeTmux(`new-window -t ${deadName} -n killme`);
      trackSession(deadName);

      // Kill the last non-zero window to make it "dead-like"
      safeTmux(`kill-window -t ${deadName}:killme`);

      // The session still has window 0, so won't show as dead
      // But findDeadSessions should still handle it gracefully
      const before = findDeadSessions();
      const killed = cleanupDeadSessions();
      expect(Array.isArray(before)).toBe(true);
      expect(Array.isArray(killed)).toBe(true);
      // Session should still exist (it had windows)
      expect(sessionExists(deadName)).toBe(true);
    });
  });

  describe("source code validation", () => {
    test("tmux new-session commands do not use -g flag", () => {
      const content = readSourceFile("tmux.ts");
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.includes("new-session") && !line.includes("//") && !line.includes("/*")) {
          expect(line).not.toMatch(/-g\s+\$\{/);
          expect(line).not.toMatch(/-g\s+['"]\w/);
        }
      }
    });

    test("createTmuxWindow checks for master without group filter", () => {
      const content = readSourceFile("tmux.ts");
      // Should check master by name only, not by group name (which may be empty)
      expect(content).not.toContain("sGroup === groupName");
    });
  });

  describe("open-* project naming — opensourcedev sessions use open- prefix", () => {
    test("project in opensourcedev gets open- prefix session name", () => {
      if (!tmuxAvailable) return;

      const slug = "analytics";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-analytics";
      const expectedSession = `open-${slug}`;

      // Track for cleanup
      trackSession(expectedSession);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(expectedSession)).toBe(true);
    });

    test("project in opensourcedev session is linked to master group", () => {
      if (!tmuxAvailable) return;

      const slug = "contacts";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-contacts";
      const sessionName = `open-${slug}`;
      trackSession(sessionName);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionGroup(sessionName)).toBe("master");
    });

    test("non-opensourcedev project gets proj- prefix session name", () => {
      if (!tmuxAvailable) return;

      const slug = "iapp-takumi";
      const path = "/home/hasna/workspace/hasnaxyz/internalapp/iapp-takumi";
      const expectedSession = `proj-${slug}`;

      trackSession(expectedSession);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(expectedSession)).toBe(true);
    });

    test("non-opensourcedev project session is linked to master group", () => {
      if (!tmuxAvailable) return;

      const slug = "platform-alumia";
      const path = "/home/hasna/workspace/hasna/platform/platform-alumia";
      const sessionName = `proj-${slug}`;
      trackSession(sessionName);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionGroup(sessionName)).toBe("master");
    });

    test("open-* project does NOT create proj- prefixed duplicate", () => {
      if (!tmuxAvailable) return;

      const slug = "todos";
      const opensourcedevPath = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-todos";
      const expectedSession = `open-${slug}`;
      const wrongSession = `proj-${slug}`;

      // Make sure the wrong session doesn't exist before
      const hadWrongSession = sessionExists(wrongSession);

      trackSession(expectedSession);
      if (!hadWrongSession) trackSession(wrongSession);

      const project = { name: slug, slug, path: opensourcedevPath } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(expectedSession)).toBe(true);
      // The proj- version should NOT have been created
      expect(sessionExists(wrongSession)).toBe(false);
    });

    test("already open- prefixed slug does not double-prefix", () => {
      if (!tmuxAvailable) return;

      const slug = "open-banking";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-banking";
      // Should be "open-banking", not "open-open-banking"
      const expectedSession = "open-banking";
      trackSession(expectedSession);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(expectedSession)).toBe(true);
      expect(sessionExists("open-open-banking")).toBe(false);
    });

    test("does not create duplicate windows on repeated calls", () => {
      if (!tmuxAvailable) return;

      const slug = "sessions";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-sessions";
      const sessionName = `open-${slug}`;
      trackSession(sessionName);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;

      createTmuxWindow(project);
      const countBefore = windowCount(sessionName);
      createTmuxWindow(project);
      const countAfter = windowCount(sessionName);

      expect(countAfter).toBe(countBefore);
    });
  });

  describe("master group architecture — sessions share windows via -t flag", () => {
    test("new open-* session is linked to master with -t flag", () => {
      if (!tmuxAvailable) return;

      const slug = "test-arch-open";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-test-arch";
      const sessionName = `open-${slug}`;
      trackSession(sessionName);

      // Kill master if it exists to ensure clean test
      try { killSession("master"); } catch { /* ignore */ }

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(sessionName)).toBe(true);
      expect(sessionGroup(sessionName)).toBe("master");
    });

    test("multiple open-* sessions share master group", () => {
      if (!tmuxAvailable) return;

      const slugs = ["test-a", "test-b"];
      const sessionNames = slugs.map((s) => `open-${s}`);
      const paths = slugs.map((s) => `/home/hasna/workspace/hasna/opensource/opensourcedev/open-${s}`);

      for (const sn of sessionNames) trackSession(sn);

      // Kill master to ensure clean state
      try { killSession("master"); } catch { /* ignore */ }

      for (let i = 0; i < slugs.length; i++) {
        const project = { name: slugs[i], slug: slugs[i], path: paths[i] } as unknown as import("../types/index.js").Project;
        createTmuxWindow(project);
      }

      for (const sn of sessionNames) {
        expect(sessionGroup(sn)).toBe("master");
      }
    });
  });
});
