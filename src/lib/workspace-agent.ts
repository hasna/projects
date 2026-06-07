import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, stepCountIs, tool } from "ai";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  acquireWorkspaceLock,
  archiveWorkspace,
  deleteWorkspace,
  completeAgentRun,
  createAgent,
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
  listWorkspaceEvents,
  listTmuxProfiles,
  listTmuxProfileWindows,
  listWorkspaces,
  mergeAgentPermissions,
  recordWorkspaceEvent,
  releaseWorkspaceLock,
  resolveTmuxProfile,
  resolveWorkspace,
  scoreRoots,
  startAgentRun,
  unarchiveWorkspace,
  updateWorkspace,
} from "../db/workspaces.js";
import { applyWorkspaceTmux, applyWorkspaceTmuxProfile, type WorkspaceTmuxWindowSpec } from "./workspace-runtime.js";
import {
  importWorkspaceFromGitHub,
  linkWorkspaceExternalIntegrations,
  normalizeWorkspaceIntegrations,
  publishWorkspaceToGitHub,
  type GitHubRemoteProtocol,
  type GitHubVisibility,
} from "./workspace-github.js";
import { doctorWorkspace } from "./workspace-doctor.js";
import { importRegisteredRoots, importWorkspace, importWorkspaceBulk, planWorkspaceImport } from "./workspace-import.js";
import {
  cleanupWorkspaceCreationTarget,
  executeWorkspaceCreation,
  planWorkspaceCreation,
  type WorkspaceCreationPlanAction,
} from "./workspace-plan.js";
import { WORKSPACE_KINDS, type Agent, type JsonObject, type Workspace, type WorkspaceIntegrations, type WorkspaceKind } from "../types/workspace.js";

export const DEFAULT_WORKSPACE_AGENT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_SECRET_KEYS = ["hasna/takumi/live/openrouter_api_key", "openrouter/api_key", "OPENROUTER_API_KEY"];

export interface WorkspaceAgentPromptOptions {
  prompt: string;
  model?: string;
  maxSteps?: number;
  dryRun?: boolean;
  approve?: boolean;
  mock?: boolean;
  agent?: string;
  root?: string;
  recipe?: string;
  tmux?: boolean;
}

export interface WorkspaceAgentPromptResult {
  mode: "ai" | "mock";
  run_id: string;
  agent_id: string;
  provider: "openrouter";
  model: string;
  actor_agent_id: string;
  approved: boolean;
  dry_run: boolean;
  text: string;
  workspaces: Workspace[];
  tool_calls: JsonObject[];
  usage?: JsonObject;
}

function pickModel(model?: string): string {
  return model ?? process.env["WORKSPACES_AGENT_MODEL"] ?? process.env["OPENROUTER_MODEL"] ?? DEFAULT_WORKSPACE_AGENT_MODEL;
}

