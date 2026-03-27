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
} from "../db/projects.js";

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
              instruction: `Project created. To work on this project, use workingDirectory: ${project.path}`,
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

// ── Start server ──────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
