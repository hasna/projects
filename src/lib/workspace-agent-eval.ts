import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  createRecipe,
  createRoot,
  createWorkspace,
  workspaceSlugify,
} from "../db/workspaces.js";
import { runWorkspaceAgentPrompt, type WorkspaceAgentPromptOptions, type WorkspaceAgentPromptResult } from "./workspace-agent.js";
import type { JsonObject } from "../types/workspace.js";

export const WORKSPACE_AGENT_EVAL_CASE_IDS = [
  "create-explicit-path",
  "create-root-recipe-no-tmux",
  "import-existing-folder",
  "update-description",
  "archive-workspace",
  "delete-workspace",
  "tmux-apply-existing",
  "github-publish-workspace",
  "github-import-remote-only",
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
  updateWorkspaceSlug: string;
  archiveWorkspaceSlug: string;
  deleteWorkspaceSlug: string;
  tmuxWorkspaceSlug: string;
  githubWorkspaceSlug: string;
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

  const updateWorkspace = createWorkspace({
    name: `Eval Update ${suffix}`,
    slug: `eval-update-${suffix}`,
    kind: "generic",
    primary_path: join(base, "update-target"),
  });
  const archiveWorkspace = createWorkspace({
    name: `Eval Archive ${suffix}`,
    slug: `eval-archive-${suffix}`,
    kind: "generic",
    primary_path: join(base, "archive-target"),
  });
  const deleteWorkspace = createWorkspace({
    name: `Eval Delete ${suffix}`,
    slug: `eval-delete-${suffix}`,
    kind: "generic",
    primary_path: join(base, "delete-target"),
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
    updateWorkspaceSlug: updateWorkspace.slug,
    archiveWorkspaceSlug: archiveWorkspace.slug,
    deleteWorkspaceSlug: deleteWorkspace.slug,
    tmuxWorkspaceSlug: tmuxWorkspace.slug,
    githubWorkspaceSlug: githubWorkspace.slug,
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
