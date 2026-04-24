#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function getPkgVersion(): string {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(p, "utf-8")) as { version: string }).version;
  } catch { return "0.0.0"; }
}

function printHelp(): void {
  console.log(`Usage: projects-mcp [options]

MCP server for project management tools (stdio transport)

Options:
  -V, --version  output the version number
  -h, --help     display help for command`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  console.log(getPkgVersion());
  process.exit(0);
}

import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  archiveProject,
  unarchiveProject,
  resolveProject,
  listSyncLogs,
  setIntegrations,
} from "../db/projects.js";
import { syncProject } from "../lib/sync.js";
import { importProject, importBulk } from "../lib/import.js";
import { publishProject, unpublishProject } from "../lib/github.js";
import { syncAll, getScheduleConfig, saveScheduleConfig, installCron, removeCron } from "../lib/scheduler.js";
import { registerCloudSyncTools } from "./tools/cloud.js";
import { addWorkdir, listWorkdirs, removeWorkdir } from "../db/workdirs.js";
import { touchLastOpened } from "../lib/status.js";
import { generateForWorkdir, generateAllWorkdirs } from "../lib/generate.js";
import { buildProjectContext, getProjectLocations } from "../lib/project-context.js";
import { cleanupStaleIssues, findStaleIssues } from "../lib/stale.js";
import { setupMachineReport } from "../lib/setup-machine.js";
import { listSessions, listWindows, createSession, killSession, restartSession, reviveSession, findDeadSessions, getWindowHealth, listWindowHealth, findDeadWindows, reviveWindow, execInWindow } from "../lib/tmux.js";

const server = new McpServer({
  name: "projects",
  version: getPkgVersion(),
});

