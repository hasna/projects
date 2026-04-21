import { resolve, join, basename } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { createProject, updateProject, archiveProject, unarchiveProject, resolveProject, getProjectByPath, getProjectBySlug } from "../../../db/projects.js";
import { setIntegrations } from "../../../db/projects.js";
import { listWorkdirs } from "../../../db/workdirs.js";
import { writeFileSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import {
  resolveProjectOrExit,
  exitProjectNotFound,
  printProject,
  wantsJsonOutput,
  type Command as Cmd,
} from "./shared.js";
import { getConfig, resolveProjectPath, resolveProjectName } from "../../../lib/config.js";
import { slugify } from "../../../db/projects.js";

const WORKSPACE = process.env.HASNA_WORKSPACE || "/home/hasna/workspace/hasna";

/**
 * Derive the project path from the group type.
 * Groups map to workspace subdirectories:
 *   open       → opensourcedev/open-<slug>
 *   community  → community/<slug>
 *   internal   → internalapp/<slug>
 *   platform   → platform/<slug>
 *   agency     → agency/<slug>
 */
function deriveProjectPath(name: string, group: string): string {
  const slug = slugify(name);
  switch (group) {
    case "open":
      return pathJoin(WORKSPACE, "opensource", "opensourcedev", `open-${slug}`);
    case "community":
      return pathJoin(WORKSPACE, "community", slug);
    case "internal":
      return pathJoin(WORKSPACE, "internalapp", slug);
    case "platform":
      return pathJoin(WORKSPACE, "platform", slug);
    case "agency":
      return pathJoin(WORKSPACE, "agency", slug);
    default:
      return pathJoin(WORKSPACE, group, slug);
  }
}

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
    .option("--tmux", "Create a tmux window and launch takumi in it")
    .option("--publish", "Create a GitHub repo and push")
    .option("--group <type>", "Smart scaffolding: derive path from group (open, community, internal, platform, agency), auto-create folders, GitHub repo, and tmux window")
    .action(async (opts) => {
      try {
        const config = getConfig();

        // Smart scaffolding via --group flag
        if (opts.group) {
          const projectPath = deriveProjectPath(opts.name, opts.group);

          // Check for existing project at this path
          const existingAtPath = getProjectByPath(projectPath);
          if (existingAtPath) {
            console.error(chalk.red(`Error: A project already exists at path: ${projectPath}`));
            console.error(chalk.dim(`  Name: ${existingAtPath.name} (slug: ${existingAtPath.slug})`));
            process.exit(1);
          }

          // Check for slug conflicts
          const existingBySlug = getProjectBySlug(slugify(opts.name));
          if (existingBySlug) {
            console.error(chalk.red(`Error: A project already exists with slug: ${slugify(opts.name)}`));
            process.exit(1);
          }

          // Create folders
          const dir = basename(projectPath);
          const parentDir = projectPath.replace(new RegExp(`${dir}$`), "");
          mkdirSync(parentDir, { recursive: true });

          // Check GitHub repo availability
          const org = config.default_github_org || "hasnaxyz";
          const repoName = slugify(opts.name);
          const fullName = `${org}/${repoName}`;
          let ghAvailable = false;
          try {
            execSync(`gh repo view ${fullName}`, { stdio: "pipe", timeout: 3000 });
          } catch {
            ghAvailable = true; // Repo doesn't exist, we can create it
          }

          if (!ghAvailable && !wantsJsonOutput(opts)) {
            console.log(chalk.yellow(`  ⚠ GitHub repo ${fullName} already exists`));
          }

          const project = createProject({
            name: opts.name,
            path: projectPath,
            description: opts.description,
            slug: slugify(opts.name),
            tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : [],
            s3_bucket: opts.s3Bucket,
            s3_prefix: opts.s3Prefix,
            git_remote: opts.gitRemote,
            git_init: opts.gitInit !== false,
          });

          // Create GitHub repo
          if (ghAvailable) {
            try {
              const { publishProject } = await import("../../../lib/github.js");
              const result = publishProject(repoName, projectPath, {
                org,
                private: config.default_repo_visibility === "private",
                description: project.description ?? undefined,
              });
              console.log(chalk.green(`✓ Published: ${result.url}`));
            } catch (err: unknown) {
              console.log(chalk.yellow(`⚠ GitHub publish failed: ${err instanceof Error ? err.message : String(err)}`));
            }
          }

          // Create tmux window
          try {
            const { createTmuxWindow } = await import("../../../lib/tmux.js");
            createTmuxWindow(project);
            console.log(chalk.green(`✓ tmux window created for ${project.name}`));
          } catch {
            console.log(chalk.yellow("⚠ tmux unavailable — run `project tmux create ${name}` manually"));
          }

          if (wantsJsonOutput(opts)) {
            console.log(JSON.stringify(project, null, 2));
            return;
          }
          console.log(chalk.green("✓ Project created with full scaffolding"));
          printProject(project);
          process.exit(0);
        }

        // Standard create flow
        const path = resolveProjectPath(opts.path);

        // Check for existing project at this path
        const existingAtPath = getProjectByPath(path);
        if (existingAtPath) {
          console.error(chalk.red(`Error: A project already exists at path: ${path}`));
          console.error(chalk.dim(`  Name: ${existingAtPath.name} (slug: ${existingAtPath.slug})`));
          process.exit(1);
        }

        // Check for slug conflict
        if (opts.slug) {
          const existingBySlug = getProjectBySlug(opts.slug);
          if (existingBySlug) {
            console.error(chalk.red(`Error: A project already exists with slug: ${opts.slug}`));
            process.exit(1);
          }
        }

        // Check GitHub repo availability (non-blocking warning, suppressed for JSON)
        const nameCheck = resolveProjectName(opts.name, config);
        if (nameCheck.suggested && !wantsJsonOutput(opts)) {
          console.log(chalk.yellow(`  ⚠ GitHub repo ${config.default_github_org}/${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")} already exists`));
          console.log(chalk.yellow(`  Suggested name: ${nameCheck.suggested}`));
        }

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

        // Post-create: tmux (blocking — user wants it)
        if (opts.tmux) {
          try {
            const { createTmuxWindow } = await import("../../../lib/tmux.js");
            createTmuxWindow(project);
            console.log(chalk.green(`✓ tmux window created for ${project.name}`));
          } catch {
            console.log(chalk.yellow("⚠ tmux unavailable — run `project tmux create ${name}` manually"));
          }
        }

        // Post-create: GitHub publish (blocking — user wants it)
        if (opts.publish) {
          try {
            const { publishProject } = await import("../../../lib/github.js");
            const result = publishProject(project.name, project.path, {
              org: config.default_github_org,
              private: config.default_repo_visibility === "private",
              description: project.description ?? undefined,
            });
            console.log(chalk.green(`✓ Published: ${result.url}`));
          } catch (err: unknown) {
            console.log(chalk.yellow(`⚠ GitHub publish failed: ${err instanceof Error ? err.message : String(err)}`));
          }
        }

        process.exit(0);
      } catch (err: unknown) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}

async function autoLinkIntegrations(project: ReturnType<typeof createProject>): Promise<void> {
  const results: string[] = [];

  // Fire and forget - errors are caught internally
  // This runs completely detached from the CLI flow
  (async () => {
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

      if (results.length > 0) {
        console.log(chalk.dim(`  Linked: ${results.join(", ")}`));
      }
    } catch { /* MCP not available, skip integrations */ }
  })().catch(() => { /* ignore errors - fire and forget */ });
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerNewCommand(cmd: Cmd) {
  cmd
    .command("new [name]")
    .description("Interactive wizard to create a project with full scaffolding")
    .option("--name <name>", "Project name (skips prompt if provided)")
    .option("--group <type>", "Project group (open, community, internal, platform, agency) — auto-derives path")
    .option("--org <org>", "GitHub org (default: hasnaxyz)")
    .option("--visibility <vis>", "GitHub visibility: private or public (default: private)")
    .option("--tmux", "Create tmux window and launch takumi")
    .option("-j, --json", "Output raw JSON")
    .action(async (opts) => {
      const config = getConfig();

      // Collect inputs from flags or interactive prompts
      const name = opts.name || await prompt("Project name: ");
      if (!name) { console.error(chalk.red("Name is required.")); process.exit(1); }

      const groups = ["open", "community", "internal", "platform", "agency"];
      let group = opts.group;
      if (!group) {
        console.log(chalk.dim("Available groups:"));
        for (const g of groups) console.log(chalk.dim(`  ${g}`));
        group = await prompt("Group (e.g. open): ", "open");
      }
      if (!group || !groups.includes(group)) {
        console.error(chalk.red(`Invalid group: ${group}. Must be one of: ${groups.join(", ")}`));
        process.exit(1);
      }

      const org = opts.org || config.default_github_org || "hasnaxyz";

      const visibility = opts.visibility || await prompt("GitHub visibility (private/public): ", "private");
      const isPrivate = visibility !== "public";

      const description = await prompt("Description (optional): ");

      const projectPath = deriveProjectPath(name, group);
      if (getProjectByPath(projectPath)) {
        console.error(chalk.red(`Error: A project already exists at path: ${projectPath}`));
        process.exit(1);
      }

      const finalSlug = slugify(name);
      if (getProjectBySlug(finalSlug)) {
        console.error(chalk.red(`Error: A project already exists with slug: ${finalSlug}`));
        process.exit(1);
      }

      if (!wantsJsonOutput(opts)) {
        console.log(chalk.green(`\n  Path: ${projectPath}`));
        console.log(chalk.green(`  GitHub: ${org}/${finalSlug} (${visibility})`));
        if (description) console.log(chalk.green(`  Desc: ${description}`));
        console.log(chalk.dim("\n  Creating project...\n"));
      }

      const project = createProject({
        name,
        path: projectPath,
        description: description || undefined,
        slug: finalSlug,
        tags: [],
        git_init: true,
      });

      // Create GitHub repo
      try {
        const { publishProject } = await import("../../../lib/github.js");
        const result = publishProject(finalSlug, projectPath, {
          org,
          private: isPrivate,
          description: project.description ?? undefined,
        });
        console.log(chalk.green(`✓ GitHub repo: ${result.url}`));
      } catch (err: unknown) {
        console.log(chalk.yellow(`⚠ GitHub publish failed: ${err instanceof Error ? err.message : String(err)}`));
      }

      // Create tmux window
      try {
        const { createTmuxWindow } = await import("../../../lib/tmux.js");
        createTmuxWindow(project);
        console.log(chalk.green(`✓ tmux window created`));
      } catch {
        console.log(chalk.yellow("⚠ tmux unavailable"));
      }

      if (wantsJsonOutput(opts)) {
        console.log(JSON.stringify(project, null, 2));
        return;
      }
      console.log(chalk.green("\n✓ Project created"));
      printProject(project);
      process.exit(0);
    });
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question + (defaultValue ? chalk.dim(` [${defaultValue}]`) : ""), (answer: string) => {
      rl.close();
      resolve((answer || defaultValue || "").trim());
    });
  });
}
