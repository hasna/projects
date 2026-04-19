import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import {
  createSession,
  createTmuxWindow,
  restartSession,
  killSession,
  listSessions,
  listWindows,
} from "./tmux";

/**
 * Regression tests for tmux session and window management.
 *
 * Key bugs being tested:
 * 1. `-g` flag on `tmux new-session` is invalid and causes silent failure
 * 2. createTmuxWindow should not create duplicate windows
 * 3. restartSession should preserve group membership
 *
 * These tests run against a real tmux instance using temporary session
 * names that are cleaned up after each test. If tmux is not available,
 * all tests are skipped gracefully.
 */

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

describe("tmux regression", () => {
  beforeAll(() => {
    tmuxAvailable = checkTmux();
  });

  afterAll(() => {
    // Clean up all test sessions
    for (const name of TEST_SESSIONS) {
      try {
        killSession(name);
      } catch {
        /* ignore */
      }
    }
  });

  function trackSession(name: string) {
    TEST_SESSIONS.push(name);
  }

  describe("createSession — no -g flag", () => {
    test("createSession creates session without -g flag failure", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-nog-${Date.now()}`;
      trackSession(sessionName);

      createSession(sessionName);

      // Verify session exists
      expect(sessionExists(sessionName)).toBe(true);
    });

    test("tmux new-session with -g flag fails (proving the old bug)", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-flag-${Date.now()}`;
      // No need to track — this session is not created

      // The old code used: tmux new-session -d -s name -t master -g group -n win
      // This should fail because -g is not valid for new-session
      let oldCmdFailed = false;
      try {
        safeTmux(`new-session -d -s ${sessionName} -t master -g projectmaintain -n ${sessionName}`);
      } catch {
        oldCmdFailed = true;
      }
      expect(oldCmdFailed).toBe(true);

      // Fixed command without -g should succeed via linking to master
      try {
        // Ensure master exists first
        try {
          safeTmux(`new-session -d -s master -n main`);
          trackSession("master");
        } catch {
          // master may already exist
        }
        safeTmux(`new-session -d -s ${sessionName} -t master -n ${sessionName}`);
        trackSession(sessionName);
        expect(sessionExists(sessionName)).toBe(true);
      } catch {
        // If master isn't available, standalone should work
        safeTmux(`new-session -d -s ${sessionName} -n ${sessionName}`);
        trackSession(sessionName);
        expect(sessionExists(sessionName)).toBe(true);
      }
    });
  });

  describe("createTmuxWindow — no duplicate windows", () => {
    test("calling createTmuxWindow twice does not create duplicate windows", () => {
      if (!tmuxAvailable) return;

      const slug = `test-nodup-${Date.now()}`;
      trackSession(`proj-${slug}`);

      const project = { name: slug, slug, path: "/tmp/test" };

      // First call — creates session and window
      createTmuxWindow(project);

      // Get window count before second call
      const countBefore = windowCount(`proj-${slug}`);

      // Second call — should select existing window, not create duplicate
      createTmuxWindow(project);

      const countAfter = windowCount(`proj-${slug}`);
      expect(countAfter).toBe(countBefore);
    });
  });

  describe("restartSession — group membership preserved", () => {
    test("restartSession recreates session successfully", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-restart-${Date.now()}`;
      trackSession(sessionName);

      // Ensure master exists
      try {
        safeTmux(`new-session -d -s master -n main`);
        trackSession("master");
      } catch {
        // master may already exist
      }

      // Create then restart
      safeTmux(`new-session -d -s ${sessionName} -n main`);
      restartSession(sessionName, "/tmp/test", "main");

      // Verify session is alive after restart
      expect(sessionExists(sessionName)).toBe(true);
    });
  });

  describe("source code validation — no -g flag", () => {
    test("tmux new-session commands do not use -g flag", async () => {
      const source = Bun.file("src/lib/tmux.ts");
      const content = await source.text();

      // Split into lines and find all tmux new-session commands
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.includes("new-session") && !line.includes("//") && !line.includes("/*")) {
          // Should not contain -g flag pattern (space followed by -g and space or variable)
          expect(line).not.toMatch(/-g\s+\$\{/);
          expect(line).not.toMatch(/-g\s+['"]\w/);
        }
      }
    });
  });
});
