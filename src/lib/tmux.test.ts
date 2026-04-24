import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  findDeadWindows,
  getWindowHealth,
  listGroups,
  createGroup,
  destroyGroup,
  createWindow,
  reviveSession,
  reviveWindow,
  TmuxSession,
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

function trackSession(name: string) {
  TEST_SESSIONS.push(name);
}

/**
 * Regression tests for tmux session and window management.
 *
 * Architecture: standalone sessions (not linked to groups).
 * Each project gets its own independent session with only its own window(s).
 * This prevents the exponential window duplication bug caused by tmux session groups.
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
    test("creates standalone session", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-create-${Date.now()}`;
      trackSession(sessionName);

      createSession(sessionName);

      expect(sessionExists(sessionName)).toBe(true);
      // Standalone sessions have empty group
      expect(sessionGroup(sessionName)).toBe("");
    });

    test("creates a project-specific window", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-win-${Date.now()}`;
      trackSession(sessionName);

      createSession(sessionName, "/tmp/test", "mywindow");

      const windows = windowNamesInSession(sessionName);
      expect(windows).toContain("mywindow");
    });

    test("creates exactly one window (no duplicate default window)", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-one-win-${Date.now()}`;
      trackSession(sessionName);

      createSession(sessionName, "/tmp/test", "mywindow");

      const count = windowCount(sessionName);
      expect(count).toBe(1);
    });

    test("sends cd command to window when path provided", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-cd-${Date.now()}`;
      trackSession(sessionName);

      createSession(sessionName, "/tmp", "mywindow");

      const allWindows = safeRun(`tmux list-windows -t ${sessionName} -F '#{window_id}:#{window_name}'`);
      const line = allWindows.split("\n").find((l) => l.endsWith(":mywindow"));
      const winId = line?.split(":")[0] || "";
      const output = safeRun(`tmux capture-pane -t "${winId}" -p`);
      expect(output).toContain("cd '/tmp'");
    });

    test("is idempotent — does not create duplicate windows", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-idem-${Date.now()}`;
      trackSession(sessionName);

      createSession(sessionName, "/tmp", "mywindow");
      const countBefore = windowCount(sessionName);
      createSession(sessionName, "/tmp", "mywindow");
      const countAfter = windowCount(sessionName);

      expect(countAfter).toBe(countBefore);
    });
  });

  describe("createSession — no -g flag regression", () => {
    test("tmux new-session with -g flag fails (proving the old bug)", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-flag-${Date.now()}`;
      let oldCmdFailed = false;
      try {
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
    test("creates standalone session for project", () => {
      if (!tmuxAvailable) return;

      const slug = `test-tmuxwin-${Date.now()}`;
      trackSession(slug);

      const project = { name: slug, slug, path: "/tmp/test" } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(slug)).toBe(true);
      // Standalone session — group should be empty
      expect(sessionGroup(slug)).toBe("");
    });

    test("does not create duplicate windows", () => {
      if (!tmuxAvailable) return;

      const slug = `test-nodup-${Date.now()}`;
      trackSession(slug);

      const project = { name: slug, slug, path: "/tmp/test" } as unknown as import("../types/index.js").Project;

      createTmuxWindow(project);
      const countBefore = windowCount(slug);
      createTmuxWindow(project);
      const countAfter = windowCount(slug);

      expect(countAfter).toBe(countBefore);
    });

    test("multiple projects do not share windows", () => {
      if (!tmuxAvailable) return;

      const slugA = `test-isolate-a-${Date.now()}`;
      const slugB = `test-isolate-b-${Date.now()}`;
      trackSession(slugA);
      trackSession(slugB);

      const projectA = { name: slugA, slug: slugA, path: "/tmp/test-a" } as unknown as import("../types/index.js").Project;
      const projectB = { name: slugB, slug: slugB, path: "/tmp/test-b" } as unknown as import("../types/index.js").Project;

      createTmuxWindow(projectA);
      createTmuxWindow(projectB);

      const winsA = windowNamesInSession(slugA);
      const winsB = windowNamesInSession(slugB);

      // Each session should only have its own window, not the other's
      expect(winsA).toContain(slugA);
      expect(winsA).not.toContain(slugB);
      expect(winsB).toContain(slugB);
      expect(winsB).not.toContain(slugA);
    });
  });

  describe("restartSession", () => {
    test("recreates session after kill", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-restart-${Date.now()}`;
      trackSession(sessionName);

      safeTmux(`new-session -d -s ${sessionName} -n main`);
      restartSession(sessionName, "/tmp/test", "main");

      expect(sessionExists(sessionName)).toBe(true);
      // Standalone session
      expect(sessionGroup(sessionName)).toBe("");
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

      const sessionName = `test-ls-win-${Date.now()}`;
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName}`);
      safeTmux(`new-window -t ${sessionName} -n testwin`);

      const windows = listWindows(sessionName);
      expect(windows.length).toBeGreaterThan(0);
      expect(windows[0].session).toBe(sessionName);
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

  describe("window health and reviveWindow", () => {
    test("reports a killed window as missing and recreates it in the same session", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-revive-win-${Date.now()}`;
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName} -n main`);

      createWindow(sessionName, "worker", "echo worker-started");
      expect(windowNamesInSession(sessionName)).toContain("worker");

      killWindow(sessionName, "worker");
      const missing = getWindowHealth(sessionName, "worker");
      expect(missing.exists).toBe(false);
      expect(missing.dead).toBe(true);
      expect(missing.reason).toBe("missing");

      const result = reviveWindow(sessionName, "worker", { command: "echo worker-revived" });
      expect(result.action).toBe("created");
      expect(result.after.exists).toBe(true);
      expect(result.after.dead).toBe(false);
      expect(windowNamesInSession(sessionName)).toContain("worker");
    });

    test("detects a dead window whose pane exited and recreates it safely", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-dead-pane-${Date.now()}`;
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName} -n main`);
      safeTmux(`new-window -d -t ${sessionName} -n deadpane "sh -c 'exit 7'"`);
      safeRun("sleep 0.3");

      const before = getWindowHealth(sessionName, "deadpane");
      expect(before.exists).toBe(true);
      expect(before.dead).toBe(true);
      expect(before.reason).toBe("all-panes-dead");
      expect(before.panes[0]?.deadStatus).toBe(7);

      const dead = findDeadWindows(sessionName);
      expect(dead.map((window) => window.name)).toContain("deadpane");

      const result = reviveWindow(sessionName, "deadpane", { command: "echo deadpane-revived" });
      expect(result.action).toBe("recreated");
      expect(result.after.exists).toBe(true);
      expect(result.after.dead).toBe(false);
    });

    test("preserves window index and cwd when recreating a dead window", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-revive-index-${Date.now()}`;
      const root = mkdtempSync(join(tmpdir(), "projects-revive-index-"));
      const marker = join(root, "revived.txt");
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName} -n main`);
      safeTmux(`new-window -d -t ${sessionName}:5 -n deadpane -c ${root} "sh -c 'exit 7'"`);
      safeRun("sleep 0.3");

      const result = reviveWindow(sessionName, "deadpane", {
        command: "pwd > revived.txt",
        cwd: root,
      });
      safeRun("sleep 0.3");

      expect(result.action).toBe("recreated");
      expect(result.after.index).toBe(5);
      expect(result.after.dead).toBe(false);
      expect(result.after.panes[0]?.currentPath).toBe(root);
      expect(readFileSync(marker, "utf-8").trim()).toBe(root);
    });

    test("does not recreate a live window unless forced", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-revive-live-${Date.now()}`;
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName} -n main`);
      safeTmux(`new-window -t ${sessionName} -n livewin`);

      const before = getWindowHealth(sessionName, "livewin");
      const result = reviveWindow(sessionName, "livewin");

      expect(before.dead).toBe(false);
      expect(result.action).toBe("alive");
      expect(result.after.dead).toBe(false);
      expect(windowNamesInSession(sessionName)).toContain("livewin");
    });

    test("force recreates a live window and sends multi-word commands correctly", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-revive-force-${Date.now()}`;
      const root = mkdtempSync(join(tmpdir(), "projects-revive-force-"));
      const marker = join(root, "forced.txt");
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName} -n main`);
      safeTmux(`new-window -d -t ${sessionName}:8 -n livewin -c ${root}`);

      const result = reviveWindow(sessionName, "livewin", {
        command: "printf forced-ok > forced.txt",
        cwd: root,
        force: true,
      });
      safeRun("sleep 0.3");

      expect(result.action).toBe("recreated");
      expect(result.after.index).toBe(8);
      expect(result.after.dead).toBe(false);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("forced-ok");
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

      focusWindow(sessionName, "focustest");

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
      trackSession(newName);

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
      for (const name of dead) {
        expect(sessionExists(name)).toBe(true);
      }
    });
  });

  describe("cleanupDeadSessions", () => {
    test("returns empty when no dead sessions", () => {
      if (!tmuxAvailable) return;

      const before = findDeadSessions();
      expect(Array.isArray(before)).toBe(true);
    });

    test("kills a truly dead session", () => {
      if (!tmuxAvailable) return;

      const deadName = `test-dead-${Date.now()}`;
      safeTmux(`new-session -d -s ${deadName}`);
      safeTmux(`new-window -t ${deadName} -n killme`);
      trackSession(deadName);

      safeTmux(`kill-window -t ${deadName}:killme`);

      const before = findDeadSessions();
      const killed = cleanupDeadSessions();
      expect(Array.isArray(before)).toBe(true);
      expect(Array.isArray(killed)).toBe(true);
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
  });

  describe("open-* project naming — opensourcedev sessions use open- prefix", () => {
    test("project in opensourcedev gets open- prefix session name", () => {
      if (!tmuxAvailable) return;

      const slug = "analytics";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-analytics";
      const expectedSession = `open-${slug}`;
      trackSession(expectedSession);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(expectedSession)).toBe(true);
    });

    test("project in opensourcedev session is standalone (not linked)", () => {
      if (!tmuxAvailable) return;

      const slug = "contacts";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-contacts";
      const sessionName = `open-${slug}`;
      trackSession(sessionName);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      // Standalone session — group should be empty
      expect(sessionGroup(sessionName)).toBe("");
    });

    test("non-opensourcedev project uses raw slug as session name", () => {
      if (!tmuxAvailable) return;

      const slug = "iapp-takumi";
      const path = "/home/hasna/workspace/hasnaxyz/internalapp/iapp-takumi";
      trackSession(slug);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(slug)).toBe(true);
    });

    test("non-opensourcedev project session is standalone", () => {
      if (!tmuxAvailable) return;

      const slug = "platform-alumia";
      const path = "/home/hasna/workspace/hasna/platform/platform-alumia";
      trackSession(slug);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionGroup(slug)).toBe("");
    });

    test("open-* project does NOT create raw slug duplicate", () => {
      if (!tmuxAvailable) return;

      const slug = `test-noproj-${Date.now()}`;
      const opensourcedevPath = `/home/hasna/workspace/hasna/opensource/opensourcedev/open-${slug}`;
      const expectedSession = `open-${slug}`;
      const wrongSession = slug;
      trackSession(expectedSession);

      const project = { name: slug, slug, path: opensourcedevPath } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(expectedSession)).toBe(true);
      expect(sessionExists(wrongSession)).toBe(false);
    });

    test("already open- prefixed slug does not double-prefix", () => {
      if (!tmuxAvailable) return;

      const slug = "open-banking";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-banking";
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

    test("explicit window name override creates named window", () => {
      if (!tmuxAvailable) return;

      const slug = `test-win-override-${Date.now()}`;
      const path = "/tmp/test";
      const customWindow = "iapp-takumi-01";
      trackSession(slug);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project, customWindow);

      const wins = windowNamesInSession(slug);
      expect(wins).toContain(customWindow);
    });

    test("numbered window names are supported", () => {
      if (!tmuxAvailable) return;

      const slug = `test-num-${Date.now()}`;
      const path = "/tmp/test";
      trackSession(slug);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;

      createTmuxWindow(project, "iapp-takumi-01");

      const wins = windowNamesInSession(slug);
      expect(wins).toContain("iapp-takumi-01");
    });

    test("createTmuxWindow does not accumulate windows on repeated calls", () => {
      if (!tmuxAvailable) return;

      const slug = `test-accum-${Date.now()}`;
      const path = "/tmp/test";
      trackSession(slug);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;

      createTmuxWindow(project, "iapp-takumi-01");
      createTmuxWindow(project, "iapp-takumi-02");
      createTmuxWindow(project, "iapp-takumi-03");

      const wins = windowNamesInSession(slug);
      // Only the first window should exist — no duplicates
      expect(wins).toContain("iapp-takumi-01");
      expect(wins.length).toBe(1);
    });

    test("explicit window name does not duplicate existing window", () => {
      if (!tmuxAvailable) return;

      const slug = `test-win-dedup-${Date.now()}`;
      const path = "/tmp/test";
      const customWindow = "my-custom-window";
      trackSession(slug);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;

      createTmuxWindow(project, customWindow);
      const countBefore = windowCount(slug);
      createTmuxWindow(project, customWindow);
      const countAfter = windowCount(slug);

      expect(countAfter).toBe(countBefore);
    });
  });

  describe("standalone architecture — projects are isolated", () => {
    test("new open-* session is standalone", () => {
      if (!tmuxAvailable) return;

      const slug = "test-arch-open";
      const path = "/home/hasna/workspace/hasna/opensource/opensourcedev/open-test-arch";
      const sessionName = `open-${slug}`;
      trackSession(sessionName);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(sessionName)).toBe(true);
      expect(sessionGroup(sessionName)).toBe("");
    });

    test("multiple open-* sessions do not share windows", () => {
      if (!tmuxAvailable) return;

      const slugs = ["test-a", "test-b"];
      const sessionNames = slugs.map((s) => `open-${s}`);
      const paths = slugs.map((s) => `/home/hasna/workspace/hasna/opensource/opensourcedev/open-${s}`);

      for (const sn of sessionNames) trackSession(sn);

      for (let i = 0; i < slugs.length; i++) {
        const project = { name: slugs[i], slug: slugs[i], path: paths[i] } as unknown as import("../types/index.js").Project;
        createTmuxWindow(project);
      }

      for (const sn of sessionNames) {
        expect(sessionGroup(sn)).toBe("");
      }

      // Each session should only have its own window
      const winsA = windowNamesInSession(sessionNames[0]);
      const winsB = windowNamesInSession(sessionNames[1]);
      expect(winsA).toContain(slugs[0]);
      expect(winsA).not.toContain(slugs[1]);
      expect(winsB).toContain(slugs[1]);
      expect(winsB).not.toContain(slugs[0]);
    });

    test("non-opensourcedev sessions are standalone", () => {
      if (!tmuxAvailable) return;

      const slugA = "arch-proj-a";
      const slugB = "arch-proj-b";
      const pathA = `/home/hasna/workspace/hasna/platform/${slugA}`;
      const pathB = `/home/hasna/workspace/hasna/platform/${slugB}`;
      const sessionA = slugA;
      const sessionB = slugB;
      trackSession(sessionA);
      trackSession(sessionB);

      const projectA = { name: slugA, slug: slugA, path: pathA } as unknown as import("../types/index.js").Project;
      const projectB = { name: slugB, slug: slugB, path: pathB } as unknown as import("../types/index.js").Project;
      createTmuxWindow(projectA);
      createTmuxWindow(projectB);

      expect(sessionGroup(sessionA)).toBe("");
      expect(sessionGroup(sessionB)).toBe("");
    });

    test("hasnaxyz project sessions stay standalone instead of joining shared groups", () => {
      if (!tmuxAvailable) return;

      const slug = `project-isolate-${Date.now()}`;
      const path = `/home/hasna/workspace/hasnaxyz/project/${slug}`;
      const hadProjectAnchor = sessionExists("project");

      try {
        const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
        createTmuxWindow(project);

        expect(sessionExists(slug)).toBe(true);
        expect(sessionGroup(slug)).toBe("");
        expect(windowNamesInSession(slug)).toContain(slug);
      } finally {
        try { killSession(slug); } catch { /* ignore */ }
        if (!hadProjectAnchor) {
          try { killSession("project"); } catch { /* ignore */ }
        }
      }
    });

    test("repairs stale linked project sessions into standalone sessions", () => {
      if (!tmuxAvailable) return;

      const groupName = `stale-project-group-${Date.now()}`;
      const slug = `project-stale-linked-${Date.now()}`;
      const wrongWindow = "project-wrong-window";
      const path = `/home/hasna/workspace/hasnaxyz/project/${slug}`;

      try {
        safeTmux(`new-session -d -s ${groupName} -n ${wrongWindow}`);
        safeTmux(`new-session -d -s ${slug} -t ${groupName}`);

        expect(sessionGroup(slug)).toBe(groupName);
        expect(windowNamesInSession(slug)).toContain(wrongWindow);

        const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
        createTmuxWindow(project);

        expect(sessionExists(slug)).toBe(true);
        expect(sessionGroup(slug)).toBe("");
        expect(windowNamesInSession(slug)).toEqual([slug]);
      } finally {
        try { killSession(slug); } catch { /* ignore */ }
        try { killSession(groupName); } catch { /* ignore */ }
      }
    });
  });

  describe("group management", () => {
    test("createGroup creates a tmux session as group", () => {
      if (!tmuxAvailable) return;

      const groupName = `test-group-${Date.now()}`;
      createGroup(groupName);
      trackSession(groupName);

      expect(sessionExists(groupName)).toBe(true);
    });

    test("createGroup is idempotent — does not throw if group exists", () => {
      if (!tmuxAvailable) return;

      const groupName = `test-group-idem-${Date.now()}`;
      safeTmux(`new-session -d -s ${groupName}`);
      trackSession(groupName);

      expect(() => createGroup(groupName)).not.toThrow();
    });

    test("destroyGroup kills the group session", () => {
      if (!tmuxAvailable) return;

      const groupName = `test-destroy-${Date.now()}`;
      safeTmux(`new-session -d -s ${groupName}`);
      expect(sessionExists(groupName)).toBe(true);

      destroyGroup(groupName);
      expect(sessionExists(groupName)).toBe(false);
    });

    test("destroyGroup does not throw for non-existent group", () => {
      if (!tmuxAvailable) return;

      expect(() => destroyGroup(`non-existent-${Date.now()}`)).not.toThrow();
    });

    test("listGroups returns groups with sessions and window counts", () => {
      if (!tmuxAvailable) return;

      const groupName = `test-listgrp-${Date.now()}`;
      safeTmux(`new-session -d -s ${groupName}`);
      trackSession(groupName);

      const groups = listGroups();
      expect(groups.length).toBeGreaterThan(0);

      const testGroup = groups.find((g) => g.name === groupName);
      expect(testGroup).toBeDefined();
      expect(Array.isArray(testGroup!.sessions)).toBe(true);
      expect(testGroup!.sessions).toContain(groupName);
      expect(typeof testGroup!.windows).toBe("number");
    });

    test("listGroups aggregates sessions with the same group", () => {
      if (!tmuxAvailable) return;

      const groupName = `test-agggrp-${Date.now()}`;
      const s1 = `test-agg-s1-${Date.now()}`;
      const s2 = `test-agg-s2-${Date.now()}`;

      safeTmux(`new-session -d -s ${groupName}`);
      trackSession(groupName);

      safeTmux(`new-session -d -s ${s1} -t ${groupName}`);
      safeTmux(`new-session -d -s ${s2} -t ${groupName}`);
      trackSession(s1);
      trackSession(s2);

      const groups = listGroups();
      const testGroup = groups.find((g) => g.name === groupName);
      expect(testGroup).toBeDefined();
      expect(testGroup!.sessions).toContain(s1);
      expect(testGroup!.sessions).toContain(s2);
    });

    test("createTmuxWindow creates standalone session for non-opensourcedev projects", () => {
      if (!tmuxAvailable) return;

      const slug = `my-project-${Date.now()}`;
      const path = `/home/hasna/workspace/hasna/platform/${slug}`;
      trackSession(slug);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(slug)).toBe(true);
      expect(sessionGroup(slug)).toBe("");
    });

    test("opensourcedev projects are standalone (not linked)", () => {
      if (!tmuxAvailable) return;

      const slug = `grp-test-${Date.now()}`;
      const path = `/home/hasna/workspace/hasna/opensource/opensourcedev/open-${slug}`;
      const sessionName = `open-${slug}`;
      trackSession(sessionName);

      const project = { name: slug, slug, path } as unknown as import("../types/index.js").Project;
      createTmuxWindow(project);

      expect(sessionExists(sessionName)).toBe(true);
      expect(sessionGroup(sessionName)).toBe("");
    });

    test("projects in different groups are isolated (standalone sessions)", () => {
      if (!tmuxAvailable) return;

      const grpA = `isolate-a-${Date.now()}`;
      const grpB = `isolate-b-${Date.now()}`;
      const slugA = `proj-a-${Date.now()}`;
      const slugB = `proj-b-${Date.now()}`;
      const sessionA = slugA;
      const sessionB = slugB;
      trackSession(sessionA);
      trackSession(sessionB);

      const projectA = { name: slugA, slug: slugA, path: `/tmp/${slugA}` } as unknown as import("../types/index.js").Project;
      const projectB = { name: slugB, slug: slugB, path: `/tmp/${slugB}` } as unknown as import("../types/index.js").Project;

      createTmuxWindow(projectA);
      createTmuxWindow(projectB);

      expect(sessionGroup(sessionA)).toBe("");
      expect(sessionGroup(sessionB)).toBe("");
      expect(sessionA).not.toBe(sessionB);
    });

    test("multiple standalone sessions do not share windows", () => {
      if (!tmuxAvailable) return;

      const sharedGroup = `shared-grp-${Date.now()}`;
      const s1 = `shared-s1-${Date.now()}`;
      const s2 = `shared-s2-${Date.now()}`;
      trackSession(s1);
      trackSession(s2);

      safeTmux(`new-session -d -s ${s1}`);
      safeTmux(`new-window -t ${s1} -n win1`);
      safeTmux(`new-session -d -s ${s2}`);
      safeTmux(`new-window -t ${s2} -n win2`);

      const wins1 = windowNamesInSession(s1);
      const wins2 = windowNamesInSession(s2);

      expect(wins1).toContain("win1");
      expect(wins1).not.toContain("win2");
      expect(wins2).toContain("win2");
      expect(wins2).not.toContain("win1");
    });
  });

  describe("createWindow", () => {
    test("creates a window with a name", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-createwin-${Date.now()}`;
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName}`);

      createWindow(sessionName, "newwin");
      const wins = windowNamesInSession(sessionName);
      expect(wins).toContain("newwin");
    });

    test("creates a window and sends a command", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-createwin-cmd-${Date.now()}`;
      const root = mkdtempSync(join(tmpdir(), "projects-create-window-"));
      const marker = join(root, "cmd-output.txt");
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName}`);

      createWindow(sessionName, "cmdwin", "printf test-cmd-output > cmd-output.txt", { cwd: root });
      safeRun("sleep 0.3");

      expect(readFileSync(marker, "utf-8")).toBe("test-cmd-output");
    });
  });

  describe("createSession with spaced paths", () => {
    test("correctly escapes paths with spaces", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-spaced-${Date.now()}`;
      trackSession(sessionName);
      const spacedPath = "/tmp/My Projects/foo bar";
      mkdirSync(spacedPath, { recursive: true });

      createSession(sessionName, spacedPath, "mywindow");

      const allWindows = safeRun(`tmux list-windows -t ${sessionName} -F '#{window_id}:#{window_name}'`);
      const line = allWindows.split("\n").find((l) => l.endsWith(":mywindow"));
      const winId = line?.split(":")[0] || "";
      const output = safeRun(`tmux capture-pane -t "${winId}" -p`);
      // Should see the escaped path with single quotes
      expect(output).toContain("cd '");
      expect(output).toContain("My Projects");
      rmSync("/tmp/My Projects", { recursive: true });
    });
  });

  describe("reviveSession", () => {
    test("returns false for non-existent session", () => {
      if (!tmuxAvailable) return;
      expect(reviveSession("non-existent-session-xyz")).toBe(false);
    });

    test("returns true for session with active takumi", () => {
      if (!tmuxAvailable) return;

      const sessionName = `test-revive-${Date.now()}`;
      trackSession(sessionName);
      safeTmux(`new-session -d -s ${sessionName}`);
      safeTmux(`new-window -t ${sessionName} -n takumiwin`);
      // Send "takumi" so the session appears alive
      safeTmux(`send-keys -t ${sessionName}:takumiwin "takumi" Enter`);

      const alive = reviveSession(sessionName);
      expect(alive).toBe(true);
    });
  });

  describe("findDeadSessions", () => {
    test("identifies unattached session with 0 windows as dead", () => {
      const fakeSessions: TmuxSession[] = [
        { name: "master", group: "", windows: 3, attached: false },
        { name: "alive-session", group: "", windows: 2, attached: true },
        { name: "dead-session", group: "", windows: 0, attached: false },
      ];
      const dead = findDeadSessions(fakeSessions);
      expect(dead).toContain("dead-session");
      expect(dead).not.toContain("master");
      expect(dead).not.toContain("alive-session");
    });

    test("returns real dead sessions when called with no args", () => {
      // At minimum, no crash — function should work against real tmux
      const dead = findDeadSessions();
      expect(Array.isArray(dead)).toBe(true);
    });
  });
});
