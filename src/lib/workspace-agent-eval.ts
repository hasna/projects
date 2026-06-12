import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "../db/database.js";
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
  "duplicate-existing-project",
  "root-create",
  "roots-list",
  "roots-match",
  "recipe-create",
  "tmux-profile-create",
  "recipe-get",
  "agent-create",
  "agents-list",
  "projects-list-query",
  "project-show",
  "project-events-list",
  "project-event-record",
  "project-verification-run",
  "import-existing-folder",
  "import-bulk",
  "scan-roots",
  "update-description",
  "update-tags",
  "archive-project",
  "unarchive-project",
  "delete-project",
  "hard-delete-project",
  "cleanup-create",
  "tmux-apply-existing",
  "github-publish-project",
  "github-unpublish-project",
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
  dbPath?: string;
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
  db_path: string;
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

function setupFixtures(basePath: string): EvalFixtures {
  const base = basePath;
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
  writeFileSync(join(bulkTwoPath, ".project.json"), JSON.stringify({ name: `Eval Bulk Two ${suffix}` }), "utf-8");

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
    explicitPath: join(base, "explicit-project"),
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
    prompt: (fixtures) => `Plan a generic project named Eval Explicit Path in ${fixtures.explicitPath}`,
    checks: (fixtures, run) => {
      const call = firstToolCallAny(run, ["projects_create", "projects_plan_create"]);
      const plan = outputPlan(call);
      const primaryPath = nested(plan, ["project", "primary_path"]);
      return [
        checkAnyTool(run, ["projects_create", "projects_plan_create"]),
        check("dry-run-no-projects", run.projects.length === 0, "Dry-run must not create project rows"),
        check("explicit-path", primaryPath === fixtures.explicitPath, `Expected primary path ${fixtures.explicitPath}`, { primary_path: primaryPath }),
        check("directory-not-created", !existsSync(fixtures.explicitPath), "Dry-run must not create the target directory"),
      ];
    },
  },
  {
    id: "create-root-recipe-no-tmux",
    prompt: () => "Plan a docs project named Eval Root Recipe with tmux",
    options: (fixtures) => ({
      agent: fixtures.actorSlug,
      root: fixtures.rootSlug,
      recipe: fixtures.recipeSlug,
      tmux: false,
    }),
    checks: (fixtures, run) => {
      const call = firstToolCallAny(run, ["projects_create", "projects_plan_create"]);
      const plan = outputPlan(call);
      const primaryPath = nested(plan, ["project", "primary_path"]);
      const tags = nested(plan, ["project", "tags"]) as unknown[] | undefined;
      return [
        checkAnyTool(run, ["projects_create", "projects_plan_create"]),
        check("actor-agent", run.actor_agent_id === fixtures.actorId, "Prompt --agent should control mutation attribution", { expected: fixtures.actorId, actual: run.actor_agent_id }),
        check("forced-root", nested(plan, ["project", "root_id"]) === fixtures.rootId, "Plan should use the forced root"),
        check("forced-recipe", nested(plan, ["project", "recipe_id"]) === fixtures.recipeId, "Plan should use the forced recipe"),
        check("root-template-path", primaryPath === join(fixtures.rootPath, "docs-eval-root-recipe"), "Plan should derive path from forced root template", { primary_path: primaryPath }),
        check("recipe-kind", nested(plan, ["project", "kind"]) === "docs", "Recipe/root kind should be applied"),
        check("recipe-tags", Array.isArray(tags) && tags.includes("docs") && tags.includes("eval-recipe"), "Recipe tags should be applied"),
        check("tmux-disabled", nested(call, ["output", "plan", "tmux"]) === null, "Tmux should be disabled by --no-tmux"),
      ];
    },
  },
  {
    id: "duplicate-existing-project",
    requiresLive: true,
    prompt: (fixtures) => `Create a project named ${fixtures.duplicateWorkspaceSlug} in ${fixtures.duplicateWorkspacePath}`,
    checks: (fixtures, run) => {
      const call = firstToolCall(run, "projects_create") ?? firstToolCall(run, "projects_show");
      return [
        checkAnyTool(run, ["projects_create", "projects_show"]),
        check("no-created-projects", run.projects.length === 0, "Duplicate dry-run must not create project rows"),
        check("existing-detected", nested(call, ["output", "status"]) === "already_exists" || nested(call, ["output", "slug"]) === fixtures.duplicateWorkspaceSlug, "Existing project should be detected", { output: call?.output }),
      ];
    },
  },
  {
    id: "root-create",
    requiresLive: true,
    prompt: (fixtures) => `Register a new root named Eval Planned Root at ${join(fixtures.basePath, "planned-root")} for projects with tag planned-root and path template {slug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_roots_add");
      return [
        checkTool(run, "projects_roots_add"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Root creation should be planned in dry-run"),
      ];
    },
  },
  {
    id: "roots-list",
    requiresLive: true,
    prompt: () => "List the registered project roots and their templates",
    checks: (_fixtures, run) => [checkTool(run, "projects_roots_list")],
  },
  {
    id: "roots-match",
    requiresLive: true,
    prompt: (fixtures) => `Match the best registered root for a docs project at ${join(fixtures.rootPath, "docs-match")} with tag eval-root`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_roots_match");
      const output = call?.output;
      return [
        checkTool(run, "projects_roots_match"),
        check("has-match", Array.isArray(output) && output.length > 0, "Root match should return at least one candidate"),
      ];
    },
  },
  {
    id: "recipe-create",
    requiresLive: true,
    prompt: () => "Create a docs project recipe named Eval Planned Recipe with tags docs and planned-recipe",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_recipes_add");
      return [
        checkTool(run, "projects_recipes_add"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Recipe creation should be planned in dry-run"),
      ];
    },
  },
  {
    id: "tmux-profile-create",
    requiresLive: true,
    prompt: () => "Create a saved tmux profile named Eval Planned Profile with editor and server windows",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_tmux_profiles_add");
      return [
        checkTool(run, "projects_tmux_profiles_add"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Tmux profile creation should be planned in dry-run"),
      ];
    },
  },
  {
    id: "recipe-get",
    requiresLive: true,
    prompt: (fixtures) => `Show the full recipe metadata for recipe ${fixtures.recipeSlug}`,
    checks: (_fixtures, run) => [checkTool(run, "projects_recipes_show")],
  },
  {
    id: "agent-create",
    requiresLive: true,
    prompt: () => "Record a human agent named Eval Planned Reviewer with role reviewer",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_agents_add");
      return [
        checkTool(run, "projects_agents_add"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Agent creation should be planned in dry-run"),
      ];
    },
  },
  {
    id: "agents-list",
    requiresLive: true,
    prompt: () => "List the registered agents that can own project changes",
    checks: (_fixtures, run) => [checkTool(run, "projects_agents_list")],
  },
  {
    id: "projects-list-query",
    requiresLive: true,
    prompt: () => "List existing projects matching security-cameras or family-security metadata",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_list");
      const output = call?.output;
      return [
        checkTool(run, "projects_list"),
        check("has-results", Array.isArray(output) && output.length > 0, "Project query should return matching metadata/tag rows"),
      ];
    },
  },
  {
    id: "project-show",
    requiresLive: true,
    prompt: (fixtures) => `Show project ${fixtures.metadataWorkspaceSlug} with metadata and tags`,
    checks: (fixtures, run) => {
      const call = firstToolCall(run, "projects_show");
      return [
        checkTool(run, "projects_show"),
        check("slug", nested(call, ["output", "slug"]) === fixtures.metadataWorkspaceSlug, "Project show should return requested project"),
      ];
    },
  },
  {
    id: "project-events-list",
    requiresLive: true,
    prompt: (fixtures) => `List audit events for project ${fixtures.updateWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_events_list");
      const output = call?.output;
      return [
        checkTool(run, "projects_events_list"),
        check("has-events", Array.isArray(output) && output.length > 0, "Events list should return creation event"),
      ];
    },
  },
  {
    id: "project-event-record",
    requiresLive: true,
    prompt: (fixtures) => `Record a custom audit event security_review_planned for project ${fixtures.metadataWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_event_record");
      return [
        checkTool(run, "projects_event_record"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Event record should be planned in dry-run"),
      ];
    },
  },
  {
    id: "project-verification-run",
    requiresLive: true,
    prompt: (fixtures) => `Run project verification checks for ${fixtures.metadataWorkspaceSlug}`,
    checks: (_fixtures, run) => [checkTool(run, "projects_doctor")],
  },
  {
    id: "import-existing-folder",
    requiresLive: true,
    prompt: (fixtures) => `Import folder ${fixtures.importPath} as a project`,
    checks: (fixtures, run) => {
      const call = firstToolCall(run, "projects_import");
      return [
        checkTool(run, "projects_import"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Import should be planned in dry-run"),
        check("preview-path", nested(call, ["output", "preview", "path"]) === fixtures.importPath, "Import preview path should match fixture"),
      ];
    },
  },
  {
    id: "import-bulk",
    requiresLive: true,
    prompt: (fixtures) => `Bulk import the direct child folders under ${fixtures.bulkImportPath} as projects`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_import");
      return [
        checkTool(run, "projects_import"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Bulk import should be planned in dry-run"),
      ];
    },
  },
  {
    id: "scan-roots",
    requiresLive: true,
    prompt: () => "Scan all registered roots and preview importing direct child folders",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_scan_roots");
      return [
        checkTool(run, "projects_scan_roots"),
        check("dry-run", Boolean(nested(call, ["output", "dry_run"])) || nested(call, ["output", "status"]) === "planned", "Scan roots should run as a dry-run preview"),
      ];
    },
  },
  {
    id: "update-description",
    requiresLive: true,
    prompt: (fixtures) => `Update project ${fixtures.updateWorkspaceSlug} description to "eval updated description"`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_update");
      const description = nested(call, ["output", "input", "description"]);
      return [
        checkTool(run, "projects_update"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Update should be planned in dry-run"),
        check("description", typeof description === "string" && description.includes("eval updated description"), "Planned update should include requested description", { description }),
      ];
    },
  },
  {
    id: "update-tags",
    requiresLive: true,
    prompt: (fixtures) => `Update project ${fixtures.updateWorkspaceSlug} tags to alpha, beta, and family-security`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_update");
      const tags = nested(call, ["output", "input", "tags"]);
      return [
        checkTool(run, "projects_update"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Update should be planned in dry-run"),
        check("tags", Array.isArray(tags) && tags.includes("family-security"), "Planned update should include requested tags", { tags }),
      ];
    },
  },
  {
    id: "archive-project",
    requiresLive: true,
    prompt: (fixtures) => `Archive project ${fixtures.archiveWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_archive");
      return [
        checkTool(run, "projects_archive"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Archive should be planned in dry-run"),
        check("next-status", nested(call, ["output", "next_status"]) === "archived", "Archive plan should set next_status archived"),
      ];
    },
  },
  {
    id: "unarchive-project",
    requiresLive: true,
    prompt: (fixtures) => `Unarchive project ${fixtures.unarchiveWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_unarchive");
      return [
        checkTool(run, "projects_unarchive"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Unarchive should be planned in dry-run"),
        check("next-status", nested(call, ["output", "next_status"]) === "active", "Unarchive plan should set next_status active"),
      ];
    },
  },
  {
    id: "delete-project",
    requiresLive: true,
    prompt: (fixtures) => `Delete project ${fixtures.deleteWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_delete");
      return [
        checkTool(run, "projects_delete"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Delete should be planned in dry-run"),
        check("next-status", nested(call, ["output", "next_status"]) === "deleted", "Delete plan should mark next_status deleted"),
      ];
    },
  },
  {
    id: "hard-delete-project",
    requiresLive: true,
    prompt: (fixtures) => `Hard delete project ${fixtures.hardDeleteWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_delete");
      return [
        checkTool(run, "projects_delete"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Hard delete should be planned in dry-run"),
        check("hard", nested(call, ["output", "hard"]) === true, "Hard delete plan should set hard=true"),
      ];
    },
  },
  {
    id: "cleanup-create",
    requiresLive: true,
    prompt: (fixtures) => `Preview cleanup for project creation artifacts of ${fixtures.cleanupWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_cleanup_create");
      return [
        checkTool(run, "projects_cleanup_create"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Cleanup should be planned in dry-run"),
      ];
    },
  },
  {
    id: "tmux-apply-existing",
    requiresLive: true,
    prompt: (fixtures) => `Plan a tmux session for existing project ${fixtures.tmuxWorkspaceSlug} with an editor window`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_tmux_profiles_apply");
      return [
        checkTool(run, "projects_tmux_profiles_apply"),
        check("no-extra-create", !firstToolCall(run, "projects_create"), "Tmux eval should not trigger projects_create fallback"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "Tmux apply should be planned in dry-run"),
        check("tmux-result", nested(call, ["output", "result", "session_action"]) === "planned", "Tmux result should be dry-run planned"),
      ];
    },
  },
  {
    id: "github-publish-project",
    requiresLive: true,
    prompt: (fixtures) => `Plan publishing project ${fixtures.githubWorkspaceSlug} to GitHub as a public repository`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_github_publish");
      return [
        checkTool(run, "projects_github_publish"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "GitHub publish should be planned in dry-run"),
        check("visibility", nested(call, ["output", "visibility"]) === "public", "GitHub publish should use public visibility"),
        check("repo-full-name", typeof nested(call, ["output", "full_name"]) === "string", "GitHub publish should return a full repo name"),
      ];
    },
  },
  {
    id: "github-unpublish-project",
    requiresLive: true,
    prompt: (fixtures) => `Plan unpublishing GitHub metadata from project ${fixtures.githubPublishedWorkspaceSlug} and clear GitHub integrations`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_github_unpublish");
      return [
        checkTool(run, "projects_github_unpublish"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "GitHub unpublish should be planned in dry-run"),
        check("clear-integrations", nested(call, ["output", "integrations_cleared"]) === true, "Unpublish should plan clearing integrations"),
      ];
    },
  },
  {
    id: "github-import-remote-only",
    requiresLive: true,
    prompt: () => "Import GitHub repository hasna/eval-remote-only as a remote-only project",
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_import_github");
      return [
        checkTool(run, "projects_import_github"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "GitHub import should be planned in dry-run"),
        check("remote-only", nested(call, ["output", "remote_only"]) === true, "GitHub import should plan a remote-only project"),
        check("repo-full-name", nested(call, ["output", "full_name"]) === "hasna/eval-remote-only", "GitHub import should preserve org/repo"),
      ];
    },
  },
  {
    id: "github-import-local-root",
    requiresLive: true,
    prompt: (fixtures) => `Import GitHub repository hasna/eval-local-import under root ${fixtures.rootSlug} as a local project without cloning`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_import_github");
      return [
        checkTool(run, "projects_import_github"),
        check("dry-run-planned", nested(call, ["output", "status"]) === "planned", "GitHub local import should be planned in dry-run"),
        check("local", nested(call, ["output", "remote_only"]) === false, "GitHub import with a root should plan a local project"),
      ];
    },
  },
  {
    id: "integrations-link",
    requiresLive: true,
    prompt: (fixtures) => `Link todos project id todo_eval_123 to project ${fixtures.githubWorkspaceSlug}`,
    checks: (_fixtures, run) => {
      const call = firstToolCall(run, "projects_link");
      return [
        checkTool(run, "projects_link"),
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
  const basePath = options.basePath ?? mkdtempSync(join(tmpdir(), "project-agent-eval-"));
  mkdirSync(basePath, { recursive: true });
  const dbPath = options.dbPath ?? join(basePath, "eval-projects.db");
  const hadPreviousDbPath = Object.prototype.hasOwnProperty.call(process.env, "HASNA_PROJECTS_DB_PATH");
  const previousDbPath = process.env["HASNA_PROJECTS_DB_PATH"];

  process.env["HASNA_PROJECTS_DB_PATH"] = dbPath;
  closeDatabase();

  try {
    const fixtures = setupFixtures(basePath);
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
      db_path: dbPath,
      summary: summary(results),
      cases: results,
    };
  } finally {
    closeDatabase();
    if (hadPreviousDbPath) {
      process.env["HASNA_PROJECTS_DB_PATH"] = previousDbPath;
    } else {
      delete process.env["HASNA_PROJECTS_DB_PATH"];
    }
  }
}
