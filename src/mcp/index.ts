#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isHttpMode, startMcpHttpServer, resolveMcpHttpPort } from "./http.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  acquireWorkspaceLock,
  addTmuxProfileWindow,
  archiveWorkspace,
  createAgent,
  createRecipe,
  createRoot,
  createTmuxProfile,
  deleteRoot,
  deleteWorkspace,
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
  resolveTmuxProfile,
  resolveWorkspace,
  unarchiveWorkspace,
  updateRoot,
  updateWorkspace,
} from "../db/workspaces.js";
import { runWorkspaceAgentPrompt } from "../lib/workspace-agent.js";
import { parseWorkspaceAgentEvalCaseIds, runWorkspaceAgentEval } from "../lib/workspace-agent-eval.js";
import { doctorWorkspace } from "../lib/workspace-doctor.js";
import { builtInWorkspaceRecipes, ensureBuiltInWorkspaceRecipes } from "../lib/workspace-defaults.js";
import {
  importWorkspaceFromGitHub,
  linkWorkspaceExternalIntegrations,
  publishWorkspaceToGitHub,
  unpublishWorkspaceFromGitHub,
  type GitHubRemoteProtocol,
  type GitHubVisibility,
} from "../lib/workspace-github.js";
import { importRegisteredRoots, importWorkspace, importWorkspaceBulk } from "../lib/workspace-import.js";
import { runWorkspaceLegacyMigration } from "../lib/workspace-migration.js";
import {
  cleanupWorkspaceCreationTarget,
  executeWorkspaceCreation,
  type WorkspaceCreationPlanAction,
} from "../lib/workspace-plan.js";
import { applyWorkspaceTmuxProfile } from "../lib/workspace-runtime.js";
import type { AgentKind, Workspace, WorkspaceIntegrations, WorkspaceKind } from "../types/workspace.js";

