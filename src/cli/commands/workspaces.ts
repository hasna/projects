import chalk from "chalk";
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireWorkspaceLock,
  addTmuxProfileWindow,
  archiveWorkspace,
  createAgent,
  createRecipe,
  createRoot,
  createTmuxProfile,
  deleteWorkspace,
  deleteRoot,
  ensureCliAgent,
  getAgent,
  getAgentBySlug,
  getRecipe,
  getRecipeBySlug,
  getRoot,
  getRootBySlug,
  listAgents,
  listRecipes,
  listRoots,
  listTmuxProfileWindows,
  listTmuxProfiles,
  listWorkspaceEvents,
  listWorkspaceLocations,
  listWorkspaceLocks,
  listWorkspaces,
  scoreRoots,
  releaseWorkspaceLock,
  resolveWorkspace,
  resolveTmuxProfile,
  unarchiveWorkspace,
  updateWorkspace,
  updateRoot,
} from "../../db/workspaces.js";
import {
  applyWorkspaceTmuxProfile,
  type WorkspaceTmuxWindowSpec,
} from "../../lib/workspace-runtime.js";
import {
  cleanupWorkspaceCreationTarget,
  executeWorkspaceCreation,
  type WorkspaceCreationCleanupTarget,
  type WorkspaceCreationPlanAction,
} from "../../lib/workspace-plan.js";
import { doctorWorkspace } from "../../lib/workspace-doctor.js";
import { builtInWorkspaceRecipes, ensureBuiltInWorkspaceRecipes } from "../../lib/workspace-defaults.js";
import {
  importWorkspaceFromGitHub,
  linkWorkspaceExternalIntegrations,
  publishWorkspaceToGitHub,
  unpublishWorkspaceFromGitHub,
  type GitHubRemoteProtocol,
  type GitHubVisibility,
} from "../../lib/workspace-github.js";
import { importRegisteredRoots, importWorkspace, importWorkspaceBulk } from "../../lib/workspace-import.js";
import { runWorkspaceLegacyMigration } from "../../lib/workspace-migration.js";
import { parseWorkspaceAgentEvalCaseIds, runWorkspaceAgentEval } from "../../lib/workspace-agent-eval.js";
import { WORKSPACE_KINDS, WORKSPACE_STATUSES, type AgentKind, type JsonObject, type Workspace, type WorkspaceIntegrations, type WorkspaceKind, type WorkspaceStatus } from "../../types/workspace.js";

function wantsJson(opts?: { json?: boolean }): boolean {
  return Boolean(opts?.json || process.env["WORKSPACES_JSON"] || process.argv.includes("--json") || process.argv.includes("-j"));
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function printObject(value: unknown, opts?: { json?: boolean }): void {
  if (wantsJson(opts)) {
    console.log(JSON.stringify(value, null, 2));
  }
}

function parseKind(value: string | undefined): WorkspaceKind | undefined {
  if (!value) return undefined;
  if ((WORKSPACE_KINDS as readonly string[]).includes(value)) return value as WorkspaceKind;
  throw new Error(`Invalid workspace kind: ${value}. Expected one of: ${WORKSPACE_KINDS.join(", ")}`);
}

function parseStatus(value: string | undefined): WorkspaceStatus | undefined {
  if (!value) return undefined;
  if ((WORKSPACE_STATUSES as readonly string[]).includes(value)) return value as WorkspaceStatus;
  throw new Error(`Invalid workspace status: ${value}. Expected one of: ${WORKSPACE_STATUSES.join(", ")}`);
}

function parseJsonObject(value: string | undefined, label: string): JsonObject | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function parseIntegrationsJson(value: string | undefined): WorkspaceIntegrations | undefined {
  const parsed = parseJsonObject(value, "--integrations-json");
  if (!parsed) return undefined;
  const integrations: WorkspaceIntegrations = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (item === null) continue;
    if (typeof item !== "string") throw new Error("--integrations-json values must be strings or null");
    integrations[key] = item;
  }
  return integrations;
}

function parseIntegrationPairs(values: string[] | undefined): WorkspaceIntegrations {
  const integrations: WorkspaceIntegrations = {};
  for (const value of values ?? []) {
    const index = value.indexOf("=");
    if (index <= 0) throw new Error("--integration values must use key=value");
    const key = value.slice(0, index).trim();
    const pairValue = value.slice(index + 1).trim();
    if (!key || !pairValue) throw new Error("--integration values must use non-empty key=value");
    integrations[key] = pairValue;
  }
  return integrations;
}

function mergeIntegrations(...items: Array<WorkspaceIntegrations | undefined>): WorkspaceIntegrations {
  return Object.assign({}, ...items.filter(Boolean));
}

function parseGitHubVisibility(value: string | undefined): GitHubVisibility | undefined {
  if (!value) return undefined;
  if (value === "public" || value === "private") return value;
  throw new Error("GitHub visibility must be public or private");
}

function parseGitHubRemoteProtocol(value: string | undefined): GitHubRemoteProtocol | undefined {
  if (!value) return undefined;
  if (value === "https" || value === "ssh") return value;
  throw new Error("GitHub remote protocol must be https or ssh");
}

function withWorkspaceLock<T>(workspace: Workspace, agentId: string | undefined, reason: string, fn: () => T): T {
  const key = `workspace:${workspace.id}`;
  acquireWorkspaceLock({ lock_key: key, workspace_id: workspace.id, agent_id: agentId, reason, ttl_seconds: 600 });
  try {
    return fn();
  } finally {
    releaseWorkspaceLock(key);
  }
}

function resolveRootId(idOrSlug: string | undefined): string | undefined {
  if (!idOrSlug) return undefined;
  const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
  if (!root) throw new Error(`Root not found: ${idOrSlug}`);
  return root.id;
}

function resolveRecipeId(idOrSlug: string | undefined): string | undefined {
  if (!idOrSlug) return undefined;
  const recipe = getRecipe(idOrSlug) ?? getRecipeBySlug(idOrSlug);
  if (!recipe) throw new Error(`Recipe not found: ${idOrSlug}`);
  return recipe.id;
}

