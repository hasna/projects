import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceLocation, createTmuxProfile, createWorkspace, getWorkspaceByPath } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import { parseProjectStartAgent, parseProjectStartSessionPolicy, projectStartCommand, startProject } from "./project-start.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("project start service", () => {
  test("resolves a registered project by slug and plans a codewith tmux window", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-start-registered-"));
    const project = createWorkspace({
      name: "Registered Project",
      slug: "registered-project",
      kind: "project",
      primary_path: path,
    }, db);

    const result = await startProject("registered-project", { dryRun: true, db });

    expect(result.project.id).toBe(project.id);
    expect(result.resolution.source).toBe("id-or-slug");
    expect(result.agent_tool).toBe("codewith");
    expect(result.tool_command).toBe("codewith");
    expect(result.tmux.session_name).toBe("registered-project");
    expect(result.tmux.windows[0]?.target).toBe("registered-project:codewith");
    expect(result.tmux.windows[0]?.status).toBe("planned");

    rmSync(path, { recursive: true, force: true });
    db.close();
  });

  test("plans importing an unregistered path before starting it", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-start-unregistered-"));

    const result = await startProject(path, {
      agentTool: "claude",
      dryRun: true,
      importTags: ["security"],
      importMetadata: { domain: "family-security" },
      db,
    });

    expect(result.resolution.source).toBe("planned-import");
    expect(result.resolution.registered).toBe(false);
    expect(result.project.primary_path).toBe(path);
    expect(result.project.tags).toEqual(["security"]);
    expect(result.project.metadata.domain).toBe("family-security");
    expect(result.resolution.preview?.metadata.domain).toBe("family-security");
    expect(result.agent_tool).toBe("claude");
    expect(result.tool_command).toBe("claude");
    expect(result.tmux.windows[0]?.target).toBe(`${result.project.slug}:claude`);
    expect(getWorkspaceByPath(path, db)).toBeNull();

    rmSync(path, { recursive: true, force: true });
    db.close();
  });

  test("resolves registered secondary project locations by path", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-start-location-primary-"));
    const secondary = mkdtempSync(join(tmpdir(), "project-start-location-secondary-"));
    const project = createWorkspace({
      name: "Location Project",
      slug: "location-project",
      kind: "project",
      primary_path: path,
    }, db);
    addWorkspaceLocation({ workspace_id: project.id, path: secondary, label: "secondary" }, db);

    const result = await startProject(secondary, { dryRun: true, db });

    expect(result.project.id).toBe(project.id);
    expect(result.resolution.source).toBe("path");
    expect(result.resolution.registered).toBe(true);
    expect(result.tmux.session_name).toBe("location-project");

    rmSync(path, { recursive: true, force: true });
    rmSync(secondary, { recursive: true, force: true });
    db.close();
  });

  test("resolves project marker files before importing an unknown folder", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-start-marker-primary-"));
    const marked = mkdtempSync(join(tmpdir(), "project-start-marker-alias-"));
    const project = createWorkspace({
      name: "Marker Project",
      slug: "marker-project",
      kind: "project",
      primary_path: path,
    }, db);
    writeFileSync(join(marked, ".project.json"), JSON.stringify({
      schema_version: 1,
      id: project.id,
      slug: project.slug,
      name: project.name,
    }), "utf-8");

    const result = await startProject(marked, { register: false, dryRun: true, db });

    expect(result.project.id).toBe(project.id);
    expect(result.resolution.source).toBe("marker");
    expect(result.resolution.registered).toBe(true);

    rmSync(path, { recursive: true, force: true });
    rmSync(marked, { recursive: true, force: true });
    db.close();
  });

  test("renders a saved tmux profile while preserving the selected start tool", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-start-profile-"));
    createWorkspace({
      name: "Profiled Project",
      slug: "profiled-project",
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
          detached: true,
        },
      ],
    }, db);

    const result = await startProject("profiled-project", {
      profile: "dev",
      agentTool: "claude",
      dryRun: true,
      db,
    });

    expect(result.tmux_profile?.slug).toBe("dev");
    expect(result.tmux.session_name).toBe("profiled-project-dev");
    expect(result.tmux.windows.map((window) => window.target)).toEqual([
      "profiled-project-dev:claude",
      "profiled-project-dev:server",
    ]);
    expect(result.tmux.windows[0]?.metadata?.command).toBe("claude");
    expect(result.tmux.windows[1]?.metadata?.command).toBe("bun run dev");

    rmSync(path, { recursive: true, force: true });
    db.close();
  });

  test("uses saved project launch defaults when start options are omitted", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-start-defaults-"));
    createWorkspace({
      name: "Defaulted Project",
      slug: "defaulted-project",
      kind: "project",
      primary_path: path,
      metadata: {
        launch_profile: "dev",
        start_agent: "claude",
        start_command: "claude --resume",
        start_session_policy: "new",
        start_windows: [{ name: "notes", command: "vim NOTES.md" }],
      },
    }, db);
    createTmuxProfile({
      name: "Dev",
      slug: "dev",
      session_template: "{slug}-dev",
      windows: [{ window_name_template: "server", command: "bun run dev" }],
    }, db);

    const result = await startProject("defaulted-project", { dryRun: true, db });

    expect(result.agent_tool).toBe("claude");
    expect(result.tool_command).toBe("claude --resume");
    expect(result.session_policy).toBe("new");
    expect(result.tmux_profile?.slug).toBe("dev");
    expect(result.launch_defaults.used_agent_tool).toBe(true);
    expect(result.launch_defaults.used_tool_command).toBe(true);
    expect(result.launch_defaults.used_tmux_profile).toBe(true);
    expect(result.launch_defaults.used_session_policy).toBe(true);
    expect(result.launch_defaults.session_policy).toBe("new");
    expect(result.launch_defaults.used_windows).toBe(true);
    expect(result.tmux.session_name).toBe("defaulted-project-dev");
    expect(result.tmux.windows.map((window) => window.target)).toEqual([
      "defaulted-project-dev:claude",
      "defaulted-project-dev:server",
      "defaulted-project-dev:notes",
    ]);
    expect(result.tmux.windows[0]?.metadata?.command).toBe("claude --resume");
    expect(result.tmux.windows[2]?.metadata?.command).toBe("vim NOTES.md");

    rmSync(path, { recursive: true, force: true });
    db.close();
  });

  test("maps supported start agents to their default commands", () => {
    expect(projectStartCommand("codewith")).toBe("codewith");
    expect(projectStartCommand("claude")).toBe("claude");
    expect(projectStartCommand("opencode")).toBe("opencode");
    expect(projectStartCommand("cursor")).toBe("cursor .");
    expect(projectStartCommand("none")).toBeUndefined();
    expect(projectStartCommand("codewith", "custom")).toBe("custom");
    expect(() => parseProjectStartAgent("bad")).toThrow("Invalid start agent");
    expect(parseProjectStartSessionPolicy(undefined)).toBe("reuse");
    expect(parseProjectStartSessionPolicy("new")).toBe("new");
    expect(parseProjectStartSessionPolicy("error-if-running")).toBe("error-if-running");
    expect(() => parseProjectStartSessionPolicy("bad")).toThrow("Invalid start session policy");
  });
});