function getSecretValue(key: string): string | null {
  try {
    const result = Bun.spawnSync({
      cmd: ["secrets", "get", key],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    const value = Buffer.from(result.stdout).toString("utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function resolveOpenRouterApiKey(): string | null {
  const envKey = process.env["OPENROUTER_API_KEY"] ?? process.env["WORKSPACES_OPENROUTER_API_KEY"];
  if (envKey) return envKey;
  if (process.env["WORKSPACES_USE_SECRETS"] === "false") return null;

  const configured = process.env["WORKSPACES_OPENROUTER_SECRET_KEY"];
  const candidates = configured ? [configured] : DEFAULT_SECRET_KEYS;
  for (const key of candidates) {
    const value = getSecretValue(key);
    if (value) return value;
  }
  return null;
}

function ensureWorkspaceAgent(model: string): Agent {
  const existing = getAgentBySlug("workspace-agent");
  const permissions = [
    "workspace:create",
    "workspace:update",
    "workspace:delete",
    "workspace:import",
    "workspace:prepare",
    "github:publish",
    "tmux:apply",
    "doctor:fix",
    "agent-runs:record",
  ];
  if (existing) {
    const missing = permissions.filter((permission) => !existing.permissions.includes(permission));
    if (missing.length === 0) return existing;
    return mergeAgentPermissions(existing.id, permissions);
  }
  return createAgent({
    slug: "workspace-agent",
    name: "Workspace Agent",
    kind: "ai",
    provider: "openrouter",
    model,
    role: "workspace-orchestrator",
    permissions,
  });
}

function compactRoot(root: ReturnType<typeof listRoots>[number]): JsonObject {
  return {
    id: root.id,
    slug: root.slug,
    name: root.name,
    base_path: root.base_path,
    tags: root.tags,
    default_kind: root.default_kind,
    path_template: root.path_template,
    github_org: root.github_org,
    repo_visibility: root.repo_visibility,
  };
}

function compactWorkspace(workspace: Workspace): JsonObject {
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    kind: workspace.kind,
    status: workspace.status,
    primary_path: workspace.primary_path,
    tags: workspace.tags,
  };
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

function resolvePromptAgent(idOrSlug: string | undefined): Agent | null {
  if (!idOrSlug) return null;
  const agent = getAgent(idOrSlug) ?? getAgentBySlug(idOrSlug);
  if (!agent) throw new Error(`Agent not found: ${idOrSlug}`);
  return agent;
}

function promptCommand(options: WorkspaceAgentPromptOptions): string {
  const flags: string[] = [];
  if (options.approve) flags.push("--yes");
  if (options.dryRun) flags.push("--dry-run");
  if (options.model) flags.push("--model", options.model);
  if (options.maxSteps) flags.push("--max-steps", String(options.maxSteps));
  if (options.agent) flags.push("--agent", options.agent);
  if (options.root) flags.push("--root", options.root);
  if (options.recipe) flags.push("--recipe", options.recipe);
  if (options.tmux === false) flags.push("--no-tmux");
  return ["projects", ...flags, JSON.stringify(options.prompt)].join(" ");
}

function splitPromptName(prompt: string): string {
  const quoted = prompt.match(/["']([^"']+)["']/)?.[1];
  if (quoted) return quoted.trim();
  const named = prompt.match(/\bnamed\s+(.+?)(?:\s+(?:in|at|under)\s+\/|\s+with\b|[.,;:]|$)/i)?.[1];
  if (named) return named.trim();
  return prompt
    .replace(/\b(plan|create|make|new|generic|workspace|project|repo|repository|folder|directory)\b/gi, " ")
    .replace(/\b(in|at|under)\s+\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ") || "New Workspace";
}

function inferPathFromPrompt(prompt: string): string | undefined {
  const path = prompt.match(/\b(?:in|at|under)\s+(\/\S+)/i)?.[1] ?? prompt.match(/(\/[^\s]+)/)?.[1];
  return path?.replace(/[.,;:!?)]$/, "");
}

function isCreateIntent(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(plan|create|make|new|scaffold)\b/.test(text) && /\b(workspace|project|repo|repository|folder|directory|app|tool|site|service)\b/.test(text);
}

function hasToolCall(toolCalls: JsonObject[], name: string): boolean {
  return toolCalls.some((call) => call["name"] === name);
}

function hasMutationToolCall(toolCalls: JsonObject[]): boolean {
  const mutationTools = new Set([
    "workspace_create",
    "workspace_update",
    "workspace_archive",
    "workspace_unarchive",
    "workspace_delete",
    "workspace_cleanup_create",
    "workspace_import",
    "workspace_scan_roots",
    "workspace_tmux_apply",
    "workspace_github_publish",
    "workspace_github_import",
    "workspace_integrations_link",
    "workspace_event_record",
  ]);
  return toolCalls.some((call) => typeof call["name"] === "string" && mutationTools.has(call["name"]));
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

function withAgentWorkspaceLock<T>(workspace: Workspace, agentId: string, reason: string, fn: () => T): T {
  const key = `workspace:${workspace.id}`;
  acquireWorkspaceLock({ lock_key: key, workspace_id: workspace.id, agent_id: agentId, reason, ttl_seconds: 600 });
  try {
    return fn();
  } finally {
    releaseWorkspaceLock(key);
  }
}

function fallbackWorkspaceCreate(
  agent: Agent,
  options: Required<Pick<WorkspaceAgentPromptOptions, "prompt" | "dryRun" | "approve">> & {
    root_id?: string;
    recipe_id?: string;
    command: string;
  },
): { call: JsonObject; workspace?: Workspace; text: string } | null {
  if (!isCreateIntent(options.prompt)) return null;
  const workspaceInput = {
    name: splitPromptName(options.prompt),
    primary_path: options.root_id ? undefined : inferPathFromPrompt(options.prompt),
    root_id: options.root_id,
    recipe_id: options.recipe_id,
    agent_id: agent.id,
    source: "agent" as const,
    prompt: options.prompt,
    command: options.command,
  };

  if (options.approve && !options.dryRun) {
    const result = executeWorkspaceCreation(workspaceInput);
    return {
      workspace: result.workspace ?? undefined,
      text: result.workspace
        ? `Created workspace ${result.workspace.slug}.`
        : `Executed workspace creation fallback for ${workspaceInput.name}.`,
      call: {
        name: "workspace_create",
        input: workspaceInput,
        success: true,
        fallback: true,
        output: { status: "created", ...result, workspace: result.workspace ? compactWorkspace(result.workspace) : null },
      },
    };
  }

  const plan = planWorkspaceCreation(workspaceInput);
  return {
    text: `Planned workspace ${plan.workspace.slug}${plan.workspace.primary_path ? ` at ${plan.workspace.primary_path}` : ""}. Run again with --yes to create it.`,
    call: {
      name: "workspace_create",
      input: workspaceInput,
      success: true,
      fallback: true,
      output: { status: "planned", plan, note: "Run again with --yes to create this workspace." },
    },
  };
}

function extractToolCalls(result: { steps?: Array<{ toolCalls?: unknown[]; toolResults?: unknown[] }> }): JsonObject[] {
  const calls: JsonObject[] = [];
  for (const step of result.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      calls.push(call as unknown as JsonObject);
    }
    for (const toolResult of step.toolResults ?? []) {
      calls.push(toolResult as unknown as JsonObject);
    }
  }
  return calls;
}

async function runMockPrompt(
  agent: Agent,
  runId: string,
  options: Required<Pick<WorkspaceAgentPromptOptions, "prompt" | "dryRun" | "approve">> & {
    model: string;
    root_id?: string;
    recipe_id?: string;
    command: string;
  },
): Promise<WorkspaceAgentPromptResult> {
  const plannedPath = inferPathFromPrompt(options.prompt);
  const workspaceInput = {
    name: splitPromptName(options.prompt),
    primary_path: options.root_id ? undefined : plannedPath,
    root_id: options.root_id,
    recipe_id: options.recipe_id,
    agent_id: agent.id,
    source: "agent" as const,
    prompt: options.prompt,
    command: options.command,
    tags: ["agent-created"],
  };

  const workspaces: Workspace[] = [];
  const plan = planWorkspaceCreation(workspaceInput);
  const toolCalls: JsonObject[] = [{
    name: "workspace_create",
    input: workspaceInput,
    dry_run: options.dryRun,
    approved: options.approve,
    output: { status: options.approve && !options.dryRun ? "created" : "planned", plan },
  }];

  if (options.approve && !options.dryRun) {
    const result = executeWorkspaceCreation(workspaceInput);
    if (result.workspace) workspaces.push(result.workspace);
    toolCalls[0]!["output"] = {
      status: "created",
      plan,
      workspace: result.workspace ? compactWorkspace(result.workspace) : null,
    };
  }

  const text = workspaces.length > 0
    ? `Created workspace ${workspaces[0]!.slug}.`
    : `Plan: create workspace "${workspaceInput.name}"${plan.workspace.primary_path ? ` at ${plan.workspace.primary_path}` : ""}. Run with --yes to execute.`;

  completeAgentRun(runId, {
    status: "completed",
    workspace_id: workspaces[0]?.id,
    tool_calls: toolCalls,
    result: { text, plan, workspaces: workspaces.map(compactWorkspace) },
  });

  return {
    mode: "mock",
    run_id: runId,
    agent_id: agent.id,
    provider: "openrouter",
    model: options.model,
    actor_agent_id: agent.id,
    approved: options.approve,
    dry_run: options.dryRun,
    text,
    workspaces,
    tool_calls: toolCalls,
  };
}

const tmuxWindowSchema = z.object({
  name: z.string().min(1).describe("Window name"),
  path: z.string().optional().describe("Optional working directory for this tmux window"),
  command: z.string().optional().describe("Optional command to send or launch in the window"),
  index: z.number().int().nonnegative().optional().describe("Optional tmux window index"),
  detached: z.boolean().optional().describe("Create the window detached; default true"),
});

export async function runWorkspaceAgentPrompt(options: WorkspaceAgentPromptOptions): Promise<WorkspaceAgentPromptResult> {
  const model = pickModel(options.model);
  const dryRun = Boolean(options.dryRun);
  const approve = Boolean(options.approve) && !dryRun;
  const mock = Boolean(options.mock || process.env["WORKSPACES_AGENT_MOCK"]);
  const runAgent = ensureWorkspaceAgent(model);
  const actorAgent = resolvePromptAgent(options.agent) ?? runAgent;
  const forcedRootId = resolveRootId(options.root);
  const forcedRecipeId = resolveRecipeId(options.recipe);
  const tmuxAllowed = options.tmux !== false;
  const command = promptCommand(options);
  const runLock = acquireWorkspaceLock({
    lock_key: `agent-run:${actorAgent.id}`,
    agent_id: actorAgent.id,
    reason: "active workspace agent prompt run",
    ttl_seconds: 900,
  });
  const run = startAgentRun({
    agent_id: runAgent.id,
    provider: "openrouter",
    model,
    prompt: options.prompt,
    metadata: {
      dry_run: dryRun,
      approved: approve,
      mock,
      actor_agent_id: actorAgent.id,
      root_id: forcedRootId,
      recipe_id: forcedRecipeId,
      tmux_allowed: tmuxAllowed,
    },
  });

  if (mock) {
    try {
      return runMockPrompt(actorAgent, run.id, {
        prompt: options.prompt,
        dryRun,
        approve,
        model,
        root_id: forcedRootId,
        recipe_id: forcedRecipeId,
        command,
      });
    } finally {
      releaseWorkspaceLock(runLock.lock_key);
    }
  }

  const apiKey = resolveOpenRouterApiKey();
  if (!apiKey) {
    const error = "Missing OpenRouter API key. Set OPENROUTER_API_KEY or store it in the local secrets vault.";
    completeAgentRun(run.id, { status: "failed", error, result: { error } });
    releaseWorkspaceLock(runLock.lock_key);
    throw new Error(error);
  }

  const createdWorkspaces: Workspace[] = [];
  const observedToolCalls: JsonObject[] = [];
  let inspectedTmuxProfiles = false;
  const provider = createOpenRouter({
    apiKey,
    appName: "open-projects",
    appUrl: "https://github.com/hasna/projects",
  });

  const tools = {
    roots_list: tool({
      description: "List registered root folders and templates where workspaces can be created.",
      inputSchema: z.object({}),
      execute: async () => listRoots().map(compactRoot),
    }),
    roots_match: tool({
      description: "Score registered roots by path, kind, tags, and GitHub org.",
      inputSchema: z.object({
        path: z.string().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        tags: z.array(z.string()).optional(),
        github_org: z.string().optional(),
      }),
      execute: async (input) => {
        const matches = scoreRoots({
          path: input.path,
          kind: input.kind,
          tags: input.tags,
          github_org: input.github_org,
        });
        return matches.map((item) => ({ root: compactRoot(item.root), score: item.score, reasons: item.reasons }));
      },
    }),
    recipes_list: tool({
      description: "List workspace creation recipes with default kind, tags, and steps.",
      inputSchema: z.object({}),
      execute: async () => listRecipes().map((recipe) => ({
        id: recipe.id,
        slug: recipe.slug,
        name: recipe.name,
        kind: recipe.kind,
        default_tags: recipe.default_tags,
        steps: recipe.steps,
      })),
    }),
    recipe_get: tool({
      description: "Get one workspace creation recipe by id or slug, including steps and variables.",
      inputSchema: z.object({
        id_or_slug: z.string().min(1),
      }),
      execute: async (input) => {
        const recipe = getRecipe(input.id_or_slug) ?? getRecipeBySlug(input.id_or_slug);
        return recipe ?? { error: `Recipe not found: ${input.id_or_slug}` };
      },
    }),
    agents_list: tool({
      description: "List registered human, CLI, service, and AI agents that can own workspace changes.",
      inputSchema: z.object({}),
      execute: async () => listAgents().map((registeredAgent) => ({
        id: registeredAgent.id,
        slug: registeredAgent.slug,
        name: registeredAgent.name,
        kind: registeredAgent.kind,
        provider: registeredAgent.provider,
        model: registeredAgent.model,
        role: registeredAgent.role,
      })),
    }),
    workspaces_list: tool({
      description: "List existing workspaces for deduplication before creating a new one.",
      inputSchema: z.object({
        kind: z.enum(WORKSPACE_KINDS).optional(),
        limit: z.number().int().positive().max(100).optional(),
      }),
      execute: async (input) => listWorkspaces({ kind: input.kind, limit: input.limit ?? 50 }).map(compactWorkspace),
    }),
    workspace_show: tool({
      description: "Resolve one workspace by id or slug and return its core metadata.",
      inputSchema: z.object({
        id_or_slug: z.string().min(1),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.id_or_slug);
        return workspace ? compactWorkspace(workspace) : { error: `Workspace not found: ${input.id_or_slug}` };
      },
    }),
    workspace_events_list: tool({
      description: "List immutable audit events for one workspace.",
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Workspace id or slug"),
        limit: z.number().int().positive().max(100).optional(),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        return listWorkspaceEvents(workspace.id).slice(-(input.limit ?? 25));
      },
    }),
    workspace_event_record: tool({
      description: "Record a custom immutable workspace event. Mutates only when approved.",
      inputSchema: z.object({
        workspace: z.string().optional().describe("Workspace id or slug; omit for system-level events"),
        event_type: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
        after: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const workspace = input.workspace ? resolveWorkspace(input.workspace) : null;
        if (input.workspace && !workspace) return { error: `Workspace not found: ${input.workspace}` };
        const eventInput = {
          workspace_id: workspace?.id,
          agent_id: actorAgent.id,
          event_type: input.event_type,
          source: "agent" as const,
          prompt: options.prompt,
          command,
          after: input.after as JsonObject | undefined,
          metadata: input.metadata as JsonObject | undefined,
        };
        if (!approve) return { status: "planned", event: eventInput, note: "Run again with --yes to record this event." };
        return { status: "recorded", event: recordWorkspaceEvent(eventInput) };
      },
    }),
    workspace_verification_run: tool({
      description: "Run workspace verification checks through the workspace doctor. This is no-write unless fix=true and the prompt is approved.",
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Workspace id or slug"),
        fix: z.boolean().optional(),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        const doctor = () => doctorWorkspace(workspace, { fix: Boolean(input.fix && approve), dryRun: !approve });
        return input.fix && approve ? withAgentWorkspaceLock(workspace, actorAgent.id, "workspace doctor fix", doctor) : doctor();
      },
    }),
    workspace_update: tool({
      description: "Update existing workspace metadata. Mutates only when approved.",
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Workspace id or slug"),
        name: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().nullable().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        status: z.enum(["active", "archived", "deleted"]).optional(),
        root: z.string().nullable().optional().describe("Root id or slug, null to clear"),
        recipe: z.string().nullable().optional().describe("Recipe id or slug, null to clear"),
        path: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        git_remote: z.string().nullable().optional(),
        integrations: z.record(z.string(), z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        const updateInput = {
          name: input.name,
          slug: input.slug,
          description: input.description,
          kind: input.kind,
          status: input.status,
          root_id: input.root === null ? null : resolveRootId(input.root),
          recipe_id: input.recipe === null ? null : resolveRecipeId(input.recipe),
          primary_path: input.path,
          tags: input.tags,
          git_remote: input.git_remote,
          integrations: input.integrations as WorkspaceIntegrations | undefined,
          metadata: input.metadata as JsonObject | undefined,
          agent_id: actorAgent.id,
          source: "agent" as const,
          prompt: options.prompt,
          command,
        };
        if (!approve) return { status: "planned", workspace: compactWorkspace(workspace), input: updateInput, note: "Run again with --yes to update this workspace." };
        const updated = withAgentWorkspaceLock(workspace, actorAgent.id, "workspace update", () => updateWorkspace(workspace.id, updateInput));
        return { status: "updated", workspace: compactWorkspace(updated) };
      },
    }),
    workspace_archive: tool({
      description: "Archive an existing workspace. Mutates only when approved.",
      inputSchema: z.object({ workspace: z.string().min(1).describe("Workspace id or slug") }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        if (!approve) return { status: "planned", workspace: compactWorkspace(workspace), next_status: "archived" };
        return { status: "archived", workspace: compactWorkspace(withAgentWorkspaceLock(workspace, actorAgent.id, "workspace archive", () => archiveWorkspace(workspace.id, {
          agent_id: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        }))) };
      },
    }),
    workspace_unarchive: tool({
      description: "Restore an archived or deleted workspace to active. Mutates only when approved.",
      inputSchema: z.object({ workspace: z.string().min(1).describe("Workspace id or slug") }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        if (!approve) return { status: "planned", workspace: compactWorkspace(workspace), next_status: "active" };
        return { status: "active", workspace: compactWorkspace(withAgentWorkspaceLock(workspace, actorAgent.id, "workspace unarchive", () => unarchiveWorkspace(workspace.id, {
          agent_id: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        }))) };
      },
    }),
    workspace_delete: tool({
      description: "Mark a workspace deleted, or hard-delete when hard=true. Mutates only when approved.",
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Workspace id or slug"),
        hard: z.boolean().optional(),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        if (!approve) return { status: "planned", workspace: compactWorkspace(workspace), hard: Boolean(input.hard), next_status: input.hard ? "removed" : "deleted" };
        const result = withAgentWorkspaceLock(workspace, actorAgent.id, "workspace delete", () => deleteWorkspace(workspace.id, {
          hard: input.hard,
          agent_id: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        }));
        return { status: result.hard ? "deleted" : "marked_deleted", hard: result.hard, workspace: compactWorkspace(result.workspace) };
      },
    }),
    workspace_cleanup_create: tool({
      description: "Safely clean up files and DB rows created by a workspace creation run. Uses stored rollback records unless rollback_actions are supplied. Mutates only when approved.",
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Workspace id or slug"),
        rollback_actions: z.array(z.object({
          type: z.literal("rollback"),
          action: z.string(),
          target: z.string(),
          status: z.literal("planned"),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })).optional(),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        const target = cleanupTargetFromWorkspace(workspace, input.rollback_actions as WorkspaceCreationPlanAction[] | undefined);
        if (!approve) {
          return {
            status: "planned",
            workspace: compactWorkspace(workspace),
            cleanup: cleanupWorkspaceCreationTarget(target, {
              dryRun: true,
              agentId: actorAgent.id,
              source: "agent",
              prompt: options.prompt,
              command,
            }),
            note: "Run again with --yes to apply this cleanup.",
          };
        }
        return {
          status: "cleaned",
          cleanup: withAgentWorkspaceLock(workspace, actorAgent.id, "workspace creation cleanup", () => cleanupWorkspaceCreationTarget(target, {
            agentId: actorAgent.id,
            source: "agent",
            prompt: options.prompt,
            command,
          })),
        };
      },
    }),
    workspace_import: tool({
      description: "Import an existing folder or direct child folders as workspaces. Mutates only when approved.",
      inputSchema: z.object({
        path: z.string().min(1),
        bulk: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
      }),
      execute: async (input) => {
        if (!approve) {
          if (input.bulk) return { status: "planned", result: await importWorkspaceBulk(input.path, { dryRun: true, tags: input.tags, agent_id: actorAgent.id }) };
          return { status: "planned", preview: planWorkspaceImport(input.path, { tags: input.tags, agent_id: actorAgent.id }) };
        }
        return input.bulk
          ? await importWorkspaceBulk(input.path, { tags: input.tags, agent_id: actorAgent.id })
          : await importWorkspace(input.path, { tags: input.tags, agent_id: actorAgent.id });
      },
    }),
    workspace_scan_roots: tool({
      description: "Scan all registered roots and preview/import direct child folders as workspaces. Mutates only when approved.",
      inputSchema: z.object({
        tags: z.array(z.string()).optional(),
      }),
      execute: async (input) => importRegisteredRoots({
        dryRun: !approve,
        tags: input.tags,
        agent_id: actorAgent.id,
      }),
    }),
    workspace_github_publish: tool({
      description: "Publish an existing workspace to GitHub. Mutates only when approved; otherwise returns the exact gh/git plan.",
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Workspace id or slug"),
        org: z.string().optional().describe("GitHub organization/user"),
        repo: z.string().optional().describe("Repository name"),
        visibility: z.enum(["public", "private"]).optional(),
        description: z.string().optional(),
        remote_protocol: z.enum(["https", "ssh"]).optional(),
        push: z.boolean().optional().describe("Push the current branch after creating the repo; default true"),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        const publish = () => publishWorkspaceToGitHub(workspace, {
          org: input.org,
          repoName: input.repo,
          visibility: input.visibility as GitHubVisibility | undefined,
          description: input.description,
          remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
          push: input.push,
          dryRun: !approve,
          agent_id: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        });
        return approve ? withAgentWorkspaceLock(workspace, actorAgent.id, "workspace GitHub publish", publish) : publish();
      },
    }),
    workspace_github_import: tool({
      description: "Import a GitHub repository as a workspace. Can create a remote-only workspace or clone/register a local path. Mutates only when approved.",
      inputSchema: z.object({
        repo: z.string().min(1).describe("GitHub URL, git URL, or org/repo"),
        root: z.string().optional().describe("Root id or slug for path derivation"),
        path: z.string().optional().describe("Explicit clone/import path"),
        clone: z.boolean().optional(),
        remote_only: z.boolean().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        tags: z.array(z.string()).optional(),
        remote_protocol: z.enum(["https", "ssh"]).optional(),
      }),
      execute: async (input) => importWorkspaceFromGitHub(input.repo, {
        root: forcedRootId ?? input.root,
        path: forcedRootId ? undefined : input.path,
        clone: input.clone,
        remoteOnly: input.remote_only,
        kind: input.kind,
        tags: input.tags,
        remoteProtocol: input.remote_protocol as GitHubRemoteProtocol | undefined,
        dryRun: !approve,
        agent_id: actorAgent.id,
        source: "agent",
        prompt: options.prompt,
        command,
      }),
    }),
    workspace_integrations_link: tool({
      description: "Merge external integration IDs, such as todos/mementos/conversations/files/GitHub IDs, into an existing workspace. Mutates only when approved.",
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Workspace id or slug"),
        integrations: z.record(z.string(), z.string()).describe("Integration key/value pairs"),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        const integrations = normalizeWorkspaceIntegrations(input.integrations as WorkspaceIntegrations);
        if (!approve) {
          return {
            status: "planned",
            workspace: compactWorkspace(workspace),
            integrations: { ...workspace.integrations, ...integrations },
            note: "Run again with --yes to link these integrations.",
          };
        }
        return withAgentWorkspaceLock(workspace, actorAgent.id, "workspace integration link", () => linkWorkspaceExternalIntegrations(workspace, integrations, {
          agent_id: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        }));
      },
    }),
    workspace_plan_create: tool({
      description: "Return a deterministic no-write creation plan for a new workspace.",
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        root: z.string().optional().describe("Root id or slug"),
        recipe: z.string().optional().describe("Recipe id or slug"),
        path: z.string().optional().describe("Explicit primary path"),
        tags: z.array(z.string()).optional(),
        git_remote: z.string().optional(),
        create_directory: z.boolean().optional(),
        git_init: z.boolean().optional(),
        write_marker: z.boolean().optional(),
        tmux: z.object({
          session: z.string().optional(),
          windows: z.array(tmuxWindowSchema).optional(),
        }).optional(),
        tmux_profile: z.string().optional(),
      }),
      execute: async (input) => {
        const createInput = {
          name: input.name,
          slug: input.slug,
          description: input.description,
          kind: input.kind,
          root_id: forcedRootId ?? resolveRootId(input.root),
          recipe_id: forcedRecipeId ?? resolveRecipeId(input.recipe),
          primary_path: forcedRootId ? undefined : input.path,
          git_remote: input.git_remote,
          tags: input.tags,
          agent_id: actorAgent.id,
          source: "agent" as const,
          prompt: options.prompt,
          command,
        };
        return {
          status: "planned",
          plan: planWorkspaceCreation({
            ...createInput,
            createDirectory: input.create_directory,
            gitInit: input.git_init,
            writeMarker: input.write_marker ?? input.create_directory,
            tmux: tmuxAllowed && input.tmux ? {
              session: input.tmux.session,
              windows: input.tmux.windows as WorkspaceTmuxWindowSpec[] | undefined,
            } : undefined,
            tmux_profile: tmuxAllowed ? input.tmux_profile : undefined,
          }),
        };
      },
    }),
    workspace_create: tool({
      description: "Create/register a workspace anywhere on disk, optionally preparing the directory, git repo, and tmux windows. Mutates only when approved.",
      inputSchema: z.object({
        name: z.string().min(1),
        slug: z.string().optional(),
        description: z.string().optional(),
        kind: z.enum(WORKSPACE_KINDS).optional(),
        root: z.string().optional().describe("Root id or slug"),
        recipe: z.string().optional().describe("Recipe id or slug"),
        path: z.string().optional().describe("Explicit absolute or relative primary path"),
        tags: z.array(z.string()).optional(),
        git_remote: z.string().optional(),
        create_directory: z.boolean().optional(),
        git_init: z.boolean().optional(),
        write_marker: z.boolean().optional(),
        tmux: z.object({
          session: z.string().optional(),
          windows: z.array(tmuxWindowSchema).optional(),
        }).optional(),
        tmux_profile: z.string().optional().describe("Existing tmux profile id or slug to apply"),
      }),
      execute: async (input) => {
        if (tmuxAllowed && input.tmux_profile && !inspectedTmuxProfiles) {
          return { error: "Call tmux_profiles_list before using a saved tmux_profile, then retry workspace_create with the selected profile slug." };
        }
        const createInput = {
          name: input.name,
          slug: input.slug,
          description: input.description,
          kind: input.kind,
          root_id: forcedRootId ?? resolveRootId(input.root),
          recipe_id: forcedRecipeId ?? resolveRecipeId(input.recipe),
          primary_path: forcedRootId ? undefined : input.path,
          git_remote: input.git_remote,
          tags: input.tags,
          agent_id: actorAgent.id,
          source: "agent" as const,
          prompt: options.prompt,
          command,
        };

        if (!approve) {
          return {
            status: "planned",
            plan: planWorkspaceCreation({
              ...createInput,
              createDirectory: input.create_directory,
              gitInit: input.git_init,
              writeMarker: input.write_marker ?? input.create_directory,
              tmux: tmuxAllowed && input.tmux ? {
                session: input.tmux.session,
                windows: input.tmux.windows as WorkspaceTmuxWindowSpec[] | undefined,
              } : undefined,
              tmux_profile: tmuxAllowed ? input.tmux_profile : undefined,
            }),
            note: tmuxAllowed
              ? "Run again with --yes to create this workspace."
              : "Run again with --yes to create this workspace. Tmux is disabled for this prompt run.",
          };
        }

        const result = executeWorkspaceCreation({
          ...createInput,
          createDirectory: input.create_directory,
          gitInit: input.git_init,
          writeMarker: input.write_marker ?? input.create_directory,
          tmux: tmuxAllowed && input.tmux ? {
            session: input.tmux.session,
            windows: input.tmux.windows as WorkspaceTmuxWindowSpec[] | undefined,
          } : undefined,
          tmux_profile: tmuxAllowed ? input.tmux_profile : undefined,
        });
        if (result.workspace) createdWorkspaces.push(result.workspace);
        return { status: "created", ...result, workspace: result.workspace ? compactWorkspace(result.workspace) : null };
      },
    }),
    tmux_profiles_list: tool({
      description: "List saved tmux profiles that can be applied to a workspace.",
      inputSchema: z.object({}),
      execute: async () => {
        inspectedTmuxProfiles = true;
        return listTmuxProfiles().map((profile) => ({
          id: profile.id,
          slug: profile.slug,
          name: profile.name,
          session_template: profile.session_template,
          windows: listTmuxProfileWindows(profile.id),
        }));
      },
    }),
    workspace_tmux_apply: tool({
      description: "Create or update a tmux session/windows for an existing workspace. Mutates only when approved.",
      inputSchema: z.object({
        workspace: z.string().min(1).describe("Workspace id or slug"),
        session: z.string().optional(),
        windows: z.array(tmuxWindowSchema).optional(),
        profile: z.string().optional().describe("Optional saved tmux profile id or slug"),
      }),
      execute: async (input) => {
        const workspace = resolveWorkspace(input.workspace);
        if (!workspace) return { error: `Workspace not found: ${input.workspace}` };
        if (!tmuxAllowed) return { error: "Tmux is disabled for this prompt run by --no-tmux." };
        if (input.profile && !inspectedTmuxProfiles) {
          return { error: "Call tmux_profiles_list before using a saved profile, then retry workspace_tmux_apply with the selected profile slug." };
        }
        if (!approve) {
          if (input.profile) {
            const profile = resolveTmuxProfile(input.profile);
            if (!profile) return { error: `Tmux profile not found: ${input.profile}` };
            return {
              status: "planned",
              result: applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), { dryRun: true }),
            };
          }
          return {
            status: "planned",
            result: applyWorkspaceTmux(workspace, {
              session: input.session,
              windows: input.windows as WorkspaceTmuxWindowSpec[] | undefined,
              dryRun: true,
            }),
          };
        }
        if (input.profile) {
          const profile = resolveTmuxProfile(input.profile);
          if (!profile) return { error: `Tmux profile not found: ${input.profile}` };
          return withAgentWorkspaceLock(workspace, actorAgent.id, "workspace tmux apply", () => applyWorkspaceTmuxProfile(workspace, profile, listTmuxProfileWindows(profile.id), {
            agentId: actorAgent.id,
            source: "agent",
            prompt: options.prompt,
            command,
          }));
        }
        return withAgentWorkspaceLock(workspace, actorAgent.id, "workspace tmux apply", () => applyWorkspaceTmux(workspace, {
          session: input.session,
          windows: input.windows as WorkspaceTmuxWindowSpec[] | undefined,
          agentId: actorAgent.id,
          source: "agent",
          prompt: options.prompt,
          command,
        }));
      },
    }),
  };

  try {
    const result = await generateText({
      model: provider(model),
      system: [
        "You are the open-projects workspace orchestration agent.",
        "Use tools to inspect roots, recipes, agents, and existing workspaces before creating anything.",
        "A workspace can represent any project or repository in any folder, not only a fixed projects/ directory.",
        `Prompt constraints: acting agent id is ${actorAgent.id};${forcedRootId ? ` root id ${forcedRootId} is required for new workspaces;` : ""}${forcedRecipeId ? ` recipe id ${forcedRecipeId} is required for new workspaces;` : ""} tmux is ${tmuxAllowed ? "allowed" : "disabled"}.`,
        "Prefer an explicit user-requested path when present. Otherwise select a registered root whose tags/kind match the request.",
        "If a prompt constraint provides a required root or recipe, pass that root/recipe to workspace_create or let the tool apply the constraint; do not choose a different one.",
        "If a required root is provided, do not invent or pass a workspace path; let the root path template determine the path.",
        "Only mutating tools are allowed to make changes, and those tools will refuse to mutate unless the CLI was run with --yes.",
        "For every requested mutation, call the corresponding mutating tool even in dry-run mode so it returns a structured planned action. Do not only describe a change after inspection.",
        "Use workspace_plan_create for explicit no-write planning, workspace_update for requested metadata changes, workspace_archive/workspace_unarchive for status changes, workspace_delete for lifecycle deletion, workspace_cleanup_create for cleaning up a partial or unwanted creation run, workspace_import for one-folder import requests, workspace_scan_roots for broad registered-root scans/imports, workspace_github_import for GitHub repository imports, workspace_github_publish for GitHub publication, workspace_integrations_link for external IDs, workspace_verification_run for checks, workspace_event_record for custom audit events, and workspace_create for new workspaces.",
        "When a user asks for tmux or mentions a saved tmux profile, call tmux_profiles_list before workspace_create or workspace_tmux_apply. The tools reject saved profile usage until profiles have been inspected.",
        "If tmux is disabled, do not call tmux tools and do not include tmux or tmux_profile arguments in workspace_create, even if the user mentions tmux.",
        "When creating a local workspace directory, write a .workspace.json marker unless the user explicitly asks not to.",
        "Finish with a concise summary of the plan or what was changed.",
      ].join("\n"),
      prompt: options.prompt,
      tools,
      stopWhen: stepCountIs(options.maxSteps ?? 6),
      temperature: 0.2,
      experimental_onToolCallFinish: (event) => {
        observedToolCalls.push({
          name: event.toolCall.toolName,
          input: event.toolCall.input,
          success: event.success,
          output: event.success ? event.output : undefined,
          error: event.success ? undefined : String(event.error),
        });
      },
    });

    const toolCalls = observedToolCalls.length > 0 ? observedToolCalls : extractToolCalls(result);
    const fallback = hasMutationToolCall(toolCalls) || hasToolCall(toolCalls, "workspace_plan_create")
      ? null
      : fallbackWorkspaceCreate(actorAgent, {
        prompt: options.prompt,
        dryRun,
        approve,
        root_id: forcedRootId,
        recipe_id: forcedRecipeId,
        command,
      });
    if (fallback) {
      toolCalls.push(fallback.call);
      if (fallback.workspace) createdWorkspaces.push(fallback.workspace);
    }
    const text = fallback ? `${result.text}\n\n${fallback.text}` : result.text;
    const usage = result.totalUsage as unknown as JsonObject;
    completeAgentRun(run.id, {
      status: "completed",
      workspace_id: createdWorkspaces[0]?.id,
      tool_calls: toolCalls,
      result: {
        text,
        workspaces: createdWorkspaces.map(compactWorkspace),
        usage,
      },
    });

    return {
      mode: "ai",
      run_id: run.id,
      agent_id: runAgent.id,
      provider: "openrouter",
      model,
      actor_agent_id: actorAgent.id,
      approved: approve,
      dry_run: dryRun,
      text,
      workspaces: createdWorkspaces,
      tool_calls: toolCalls,
      usage,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    completeAgentRun(run.id, { status: "failed", error, tool_calls: observedToolCalls, result: { error } });
    throw err;
  } finally {
    releaseWorkspaceLock(runLock.lock_key);
    ensureCliAgent();
  }
}