function resolveAgentId(idOrSlug: string | undefined): string {
  if (!idOrSlug) return ensureCliAgent().id;
  const agent = getAgent(idOrSlug) ?? getAgentBySlug(idOrSlug);
  if (!agent) throw new Error(`Agent not found: ${idOrSlug}`);
  return agent.id;
}

function printRows(rows: Array<Record<string, unknown>>, columns: string[]): void {
  if (!rows.length) {
    console.log(chalk.dim("No records found."));
    return;
  }
  for (const row of rows) {
    console.log(columns.map((column) => String(row[column] ?? "")).join("\t"));
  }
}

function parseTmuxWindowsJson(value: string | undefined): WorkspaceTmuxWindowSpec[] | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("--tmux-windows-json must be a JSON array");
  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each tmux window must be an object");
    const window = item as Record<string, unknown>;
    if (typeof window.name !== "string" || window.name.trim().length === 0) {
      throw new Error("Each tmux window needs a non-empty name");
    }
    return {
      name: window.name,
      path: typeof window.path === "string" ? window.path : undefined,
      command: typeof window.command === "string" ? window.command : undefined,
      index: typeof window.index === "number" ? window.index : undefined,
      detached: typeof window.detached === "boolean" ? window.detached : undefined,
    };
  });
}

function parseTmuxProfileWindowsJson(value: string | undefined) {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("--windows-json must be a JSON array");
  return parsed.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each profile window must be an object");
    const window = item as Record<string, unknown>;
    const name = window.window_name_template ?? window.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Each profile window needs name or window_name_template");
    }
    return {
      window_name_template: name,
      path_template: typeof window.path_template === "string" ? window.path_template : typeof window.path === "string" ? window.path : undefined,
      command: typeof window.command === "string" ? window.command : undefined,
      window_index: typeof window.window_index === "number" ? window.window_index : typeof window.index === "number" ? window.index : undefined,
      detached: typeof window.detached === "boolean" ? window.detached : undefined,
      env: window.env && typeof window.env === "object" ? window.env as Record<string, string> : undefined,
      revive: typeof window.revive === "boolean" ? window.revive : undefined,
    };
  });
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function isRollbackAction(value: unknown): value is WorkspaceCreationPlanAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  return action.type === "rollback"
    && typeof action.action === "string"
    && typeof action.target === "string"
    && action.status === "planned";
}

function parseRollbackActions(value: unknown): WorkspaceCreationPlanAction[] | null {
  if (!Array.isArray(value)) return null;
  const actions = value.filter(isRollbackAction);
  return actions.length === value.length ? actions : null;
}

function cleanupTargetFromPlanFile(path: string): WorkspaceCreationCleanupTarget {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  const payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const plan = payload.plan && typeof payload.plan === "object" ? payload.plan as Record<string, unknown> : payload;
  const workspace = plan.workspace && typeof plan.workspace === "object" ? plan.workspace as Record<string, unknown> : null;
  const rollbackActions = parseRollbackActions(plan.rollback_actions);
  if (!workspace || typeof workspace.slug !== "string" || !rollbackActions) {
    throw new Error("--plan must point to a workspace creation plan or execution JSON payload");
  }
  return {
    workspace_slug: workspace.slug,
    primary_path: typeof workspace.primary_path === "string" ? workspace.primary_path : null,
    rollback_actions: rollbackActions,
  };
}

