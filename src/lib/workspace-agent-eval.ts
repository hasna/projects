import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveWorkspace,
  createAgent,
  createRecipe,
  createRoot,
  createTmuxProfile,
  createWorkspace,
  workspaceSlugify,
} from "../db/workspaces.js";
import { runWorkspaceAgentPrompt, type WorkspaceAgentPromptOptions, type WorkspaceAgentPromptResult } from "./workspace-agent.js";
import type { JsonObject } from "../types/workspace.js";

export const WORKSPACE_AGENT_EVAL_CASE_IDS = [
  "create-explicit-path",
  "create-root-recipe-no-tmux",
  "duplicate-existing-workspace",
  "root-create",
  "roots-list",
  "roots-match",
  "recipe-create",
  "tmux-profile-create",
  "recipe-get",
  "agent-create",
  "agents-list",
  "workspaces-list-query",
  "workspace-show",
  "workspace-events-list",
  "workspace-event-record",
  "workspace-verification-run",
  "import-existing-folder",
  "import-bulk",
  "scan-roots",
  "update-description",
  "update-tags",
  "archive-workspace",
  "unarchive-workspace",
  "delete-workspace",
  "hard-delete-workspace",
  "cleanup-create",
  "tmux-apply-existing",
  "github-publish-workspace",
  "github-unpublish-workspace",
  "github-import-remote-only",
  "github-import-local-root",
  "integrations-link",
] as const;

export type WorkspaceAgentEvalCaseId = (typeof WORKSPACE_AGENT_EVAL_CASE_IDS)[number];

export interface WorkspaceAgentEvalOptions {
  mock?: boolean;
  model?: string;
  maxSteps?: number;
  caseIds?: WorkspaceAgentEvalCaseId[];
  basePath?: string;
}

export interface WorkspaceAgentEvalCheck {
  name: string;
  passed: boolean;
  message: string;
  metadata?: JsonObject;
}

export interface WorkspaceAgentEvalCaseResult {
  id: WorkspaceAgentEvalCaseId;
  prompt: string;
  skipped: boolean;
  skip_reason?: string;
  passed: boolean;
  confidence: number;
  checks: WorkspaceAgentEvalCheck[];
  run?: WorkspaceAgentPromptResult;
  error?: string;
}

export interface WorkspaceAgentEvalSummary {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  success_rate: number;
  confidence: number;
}

export interface WorkspaceAgentEvalResult {
  mode: "ai" | "mock";
  model: string;
  base_path: string;
  summary: WorkspaceAgentEvalSummary;
  cases: WorkspaceAgentEvalCaseResult[];
}

interface EvalFixtures {
  basePath: string;
  explicitPath: string;
  rootPath: string;
  rootSlug: string;
  rootId: string;
  recipeSlug: string;
  recipeId: string;
  actorSlug: string;
  actorId: string;
  importPath: string;
  bulkImportPath: string;
  scanCandidatePath: string;
  duplicateWorkspaceSlug: string;
  duplicateWorkspacePath: string;
  metadataWorkspaceSlug: string;
  updateWorkspaceSlug: string;
  archiveWorkspaceSlug: string;
  unarchiveWorkspaceSlug: string;
  deleteWorkspaceSlug: string;
  hardDeleteWorkspaceSlug: string;
  cleanupWorkspaceSlug: string;
  tmuxWorkspaceSlug: string;
  tmuxProfileSlug: string;
  githubWorkspaceSlug: string;
  githubPublishedWorkspaceSlug: string;
  githubImportLocalPath: string;
}