// ── projects_create ───────────────────────────────────────────────────────────
server.tool(
  "projects_create",
  "Register a new project. Returns the project with its workingDirectory so AI agents can cd into it.",
  {
    name: z.string().describe("Project name"),
    path: z.string().optional().describe("Absolute path to the project (defaults to cwd)"),
    description: z.string().optional().describe("Project description"),
    slug: z.string().optional().describe("Custom slug (auto-generated if omitted)"),
    tags: z.array(z.string()).optional().describe("Tags"),
    s3_bucket: z.string().optional().describe("S3 bucket for sync"),
    s3_prefix: z.string().optional().describe("S3 key prefix"),
    git_remote: z.string().optional().describe("Git remote URL"),
    git_init: z.boolean().optional().describe("Auto-init a git repo in the project path (default: true)"),
  },
  async (input) => {
    try {
      const path = input.path ? resolve(input.path) : process.cwd();
      const project = createProject({ ...input, path });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...project,
              workingDirectory: project.path,
              instruction: `Project "${project.name}" created at ${project.path}. workingDirectory: ${project.path}`,
              post_create_actions: [
                {
                  description: "Register with open-todos for task tracking",
                  tool: "mcp__todos__create_project",
                  args: { name: project.name, path: project.path, description: project.description },
                  on_complete: `Call projects_link with todos_project_id=<returned id>`,
                },
                {
                  description: "Register with open-mementos for persistent memory",
                  tool: "mcp__mementos__register_project",
                  args: { name: project.name, path: project.path },
                  on_complete: `Call projects_link with mementos_project_id=<returned id>`,
                },
                {
                  description: "Create a conversations space for team coordination (optional)",
                  tool: "mcp__conversations__create_space",
                  args: { name: project.slug, description: project.description },
                  on_complete: `Call projects_link with conversations_space=<returned space name>`,
                },
              ],
            }, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── projects_list ─────────────────────────────────────────────────────────────
server.tool(
  "projects_list",
  "List all registered projects",
  {
    status: z.enum(["active", "archived"]).optional().describe("Filter by status"),
    tags: z.array(z.string()).optional().describe("Filter by tags (AND — all tags must match)"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async (input) => {
    const projects = listProjects({ status: input.status, tags: input.tags, limit: input.limit ?? 50 });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(projects, null, 2) }],
    };
  },
);

// ── projects_get ──────────────────────────────────────────────────────────────
server.tool(
  "projects_get",
  "Get a project by ID or slug",
  {
    id: z.string().describe("Project ID or slug"),
  },
  async (input) => {
    const project = resolveProject(input.id);
    if (!project) {
      return {
        content: [{ type: "text" as const, text: `Project not found: ${input.id}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...project, workingDirectory: project.path }, null, 2),
        },
      ],
    };
  },
);

// ── projects_update ───────────────────────────────────────────────────────────
server.tool(
  "projects_update",
  "Update project metadata",
  {
    id: z.string().describe("Project ID or slug"),
    name: z.string().optional(),
    description: z.string().optional(),
    path: z.string().optional(),
    tags: z.array(z.string()).optional(),
    s3_bucket: z.string().nullable().optional(),
    s3_prefix: z.string().nullable().optional(),
    git_remote: z.string().nullable().optional(),
  },
  async (input) => {
    try {
      const project = resolveProject(input.id);
      if (!project) {
        return {
          content: [{ type: "text" as const, text: `Project not found: ${input.id}` }],
          isError: true,
        };
      }
      const { id: _id, ...rest } = input;
      const updated = updateProject(project.id, rest);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── projects_archive ──────────────────────────────────────────────────────────
server.tool(
  "projects_archive",
  "Archive a project (soft delete)",
  {
    id: z.string().describe("Project ID or slug"),
  },
  async (input) => {
    try {
      const project = resolveProject(input.id);
      if (!project) {
        return {
          content: [{ type: "text" as const, text: `Project not found: ${input.id}` }],
          isError: true,
        };
      }
      const archived = archiveProject(project.id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(archived, null, 2) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── projects_open ─────────────────────────────────────────────────────────────
server.tool(
  "projects_open",
  "Get the local path of a project so an AI agent can work in the correct directory",
  {
    id: z.string().describe("Project ID or slug"),
  },
  async (input) => {
    const project = resolveProject(input.id);
    if (!project) {
      return {
        content: [{ type: "text" as const, text: `Project not found: ${input.id}` }],
        isError: true,
      };
    }
    touchLastOpened(project.id);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            id: project.id,
            name: project.name,
            path: project.path,
            workingDirectory: project.path,
            instruction: `To work on project "${project.name}", change your working directory to: ${project.path}`,
          }, null, 2),
        },
      ],
    };
  },
);

// ── projects_sync_log ─────────────────────────────────────────────────────────
server.tool(
  "projects_sync_log",
  "List recent sync history for a project",
  {
    id: z.string().describe("Project ID or slug"),
    limit: z.number().optional().describe("Max entries (default 10)"),
  },
  async (input) => {
    const project = resolveProject(input.id);
    if (!project) {
      return {
        content: [{ type: "text" as const, text: `Project not found: ${input.id}` }],
        isError: true,
      };
    }
    const logs = listSyncLogs(project.id, input.limit ?? 10);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(logs, null, 2) }],
    };
  },
);

// ── projects_workdir_add ──────────────────────────────────────────────────────
server.tool(
  "projects_workdir_add",
  "Add a working directory to a project. Optionally generate CLAUDE.md and AGENTS.md to instruct AI agents to write code there.",
  {
    id: z.string().describe("Project ID or slug"),
    path: z.string().describe("Absolute path to the working directory"),
    label: z.string().optional().describe("Label (e.g. frontend, backend, docs). Default: main"),
    is_primary: z.boolean().optional().describe("Set as primary working directory"),
    generate: z.boolean().optional().describe("Generate CLAUDE.md + AGENTS.md immediately"),
  },
  async (input) => {
    try {
      const project = resolveProject(input.id);
      if (!project) return { content: [{ type: "text" as const, text: `Project not found: ${input.id}` }], isError: true };
      const workdir = addWorkdir({ project_id: project.id, path: input.path, label: input.label, is_primary: input.is_primary });
      const allDirs = listWorkdirs(project.id);
      let generated = null;
      if (input.generate) {
        generated = generateForWorkdir(project, workdir, allDirs);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ workdir, generated: generated ? { path: generated.path, written: generated.written } : null }, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_workdir_list",
  "List all working directories for a project",
  { id: z.string() },
  async (input) => {
    const project = resolveProject(input.id);
    if (!project) return { content: [{ type: "text" as const, text: `Project not found: ${input.id}` }], isError: true };
    const workdirs = listWorkdirs(project.id);
    return { content: [{ type: "text" as const, text: JSON.stringify(workdirs, null, 2) }] };
  },
);

server.tool(
  "projects_workdir_generate",
  "Generate CLAUDE.md and AGENTS.md in project working directories. This tells AI agents which directory to write code in.",
  {
    id: z.string().describe("Project ID or slug"),
    path: z.string().optional().describe("Only generate for this specific workdir path. Omit to generate for all."),
    dry_run: z.boolean().optional(),
    force: z.boolean().optional().describe("Overwrite existing CLAUDE.md even if not generated by open-projects"),
  },
  async (input) => {
    try {
      const project = resolveProject(input.id);
      if (!project) return { content: [{ type: "text" as const, text: `Project not found: ${input.id}` }], isError: true };
      const allDirs = listWorkdirs(project.id);
      const opts = { dryRun: input.dry_run, force: input.force };
      if (input.path) {
        const workdir = allDirs.find((w) => w.path === input.path);
        if (!workdir) return { content: [{ type: "text" as const, text: `Workdir not found: ${input.path}` }], isError: true };
        const result = generateForWorkdir(project, workdir, allDirs, opts);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      const results = generateAllWorkdirs(project, opts);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── projects_sync_all ─────────────────────────────────────────────────────────
server.tool(
  "projects_sync_all",
  "Sync all active projects that have S3 configured",
  {
    direction: z.enum(["push", "pull", "both"]).optional(),
  },
  async (input) => {
    const logs: string[] = [];
    const result = await syncAll(input.direction, (msg) => logs.push(msg));
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, log: logs }, null, 2) }] };
  },
);

server.tool(
  "projects_schedule_set",
  "Enable scheduled auto-sync via system cron",
  {
    interval: z.enum(["hourly", "daily", "weekly"]).optional(),
    direction: z.enum(["push", "pull", "both"]).optional(),
  },
  async (input) => {
    const config = { enabled: true, interval: input.interval ?? "daily", direction: input.direction ?? "both" };
    saveScheduleConfig(config);
    try {
      installCron(config);
      return { content: [{ type: "text" as const, text: `Scheduled: ${config.interval} sync (${config.direction})` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Config saved but crontab install failed: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

server.tool(
  "projects_schedule_status",
  "Get current auto-sync schedule configuration",
  {},
  async () => {
    const config = getScheduleConfig();
    return { content: [{ type: "text" as const, text: JSON.stringify(config, null, 2) }] };
  },
);

// ── projects_publish ──────────────────────────────────────────────────────────
server.tool(
  "projects_publish",
  "Publish a project to GitHub. Creates the repo, adds remote, and pushes.",
  {
    id: z.string().describe("Project ID or slug"),
    org: z.string().optional().describe("GitHub org (default: hasnaxyz)"),
    private: z.boolean().optional().describe("Make repo private (default: true)"),
  },
  async (input) => {
    try {
      const project = resolveProject(input.id);
      if (!project) return { content: [{ type: "text" as const, text: `Project not found: ${input.id}` }], isError: true };
      const result = publishProject(project.name, project.path, {
        org: input.org,
        private: input.private !== false,
        description: project.description ?? undefined,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── projects_import ───────────────────────────────────────────────────────────
server.tool(
  "projects_import",
  "Import an existing directory as a project. Infers name from package.json or directory name.",
  {
    path: z.string().describe("Absolute path to import"),
    tags: z.array(z.string()).optional().describe("Tags to apply"),
    dry_run: z.boolean().optional().describe("Preview without importing"),
  },
  async (input) => {
    const logs: string[] = [];
    const { project, skipped, error } = await importProject(input.path, {
      dryRun: input.dry_run,
      defaultTags: input.tags,
      onProgress: (msg) => logs.push(msg),
    });
    if (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }], isError: true };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ project: project ?? null, skipped: skipped ?? null, log: logs }, null, 2) }],
    };
  },
);

server.tool(
  "projects_import_bulk",
  "Import all subdirectories of a path as projects. Useful for migrating existing project collections.",
  {
    dir: z.string().describe("Directory whose subdirectories will be imported"),
    tags: z.array(z.string()).optional().describe("Tags to apply to all imported projects"),
    dry_run: z.boolean().optional().describe("Preview without importing"),
  },
  async (input) => {
    const logs: string[] = [];
    const result = await importBulk(input.dir, {
      dryRun: input.dry_run,
      defaultTags: input.tags,
      onProgress: (msg) => logs.push(msg),
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ...result, log: logs }, null, 2) }],
    };
  },
);

// ── projects_sync ─────────────────────────────────────────────────────────────
server.tool(
  "projects_sync",
  "Sync a project's files to/from S3. Incremental via file hashes. Skips files >100MB.",
  {
    id: z.string().describe("Project ID or slug"),
    direction: z.enum(["push", "pull", "both"]).optional().describe("Sync direction (default: both)"),
    dry_run: z.boolean().optional().describe("Show what would sync without doing it"),
    region: z.string().optional().describe("AWS region (default: AWS_DEFAULT_REGION or us-east-1)"),
  },
  async (input) => {
    try {
      const project = resolveProject(input.id);
      if (!project) {
        return {
          content: [{ type: "text" as const, text: `Project not found: ${input.id}` }],
          isError: true,
        };
      }
      const logs: string[] = [];
      const result = await syncProject(project, {
        direction: input.direction,
        dryRun: input.dry_run,
        region: input.region,
        onProgress: (msg) => logs.push(msg),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...result, log: logs }, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── projects_link ─────────────────────────────────────────────────────────────
server.tool(
  "projects_link",
  "Store external service integration IDs for a project (todos, mementos, conversations, files). Call this after registering the project with each external service.",
  {
    id: z.string().describe("Project ID or slug"),
    todos_project_id: z.string().optional().describe("open-todos project ID"),
    mementos_project_id: z.string().optional().describe("open-mementos project ID"),
    conversations_space: z.string().optional().describe("open-conversations space name"),
    files_index_id: z.string().optional().describe("open-files index ID"),
  },
  async (input) => {
    try {
      const project = resolveProject(input.id);
      if (!project) {
        return {
          content: [{ type: "text" as const, text: `Project not found: ${input.id}` }],
          isError: true,
        };
      }
      const { id: _id, ...integrations } = input;
      // Remove undefined values
      const clean = Object.fromEntries(
        Object.entries(integrations).filter(([, v]) => v !== undefined),
      );
      const updated = setIntegrations(project.id, clean);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(updated.integrations, null, 2) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Cloud sync tools ──────────────────────────────────────────────────────────
registerCloudSyncTools(server);

// ── tmux management ───────────────────────────────────────────────────────────
server.tool(
  "projects_tmux_list",
  "List all tmux sessions",
  {},
  async () => {
    try {
      const sessions = listSessions();
      return { content: [{ type: "text" as const, text: JSON.stringify(sessions, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_tmux_windows",
  "List tmux windows in a session or all sessions",
  { session: z.string().optional().describe("Session name (all if omitted)") },
  async (input) => {
    try {
      const windows = listWindows(input.session);
      return { content: [{ type: "text" as const, text: JSON.stringify(windows, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_tmux_create",
  "Create a new tmux session for a project. Optionally create a window with an initial command.",
  {
    name: z.string().describe("Session name"),
    path: z.string().optional().describe("Project path to cd into"),
    window: z.string().optional().describe("Window name"),
    command: z.string().optional().describe("Command to run in the window"),
  },
  async (input) => {
    try {
      createSession(input.name, input.path, input.window);
      if (input.command) {
        const win = input.window || input.name;
        execInWindow(input.name, win, input.command);
      }
      return { content: [{ type: "text" as const, text: `✓ Created session: ${input.name}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_tmux_kill",
  "Kill a tmux session",
  { name: z.string().describe("Session name") },
  async (input) => {
    try {
      killSession(input.name);
      return { content: [{ type: "text" as const, text: `✓ Killed session: ${input.name}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Session not found: ${input.name}` }], isError: true };
    }
  },
);

server.tool(
  "projects_tmux_restart",
  "Kill and recreate a tmux session",
  { name: z.string().describe("Session name"), window: z.string().optional().describe("Window name") },
  async (input) => {
    try {
      restartSession(input.name, undefined, input.window);
      return { content: [{ type: "text" as const, text: `✓ Restarted session: ${input.name}` }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_tmux_revive",
  "Check tmux session health. Revive a session if alive, or find dead sessions.",
  { name: z.string().optional().describe("Session name (find dead sessions if omitted)") },
  async (input) => {
    try {
      if (input.name) {
        const alive = reviveSession(input.name);
        return { content: [{ type: "text" as const, text: JSON.stringify({ name: input.name, alive }, null, 2) }] };
      }
      const dead = findDeadSessions();
      return { content: [{ type: "text" as const, text: JSON.stringify({ dead, all_healthy: dead.length === 0 }, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_tmux_window_status",
  "Check whether one tmux window or all windows in a session are alive, dead, or missing",
  {
    session: z.string().describe("Session name"),
    window: z.string().optional().describe("Window name or index. Omit to inspect all windows in the session."),
  },
  async (input) => {
    try {
      const result = input.window ? getWindowHealth(input.session, input.window) : listWindowHealth(input.session);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_tmux_dead_windows",
  "List tmux windows whose panes have exited",
  { session: z.string().optional().describe("Session name. Omit to scan all sessions.") },
  async (input) => {
    try {
      const dead = findDeadWindows(input.session);
      return { content: [{ type: "text" as const, text: JSON.stringify(dead, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_tmux_revive_window",
  "Safely recreate a missing/dead tmux window. Alive windows are left alone unless force=true.",
  {
    session: z.string().describe("Session name"),
    window: z.string().describe("Window name or index"),
    command: z.string().optional().describe("Initial command to send after recreating"),
    cwd: z.string().optional().describe("Working directory for the recreated window"),
    force: z.boolean().optional().describe("Recreate even if the window is alive"),
  },
  async (input) => {
    try {
      const result = reviveWindow(input.session, input.window, { command: input.command, cwd: input.cwd, force: input.force });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  "projects_context",
  "Return a complete agent handoff context for a project: path, git, tmux, workdirs, sync, integrations, and next commands.",
  { id: z.string().describe("Project ID or slug") },
  async (input) => {
    const project = resolveProject(input.id);
    if (!project) return { content: [{ type: "text" as const, text: `Project not found: ${input.id}` }], isError: true };
    return { content: [{ type: "text" as const, text: JSON.stringify(buildProjectContext(project), null, 2) }] };
  },
);

server.tool(
  "projects_where",
  "Show where a project lives across machines and which paths exist on the current machine.",
  { id: z.string().describe("Project ID or slug") },
  async (input) => {
    const project = resolveProject(input.id);
    if (!project) return { content: [{ type: "text" as const, text: `Project not found: ${input.id}` }], isError: true };
    return { content: [{ type: "text" as const, text: JSON.stringify({ project, locations: getProjectLocations(project) }, null, 2) }] };
  },
);

server.tool(
  "projects_setup_machine",
  "Preflight this machine for open-projects usage.",
  {
    fix: z.boolean().optional().describe("Create safe missing directories"),
    dry_run: z.boolean().optional().describe("Preview fixes without writing"),
  },
  async (input) => {
    const report = setupMachineReport({ fix: input.fix, dryRun: input.fix ? input.dry_run !== false : true });
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

server.tool(
  "projects_stale",
  "Find stale project records, missing local workdirs, orphan tmux sessions, and dead tmux windows.",
  { id: z.string().optional().describe("Project ID or slug. Omit to scan all projects.") },
  async (input) => {
    const project = input.id ? resolveProject(input.id) : null;
    if (input.id && !project) return { content: [{ type: "text" as const, text: `Project not found: ${input.id}` }], isError: true };
    return { content: [{ type: "text" as const, text: JSON.stringify(findStaleIssues(project ?? undefined), null, 2) }] };
  },
);

server.tool(
  "projects_cleanup",
  "Preview or apply safe stale-record cleanup.",
  { apply: z.boolean().optional().describe("Apply safe cleanup actions. Defaults to dry-run.") },
  async (input) => {
    return { content: [{ type: "text" as const, text: JSON.stringify(cleanupStaleIssues({ apply: input.apply }), null, 2) }] };
  },
);

// ── Start server ──────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