function cleanupTargetFromWorkspace(workspace: Workspace): WorkspaceCreationCleanupTarget {
  for (const event of listWorkspaceEvents(workspace.id).slice().reverse()) {
    const fromMetadata = parseRollbackActions(event.metadata.rollback_actions);
    if (fromMetadata) {
      return {
        workspace_slug: workspace.slug,
        primary_path: workspace.primary_path,
        rollback_actions: fromMetadata,
      };
    }
    const after = event.after_json as Record<string, unknown> | null;
    const plan = after?.plan as Record<string, unknown> | undefined;
    const fromPlan = parseRollbackActions(plan?.rollback_actions);
    if (fromPlan) {
      return {
        workspace_slug: workspace.slug,
        primary_path: workspace.primary_path,
        rollback_actions: fromPlan,
      };
    }
  }

  const rollbackActions: WorkspaceCreationPlanAction[] = [
    { type: "rollback", action: "delete", target: `workspaces:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
    { type: "rollback", action: "delete", target: `workspace_events:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
  ];
  if (workspace.primary_path) {
    rollbackActions.push({ type: "rollback", action: "delete", target: `workspace_locations:${workspace.primary_path}`, status: "planned", metadata: { automatic: false } });
    rollbackActions.push({ type: "rollback", action: "remove_file", target: join(workspace.primary_path, ".workspace.json"), status: "planned", metadata: { automatic: false } });
    rollbackActions.push({ type: "rollback", action: "remove_git_dir", target: join(workspace.primary_path, ".git"), status: "planned", metadata: { automatic: false } });
    rollbackActions.push({ type: "rollback", action: "remove_empty_directory", target: workspace.primary_path, status: "planned", metadata: { automatic: false } });
  }
  return {
    workspace_slug: workspace.slug,
    primary_path: workspace.primary_path,
    rollback_actions: rollbackActions,
  };
}

export function registerWorkspaceCommands(program: Command): void {
  registerRootsCommand(program);
  registerRecipesCommand(program);
  registerAgentsCommand(program);
  registerTmuxProfilesCommand(program);
  registerWorkspacesCommand(program);
}

function registerRootsCommand(program: Command): void {
  const cmd = program.command("roots").description("Manage registered workspace roots");

  cmd
    .command("add")
    .requiredOption("--name <name>", "Root name")
    .requiredOption("--path <path>", "Base path")
    .option("--slug <slug>", "Root slug")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--kind <kind>", `Default workspace kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--github-org <org>", "Default GitHub organization")
    .option("--visibility <visibility>", "Default repo visibility: public or private")
    .option("--path-template <template>", "Path template relative to base path")
    .option("--name-template <template>", "Name template for generated names")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const visibility = opts.visibility as "public" | "private" | undefined;
        if (visibility && visibility !== "public" && visibility !== "private") {
          throw new Error("Visibility must be public or private");
        }
        const root = createRoot({
          name: opts.name,
          slug: opts.slug,
          base_path: opts.path,
          tags: splitList(opts.tags),
          default_kind: parseKind(opts.kind),
          github_org: opts.githubOrg,
          repo_visibility: visibility,
          path_template: opts.pathTemplate,
          name_template: opts.nameTemplate,
        });
        if (wantsJson(opts)) { printObject(root, opts); return; }
        console.log(chalk.green(`✓ Root created: ${root.slug}`));
        console.log(`  ${chalk.dim("path:")} ${root.base_path}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const roots = listRoots();
      if (wantsJson(opts)) { printObject(roots, opts); return; }
      printRows(roots.map((root) => ({
        slug: root.slug,
        kind: root.default_kind ?? "",
        path: root.base_path,
        tags: root.tags.join(","),
      })), ["slug", "kind", "path", "tags"]);
    });

  cmd
    .command("show <id-or-slug>")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
      if (!root) {
        console.error(chalk.red(`Root not found: ${idOrSlug}`));
        process.exit(1);
      }
      if (wantsJson(opts)) { printObject(root, opts); return; }
      console.log(`${chalk.bold(root.name)} ${chalk.dim(`(${root.slug})`)}`);
      console.log(`  ${chalk.dim("path:")} ${root.base_path}`);
      if (root.default_kind) console.log(`  ${chalk.dim("kind:")} ${root.default_kind}`);
      if (root.github_org) console.log(`  ${chalk.dim("github:")} ${root.github_org}`);
    });

  cmd
    .command("update <id-or-slug>")
    .option("--name <name>", "Root name")
    .option("--slug <slug>", "Root slug")
    .option("--path <path>", "Base path")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--kind <kind>", `Default workspace kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--clear-kind", "Clear default kind")
    .option("--github-org <org>", "Default GitHub organization")
    .option("--clear-github-org", "Clear default GitHub organization")
    .option("--visibility <visibility>", "Default repo visibility: public or private")
    .option("--clear-visibility", "Clear default repo visibility")
    .option("--path-template <template>", "Path template relative to base path")
    .option("--clear-path-template", "Clear path template")
    .option("--name-template <template>", "Name template")
    .option("--clear-name-template", "Clear name template")
    .option("--allowed-recipes <ids>", "Comma-separated allowed recipe ids/slugs")
    .option("--allowed-agents <ids>", "Comma-separated allowed agent ids/slugs")
    .option("--metadata-json <json>", "Replace metadata with JSON object")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
        if (!root) throw new Error(`Root not found: ${idOrSlug}`);
        const visibility = opts.clearVisibility ? null : opts.visibility as "public" | "private" | undefined;
        if (visibility && visibility !== "public" && visibility !== "private") throw new Error("Visibility must be public or private");
        const updated = updateRoot(root.id, {
          name: opts.name,
          slug: opts.slug,
          base_path: opts.path,
          tags: opts.tags === undefined ? undefined : splitList(opts.tags),
          default_kind: opts.clearKind ? null : parseKind(opts.kind),
          github_org: opts.clearGithubOrg ? null : opts.githubOrg,
          repo_visibility: visibility,
          path_template: opts.clearPathTemplate ? null : opts.pathTemplate,
          name_template: opts.clearNameTemplate ? null : opts.nameTemplate,
          allowed_recipes: opts.allowedRecipes === undefined ? undefined : splitList(opts.allowedRecipes),
          allowed_agents: opts.allowedAgents === undefined ? undefined : splitList(opts.allowedAgents),
          metadata: parseJsonObject(opts.metadataJson, "--metadata-json"),
        });
        if (wantsJson(opts)) { printObject(updated, opts); return; }
        console.log(chalk.green(`✓ Root updated: ${updated.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("delete <id-or-slug>")
    .option("--detach-workspaces", "Clear root_id on referencing workspaces before deleting")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
        if (!root) throw new Error(`Root not found: ${idOrSlug}`);
        const result = deleteRoot(root.id, { detachWorkspaces: opts.detachWorkspaces });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(chalk.yellow(`✓ Root deleted: ${result.root.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("match")
    .option("--path <path>", "Path to match")
    .option("--kind <kind>", `Workspace kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--tags <tags>", "Comma-separated tags")
    .option("--github-org <org>", "GitHub organization")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const matches = scoreRoots({
          path: opts.path,
          kind: parseKind(opts.kind),
          tags: splitList(opts.tags),
          github_org: opts.githubOrg,
        });
        if (wantsJson(opts)) { printObject(matches, opts); return; }
        printRows(matches.map((item) => ({
          slug: item.root.slug,
          score: item.score,
          reasons: item.reasons.join(","),
          path: item.root.base_path,
        })), ["slug", "score", "reasons", "path"]);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerRecipesCommand(program: Command): void {
  const cmd = program.command("recipes").description("Manage workspace creation recipes");

  cmd
    .command("add")
    .requiredOption("--name <name>", "Recipe name")
    .option("--slug <slug>", "Recipe slug")
    .option("--description <text>", "Description")
    .option("--kind <kind>", `Recipe workspace kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--tags <tags>", "Default tags")
    .option("--step-json <json>", "Single JSON recipe step to append")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const steps = opts.stepJson ? [JSON.parse(opts.stepJson)] : [];
        const recipe = createRecipe({
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          kind: parseKind(opts.kind),
          default_tags: splitList(opts.tags),
          steps,
        });
        if (wantsJson(opts)) { printObject(recipe, opts); return; }
        console.log(chalk.green(`✓ Recipe created: ${recipe.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const recipes = listRecipes();
      if (wantsJson(opts)) { printObject(recipes, opts); return; }
      printRows(recipes.map((recipe) => ({
        slug: recipe.slug,
        kind: recipe.kind ?? "",
        version: recipe.version,
        tags: recipe.default_tags.join(","),
      })), ["slug", "kind", "version", "tags"]);
    });

  cmd
    .command("built-ins")
    .description("List built-in workspace recipes")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const recipes = builtInWorkspaceRecipes();
      if (wantsJson(opts)) { printObject(recipes, opts); return; }
      printRows(recipes.map((recipe) => ({
        slug: recipe.slug ?? "",
        kind: recipe.kind ?? "",
        tags: recipe.default_tags?.join(",") ?? "",
        name: recipe.name,
      })), ["slug", "kind", "tags", "name"]);
    });

  cmd
    .command("seed-defaults")
    .description("Create missing built-in workspace recipes")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const result = ensureBuiltInWorkspaceRecipes();
      if (wantsJson(opts)) { printObject(result, opts); return; }
      console.log(chalk.green(`✓ Created ${result.created.length} built-in recipe(s)`));
      if (result.existing.length) console.log(chalk.dim(`  existing: ${result.existing.length}`));
    });
}

function registerAgentsCommand(program: Command): void {
  const cmd = program.command("agents").description("Manage workspace agents");

  cmd
    .command("add")
    .requiredOption("--name <name>", "Agent name")
    .requiredOption("--kind <kind>", "Agent kind: human, ai, service, cli")
    .option("--slug <slug>", "Agent slug")
    .option("--provider <provider>", "Provider, e.g. openrouter")
    .option("--model <model>", "Model name")
    .option("--role <role>", "Default role")
    .option("--permissions <permissions>", "Comma-separated permissions")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const kind = opts.kind as AgentKind;
        if (!["human", "ai", "service", "cli"].includes(kind)) {
          throw new Error("Agent kind must be human, ai, service, or cli");
        }
        const agent = createAgent({
          name: opts.name,
          slug: opts.slug,
          kind,
          provider: opts.provider,
          model: opts.model,
          role: opts.role,
          permissions: splitList(opts.permissions),
        });
        if (wantsJson(opts)) { printObject(agent, opts); return; }
        console.log(chalk.green(`✓ Agent created: ${agent.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const agents = listAgents();
      if (wantsJson(opts)) { printObject(agents, opts); return; }
      printRows(agents.map((agent) => ({
        slug: agent.slug,
        kind: agent.kind,
        provider: agent.provider ?? "",
        model: agent.model ?? "",
        role: agent.role ?? "",
      })), ["slug", "kind", "provider", "model", "role"]);
    });
}

function registerTmuxProfilesCommand(program: Command): void {
  const cmd = program.command("tmux-profiles").description("Manage workspace tmux profiles");

  cmd
    .command("add")
    .requiredOption("--name <name>", "Profile name")
    .option("--slug <slug>", "Profile slug")
    .option("--description <text>", "Description")
    .option("--session-template <template>", "Session template", "{slug}")
    .option("--attach", "Attach after applying")
    .option("--windows-json <json>", "JSON array of profile windows")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const profile = createTmuxProfile({
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          session_template: opts.sessionTemplate,
          attach: opts.attach,
          windows: parseTmuxProfileWindowsJson(opts.windowsJson),
        });
        const payload = { profile, windows: listTmuxProfileWindows(profile.id) };
        if (wantsJson(opts)) { printObject(payload, opts); return; }
        console.log(chalk.green(`✓ Tmux profile created: ${profile.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("window-add <profile>")
    .requiredOption("--name <template>", "Window name template")
    .option("--path-template <template>", "Window path template")
    .option("--command <command>", "Command template")
    .option("--index <n>", "Window index")
    .option("--attached", "Create focused rather than detached")
    .option("-j, --json", "Output JSON")
    .action((profileIdOrSlug, opts) => {
      try {
        const profile = resolveTmuxProfile(profileIdOrSlug);
        if (!profile) throw new Error(`Tmux profile not found: ${profileIdOrSlug}`);
        const window = addTmuxProfileWindow({
          profile_id: profile.id,
          window_name_template: opts.name,
          path_template: opts.pathTemplate,
          command: opts.command,
          window_index: opts.index ? Number.parseInt(opts.index, 10) : undefined,
          detached: !opts.attached,
        });
        if (wantsJson(opts)) { printObject(window, opts); return; }
        console.log(chalk.green(`✓ Window added: ${window.window_name_template}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const profiles = listTmuxProfiles();
      if (wantsJson(opts)) { printObject(profiles, opts); return; }
      printRows(profiles.map((profile) => ({
        slug: profile.slug,
        session: profile.session_template,
        attach: profile.attach ? "yes" : "no",
      })), ["slug", "session", "attach"]);
    });

  cmd
    .command("show <profile>")
    .option("-j, --json", "Output JSON")
    .action((profileIdOrSlug, opts) => {
      const profile = resolveTmuxProfile(profileIdOrSlug);
      if (!profile) {
        console.error(chalk.red(`Tmux profile not found: ${profileIdOrSlug}`));
        process.exit(1);
      }
      const payload = { profile, windows: listTmuxProfileWindows(profile.id) };
      if (wantsJson(opts)) { printObject(payload, opts); return; }
      console.log(`${chalk.bold(profile.name)} ${chalk.dim(`(${profile.slug})`)}`);
      for (const window of payload.windows) console.log(`  ${window.window_name_template}`);
    });

  cmd
    .command("apply <profile> <workspace>")
    .option("--dry-run", "Plan tmux changes without applying")
    .option("-j, --json", "Output JSON")
    .action((profileIdOrSlug, workspaceIdOrSlug, opts) => {
      try {
        const profile = resolveTmuxProfile(profileIdOrSlug);
        if (!profile) throw new Error(`Tmux profile not found: ${profileIdOrSlug}`);
        const workspace = resolveWorkspace(workspaceIdOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${workspaceIdOrSlug}`);
        const agentId = ensureCliAgent().id;
        const result = opts.dryRun
          ? applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), {
              dryRun: true,
              source: "cli",
              command: process.argv.join(" "),
            })
          : withWorkspaceLock(workspace, agentId, "tmux profile apply", () => applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), {
              source: "cli",
              command: process.argv.join(" "),
            }));
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(`${result.success ? chalk.green("✓") : chalk.red("✗")} ${result.session_action} ${result.session_name}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function registerWorkspacesCommand(program: Command): void {
  const cmd = program.command("workspaces").description("Manage workspaces");

  cmd
    .command("create")
    .requiredOption("--name <name>", "Workspace name")
    .option("--slug <slug>", "Workspace slug")
    .option("--description <text>", "Description")
    .option("--kind <kind>", `Workspace kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--root <id-or-slug>", "Root id or slug")
    .option("--recipe <id-or-slug>", "Recipe id or slug")
    .option("--path <path>", "Explicit primary path")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--agent <id-or-slug>", "Creating agent; defaults to CLI agent")
    .option("--git-remote <url>", "Git remote URL")
    .option("--mkdir", "Create the workspace directory")
    .option("--git-init", "Initialize a git repository in the workspace directory")
    .option("--marker", "Write .workspace.json marker")
    .option("--tmux-session <name>", "Create or reuse a tmux session after creating the workspace")
    .option("--tmux-windows-json <json>", "JSON array of tmux windows: [{\"name\":\"editor\",\"command\":\"npm run dev\"}]")
    .option("--tmux-profile <id-or-slug>", "Apply a saved tmux profile")
    .option("--dry-run", "Preview full creation without writing DB/files/tmux")
    .option("--dry-run-runtime", "Plan directory/git/tmux runtime actions without applying them")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const agentId = resolveAgentId(opts.agent);
        const tmuxWindows = parseTmuxWindowsJson(opts.tmuxWindowsJson);
        const result = executeWorkspaceCreation({
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          kind: parseKind(opts.kind),
          root_id: resolveRootId(opts.root),
          recipe_id: resolveRecipeId(opts.recipe),
          primary_path: opts.path,
          git_remote: opts.gitRemote,
          tags: splitList(opts.tags),
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
          createDirectory: opts.mkdir || opts.gitInit,
          gitInit: opts.gitInit,
          writeMarker: opts.marker,
          tmux: opts.tmuxSession || tmuxWindows ? { session: opts.tmuxSession, windows: tmuxWindows } : undefined,
          tmux_profile: opts.tmuxProfile,
        }, { dryRun: opts.dryRun, runtimeDryRun: opts.dryRunRuntime });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        if (result.dry_run) {
          console.log(chalk.dim(`[dry-run] Workspace plan: ${result.plan.workspace.slug}`));
          if (result.plan.workspace.primary_path) console.log(`  ${chalk.dim("path:")} ${result.plan.workspace.primary_path}`);
          for (const action of result.plan.runtime_actions) {
            console.log(`  ${chalk.dim(action.type + ":")} ${action.status} ${action.target}`);
          }
          if (result.plan.tmux) console.log(`  ${chalk.dim("tmux:")} planned ${result.plan.tmux.session_name}`);
          return;
        }
        const workspace = result.workspace!;
        console.log(chalk.green(`✓ Workspace created: ${workspace.slug}`));
        if (workspace.primary_path) console.log(`  ${chalk.dim("path:")} ${workspace.primary_path}`);
        for (const action of result.prepare) {
          console.log(`  ${chalk.dim(action.type + ":")} ${action.status} ${action.target}`);
        }
        if (result.tmux) {
          const status = result.tmux.success ? result.tmux.session_action : "failed";
          console.log(`  ${chalk.dim("tmux:")} ${status} ${result.tmux.session_name}`);
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("cleanup-create [id-or-slug]")
    .description("Safely clean up DB/files created by a workspace creation run")
    .option("--plan <path>", "Creation plan/execution JSON file to clean up")
    .option("--dry-run", "Preview cleanup actions without mutating DB/files")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const target = opts.plan
          ? cleanupTargetFromPlanFile(opts.plan)
          : (() => {
              if (!idOrSlug) throw new Error("Provide a workspace id/slug or --plan");
              const workspace = resolveWorkspace(idOrSlug);
              if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
              return cleanupTargetFromWorkspace(workspace);
            })();
        const result = cleanupWorkspaceCreationTarget(target, {
          dryRun: opts.dryRun,
          agentId: opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id,
          source: "cli",
          command: process.argv.join(" "),
        });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(result.dry_run ? chalk.dim(`[dry-run] Cleanup ${result.workspace_slug}`) : chalk.green(`✓ Cleanup ${result.workspace_slug}`));
        for (const action of result.actions) {
          const color = action.status === "failed" ? chalk.red : action.status === "skipped" ? chalk.yellow : action.status === "planned" ? chalk.dim : chalk.green;
          console.log(`  ${color(action.status)} ${action.action} ${action.target}${action.message ? chalk.dim(` - ${action.message}`) : ""}`);
        }
        if (!result.success) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("import <path>")
    .description("Import an existing folder as a workspace")
    .option("--bulk", "Import direct child directories")
    .option("--dry-run", "Preview imports without writing workspace rows")
    .option("--tags <tags>", "Comma-separated tags")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action(async (path, opts) => {
      try {
        const agentId = opts.agent ? resolveAgentId(opts.agent) : undefined;
        const result = opts.bulk
          ? await importWorkspaceBulk(path, { dryRun: opts.dryRun, tags: splitList(opts.tags), agent_id: agentId })
          : await importWorkspace(path, { dryRun: opts.dryRun, tags: splitList(opts.tags), agent_id: agentId });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        if ("imported" in result) {
          console.log(chalk.green(`✓ Imported ${result.imported.length} workspace(s)`));
          if (result.previews.length) console.log(chalk.dim(`  previews: ${result.previews.length}`));
          if (result.skipped.length) console.log(chalk.dim(`  skipped: ${result.skipped.length}`));
          if (result.errors.length) console.log(chalk.yellow(`  errors: ${result.errors.length}`));
          return;
        }
        if (result.workspace) console.log(chalk.green(`✓ Imported: ${result.workspace.slug}`));
        else if (result.preview) console.log(`${chalk.dim("[dry-run]")} ${result.preview.slug} ${result.preview.path}`);
        else console.log(chalk.yellow(result.skipped ?? result.error ?? "No import performed"));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("import-github <repo>")
    .description("Import a GitHub repository as a workspace")
    .option("--root <id-or-slug>", "Root id or slug used for path derivation")
    .option("--path <path>", "Explicit clone/import path")
    .option("--clone", "Clone the repository before registering the workspace")
    .option("--remote-only", "Register a remote-only workspace without a local path")
    .option("--kind <kind>", `Workspace kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--tags <tags>", "Comma-separated tags")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("--remote-protocol <protocol>", "Git remote protocol: https or ssh")
    .option("--dry-run", "Preview the import without cloning or writing DB rows")
    .option("-j, --json", "Output JSON")
    .action(async (repo, opts) => {
      try {
        const result = await importWorkspaceFromGitHub(repo, {
          root: opts.root,
          path: opts.path,
          clone: opts.clone,
          remoteOnly: opts.remoteOnly,
          kind: parseKind(opts.kind),
          tags: splitList(opts.tags),
          remoteProtocol: parseGitHubRemoteProtocol(opts.remoteProtocol),
          dryRun: opts.dryRun,
          agent_id: opts.agent ? resolveAgentId(opts.agent) : undefined,
          source: "cli",
          command: process.argv.join(" "),
        });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        if (result.status === "planned") {
          console.log(chalk.dim(`[dry-run] GitHub import: ${result.full_name}`));
          if (result.path) console.log(`  ${chalk.dim("path:")} ${result.path}`);
          return;
        }
        if (result.status === "skipped") {
          console.log(chalk.yellow(`Skipped: ${result.skipped}`));
          return;
        }
        console.log(chalk.green(`✓ Imported GitHub workspace: ${result.workspace?.slug ?? result.full_name}`));
        if (result.path) console.log(`  ${chalk.dim("path:")} ${result.path}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("scan-roots")
    .description("Scan all registered roots and preview/import direct child folders")
    .option("--apply", "Import discovered workspaces instead of previewing")
    .option("--tags <tags>", "Additional comma-separated tags")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action(async (opts) => {
      try {
        const result = await importRegisteredRoots({
          dryRun: !opts.apply,
          tags: splitList(opts.tags),
          agent_id: opts.agent ? resolveAgentId(opts.agent) : undefined,
        });
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(result.dry_run ? chalk.dim(`[dry-run] Scanned ${result.roots.length} root(s)`) : chalk.green(`✓ Imported ${result.imported.length} workspace(s)`));
        console.log(`  ${chalk.dim("previews:")} ${result.previews.length}`);
        console.log(`  ${chalk.dim("skipped:")}  ${result.skipped.length}`);
        console.log(`  ${chalk.dim("errors:")}   ${result.errors.length}`);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("publish <id-or-slug>")
    .description("Publish a workspace to GitHub")
    .option("--org <org>", "GitHub organization/user")
    .option("--repo <name>", "GitHub repository name")
    .option("--visibility <visibility>", "GitHub visibility: public or private")
    .option("--public", "Make repo public")
    .option("--private", "Make repo private")
    .option("--description <text>", "Repository description")
    .option("--remote-protocol <protocol>", "Git remote protocol: https or ssh")
    .option("--no-push", "Create repo and set remote without pushing")
    .option("--dry-run", "Preview GitHub and git actions without mutating")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const workspace = resolveWorkspace(idOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
        const visibility = opts.public ? "public" : opts.private ? "private" : parseGitHubVisibility(opts.visibility);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const publish = () => publishWorkspaceToGitHub(workspace, {
          org: opts.org,
          repoName: opts.repo,
          visibility,
          description: opts.description,
          remoteProtocol: parseGitHubRemoteProtocol(opts.remoteProtocol),
          push: opts.push,
          dryRun: opts.dryRun,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        });
        const result = opts.dryRun ? publish() : withWorkspaceLock(workspace, agentId, "workspace GitHub publish", publish);
        if (wantsJson(opts)) { printObject(result, opts); return; }
        if (result.dry_run) {
          console.log(chalk.dim(`[dry-run] GitHub publish: ${result.full_name}`));
          for (const command of result.commands) console.log(`  ${chalk.dim(command)}`);
          return;
        }
        console.log(chalk.green(`✓ Published: ${result.url}`));
        if (result.pushed) console.log(chalk.dim("  pushed to origin"));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("unpublish <id-or-slug>")
    .description("Remove GitHub origin metadata from a workspace without deleting the GitHub repo")
    .option("--clear-integrations", "Clear github_repo and github_url integrations")
    .option("--dry-run", "Preview without changing git remotes or workspace metadata")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const workspace = resolveWorkspace(idOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const unpublish = () => unpublishWorkspaceFromGitHub(workspace, {
          clearIntegrations: opts.clearIntegrations,
          dryRun: opts.dryRun,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        });
        const result = opts.dryRun ? unpublish() : withWorkspaceLock(workspace, agentId, "workspace GitHub unpublish", unpublish);
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(result.dry_run ? chalk.dim(`[dry-run] Unpublish ${workspace.slug}`) : chalk.yellow(`✓ Removed GitHub remote metadata from ${workspace.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("link <id-or-slug>")
    .description("Merge external integration IDs into a workspace")
    .option("--github-repo <name>", "GitHub full name, such as org/repo")
    .option("--github-url <url>", "GitHub repository URL")
    .option("--todos-project-id <id>", "Todos project id")
    .option("--mementos-project-id <id>", "Mementos project id")
    .option("--conversations-space <space>", "Conversations space")
    .option("--files-index-id <id>", "Files index id")
    .option("--integration <key=value>", "Additional integration key=value", collectOption, [])
    .option("--integrations-json <json>", "Additional integrations JSON object")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const workspace = resolveWorkspace(idOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
        const integrations = mergeIntegrations(
          {
            github_repo: opts.githubRepo,
            github_url: opts.githubUrl,
            todos_project_id: opts.todosProjectId,
            mementos_project_id: opts.mementosProjectId,
            conversations_space: opts.conversationsSpace,
            files_index_id: opts.filesIndexId,
          },
          parseIntegrationPairs(opts.integration),
          parseIntegrationsJson(opts.integrationsJson),
        );
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const updated = withWorkspaceLock(workspace, agentId, "workspace integration link", () => linkWorkspaceExternalIntegrations(workspace, integrations, {
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(updated, opts); return; }
        console.log(chalk.green(`✓ Linked integrations for ${updated.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .option("--kind <kind>", "Filter by kind")
    .option("--status <status>", "Filter by status")
    .option("--query <text>", "Search name, slug, description, or path")
    .option("--tags <tags>", "Comma-separated tag filter")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const workspaces = listWorkspaces({
          kind: parseKind(opts.kind),
          status: parseStatus(opts.status),
          query: opts.query,
          tags: splitList(opts.tags),
        });
        if (wantsJson(opts)) { printObject(workspaces, opts); return; }
        printRows(workspaces.map((workspace) => ({
          slug: workspace.slug,
          kind: workspace.kind,
          status: workspace.status,
          path: workspace.primary_path ?? "",
        })), ["slug", "kind", "status", "path"]);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("show <id-or-slug>")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      const workspace = resolveWorkspace(idOrSlug);
      if (!workspace) {
        console.error(chalk.red(`Workspace not found: ${idOrSlug}`));
        process.exit(1);
      }
      const payload = {
        workspace,
        locations: listWorkspaceLocations(workspace.id),
        events: listWorkspaceEvents(workspace.id),
      };
      if (wantsJson(opts)) { printObject(payload, opts); return; }
      console.log(`${chalk.bold(workspace.name)} ${chalk.dim(`(${workspace.slug})`)} ${chalk.green(`[${workspace.status}]`)}`);
      console.log(`  ${chalk.dim("id:")}   ${workspace.id}`);
      console.log(`  ${chalk.dim("kind:")} ${workspace.kind}`);
      if (workspace.primary_path) console.log(`  ${chalk.dim("path:")} ${workspace.primary_path}`);
      if (workspace.tags.length) console.log(`  ${chalk.dim("tags:")} ${workspace.tags.join(", ")}`);
    });

  cmd
    .command("update <id-or-slug>")
    .description("Update workspace metadata")
    .option("--name <name>", "Workspace name")
    .option("--slug <slug>", "Workspace slug")
    .option("--description <text>", "Description")
    .option("--kind <kind>", `Workspace kind (${WORKSPACE_KINDS.join(", ")})`)
    .option("--status <status>", `Workspace status (${WORKSPACE_STATUSES.join(", ")})`)
    .option("--root <id-or-slug>", "Root id or slug")
    .option("--clear-root", "Clear root")
    .option("--recipe <id-or-slug>", "Recipe id or slug")
    .option("--clear-recipe", "Clear recipe")
    .option("--path <path>", "Primary path")
    .option("--clear-path", "Clear primary path")
    .option("--tags <tags>", "Replace tags with comma-separated tags")
    .option("--git-remote <url>", "Git remote URL")
    .option("--clear-git-remote", "Clear git remote")
    .option("--s3-bucket <bucket>", "S3 bucket")
    .option("--clear-s3-bucket", "Clear S3 bucket")
    .option("--s3-prefix <prefix>", "S3 prefix")
    .option("--clear-s3-prefix", "Clear S3 prefix")
    .option("--integrations-json <json>", "Replace integrations with a JSON object")
    .option("--metadata-json <json>", "Replace metadata with a JSON object")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const workspace = resolveWorkspace(idOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const updated = withWorkspaceLock(workspace, agentId, "workspace update", () => updateWorkspace(workspace.id, {
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          kind: parseKind(opts.kind),
          status: parseStatus(opts.status),
          root_id: opts.clearRoot ? null : resolveRootId(opts.root),
          recipe_id: opts.clearRecipe ? null : resolveRecipeId(opts.recipe),
          primary_path: opts.clearPath ? null : opts.path,
          tags: opts.tags === undefined ? undefined : splitList(opts.tags),
          git_remote: opts.clearGitRemote ? null : opts.gitRemote,
          s3_bucket: opts.clearS3Bucket ? null : opts.s3Bucket,
          s3_prefix: opts.clearS3Prefix ? null : opts.s3Prefix,
          integrations: parseIntegrationsJson(opts.integrationsJson),
          metadata: parseJsonObject(opts.metadataJson, "--metadata-json"),
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(updated, opts); return; }
        console.log(chalk.green(`✓ Workspace updated: ${updated.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("archive <id-or-slug>")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const workspace = resolveWorkspace(idOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const archived = withWorkspaceLock(workspace, agentId, "workspace archive", () => archiveWorkspace(workspace.id, {
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(archived, opts); return; }
        console.log(chalk.green(`✓ Archived ${archived.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("unarchive <id-or-slug>")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const workspace = resolveWorkspace(idOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const unarchived = withWorkspaceLock(workspace, agentId, "workspace unarchive", () => unarchiveWorkspace(workspace.id, {
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(unarchived, opts); return; }
        console.log(chalk.green(`✓ Unarchived ${unarchived.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("delete <id-or-slug>")
    .description("Mark a workspace deleted, or hard-delete the row with --hard")
    .option("--hard", "Hard-delete the workspace row")
    .option("--agent <id-or-slug>", "Attributing agent")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const workspace = resolveWorkspace(idOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
        const agentId = opts.agent ? resolveAgentId(opts.agent) : ensureCliAgent().id;
        const result = withWorkspaceLock(workspace, agentId, "workspace delete", () => deleteWorkspace(workspace.id, {
          hard: opts.hard,
          agent_id: agentId,
          source: "cli",
          command: process.argv.join(" "),
        }));
        if (wantsJson(opts)) { printObject(result, opts); return; }
        console.log(result.hard ? chalk.yellow(`Deleted ${result.workspace.slug}`) : chalk.green(`✓ Marked deleted ${result.workspace.slug}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("doctor [id-or-slug]")
    .option("--fix", "Apply safe fixes")
    .option("--dry-run", "Preview fixes without writing")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      const runDoctor = (workspace: Workspace) => opts.fix && !opts.dryRun
        ? withWorkspaceLock(workspace, ensureCliAgent().id, "workspace doctor fix", () => doctorWorkspace(workspace, { fix: opts.fix, dryRun: opts.dryRun }))
        : doctorWorkspace(workspace, { fix: opts.fix, dryRun: opts.dryRun });
      const results = idOrSlug
        ? (() => {
            const workspace = resolveWorkspace(idOrSlug);
            if (!workspace) {
              console.error(chalk.red(`Workspace not found: ${idOrSlug}`));
              process.exit(1);
            }
            return [runDoctor(workspace)];
          })()
        : listWorkspaces({ limit: 500 }).map(runDoctor);
      if (wantsJson(opts)) { printObject(results, opts); return; }
      for (const result of results) {
        console.log(`${chalk.bold(result.workspace.slug)} ${result.ok ? chalk.green("[ok]") : chalk.yellow("[needs attention]")}`);
        for (const check of result.checks) {
          const color = check.status === "ok" ? chalk.green : check.status === "error" ? chalk.red : chalk.yellow;
          console.log(`  ${color(check.status)} ${check.code} ${chalk.dim(check.message)}`);
        }
      }
    });

  cmd
    .command("lock <id-or-slug>")
    .option("--key <key>", "Explicit lock key")
    .option("--agent <id-or-slug>", "Locking agent")
    .option("--reason <reason>", "Reason")
    .option("--ttl <seconds>", "TTL in seconds")
    .option("-j, --json", "Output JSON")
    .action((idOrSlug, opts) => {
      try {
        const workspace = resolveWorkspace(idOrSlug);
        if (!workspace) throw new Error(`Workspace not found: ${idOrSlug}`);
        const lock = acquireWorkspaceLock({
          lock_key: opts.key ?? `workspace:${workspace.id}`,
          workspace_id: workspace.id,
          agent_id: opts.agent ? resolveAgentId(opts.agent) : undefined,
          reason: opts.reason,
          ttl_seconds: opts.ttl ? Number.parseInt(opts.ttl, 10) : undefined,
        });
        if (wantsJson(opts)) { printObject(lock, opts); return; }
        console.log(chalk.green(`✓ Locked ${lock.lock_key}`));
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("unlock <key>")
    .option("-j, --json", "Output JSON")
    .action((key, opts) => {
      const released = releaseWorkspaceLock(key);
      if (wantsJson(opts)) { printObject({ released }, opts); return; }
      console.log(released ? chalk.green(`✓ Unlocked ${key}`) : chalk.dim(`No lock found: ${key}`));
    });

  cmd
    .command("locks")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const locks = listWorkspaceLocks();
      if (wantsJson(opts)) { printObject(locks, opts); return; }
      printRows(locks.map((lock) => ({
        key: lock.lock_key,
        workspace: lock.workspace_id ?? "",
        agent: lock.agent_id ?? "",
        expires: lock.expires_at ?? "",
      })), ["key", "workspace", "agent", "expires"]);
    });

  cmd
    .command("agent-eval")
    .description("Run prompt-agent eval cases and report pass rate/confidence")
    .option("--mock", "Use deterministic mock prompt mode; live-only cases are skipped")
    .option("--model <model>", "OpenRouter model for live eval")
    .option("--max-steps <n>", "Maximum AI SDK tool-call steps per case", "8")
    .option("--case <ids>", "Comma-separated eval case ids")
    .option("--base-path <path>", "Base path for eval fixtures")
    .option("--fail-on-error", "Exit nonzero if any executed eval case fails")
    .option("-j, --json", "Output JSON")
    .action(async (opts) => {
      try {
        const maxSteps = Number.parseInt(opts.maxSteps, 10);
        if (!Number.isInteger(maxSteps) || maxSteps <= 0) throw new Error("--max-steps must be a positive integer");
        const result = await runWorkspaceAgentEval({
          mock: opts.mock,
          model: opts.model,
          maxSteps,
          caseIds: parseWorkspaceAgentEvalCaseIds(opts.case),
          basePath: opts.basePath,
        });
        if (wantsJson(opts)) {
          printObject(result, opts);
        } else {
          const rate = `${Math.round(result.summary.success_rate * 100)}%`;
          const confidence = `${Math.round(result.summary.confidence * 100)}%`;
          console.log(`${result.summary.failed === 0 ? chalk.green("✓") : chalk.red("✗")} agent eval ${rate} success, ${confidence} confidence`);
          console.log(`  ${chalk.dim("executed:")} ${result.summary.executed}`);
          console.log(`  ${chalk.dim("passed:")}   ${result.summary.passed}`);
          console.log(`  ${chalk.dim("failed:")}   ${result.summary.failed}`);
          console.log(`  ${chalk.dim("skipped:")}  ${result.summary.skipped}`);
          for (const item of result.cases) {
            const status = item.skipped ? chalk.dim("skipped") : item.passed ? chalk.green("pass") : chalk.red("fail");
            console.log(`  ${status} ${item.id}`);
          }
        }
        if (opts.failOnError && result.summary.failed > 0) process.exit(1);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  cmd
    .command("migrate-legacy")
    .description("Migrate old projects table rows into the new workspace tables")
    .option("--dry-run", "Run migration against a temporary database copy")
    .option("--db <path>", "SQLite database path")
    .option("--backup-dir <path>", "Directory for the pre-migration backup snapshot")
    .option("--backup-path <path>", "Exact pre-migration backup snapshot path")
    .option("--report <path>", "Write a JSON migration report")
    .option("--no-backup", "Skip the pre-migration backup snapshot")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      try {
        const report = runWorkspaceLegacyMigration({
          dbPath: opts.db,
          dryRun: opts.dryRun,
          backup: opts.backup,
          backupDir: opts.backupDir,
          backupPath: opts.backupPath,
          reportPath: opts.report,
        });
        const result = report.result;
        if (wantsJson(opts)) {
          printObject(report, opts);
          if (!result.validation.valid) process.exitCode = 1;
          return;
        }
        const mark = result.validation.valid ? chalk.green("✓") : chalk.red("✗");
        console.log(`${mark} Legacy project migration ${report.dry_run ? "dry-run checked" : "checked"}`);
        console.log(`  ${chalk.dim("migrated:")} ${result.migrated}`);
        console.log(`  ${chalk.dim("skipped:")}  ${result.skipped}`);
        console.log(`  ${chalk.dim("roots:")}    ${result.roots_created_or_reused}`);
        console.log(`  ${chalk.dim("workdirs:")} ${result.workdirs_migrated} migrated, ${result.workdirs_skipped} skipped`);
        console.log(`  ${chalk.dim("valid:")}    ${String(result.validation.valid)}`);
        if (report.backup_path) console.log(`  ${chalk.dim("backup:")}   ${report.backup_path}`);
        if (report.report_path) console.log(`  ${chalk.dim("report:")}   ${report.report_path}`);
        if (!result.validation.valid) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
