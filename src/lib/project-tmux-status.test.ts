import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmuxProfile, createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import { projectTmuxStatus } from "./project-tmux-status.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("project tmux status", () => {
  test("reports expected session and windows for a saved profile", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-tmux-status-"));
    createWorkspace({
      name: "Status Project",
      slug: "status-project",
      kind: "project",
      primary_path: path,
    }, db);
    createTmuxProfile({
      name: "Dev",
      slug: "dev",
      session_template: "{slug}-dev",
      windows: [
        {
          window_name_template: "server",
          path_template: "{path}",
          command: "bun run dev",
        },
      ],
    }, db);

    const result = await projectTmuxStatus("status-project", {
      profile: "dev",
      agentTool: "claude",
      db,
    });

    expect(result.project.slug).toBe("status-project");
    expect(result.expected.session_name).toBe("status-project-dev");
    expect(result.expected.profile?.slug).toBe("dev");
    expect(result.expected.windows.map((window) => window.name)).toEqual(["claude", "server"]);
    expect(result.expected.windows.map((window) => window.command)).toEqual(["claude", "bun run dev"]);
    expect(typeof result.exists).toBe("boolean");
    expect(Array.isArray(result.windows)).toBe(true);

    rmSync(path, { recursive: true, force: true });
    db.close();
  });

  test("uses saved launch defaults for expected tmux status", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-tmux-status-defaults-"));
    createWorkspace({
      name: "Default Status",
      slug: "default-status",
      kind: "project",
      primary_path: path,
      metadata: {
        launch_profile: "dev",
        start_agent: "opencode",
        start_command: "opencode run",
        start_session_policy: "error-if-running",
        start_windows: [{ name: "logs", command: "tail -f app.log" }],
      },
    }, db);
    createTmuxProfile({
      name: "Dev",
      slug: "dev",
      session_template: "{slug}-dev",
      windows: [{ window_name_template: "server", command: "bun run dev" }],
    }, db);

    const result = await projectTmuxStatus("default-status", { db });

    expect(result.expected.session_name).toBe("default-status-dev");
    expect(result.expected.profile?.slug).toBe("dev");
    expect(result.launch_defaults.used_agent_tool).toBe(true);
    expect(result.launch_defaults.used_tool_command).toBe(true);
    expect(result.launch_defaults.used_tmux_profile).toBe(true);
    expect(result.launch_defaults.used_session_policy).toBe(true);
    expect(result.launch_defaults.session_policy).toBe("error-if-running");
    expect(result.launch_defaults.used_windows).toBe(true);
    expect(result.expected.windows.map((window) => window.name)).toEqual(["opencode", "server", "logs"]);
    expect(result.expected.windows.map((window) => window.command)).toEqual(["opencode run", "bun run dev", "tail -f app.log"]);

    rmSync(path, { recursive: true, force: true });
    db.close();
  });
});