function getPkgVersion(): string {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return (JSON.parse(readFileSync(p, "utf-8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

function printHelp(): void {
  console.log(`Usage: projects-mcp [options]

MCP server for generic workspace orchestration tools (stdio transport by default)

Options:
  --http         serve MCP over Streamable HTTP on 127.0.0.1 (also MCP_HTTP=1)
  --port <n>     HTTP port (default 8871, or MCP_HTTP_PORT)
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

export function buildServer(): McpServer {
const server = new McpServer({
  name: "projects",
  version: getPkgVersion(),
});

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorText(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function rootId(idOrSlug: string | undefined): string | undefined {
  if (!idOrSlug) return undefined;
  const root = getRoot(idOrSlug) ?? getRootBySlug(idOrSlug);
  if (!root) throw new Error(`Root not found: ${idOrSlug}`);
  return root.id;
}

function recipeId(idOrSlug: string | undefined): string | undefined {
  if (!idOrSlug) return undefined;
  const recipe = getRecipe(idOrSlug) ?? getRecipeBySlug(idOrSlug);
  if (!recipe) throw new Error(`Recipe not found: ${idOrSlug}`);
  return recipe.id;
}

function agentId(idOrSlug: string | undefined): string {
  if (!idOrSlug) return ensureCliAgent().id;
  const agent = getAgent(idOrSlug) ?? getAgentBySlug(idOrSlug);
  if (!agent) throw new Error(`Agent not found: ${idOrSlug}`);
  return agent.id;
}

function withWorkspaceMutationLock<T>(workspace: Workspace, owner: string | undefined, reason: string, fn: () => T): T {
  const key = `workspace:${workspace.id}`;
  acquireWorkspaceLock({ lock_key: key, workspace_id: workspace.id, agent_id: owner, reason, ttl_seconds: 600 });
  try {
    return fn();
  } finally {
    releaseWorkspaceLock(key);
  }
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

function cleanupTargetFromWorkspace(workspace: Workspace, rollbackActions?: WorkspaceCreationPlanAction[]) {
  if (rollbackActions?.length) {
    return {
      workspace_slug: workspace.slug,
      primary_path: workspace.primary_path,
      rollback_actions: rollbackActions,
    };
  }
  for (const event of listWorkspaceEvents(workspace.id).slice().reverse()) {
    const fromMetadata = parseRollbackActions(event.metadata.rollback_actions);
    if (fromMetadata) return { workspace_slug: workspace.slug, primary_path: workspace.primary_path, rollback_actions: fromMetadata };
    const after = event.after_json as Record<string, unknown> | null;
    const plan = after?.plan as Record<string, unknown> | undefined;
    const fromPlan = parseRollbackActions(plan?.rollback_actions);
    if (fromPlan) return { workspace_slug: workspace.slug, primary_path: workspace.primary_path, rollback_actions: fromPlan };
  }
  const fallback: WorkspaceCreationPlanAction[] = [
    { type: "rollback", action: "delete", target: `workspaces:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
    { type: "rollback", action: "delete", target: `workspace_events:${workspace.slug}`, status: "planned", metadata: { automatic: false } },
  ];
  if (workspace.primary_path) {
    fallback.push({ type: "rollback", action: "delete", target: `workspace_locations:${workspace.primary_path}`, status: "planned", metadata: { automatic: false } });
    fallback.push({ type: "rollback", action: "remove_file", target: join(workspace.primary_path, ".workspace.json"), status: "planned", metadata: { automatic: false } });
    fallback.push({ type: "rollback", action: "remove_git_dir", target: join(workspace.primary_path, ".git"), status: "planned", metadata: { automatic: false } });
    fallback.push({ type: "rollback", action: "remove_empty_directory", target: workspace.primary_path, status: "planned", metadata: { automatic: false } });
  }
  return { workspace_slug: workspace.slug, primary_path: workspace.primary_path, rollback_actions: fallback };
}

server.tool(
  "projects_roots_list",
  "List registered root folders and path templates for generic workspaces.",
  {},
  async () => jsonText(listRoots()),
);

server.tool(
  "projects_roots_add",
  "Register a root folder that workspaces can be created under.",
  {
    name: z.string(),
    path: z.string(),
    slug: z.string().optional(),
    tags: z.array(z.string()).optional(),
    kind: z.string().optional(),
    github_org: z.string().optional(),
    repo_visibility: z.enum(["public", "private"]).optional(),
    path_template: z.string().optional(),
    name_template: z.string().optional(),
  },
  async (input) => {
    try {
      return jsonText(createRoot({
        name: input.name,
        base_path: input.path,
        slug: input.slug,
        tags: input.tags,
        default_kind: input.kind as WorkspaceKind | undefined,
        github_org: input.github_org,
        repo_visibility: input.repo_visibility,
        path_template: input.path_template,
        name_template: input.name_template,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_roots_show",
  "Show one registered root by id or slug.",
  { id: z.string() },
  async (input) => {
    const root = getRoot(input.id) ?? getRootBySlug(input.id);
    return root ? jsonText(root) : errorText(`Root not found: ${input.id}`);
  },
);

server.tool(
  "projects_roots_update",
  "Update a registered root folder and its defaults.",
  {
    id: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    path: z.string().optional(),
    tags: z.array(z.string()).optional(),
    kind: z.string().nullable().optional(),
    github_org: z.string().nullable().optional(),
    repo_visibility: z.enum(["public", "private"]).nullable().optional(),
    path_template: z.string().nullable().optional(),
    name_template: z.string().nullable().optional(),
    allowed_recipes: z.array(z.string()).optional(),
    allowed_agents: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async (input) => {
    try {
      const root = getRoot(input.id) ?? getRootBySlug(input.id);
      if (!root) return errorText(`Root not found: ${input.id}`);
      return jsonText(updateRoot(root.id, {
        name: input.name,
        slug: input.slug,
        base_path: input.path,
        tags: input.tags,
        default_kind: input.kind as WorkspaceKind | null | undefined,
        github_org: input.github_org,
        repo_visibility: input.repo_visibility,
        path_template: input.path_template,
        name_template: input.name_template,
        allowed_recipes: input.allowed_recipes,
        allowed_agents: input.allowed_agents,
        metadata: input.metadata,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_roots_delete",
  "Delete a registered root. Refuses roots referenced by workspaces unless detach_workspaces=true.",
  {
    id: z.string(),
    detach_workspaces: z.boolean().optional(),
  },
  async (input) => {
    try {
      const root = getRoot(input.id) ?? getRootBySlug(input.id);
      if (!root) return errorText(`Root not found: ${input.id}`);
      return jsonText(deleteRoot(root.id, { detachWorkspaces: input.detach_workspaces }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_roots_match",
  "Score and match registered roots by path, kind, tags, and GitHub org.",
  {
    path: z.string().optional(),
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    github_org: z.string().optional(),
  },
  async (input) => jsonText(scoreRoots({
    path: input.path,
    kind: input.kind as WorkspaceKind | undefined,
    tags: input.tags,
    github_org: input.github_org,
  })),
);

server.tool(
  "projects_recipes_list",
  "List workspace recipes for agent-visible creation defaults.",
  {},
  async () => jsonText(listRecipes()),
);

server.tool(
  "projects_recipes_add",
  "Register a workspace recipe with optional default tags and JSON steps.",
  {
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    steps: z.array(z.record(z.unknown())).optional(),
  },
  async (input) => {
    try {
      return jsonText(createRecipe({
        name: input.name,
        slug: input.slug,
        description: input.description,
        kind: input.kind as WorkspaceKind | undefined,
        default_tags: input.tags,
        steps: input.steps,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_recipes_built_ins",
  "List built-in workspace recipe definitions.",
  {},
  async () => jsonText(builtInWorkspaceRecipes()),
);

server.tool(
  "projects_recipes_seed_defaults",
  "Create any missing built-in workspace recipes.",
  {},
  async () => jsonText(ensureBuiltInWorkspaceRecipes()),
);

server.tool(
  "projects_agents_list",
  "List registered agents that can own workspace changes.",
  {},
  async () => jsonText(listAgents()),
);

server.tool(
  "projects_agents_add",
  "Register a human, CLI, service, or AI agent for workspace attribution.",
  {
    name: z.string(),
    kind: z.enum(["human", "ai", "service", "cli"]),
    slug: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    role: z.string().optional(),
    permissions: z.array(z.string()).optional(),
  },
  async (input) => {
    try {
      return jsonText(createAgent({
        name: input.name,
        slug: input.slug,
        kind: input.kind as AgentKind,
        provider: input.provider,
        model: input.model,
        role: input.role,
        permissions: input.permissions,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_tmux_profiles_list",
  "List saved workspace tmux profiles.",
  {},
  async () => jsonText(listTmuxProfiles().map((profile) => ({ ...profile, windows: listTmuxProfileWindows(profile.id) }))),
);

server.tool(
  "projects_tmux_profiles_add",
  "Create a saved tmux profile with optional windows.",
  {
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    session_template: z.string().optional(),
    attach: z.boolean().optional(),
    windows: z.array(z.object({
      name: z.string(),
      path_template: z.string().optional(),
      command: z.string().optional(),
      index: z.number().int().nonnegative().optional(),
      detached: z.boolean().optional(),
    })).optional(),
  },
  async (input) => {
    try {
      const profile = createTmuxProfile({
        name: input.name,
        slug: input.slug,
        description: input.description,
        session_template: input.session_template,
        attach: input.attach,
      });
      for (const window of input.windows ?? []) {
        addTmuxProfileWindow({
          profile_id: profile.id,
          window_name_template: window.name,
          path_template: window.path_template,
          command: window.command,
          window_index: window.index,
          detached: window.detached,
        });
      }
      return jsonText({ profile, windows: listTmuxProfileWindows(profile.id) });
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

const tmuxWindowInput = z.object({
  name: z.string(),
  path: z.string().optional(),
  command: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
  detached: z.boolean().optional(),
});

const rollbackActionInput = z.object({
  type: z.literal("rollback"),
  action: z.string(),
  target: z.string(),
  status: z.literal("planned"),
  metadata: z.record(z.unknown()).optional(),
});

server.tool(
  "projects_tmux_profiles_apply",
  "Apply a saved tmux profile to a workspace.",
  {
    profile: z.string(),
    workspace: z.string(),
    dry_run: z.boolean().optional(),
  },
  async (input) => {
    try {
      const profile = resolveTmuxProfile(input.profile);
      if (!profile) return errorText(`Tmux profile not found: ${input.profile}`);
      const workspace = resolveWorkspace(input.workspace);
      if (!workspace) return errorText(`Workspace not found: ${input.workspace}`);
      const owner = ensureCliAgent().id;
      const apply = () => applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), {
        dryRun: input.dry_run,
        source: "mcp",
        command: "projects_tmux_profiles_apply",
      });
      return jsonText(input.dry_run ? apply() : withWorkspaceMutationLock(workspace, owner, "tmux profile apply", apply));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_list",
  "List generic workspaces across all registered roots and arbitrary paths.",
  {
    kind: z.string().optional(),
    status: z.enum(["active", "archived", "deleted"]).optional(),
    query: z.string().optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(500).optional(),
  },
  async (input) => jsonText(listWorkspaces({
    kind: input.kind as WorkspaceKind | undefined,
    status: input.status,
    query: input.query,
    tags: input.tags,
    limit: input.limit,
  })),
);

server.tool(
  "projects_workspaces_create",
  "Create/register a generic workspace anywhere on disk, optionally preparing directory/git and tmux windows.",
  {
    name: z.string(),
    slug: z.string().optional(),
    description: z.string().optional(),
    kind: z.string().optional(),
    root: z.string().optional(),
    recipe: z.string().optional(),
    path: z.string().optional(),
    tags: z.array(z.string()).optional(),
    agent: z.string().optional(),
    git_remote: z.string().optional(),
    mkdir: z.boolean().optional(),
    git_init: z.boolean().optional(),
    marker: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    dry_run_runtime: z.boolean().optional(),
    tmux_session: z.string().optional(),
    tmux_windows: z.array(tmuxWindowInput).optional(),
    tmux_profile: z.string().optional(),
  },
  async (input) => {
    try {
      const owner = agentId(input.agent);
      return jsonText(executeWorkspaceCreation({
        name: input.name,
        slug: input.slug,
        description: input.description,
        kind: input.kind as WorkspaceKind | undefined,
        root_id: rootId(input.root),
        recipe_id: recipeId(input.recipe),
        primary_path: input.path,
        tags: input.tags,
        git_remote: input.git_remote,
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_create",
        createDirectory: input.mkdir || input.git_init,
        gitInit: input.git_init,
        writeMarker: input.marker,
        tmux: input.tmux_session || input.tmux_windows ? {
          session: input.tmux_session,
          windows: input.tmux_windows,
        } : undefined,
        tmux_profile: input.tmux_profile,
      }, { dryRun: input.dry_run, runtimeDryRun: input.dry_run_runtime }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_import",
  "Import an existing folder or direct child folders as generic workspaces.",
  {
    path: z.string(),
    bulk: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const owner = input.agent ? agentId(input.agent) : undefined;
      return jsonText(input.bulk
        ? await importWorkspaceBulk(input.path, { dryRun: input.dry_run, tags: input.tags, agent_id: owner })
        : await importWorkspace(input.path, { dryRun: input.dry_run, tags: input.tags, agent_id: owner }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_scan_roots",
  "Scan all registered roots and preview or import direct child folders as workspaces. Dry-run by default.",
  {
    apply: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const owner = input.agent ? agentId(input.agent) : undefined;
      return jsonText(await importRegisteredRoots({
        dryRun: !input.apply,
        tags: input.tags,
        agent_id: owner,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_import_github",
  "Import a GitHub repository as a generic workspace. Can plan, clone, or register remote-only workspaces.",
  {
    repo: z.string(),
    root: z.string().optional(),
    path: z.string().optional(),
    clone: z.boolean().optional(),
    remote_only: z.boolean().optional(),
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    agent: z.string().optional(),
    remote_protocol: z.enum(["https", "ssh"]).optional(),
    dry_run: z.boolean().optional(),
  },
  async (input) => {
    try {
      const owner = input.agent ? agentId(input.agent) : undefined;
      return jsonText(await importWorkspaceFromGitHub(input.repo, {
        root: input.root,
        path: input.path,
        clone: input.clone,
        remoteOnly: input.remote_only,
        kind: input.kind as WorkspaceKind | undefined,
        tags: input.tags,
        remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
        dryRun: input.dry_run,
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_import_github",
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_github_publish",
  "Publish a workspace to GitHub. Creates the repo, updates workspace git/integration metadata, and can push local git.",
  {
    workspace: z.string(),
    org: z.string().optional(),
    repo: z.string().optional(),
    visibility: z.enum(["public", "private"]).optional(),
    description: z.string().optional(),
    remote_protocol: z.enum(["https", "ssh"]).optional(),
    push: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.workspace);
      if (!workspace) return errorText(`Workspace not found: ${input.workspace}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const publish = () => publishWorkspaceToGitHub(workspace, {
        org: input.org,
        repoName: input.repo,
        visibility: input.visibility as GitHubVisibility | undefined,
        description: input.description,
        remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
        push: input.push,
        dryRun: input.dry_run,
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_github_publish",
      });
      return jsonText(input.dry_run ? publish() : withWorkspaceMutationLock(workspace, owner, "workspace GitHub publish", publish));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_github_unpublish",
  "Remove GitHub origin metadata from a workspace without deleting the GitHub repo.",
  {
    workspace: z.string(),
    clear_integrations: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.workspace);
      if (!workspace) return errorText(`Workspace not found: ${input.workspace}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      const unpublish = () => unpublishWorkspaceFromGitHub(workspace, {
        clearIntegrations: input.clear_integrations,
        dryRun: input.dry_run,
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_github_unpublish",
      });
      return jsonText(input.dry_run ? unpublish() : withWorkspaceMutationLock(workspace, owner, "workspace GitHub unpublish", unpublish));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_integrations_link",
  "Merge external integration IDs into a workspace and record an update event.",
  {
    workspace: z.string(),
    integrations: z.record(z.string()),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.workspace);
      if (!workspace) return errorText(`Workspace not found: ${input.workspace}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      return jsonText(linkWorkspaceExternalIntegrations(workspace, input.integrations as WorkspaceIntegrations, {
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_integrations_link",
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_show",
  "Show a generic workspace with locations and event history.",
  { id: z.string() },
  async (input) => {
    const workspace = resolveWorkspace(input.id);
    if (!workspace) return errorText(`Workspace not found: ${input.id}`);
    return jsonText({
      workspace,
      locations: listWorkspaceLocations(workspace.id),
      events: listWorkspaceEvents(workspace.id),
    });
  },
);

server.tool(
  "projects_workspaces_update",
  "Update generic workspace metadata. Acquires a workspace mutation lock and records an immutable event.",
  {
    id: z.string(),
    name: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().nullable().optional(),
    kind: z.string().optional(),
    status: z.enum(["active", "archived", "deleted"]).optional(),
    root: z.string().optional(),
    clear_root: z.boolean().optional(),
    recipe: z.string().optional(),
    clear_recipe: z.boolean().optional(),
    path: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    git_remote: z.string().nullable().optional(),
    s3_bucket: z.string().nullable().optional(),
    s3_prefix: z.string().nullable().optional(),
    integrations: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.id);
      if (!workspace) return errorText(`Workspace not found: ${input.id}`);
      const owner = agentId(input.agent);
      return jsonText(withWorkspaceMutationLock(workspace, owner, "workspace update", () => updateWorkspace(workspace.id, {
        name: input.name,
        slug: input.slug,
        description: input.description,
        kind: input.kind as WorkspaceKind | undefined,
        status: input.status,
        root_id: input.clear_root ? null : rootId(input.root),
        recipe_id: input.clear_recipe ? null : recipeId(input.recipe),
        primary_path: input.path,
        tags: input.tags,
        git_remote: input.git_remote,
        s3_bucket: input.s3_bucket,
        s3_prefix: input.s3_prefix,
        integrations: input.integrations as WorkspaceIntegrations | undefined,
        metadata: input.metadata,
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_update",
      })));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_archive",
  "Archive a generic workspace. Acquires a mutation lock and records an event.",
  { id: z.string(), agent: z.string().optional() },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.id);
      if (!workspace) return errorText(`Workspace not found: ${input.id}`);
      const owner = agentId(input.agent);
      return jsonText(withWorkspaceMutationLock(workspace, owner, "workspace archive", () => archiveWorkspace(workspace.id, {
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_archive",
      })));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_unarchive",
  "Restore an archived or deleted generic workspace to active.",
  { id: z.string(), agent: z.string().optional() },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.id);
      if (!workspace) return errorText(`Workspace not found: ${input.id}`);
      const owner = agentId(input.agent);
      return jsonText(withWorkspaceMutationLock(workspace, owner, "workspace unarchive", () => unarchiveWorkspace(workspace.id, {
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_unarchive",
      })));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_delete",
  "Mark a generic workspace deleted, or hard-delete the row when hard=true.",
  { id: z.string(), hard: z.boolean().optional(), agent: z.string().optional() },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.id);
      if (!workspace) return errorText(`Workspace not found: ${input.id}`);
      const owner = agentId(input.agent);
      return jsonText(withWorkspaceMutationLock(workspace, owner, "workspace delete", () => deleteWorkspace(workspace.id, {
        hard: input.hard,
        agent_id: owner,
        source: "mcp",
        command: "projects_workspaces_delete",
      })));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_cleanup_create",
  "Safely clean up DB/files created by a workspace creation run using stored or supplied rollback actions.",
  {
    workspace: z.string(),
    rollback_actions: z.array(rollbackActionInput).optional(),
    dry_run: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.workspace);
      if (!workspace) return errorText(`Workspace not found: ${input.workspace}`);
      const owner = input.agent ? agentId(input.agent) : ensureCliAgent().id;
      return jsonText(withWorkspaceMutationLock(workspace, owner, "workspace creation cleanup", () => cleanupWorkspaceCreationTarget(
        cleanupTargetFromWorkspace(workspace, input.rollback_actions),
        {
          dryRun: input.dry_run,
          agentId: owner,
          source: "mcp",
          command: "projects_workspaces_cleanup_create",
        },
      )));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_doctor",
  "Check one or all workspaces for path, marker, reference, location, and failed-run issues.",
  {
    id: z.string().optional(),
    fix: z.boolean().optional(),
    dry_run: z.boolean().optional(),
  },
  async (input) => {
    const options = { fix: input.fix, dryRun: input.dry_run };
    if (input.id) {
      const workspace = resolveWorkspace(input.id);
      if (!workspace) return errorText(`Workspace not found: ${input.id}`);
      const owner = ensureCliAgent().id;
      const result = input.fix && !input.dry_run
        ? withWorkspaceMutationLock(workspace, owner, "workspace doctor fix", () => doctorWorkspace(workspace, options))
        : doctorWorkspace(workspace, options);
      return jsonText([result]);
    }
    const owner = ensureCliAgent().id;
    return jsonText(listWorkspaces({ limit: 500 }).map((workspace) => input.fix && !input.dry_run
      ? withWorkspaceMutationLock(workspace, owner, "workspace doctor fix", () => doctorWorkspace(workspace, options))
      : doctorWorkspace(workspace, options)));
  },
);

server.tool(
  "projects_workspaces_lock",
  "Acquire a workspace mutation lock.",
  {
    workspace: z.string(),
    key: z.string().optional(),
    agent: z.string().optional(),
    reason: z.string().optional(),
    ttl_seconds: z.number().int().positive().optional(),
  },
  async (input) => {
    try {
      const workspace = resolveWorkspace(input.workspace);
      if (!workspace) return errorText(`Workspace not found: ${input.workspace}`);
      return jsonText(acquireWorkspaceLock({
        lock_key: input.key ?? `workspace:${workspace.id}`,
        workspace_id: workspace.id,
        agent_id: input.agent ? agentId(input.agent) : undefined,
        reason: input.reason,
        ttl_seconds: input.ttl_seconds,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_workspaces_unlock",
  "Release a workspace mutation lock.",
  { key: z.string() },
  async (input) => jsonText({ released: releaseWorkspaceLock(input.key) }),
);

server.tool(
  "projects_workspaces_locks",
  "List currently held workspace mutation locks.",
  {},
  async () => jsonText(listWorkspaceLocks()),
);

server.tool(
  "projects_workspaces_migrate_legacy",
  "Migrate rows from the legacy projects table into the generic workspace tables.",
  {
    dry_run: z.boolean().optional(),
    db_path: z.string().optional(),
    backup: z.boolean().optional(),
    backup_dir: z.string().optional(),
    backup_path: z.string().optional(),
    report_path: z.string().optional(),
  },
  async (input) => {
    try {
      return jsonText(runWorkspaceLegacyMigration({
        dbPath: input.db_path,
        dryRun: input.dry_run,
        backup: input.backup,
        backupDir: input.backup_dir,
        backupPath: input.backup_path,
        reportPath: input.report_path,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_agent_eval",
  "Run workspace prompt-agent eval cases and return pass rate/confidence.",
  {
    mock: z.boolean().optional(),
    model: z.string().optional(),
    max_steps: z.number().int().positive().max(20).optional(),
    cases: z.array(z.string()).optional(),
    base_path: z.string().optional(),
  },
  async (input) => {
    try {
      return jsonText(await runWorkspaceAgentEval({
        mock: input.mock,
        model: input.model,
        maxSteps: input.max_steps,
        caseIds: parseWorkspaceAgentEvalCaseIds(input.cases?.join(",")),
        basePath: input.base_path,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "projects_agent_prompt",
  "Run the AI SDK/OpenRouter workspace agent prompt loop. Use dry_run unless explicit mutation is desired.",
  {
    prompt: z.string(),
    yes: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    model: z.string().optional(),
    max_steps: z.number().int().positive().max(20).optional(),
    agent: z.string().optional(),
    root: z.string().optional(),
    recipe: z.string().optional(),
    tmux: z.boolean().optional(),
    mock: z.boolean().optional(),
  },
  async (input) => {
    try {
      return jsonText(await runWorkspaceAgentPrompt({
        prompt: input.prompt,
        approve: input.yes,
        dryRun: input.dry_run,
        model: input.model,
        maxSteps: input.max_steps,
        agent: input.agent,
        root: input.root,
        recipe: input.recipe,
        tmux: input.tmux,
        mock: input.mock,
      }));
    } catch (err) {
      return errorText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (isHttpMode(args)) {
    startMcpHttpServer({ name: "projects", port: resolveMcpHttpPort(args), buildServer });
    return;
  }
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
}

if (import.meta.main) {
  await main();
}
