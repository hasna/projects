import type { Database } from "bun:sqlite";
import { customAlphabet } from "nanoid";
import { getDatabase, now } from "../db/database.js";
import { recordWorkspaceEvent } from "../db/workspaces.js";
import type { JsonObject } from "../types/workspace.js";

const nanoid = customAlphabet(`0123456789${"abcdefghijklmnopqrstuvwxyz"}`, 12);

export type ProjectBudgetScopeType = "project" | "run";
export type ProjectBudgetWindow = "daily" | "monthly" | "lifetime";
export type ProjectBudgetMode = "hard" | "soft";

export interface ProjectBudget {
  id: string;
  scope_type: ProjectBudgetScopeType;
  scope_id: string;
  window: ProjectBudgetWindow;
  mode: ProjectBudgetMode;
  max_usd: number | null;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  max_total_tokens: number | null;
  warning_threshold: number | null;
  reset_at: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

interface ProjectBudgetRow extends Omit<ProjectBudget, "scope_type" | "window" | "mode" | "metadata"> {
  scope_type: string;
  window: string;
  mode: string;
  metadata: string;
}

export interface CreateProjectBudgetInput {
  id?: string;
  scope_type: ProjectBudgetScopeType;
  scope_id: string;
  window?: ProjectBudgetWindow;
  mode?: ProjectBudgetMode;
  max_usd?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_total_tokens?: number;
  warning_threshold?: number;
  metadata?: JsonObject;
}

export interface ProjectSpendInput {
  workspace_id?: string;
  run_id?: string;
  provider?: string;
  model?: string;
  usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  metadata?: JsonObject;
}

export interface ProjectBudgetSpend {
  id: string;
  workspace_id: string | null;
  run_id: string | null;
  provider: string | null;
  model: string | null;
  usd: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  metadata: JsonObject;
  created_at: string;
}

interface ProjectBudgetSpendRow extends Omit<ProjectBudgetSpend, "metadata"> {
  metadata: string;
}

export interface ProjectBudgetTotals {
  usd: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ProjectBudgetStatus {
  budget: ProjectBudget;
  spent: ProjectBudgetTotals;
  remaining: {
    usd?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  window_start: string | null;
  exhausted: boolean;
  exceeded: boolean;
  warnings: string[];
}

export interface ProjectBudgetContext {
  workspace_id?: string;
  run_id?: string;
  budget_id?: string;
}

export class BudgetExceededError extends Error {
  readonly status = "budget_exceeded";
  readonly statuses: ProjectBudgetStatus[];

  constructor(statuses: ProjectBudgetStatus[]) {
    const ids = statuses.map((status) => status.budget.id).join(", ");
    super(`Project budget exceeded: ${ids}`);
    this.name = "BudgetExceededError";
    this.statuses = statuses;
  }
}

const zeroTotals: ProjectBudgetTotals = {
  usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
};

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToBudget(row: ProjectBudgetRow): ProjectBudget {
  return {
    ...row,
    scope_type: row.scope_type as ProjectBudgetScopeType,
    window: row.window as ProjectBudgetWindow,
    mode: row.mode as ProjectBudgetMode,
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function rowToSpend(row: ProjectBudgetSpendRow): ProjectBudgetSpend {
  return {
    ...row,
    metadata: parseJson<JsonObject>(row.metadata, {}),
  };
}

function roundMoney(value: number): number {
  return Number(value.toFixed(12));
}

function assertLimit(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
}

function assertBudgetHasLimit(input: CreateProjectBudgetInput): void {
  if (
    input.max_usd === undefined &&
    input.max_input_tokens === undefined &&
    input.max_output_tokens === undefined &&
    input.max_total_tokens === undefined
  ) {
    throw new Error("Budget must define at least one money or token limit");
  }
}

export function createProjectBudget(input: CreateProjectBudgetInput, db?: Database): ProjectBudget {
  assertBudgetHasLimit(input);
  assertLimit(input.max_usd, "max_usd");
  assertLimit(input.max_input_tokens, "max_input_tokens");
  assertLimit(input.max_output_tokens, "max_output_tokens");
  assertLimit(input.max_total_tokens, "max_total_tokens");

  const d = db || getDatabase();
  const id = input.id ?? `bud_${nanoid()}`;
  const ts = now();
  d.run(
    `INSERT INTO project_budgets (
      id, scope_type, scope_id, window, mode, max_usd, max_input_tokens,
      max_output_tokens, max_total_tokens, warning_threshold, reset_at, metadata,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      scope_type = excluded.scope_type,
      scope_id = excluded.scope_id,
      window = excluded.window,
      mode = excluded.mode,
      max_usd = excluded.max_usd,
      max_input_tokens = excluded.max_input_tokens,
      max_output_tokens = excluded.max_output_tokens,
      max_total_tokens = excluded.max_total_tokens,
      warning_threshold = excluded.warning_threshold,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at`,
    [
      id,
      input.scope_type,
      input.scope_id,
      input.window ?? "lifetime",
      input.mode ?? "hard",
      input.max_usd ?? null,
      input.max_input_tokens ?? null,
      input.max_output_tokens ?? null,
      input.max_total_tokens ?? null,
      input.warning_threshold ?? null,
      json(input.metadata ?? {}),
      ts,
      ts,
    ],
  );
  return getProjectBudget(id, d)!;
}

export function getProjectBudget(id: string, db?: Database): ProjectBudget | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM project_budgets WHERE id = ?").get(id) as ProjectBudgetRow | null;
  return row ? rowToBudget(row) : null;
}

export function listProjectBudgets(filter: ProjectBudgetContext = {}, db?: Database): ProjectBudget[] {
  const d = db || getDatabase();
  if (filter.budget_id) {
    return (d.query("SELECT * FROM project_budgets WHERE id = ? ORDER BY created_at ASC").all(filter.budget_id) as ProjectBudgetRow[])
      .map(rowToBudget);
  }
  if (filter.workspace_id && filter.run_id) {
    return (d
      .query("SELECT * FROM project_budgets WHERE (scope_type = 'project' AND scope_id = ?) OR (scope_type = 'run' AND scope_id = ?) ORDER BY created_at ASC")
      .all(filter.workspace_id, filter.run_id) as ProjectBudgetRow[])
      .map(rowToBudget);
  }
  if (filter.workspace_id) {
    return (d
      .query("SELECT * FROM project_budgets WHERE scope_type = 'project' AND scope_id = ? ORDER BY created_at ASC")
      .all(filter.workspace_id) as ProjectBudgetRow[])
      .map(rowToBudget);
  }
  if (filter.run_id) {
    return (d
      .query("SELECT * FROM project_budgets WHERE scope_type = 'run' AND scope_id = ? ORDER BY created_at ASC")
      .all(filter.run_id) as ProjectBudgetRow[])
      .map(rowToBudget);
  }
  return (d.query("SELECT * FROM project_budgets ORDER BY created_at ASC").all() as ProjectBudgetRow[]).map(rowToBudget);
}

export function resetProjectBudget(id: string, db?: Database): ProjectBudget {
  const d = db || getDatabase();
  d.run("UPDATE project_budgets SET reset_at = ?, updated_at = ? WHERE id = ?", [now(), now(), id]);
  const budget = getProjectBudget(id, d);
  if (!budget) throw new Error(`Budget not found: ${id}`);
  return budget;
}

export function recordProjectSpend(input: ProjectSpendInput, db?: Database): ProjectBudgetSpend {
  const d = db || getDatabase();
  const id = `spend_${nanoid()}`;
  const totalTokens = input.total_tokens ?? (input.input_tokens ?? 0) + (input.output_tokens ?? 0);
  d.run(
    `INSERT INTO project_budget_spend (
      id, workspace_id, run_id, provider, model, usd, input_tokens,
      output_tokens, total_tokens, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspace_id ?? null,
      input.run_id ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.usd ?? 0,
      input.input_tokens ?? 0,
      input.output_tokens ?? 0,
      totalTokens,
      json(input.metadata ?? {}),
      now(),
    ],
  );
  const row = d.query("SELECT * FROM project_budget_spend WHERE id = ?").get(id) as ProjectBudgetSpendRow;
  const spend = rowToSpend(row);
  if (input.workspace_id) {
    recordWorkspaceEvent({
      workspace_id: input.workspace_id,
      event_type: "budget_spend",
      source: "system",
      after: spend as unknown as JsonObject,
      metadata: { run_id: input.run_id ?? null },
    }, d);
  }
  return spend;
}

function windowStartFor(budget: ProjectBudget): string | null {
  const current = new Date();
  let start: Date | null = null;
  if (budget.window === "daily") {
    start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate()));
  } else if (budget.window === "monthly") {
    start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1));
  }
  const resetAt = budget.reset_at ? new Date(budget.reset_at) : null;
  if (resetAt && (!start || resetAt > start)) return resetAt.toISOString();
  return start?.toISOString() ?? null;
}

function totalsForBudget(budget: ProjectBudget, db: Database): ProjectBudgetTotals {
  const start = windowStartFor(budget);
  const startParam = start?.replace("T", " ").replace("Z", "");
  const projectTotalsSql = `
    SELECT
      COALESCE(SUM(usd), 0) as usd,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM project_budget_spend
    WHERE workspace_id = ?
  `;
  const projectTotalsWindowSql = `
    SELECT
      COALESCE(SUM(usd), 0) as usd,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM project_budget_spend
    WHERE workspace_id = ? AND created_at >= ?
  `;
  const runTotalsSql = `
    SELECT
      COALESCE(SUM(usd), 0) as usd,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM project_budget_spend
    WHERE run_id = ?
  `;
  const runTotalsWindowSql = `
    SELECT
      COALESCE(SUM(usd), 0) as usd,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(total_tokens), 0) as total_tokens
    FROM project_budget_spend
    WHERE run_id = ? AND created_at >= ?
  `;
  const row = budget.scope_type === "project"
    ? startParam
      ? db.query(projectTotalsWindowSql).get(budget.scope_id, startParam) as ProjectBudgetTotals
      : db.query(projectTotalsSql).get(budget.scope_id) as ProjectBudgetTotals
    : startParam
      ? db.query(runTotalsWindowSql).get(budget.scope_id, startParam) as ProjectBudgetTotals
      : db.query(runTotalsSql).get(budget.scope_id) as ProjectBudgetTotals;
  return {
    usd: roundMoney(row.usd),
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
  };
}

function remainingNumber(limit: number | null, spent: number): number | undefined {
  return limit === null ? undefined : Math.max(0, roundMoney(limit - spent));
}

function remainingTokens(limit: number | null, spent: number): number | undefined {
  return limit === null ? undefined : Math.max(0, limit - spent);
}

function exceeded(limit: number | null, spent: number): boolean {
  return limit !== null && spent > limit;
}

function exhausted(limit: number | null, spent: number): boolean {
  return limit !== null && spent >= limit;
}

function warningsFor(budget: ProjectBudget, spent: ProjectBudgetTotals): string[] {
  const threshold = budget.warning_threshold ?? (budget.mode === "soft" ? 0.8 : null);
  const warnings: string[] = [];
  const check = (label: string, limit: number | null, value: number) => {
    if (limit === null) return;
    if (value > limit) warnings.push(`${label} budget exceeded`);
    else if (threshold !== null && limit > 0 && value >= limit * threshold) {
      warnings.push(`${label} budget at or above ${Math.round(threshold * 100)}%`);
    }
  };
  check("USD", budget.max_usd, spent.usd);
  check("input token", budget.max_input_tokens, spent.input_tokens);
  check("output token", budget.max_output_tokens, spent.output_tokens);
  check("total token", budget.max_total_tokens, spent.total_tokens);
  return warnings;
}

function statusForBudget(budget: ProjectBudget, db: Database): ProjectBudgetStatus {
  const spent = totalsForBudget(budget, db);
  return {
    budget,
    spent,
    remaining: {
      ...(budget.max_usd === null ? {} : { usd: remainingNumber(budget.max_usd, spent.usd) }),
      ...(budget.max_input_tokens === null ? {} : { input_tokens: remainingTokens(budget.max_input_tokens, spent.input_tokens) }),
      ...(budget.max_output_tokens === null ? {} : { output_tokens: remainingTokens(budget.max_output_tokens, spent.output_tokens) }),
      ...(budget.max_total_tokens === null ? {} : { total_tokens: remainingTokens(budget.max_total_tokens, spent.total_tokens) }),
    },
    window_start: windowStartFor(budget),
    exhausted:
      exhausted(budget.max_usd, spent.usd) ||
      exhausted(budget.max_input_tokens, spent.input_tokens) ||
      exhausted(budget.max_output_tokens, spent.output_tokens) ||
      exhausted(budget.max_total_tokens, spent.total_tokens),
    exceeded:
      exceeded(budget.max_usd, spent.usd) ||
      exceeded(budget.max_input_tokens, spent.input_tokens) ||
      exceeded(budget.max_output_tokens, spent.output_tokens) ||
      exceeded(budget.max_total_tokens, spent.total_tokens),
    warnings: warningsFor(budget, spent),
  };
}

export function getProjectBudgetStatuses(context: ProjectBudgetContext = {}, db?: Database): ProjectBudgetStatus[] {
  const d = db || getDatabase();
  return listProjectBudgets(context, d).map((budget) => statusForBudget(budget, d));
}

export function assertProjectBudgets(context: ProjectBudgetContext = {}, db?: Database): ProjectBudgetStatus[] {
  const statuses = getProjectBudgetStatuses(context, db);
  const blocked = statuses.filter((status) => status.budget.mode === "hard" && status.exhausted);
  if (blocked.length > 0) throw new BudgetExceededError(blocked);
  return statuses;
}

export function assertProjectBudgetsAfterSpend(context: ProjectBudgetContext = {}, db?: Database): ProjectBudgetStatus[] {
  const statuses = getProjectBudgetStatuses(context, db);
  const blocked = statuses.filter((status) => status.budget.mode === "hard" && status.exceeded);
  if (blocked.length > 0) throw new BudgetExceededError(blocked);
  return statuses;
}

export interface ProjectUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeProjectUsage(raw: unknown): ProjectUsage {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const input = numberFrom(record.inputTokens) ?? numberFrom(record.promptTokens) ?? numberFrom(record.prompt_tokens) ?? 0;
  const output = numberFrom(record.outputTokens) ?? numberFrom(record.completionTokens) ?? numberFrom(record.completion_tokens) ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: numberFrom(record.totalTokens) ?? numberFrom(record.total_tokens) ?? input + output,
  };
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function openRouterCostFromMetadata(providerMetadata: unknown): number | undefined {
  const metadata = objectFrom(providerMetadata);
  const openrouter = objectFrom(metadata.openrouter);
  const usage = objectFrom(openrouter.usage);
  return numberFrom(usage.cost);
}

export function modelPricing(model: string): { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number } | undefined {
  const raw = process.env["PROJECTS_MODEL_PRICING_JSON"];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, { inputUsdPerMillionTokens?: number; outputUsdPerMillionTokens?: number }>;
      const price = parsed[model];
      if (typeof price?.inputUsdPerMillionTokens === "number" && typeof price.outputUsdPerMillionTokens === "number") {
        return {
          inputUsdPerMillionTokens: price.inputUsdPerMillionTokens,
          outputUsdPerMillionTokens: price.outputUsdPerMillionTokens,
        };
      }
    } catch {
      // Ignore invalid optional pricing config.
    }
  }
  const defaults: Record<string, { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }> = {
    "openai/gpt-4o-mini": { inputUsdPerMillionTokens: 0.15, outputUsdPerMillionTokens: 0.6 },
    "openai/gpt-4.1-mini": { inputUsdPerMillionTokens: 0.4, outputUsdPerMillionTokens: 1.6 },
  };
  return defaults[model];
}

export function estimateProjectCostUsd(
  usage: ProjectUsage,
  model: string,
  providerMetadata?: unknown,
): number {
  const metadataCost = openRouterCostFromMetadata(providerMetadata);
  if (metadataCost !== undefined) return metadataCost;
  const price = modelPricing(model);
  if (!price) return 0;
  return roundMoney(
    (usage.input_tokens * price.inputUsdPerMillionTokens + usage.output_tokens * price.outputUsdPerMillionTokens) / 1_000_000,
  );
}
