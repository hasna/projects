#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
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

const server = new McpServer({
  name: "open-projects",
  version: "0.1.0",
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
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async (input) => {
    const projects = listProjects({ status: input.status, limit: input.limit ?? 50 });
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

// ── Start server ──────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