interface EvalCase {
  id: WorkspaceAgentEvalCaseId;
  requiresLive?: boolean;
  prompt: (fixtures: EvalFixtures) => string;
  options?: (fixtures: EvalFixtures) => Partial<WorkspaceAgentPromptOptions>;
  checks: (fixtures: EvalFixtures, run: WorkspaceAgentPromptResult) => WorkspaceAgentEvalCheck[];
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function setupFixtures(basePath?: string): EvalFixtures {
  const base = basePath ?? mkdtempSync(join(tmpdir(), "workspace-agent-eval-"));
  mkdirSync(base, { recursive: true });
  const suffix = uniqueSuffix();
  const rootPath = join(base, "root");
  mkdirSync(rootPath, { recursive: true });
  const importPath = join(base, "import-existing");
  mkdirSync(importPath, { recursive: true });
  writeFileSync(join(importPath, "package.json"), JSON.stringify({ name: `eval-import-${suffix}` }), "utf-8");
  const bulkImportPath = join(base, "bulk-import");
  const bulkOnePath = join(bulkImportPath, "bulk-one");
  const bulkTwoPath = join(bulkImportPath, "bulk-two");
  mkdirSync(bulkOnePath, { recursive: true });
  mkdirSync(bulkTwoPath, { recursive: true });
  writeFileSync(join(bulkOnePath, "package.json"), JSON.stringify({ name: `eval-bulk-one-${suffix}` }), "utf-8");
  writeFileSync(join(bulkTwoPath, ".workspace.json"), JSON.stringify({ name: `Eval Bulk Two ${suffix}` }), "utf-8");

  const root = createRoot({
    name: `Eval Root ${suffix}`,
    slug: `eval-root-${suffix}`,
    base_path: rootPath,
    default_kind: "docs",
    path_template: "docs-{slug}",
    tags: ["eval-root"],
    github_org: "hasna",
    repo_visibility: "public",
  });
  const recipe = createRecipe({
    name: `Eval Docs ${suffix}`,
    slug: `eval-docs-${suffix}`,
    kind: "docs",
    default_tags: ["docs", "eval-recipe"],
  });
  const actor = createAgent({
    name: `Eval Actor ${suffix}`,
    slug: `eval-actor-${suffix}`,
    kind: "human",
    role: "eval-owner",
  });
  const tmuxProfile = createTmuxProfile({
    name: `Eval Profile ${suffix}`,
    slug: `eval-profile-${suffix}`,
    session_template: "{slug}-eval",
    windows: [
      { window_name_template: "editor", command: "vim" },
      { window_name_template: "server", command: "bun run dev" },
    ],
  });

  const scanCandidatePath = join(rootPath, "scan-candidate");
  mkdirSync(scanCandidatePath, { recursive: true });
  writeFileSync(join(scanCandidatePath, "package.json"), JSON.stringify({ name: `eval-scan-${suffix}` }), "utf-8");
  const duplicateWorkspace = createWorkspace({
    name: `Eval Duplicate ${suffix}`,
    slug: `eval-duplicate-${suffix}`,
    kind: "project",
    primary_path: join(base, "duplicate-target"),
    tags: ["eval-duplicate", "family-security"],
    metadata: { domain: "duplicate-check", purpose: "deduplication eval" },
  });
  const metadataWorkspace = createWorkspace({
    name: `Eval Metadata ${suffix}`,
    slug: `eval-metadata-${suffix}`,
    kind: "project",
    primary_path: join(base, "metadata-target"),
    tags: ["eval-metadata", "security-cameras"],
    metadata: { domain: "family-security", purpose: "camera planning" },
  });
  const updateWorkspace = createWorkspace({
    name: `Eval Update ${suffix}`,
    slug: `eval-update-${suffix}`,
    kind: "generic",
    primary_path: join(base, "update-target"),
  });
  const archiveTargetWorkspace = createWorkspace({
    name: `Eval Archive ${suffix}`,
    slug: `eval-archive-${suffix}`,
    kind: "generic",
    primary_path: join(base, "archive-target"),
  });
  const unarchiveTargetWorkspace = archiveWorkspace(createWorkspace({
    name: `Eval Unarchive ${suffix}`,
    slug: `eval-unarchive-${suffix}`,
    kind: "generic",
    primary_path: join(base, "unarchive-target"),
  }).id);
  const deleteWorkspace = createWorkspace({
    name: `Eval Delete ${suffix}`,
    slug: `eval-delete-${suffix}`,
    kind: "generic",
    primary_path: join(base, "delete-target"),
  });
  const hardDeleteWorkspace = createWorkspace({
    name: `Eval Hard Delete ${suffix}`,
    slug: `eval-hard-delete-${suffix}`,
    kind: "generic",
    primary_path: join(base, "hard-delete-target"),
  });
  const cleanupWorkspace = createWorkspace({
    name: `Eval Cleanup ${suffix}`,
    slug: `eval-cleanup-${suffix}`,
    kind: "generic",
    primary_path: join(base, "cleanup-target"),
  });
  const tmuxWorkspace = createWorkspace({
    name: `Eval Tmux ${suffix}`,
    slug: `eval-tmux-${suffix}`,
    kind: "generic",
    primary_path: join(base, "tmux-target"),
  });
  const githubWorkspace = createWorkspace({
    name: `Eval GitHub ${suffix}`,
    slug: `eval-github-${suffix}`,
    kind: "open-source",
    root_id: root.id,
    primary_path: join(base, "github-target"),
  });
  const githubPublishedWorkspace = createWorkspace({
    name: `Eval GitHub Published ${suffix}`,
    slug: `eval-github-published-${suffix}`,
    kind: "open-source",
    root_id: root.id,
    primary_path: join(base, "github-published-target"),
    git_remote: `https://github.com/hasna/eval-github-published-${suffix}.git`,
    integrations: {
      github_repo: `hasna/eval-github-published-${suffix}`,
      github_url: `https://github.com/hasna/eval-github-published-${suffix}`,
    },
  });

  return {
    basePath: base,
    explicitPath: join(base, "explicit-workspace"),
    rootPath,
    rootSlug: root.slug,
    rootId: root.id,
    recipeSlug: recipe.slug,
    recipeId: recipe.id,
    actorSlug: actor.slug,
    actorId: actor.id,
    importPath,
    bulkImportPath,
    scanCandidatePath,
    duplicateWorkspaceSlug: duplicateWorkspace.slug,
    duplicateWorkspacePath: duplicateWorkspace.primary_path!,
    metadataWorkspaceSlug: metadataWorkspace.slug,
    updateWorkspaceSlug: updateWorkspace.slug,
    archiveWorkspaceSlug: archiveTargetWorkspace.slug,
    unarchiveWorkspaceSlug: unarchiveTargetWorkspace.slug,
    deleteWorkspaceSlug: deleteWorkspace.slug,
    hardDeleteWorkspaceSlug: hardDeleteWorkspace.slug,
    cleanupWorkspaceSlug: cleanupWorkspace.slug,
    tmuxWorkspaceSlug: tmuxWorkspace.slug,
    tmuxProfileSlug: tmuxProfile.slug,
    githubWorkspaceSlug: githubWorkspace.slug,
    githubPublishedWorkspaceSlug: githubPublishedWorkspace.slug,
    githubImportLocalPath: join(base, "github-local-import"),
  };
}

function toolCalls(run: WorkspaceAgentPromptResult, name: string): JsonObject[] {
  return run.tool_calls.filter((call) => call["name"] === name);
}

function firstToolCall(run: WorkspaceAgentPromptResult, name: string): JsonObject | undefined {
  return toolCalls(run, name)[0];
}

function firstToolCallAny(run: WorkspaceAgentPromptResult, names: string[]): JsonObject | undefined {
  for (const name of names) {
    const call = firstToolCall(run, name);
    if (call) return call;
  }
  return undefined;
}

function nested(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function check(name: string, passed: boolean, message: string, metadata?: JsonObject): WorkspaceAgentEvalCheck {
  return { name, passed, message, metadata };
}

function checkTool(run: WorkspaceAgentPromptResult, name: string): WorkspaceAgentEvalCheck {
  return check(
    `tool:${name}`,
    Boolean(firstToolCall(run, name)),
    firstToolCall(run, name) ? `Called ${name}` : `Expected ${name} tool call`,
  );
}

function checkAnyTool(run: WorkspaceAgentPromptResult, names: string[]): WorkspaceAgentEvalCheck {
  const found = names.find((name) => firstToolCall(run, name));
  return check(
    `tool:${names.join("|")}`,
    Boolean(found),
    found ? `Called ${found}` : `Expected one of: ${names.join(", ")}`,
  );
}

function outputPlan(call: JsonObject | undefined): JsonObject | undefined {
  return nested(call, ["output", "plan"]) as JsonObject | undefined;
}

const EVAL_CASES: EvalCase[] = [
  {
    id: "create-explicit-path",
    prompt: (fixtures) => `Plan a generic workspace named Eval Explicit Path in ${fixtures.explicitPath}`,
    checks: (fixtures, run) => {
      const call = firstToolCallAny(run, ["workspace_create", "workspace_plan_create"]);
      const plan = outputPlan(call);
      const primaryPath = nested(plan, ["workspace", "primary_path"]);
      return [
        checkAnyTool(run, ["workspace_create", "workspace_plan_create"]),
        check("dry-run-no-workspaces", run.workspaces.length === 0, "Dry-run must not create workspace rows"),
        check("explicit-path", primaryPath === fixtures.explicitPath, `Expected primary path ${fixtures.explicitPath}`, { primary_path: primaryPath }),
        check("directory-not-created", !existsSync(fixtures.explicitPath), "Dry-run must not create the target directory"),
      ];
    },
  },
  {
    id: "create-root-recipe-no-tmux",
    prompt: () => "Plan a docs workspace named Eval Root Recipe with tmux",
    options: (fixtures) => ({
      agent: fixtures.actorSlug,
      root: fixtures.rootSlug,
      recipe: fixtures.recipeSlug,
      tmux: false,
    }),
    checks: (fixtures, run) => {
      const call = firstToolCallAny(run, ["workspace_create", "workspace_plan_create"]);
      const plan = outputPlan(call);
      const primaryPath = nested(plan, ["workspace", "primary_path"]);
      const tags = nested(plan, ["workspace", "tags"]) as unknown[] | undefined;
      return [
        checkAnyTool(run, ["workspace_create", "workspace_plan_create"]),
        check("actor-agent", run.actor_agent_id === fixtures.actorId, "Prompt --agent should control mutation attribution", { expected: fixtures.actorId, actual: run.actor_agent_id }),
        check("forced-root", nested(plan, ["workspace", "root_id"]) === fixtures.rootId, "Plan should use the forced root"),
        check("forced-recipe", nested(plan, ["workspace", "recipe_id"]) === fixtures.recipeId, "Plan should use the forced recipe"),
        check("root-template-path", primaryPath === join(fixtures.rootPath, "docs-eval-root-recipe"), "Plan should derive path from forced root template", { primary_path: primaryPath }),
        check("recipe-kind", nested(plan, ["workspace", "kind"]) === "docs", "Recipe/root kind should be applied"),
        check("recipe-tags", Array.isArray(tags) && tags.includes("docs") && tags.includes("eval-recipe"), "Recipe tags should be applied"),
        check("tmux-disabled", nested(call, ["output", "plan", "tmux"]) === null, "Tmux should be disabled by --no-tmux"),
      ];
    },
  },
  {
    id: "duplicate-existing-workspace",
    requiresLive: true,
    prompt: (fixtures) => `Create a workspace named ${fixtures.duplicateWorkspaceSlug} in ${fixtures.duplicateWorkspacePath}`,
    checks: (fixtures, run) => {
      const call = firstToolCall(run, "workspace_create") ?? firstToolCall(run, "workspace_show");
      return [
        checkAnyTool(run, ["workspace_create", "workspace_show"]),
        check("no-created-workspaces", run.workspaces.length === 0, "Duplicate dry-run must not create workspace rows"),
        check("existing-detected", nested(call, ["output", "status"]) === "already_exists" || nested(call, ["output", "slug"]) === fixtures.duplicateWorkspaceSlug, "Existing workspace should be detected", { output: call?.output }),
      ];
    },
  },
  {
    id: "root-create",
    requiresLive: true,
    prompt: (fixtures) => `Register a new root named Eval Planned Root at ${join(fixtures.basePath, "planned-root")} for project workspaces with tag planned-root and path template {slug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "root_create");
      return [
        checkTool(run, "root_create"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Root creation should be planned in dry-run"),
      ];
    },
  },
  {
    id: "roots-list",
    requiresLive: true,
    prompt: () => "List the registered workspace roots and their templates",
    checks: (_fixtures, run) => [checkTool(run, "roots_list")],
  },
  {
    id: "roots-match",
    requiresLive: true,
    prompt: (fixtures) => `Match the best registered root for a docs workspace at ${join(fixtures.rootPath, "docs-match")} with tag eval-root`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "roots_match");
      const output = call?.output;
      return [
        checkTool(run, "roots_match"),
        check("has-match", Array.isArray(output) && output.length > 0, "Root match should return at least one candidate"),
      ];
    },
  },
  {
    id: "recipe-create",
    requiresLive: true,
    prompt: () => "Create a docs workspace recipe named Eval Planned Recipe with tags docs and planned-recipe",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "recipe_create");
      return [
        checkTool(run, "recipe_create"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Recipe creation should be planned in dry-run"),
      ];
    },
  },
  {
    id: "tmux-profile-create",
    requiresLive: true,
    prompt: () => "Create a saved tmux profile named Eval Planned Profile with editor and server windows",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "tmux_profile_create");
      return [
        checkTool(run, "tmux_profile_create"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Tmux profile creation should be planned in dry-run"),
      ];
    },
  },
  {
    id: "recipe-get",
    requiresLive: true,
    prompt: (fixtures) => `Show the full recipe metadata for recipe ${fixtures.recipeSlug}`,
    checks: (_fixtures, run) => [checkTool(run, "recipe_get")],
  },
  {
    id: "agent-create",
    requiresLive: true,
    prompt: () => "Record a human agent named Eval Planned Reviewer with role reviewer",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "agent_create");
      return [
        checkTool(run, "agent_create"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Agent creation should be planned in dry-run"),
      ];
    },
  },
  {
    id: "agents-list",
    requiresLive: true,
    prompt: () => "List the registered agents that can own workspace changes",
    checks: (_fixtures, run) => [checkTool(run, "agents_list")],
  },
  {
    id: "workspaces-list-query",
    requiresLive: true,
    prompt: () => "List existing workspaces matching security-cameras or family-security metadata",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspaces_list");
      const output = call?.output;
      return [
        checkTool(run, "workspaces_list"),
        check("has-results", Array.isArray(output) && output.length > 0, "Workspace query should return matching metadata/tag rows"),
      ];
    },
  },
  {
    id: "workspace-show",
    requiresLive: true,
    prompt: (fixtures) => `Show workspace ${fixtures.metadataWorkspaceSlug} with metadata and tags`,
    checks: (fixtures, run) => {
      const call = firstToolCall(run, "workspace_show");
      return [
        checkTool(run, "workspace_show"),
        check("slug", nested(call, ["output", "slug"]) === fixtures.metadataWorkspaceSlug, "Workspace show should return requested workspace"),
      ];
    },
  },
  {
    id: "workspace-events-list",
    requiresLive: true,
    prompt: (fixtures) => `List audit events for workspace ${fixtures.updateWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_events_list");
      const output = call?.output;
      return [
        checkTool(run, "workspace_events_list"),
        check("has-events", Array.isArray(output) && output.length > 0, "Events list should return creation event"),
      ];
    },
  },
  {
    id: "workspace-event-record",
    requiresLive: true,
    prompt: (fixtures) => `Record a custom audit event security_review_planned for workspace ${fixtures.metadataWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_event_record");
      return [
        checkTool(run, "workspace_event_record"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Event record should be planned in dry-run"),
      ];
    },
  },
  {
    id: "workspace-verification-run",
    requiresLive: true,
    prompt: (fixtures) => `Run workspace verification checks for ${fixtures.metadataWorkspaceSlug}`,
    checks: (_fixtures, run) => [checkTool(run, "workspace_verification_run")],
  },
  {
    id: "import-existing-folder",
    requiresLive: true,
    prompt: (fixtures) => `Import folder ${fixtures.importPath} as a workspace`,
    checks: (fixtures, run) => {
      const call = firstToolCall(run, "workspace_import");
      return [
        checkTool(run, "workspace_import"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Import should be planned in dry-run"),
        check("preview-path", nested(call, ["output", "preview", "path"]) === fixtures.importPath, "Import preview path should match fixture"),
      ];
    },
  },
  {
    id: "import-bulk",
    requiresLive: true,
    prompt: (fixtures) => `Bulk import the direct child folders under ${fixtures.bulkImportPath} as workspaces`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_import");
      return [
        checkTool(run, "workspace_import"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Bulk import should be planned in dry-run"),
      ];
    },
  },
  {
    id: "scan-roots",
    requiresLive: true,
    prompt: () => "Scan all registered roots and preview importing direct child folders",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_scan_roots");
      return [
        checkTool(run, "workspace_scan_roots"),
        check("dry-run", Boolean(nested(call, ["output", "dry_run"])) || nested(call, ["output", "status"]) === "planned", "Scan roots should run as a dry-run preview"),
      ];
    },
  },
  {
    id: "update-description",
    requiresLive: true,
    prompt: (fixtures) => `Update workspace ${fixtures.updateWorkspaceSlug} description to "eval updated description"`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_update");
      const description = nested(call, ["output", "input", "description"]);
      return [
        checkTool(run, "workspace_update"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Update should be planned in dry-run"),
        check("description", typeof description === "string" && description.includes("eval updated description"), "Planned update should include requested description", { description }),
      ];
    },
  },
  {
    id: "update-tags",
    requiresLive: true,
    prompt: (fixtures) => `Update workspace ${fixtures.updateWorkspaceSlug} tags to alpha, beta, and family-security`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_update");
      const tags = nested(call, ["output", "input", "tags"]);
      return [
        checkTool(run, "workspace_update"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Update should be planned in dry-run"),
        check("tags", Array.isArray(tags) && tags.includes("family-security"), "Planned update should include requested tags", { tags }),
      ];
    },
  },
  {
    id: "archive-workspace",
    requiresLive: true,
    prompt: (fixtures) => `Archive workspace ${fixtures.archiveWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_archive");
      return [
        checkTool(run, "workspace_archive"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Archive should be planned in dry-run"),
        check("next-status", nested(call, ["output", "next_status"]) === "archived", "Archive plan should set next_status archived"),
      ];
    },
  },
  {
    id: "unarchive-workspace",
    requiresLive: true,
    prompt: (fixtures) => `Unarchive workspace ${fixtures.unarchiveWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_unarchive");
      return [
        checkTool(run, "workspace_unarchive"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Unarchive should be planned in dry-run"),
        check("next-status", nested(call, ["output", "next_status"]) === "active", "Unarchive plan should set next_status active"),
      ];
    },
  },
  {
    id: "delete-workspace",
    requiresLive: true,
    prompt: (fixtures) => `Delete workspace ${fixtures.deleteWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_delete");
      return [
        checkTool(run, "workspace_delete"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Delete should be planned in dry-run"),
        check("next-status", nested(call, ["output", "next_status"]) === "deleted", "Delete plan should mark next_status deleted"),
      ];
    },
  },
  {
    id: "hard-delete-workspace",
    requiresLive: true,
    prompt: (fixtures) => `Hard delete workspace ${fixtures.hardDeleteWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_delete");
      return [
        checkTool(run, "workspace_delete"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Hard delete should be planned in dry-run"),
        check("hard", nested(call, ["output", "hard"]) === true, "Hard delete plan should set hard=true"),
      ];
    },
  },
  {
    id: "cleanup-create",
    requiresLive: true,
    prompt: (fixtures) => `Preview cleanup for workspace creation artifacts of ${fixtures.cleanupWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_cleanup_create");
      return [
        checkTool(run, "workspace_cleanup_create"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Cleanup should be planned in dry-run"),
      ];
    },
  },
  {
    id: "tmux-apply-existing",
    requiresLive: true,
    prompt: (fixtures) => `Plan a tmux session for existing workspace ${fixtures.tmuxWorkspaceSlug} with an editor window`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_tmux_apply");
      return [
        checkTool(run, "workspace_tmux_apply"),
        check("no-extra-create", !firstToolCall(run, "workspace_create"), "Tmux eval should not trigger workspace_create fallback"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Tmux apply should be planned in dry-run"),
        check("tmux-result", nested(call, ["output", "result", "session_action"]) === "planned", "Tmux result should be dry-run planned"),
      ];
    },
  },
  {
    id: "github-publish-workspace",
    requiresLive: true,
    prompt: (fixtures) => `Plan publishing workspace ${fixtures.githubWorkspaceSlug} to GitHub as a public repository`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_github_publish");
      return [
        checkTool(run, "workspace_github_publish"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "GitHub publish should be planned in dry-run"),
        check("visibility", nested(call, ["output", "visibility"]) === "public", "GitHub publish should use public visibility"),
        check("repo-full-name", typeof nested(call, ["output", "full_name"]) === "string", "GitHub publish should return a full repo name"),
      ];
    },
  },
  {
    id: "github-unpublish-workspace",
    requiresLive: true,
    prompt: (fixtures) => `Plan unpublishing GitHub metadata from workspace ${fixtures.githubPublishedWorkspaceSlug} and clear GitHub integrations`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_github_unpublish");
      return [
        checkTool(run, "workspace_github_unpublish"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "GitHub unpublish should be planned in dry-run"),
        check("clear-integrations", nested(call, ["output", "integrations_cleared"]) === true, "Unpublish should plan clearing integrations"),
      ];
    },
  },
  {
    id: "github-import-remote-only",
    requiresLive: true,
    prompt: () => "Import GitHub repository hasna/eval-remote-only as a remote-only workspace",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_github_import");
      return [
        checkTool(run, "workspace_github_import"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "GitHub import should be planned in dry-run"),
        check("remote-only", nested(call, ["output", "remote_only"]) === true, "GitHub import should plan a remote-only workspace"),
        check("repo-full-name", nested(call, ["output", "full_name"]) === "hasna/eval-remote-only", "GitHub import should preserve org/repo"),
      ];
    },
  },
  {
    id: "github-import-local-root",
    requiresLive: true,
    prompt: (fixtures) => `Import GitHub repository hasna/eval-local-import under root ${fixtures.rootSlug} as a local project without cloning`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_github_import");
      return [
        checkTool(run, "workspace_github_import"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "GitHub local import should be planned in dry-run"),
        check("local", nested(call, ["output", "remote_only"]) === false, "GitHub import with a root should plan a local workspace"),
      ];
    },
  },
  {
    id: "integrations-link",
    requiresLive: true,
    prompt: (fixtures) => `Link todos project id todo_eval_123 to workspace ${fixtures.githubWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "workspace_integrations_link");
      return [
        checkTool(run, "workspace_integrations_link"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Integration link should be planned in dry-run"),
        check("todos-id", nested(call, ["output", "integrations", "todos_project_id"]) === "todo_eval_123", "Integration link should include todos_project_id"),
      ];
    },
  },
];

function selectedCases(caseIds: WorkspaceAgentEvalCaseId[] | undefined): EvalCase[] {
  if (!caseIds?.length) return EVAL_CASES;
  const selected = new Set(caseIds);
  return EVAL_CASES.filter((item) => selected.has(item.id));
}

function caseConfidence(checks: WorkspaceAgentEvalCheck[]): number {
  if (!checks.length) return 0;
  return checks.filter((item) => item.passed).length / checks.length;
}

function summary(results: WorkspaceAgentEvalCaseResult[]): WorkspaceAgentEvalSummary {
  const executed = results.filter((item) => !item.skipped);
  const passed = executed.filter((item) => item.passed).length;
  const failed = executed.filter((item) => !item.passed).length;
  const skipped = results.length - executed.length;
  return {
    total: results.length,
    executed: executed.length,
    passed,
    failed,
    skipped,
    success_rate: executed.length === 0 ? 0 : passed / executed.length,
    confidence: executed.length === 0 ? 0 : executed.reduce((sum, item) => sum + item.confidence, 0) / executed.length,
  };
}

export function parseWorkspaceAgentEvalCaseIds(value: string | undefined): WorkspaceAgentEvalCaseId[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    if (!(WORKSPACE_AGENT_EVAL_CASE_IDS as readonly string[]).includes(item)) {
      throw new Error(`Unknown eval case: ${item}. Expected one of: ${WORKSPACE_AGENT_EVAL_CASE_IDS.join(", ")}`);
    }
    return item as WorkspaceAgentEvalCaseId;
  });
}

export async function runWorkspaceAgentEval(options: WorkspaceAgentEvalOptions = {}): Promise<WorkspaceAgentEvalResult> {
  const fixtures = setupFixtures(options.basePath);
  const cases = selectedCases(options.caseIds);
  const results: WorkspaceAgentEvalCaseResult[] = [];

  for (const evalCase of cases) {
    const prompt = evalCase.prompt(fixtures);
    if (options.mock && evalCase.requiresLive) {
      results.push({
        id: evalCase.id,
        prompt,
        skipped: true,
        skip_reason: "requires live AI model",
        passed: false,
        confidence: 0,
        checks: [],
      });
      continue;
    }

    try {
      const run = await runWorkspaceAgentPrompt({
        prompt,
        dryRun: true,
        approve: false,
        mock: options.mock,
        model: options.model,
        maxSteps: options.maxSteps ?? 8,
        ...evalCase.options?.(fixtures),
      });
      const checks = evalCase.checks(fixtures, run);
      const confidence = caseConfidence(checks);
      results.push({
        id: evalCase.id,
        prompt,
        skipped: false,
        passed: checks.every((item) => item.passed),
        confidence,
        checks,
        run,
      });
    } catch (err) {
      results.push({
        id: evalCase.id,
        prompt,
        skipped: false,
        passed: false,
        confidence: 0,
        checks: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    mode: options.mock ? "mock" : "ai",
    model: options.model ?? "openai/gpt-4o-mini",
    base_path: fixtures.basePath,
    summary: summary(results),
    cases: results,
  };
}
