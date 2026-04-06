import { resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { createProject, updateProject, archiveProject, unarchiveProject } from "../../../db/projects.js";
import { setIntegrations } from "../../../db/projects.js";
import { listWorkdirs } from "../../../db/workdirs.js";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveProjectOrExit,
  exitProjectNotFound,
  printProject,
  wantsJsonOutput,
  type Command as Cmd,
} from "./shared.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerCreateCommand(cmd: Cmd) {
  cmd
    .command("create")
    .description("Register a new project")
    .requiredOption("--name <name>", "Project name")
    .option("--path <path>", "Project path (default: cwd)")
    .option("--slug <slug>", "Custom slug (auto-generated from name if omitted)")
    .option("--description <desc>", "Description")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--s3-bucket <bucket>", "S3 bucket for sync")
    .option("--s3-prefix <prefix>", "S3 prefix")
    .option("--git-remote <remote>", "Git remote URL")
    .option("--no-git-init", "Skip auto git init")
    .option("-j, --json", "Output raw JSON")
    .option("--no-integrations", "Skip auto-linking integrations (todos, mementos)")
    .action((opts) => {
      try {
        const path = opts.path ? resolve(opts.path) : process.cwd();
        const project = createProject({
          name: opts.name,
          path,
          description: opts.description,
          slug: opts.slug,
          tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
          s3_bucket: opts.s3Bucket,
          s3_prefix: opts.s3Prefix,
          git_remote: opts.gitRemote,
          git_init: opts.gitInit !== false,
        });

        // Auto-link integrations if opt-in via flag or env var
        if (opts.integrations === true || process.env["PROJECT_AUTO_LINK"]) {
          // Detach without awaiting - fire and forget
          // Use unref() so it doesn't keep process alive
          const timer = setTimeout(() => {
            autoLinkIntegrations(project).catch(() => { /* ignore */ });
          }, 0);
          if (typeof timer.unref === "function") timer.unref();
        }

        if (wantsJsonOutput(opts)) {
          console.log(JSON.stringify(project, null, 2));
          return;
        }
        console.log(chalk.green("✓ Project created"));
        printProject(project);
        if (!existsSync(project.path)) {
          console.log(chalk.yellow(`  ⚠ Path does not exist yet: ${project.path}`));
          console.log(chalk.dim(`    Create it to enable git init and workdir generation.`));
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}

async function autoLinkIntegrations(project: ReturnType<typeof createProject>): Promise<void> {
  const results: string[] = [];

  // Run in background with very short timeout - don't block CLI
  const linkPromise = (async () => {
    try {
      const { getMcpClient } = await import("../../../lib/mcp-client.js");
      const mcp = getMcpClient();

      // Helper to extract text from MCP content, handling different content types
      const getTextContent = (content: { type: string; text?: string }): string | null => {
        if (content.type === "text" && "text" in content) return content.text as string;
        return null;
      };

      // Try todos
      try {
        const todosResult = await mcp.callTool("todos_create_project", {
          name: project.name,
          path: project.path,
          description: project.description,
        });
        if (!todosResult.isError && todosResult.content[0]) {
          const text = getTextContent(todosResult.content[0]);
          if (text) {
            const parsed = JSON.parse(text);
            const todosId = parsed.id || parsed.project_id;
            if (todosId) {
              setIntegrations(project.id, { todos_project_id: todosId });
              results.push(`todos: ${todosId}`);
            }
          }
        }
      } catch { /* skip */ }

      // Try mementos
      try {
        const mementosResult = await mcp.callTool("mementos_register_project", {
          name: project.name,
          path: project.path,
        });
        if (!mementosResult.isError && mementosResult.content[0]) {
          const text = getTextContent(mementosResult.content[0]);
          if (text) {
            const parsed = JSON.parse(text);
            const mementosId = parsed.id || parsed.project_id;
            if (mementosId) {
              setIntegrations(project.id, { mementos_project_id: mementosId });
              results.push(`mementos: ${mementosId}`);
            }
          }
        }
      } catch { /* skip */ }

      // Try conversations
      try {
        const convResult = await mcp.callTool("conversations_create_space", {
          name: project.slug,
          description: project.description,
        });
        if (!convResult.isError && convResult.content[0]) {
          const text = getTextContent(convResult.content[0]);
          if (text) {
            const parsed = JSON.parse(text);
            const spaceName = parsed.name || parsed.space || parsed.space_name;
            if (spaceName) {
              setIntegrations(project.id, { conversations_space: spaceName });
              results.push(`conversations: ${spaceName}`);
            }
          }
        }
      } catch { /* skip */ }
    } catch { /* MCP not available, skip integrations */ }

    if (results.length > 0) {
      console.log(chalk.dim(`  Linked: ${results.join(", ")}`));
    }
  })();

  // Don't await - let it run in background
  // If it doesn't complete in 1s, just move on
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerRenameCommand(cmd: Cmd) {
  cmd
    .command("rename <id-or-slug> <new-name>")
    .description("Rename a project and update slug + .project.json in all workdirs")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, newName, opts?: { json?: boolean }) => {
      const project = resolveProjectOrExit(idOrSlug);
      const updated = updateProject(project.id, { name: newName });
      const workdirs = listWorkdirs(project.id);
      for (const w of workdirs) {
        try {
          const jsonPath = join(w.path, ".project.json");
          if (existsSync(jsonPath)) {
            const existing = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
            writeFileSync(jsonPath, JSON.stringify({ ...existing, name: newName, slug: updated.slug }, null, 2) + "\n");
          }
        } catch { /* non-fatal */ }
      }
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(chalk.green(`✓ Renamed: ${project.name} → ${updated.name} (slug: ${updated.slug})`));
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerArchiveCommands(cmd: Cmd) {
  cmd
    .command("archive <id-or-slug>")
    .description("Archive a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts?: { json?: boolean }) => {
      const project = resolveProjectOrExit(idOrSlug);
      const archived = archiveProject(project.id);
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(archived, null, 2)); return; }
      console.log(chalk.yellow(`✓ Archived: ${project.name}`));
    });

  cmd
    .command("unarchive <id-or-slug>")
    .description("Unarchive a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, opts?: { json?: boolean }) => {
      const project = resolveProjectOrExit(idOrSlug);
      const unarchived = unarchiveProject(project.id);
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(unarchived, null, 2)); return; }
      console.log(chalk.green(`✓ Unarchived: ${project.name}`));
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerTagCommands(cmd: Cmd) {
  cmd
    .command("tag <id-or-slug> [tags...]")
    .description("Add tags to a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, tags: string[], opts?: { json?: boolean }) => {
      const project = resolveProjectOrExit(idOrSlug);
      const merged = [...new Set([...project.tags, ...tags])];
      const updated = updateProject(project.id, { tags: merged });
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(chalk.green(`✓ Tags: ${merged.join(", ")}`));
    });

  cmd
    .command("untag <id-or-slug> [tags...]")
    .description("Remove tags from a project")
    .option("-j, --json", "Output raw JSON")
    .action((idOrSlug, tags: string[], opts?: { json?: boolean }) => {
      const project = resolveProjectOrExit(idOrSlug);
      const remaining = project.tags.filter((t) => !tags.includes(t));
      const updated = updateProject(project.id, { tags: remaining });
      if (wantsJsonOutput(opts)) { console.log(JSON.stringify(updated, null, 2)); return; }
      console.log(chalk.green(`✓ Tags: ${remaining.length ? remaining.join(", ") : "(none)"}`));
    });
}
