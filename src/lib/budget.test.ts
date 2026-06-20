import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "../db/database.js";
import { createWorkspace } from "../db/workspaces.js";
import {
  BudgetExceededError,
  assertProjectBudgets,
  createProjectBudget,
  getProjectBudgetStatuses,
  recordProjectSpend,
} from "./budget.js";

describe("project budgets", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env["HASNA_PROJECTS_DB_PATH"];
  });

  test("tracks remaining money and tokens for project budgets", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-budget-store-"));
    process.env["HASNA_PROJECTS_DB_PATH"] = join(root, "projects.db");
    const project = createWorkspace({ name: "Budgeted App", slug: "budgeted-app", kind: "project" });
    const budget = createProjectBudget({
      scope_type: "project",
      scope_id: project.id,
      window: "lifetime",
      mode: "hard",
      max_usd: 0.25,
      max_total_tokens: 100,
    });

    recordProjectSpend({
      workspace_id: project.id,
      run_id: "run_test",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      usd: 0.05,
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
    });

    const [status] = getProjectBudgetStatuses({ workspace_id: project.id });
    expect(status?.budget.id).toBe(budget.id);
    expect(status?.spent.usd).toBe(0.05);
    expect(status?.spent.total_tokens).toBe(25);
    expect(status?.remaining.usd).toBe(0.2);
    expect(status?.remaining.total_tokens).toBe(75);
  });

  test("throws before work starts when a hard budget is exhausted", () => {
    const root = mkdtempSync(join(tmpdir(), "projects-budget-block-"));
    process.env["HASNA_PROJECTS_DB_PATH"] = join(root, "projects.db");
    const project = createWorkspace({ name: "Blocked App", slug: "blocked-app", kind: "project" });
    createProjectBudget({
      scope_type: "project",
      scope_id: project.id,
      window: "lifetime",
      mode: "hard",
      max_total_tokens: 2,
      max_usd: 0.01,
    });
    recordProjectSpend({
      workspace_id: project.id,
      run_id: "run_one",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      usd: 0.0001,
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    });

    expect(() => assertProjectBudgets({ workspace_id: project.id })).toThrow(BudgetExceededError);
  });
});
