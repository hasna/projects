import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/schema.js";
import {
  completeAgentRun,
  createWorkspace,
  getWorkspaceBySlug,
  listAgentRuns,
  listWorkspaceEvents,
  recordWorkspaceEvent,
  startAgentRun,
} from "../db/workspaces.js";
import { buildProjectHandoff, toAgentText } from "./project-agent-assist.js";
import {
  PROJECT_REDACTED_VALUE,
  redactProjectText,
  redactProjectValue,
} from "./redaction.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("project redaction", () => {
  test("redacts secret-shaped keys and strings", () => {
    const input = {
      name: "safe",
      token: "redaction-fixture-token-value",
      nested: {
        command: "OPENROUTER_API_KEY=redaction-fixture-key run",
        url: "https://user:pass@example.test/path",
      },
    };

    const redacted = JSON.stringify(redactProjectValue(input));
    expect(redacted).toContain(PROJECT_REDACTED_VALUE);
    expect(redacted).not.toContain("redaction-fixture-token-value");
    expect(redacted).not.toContain("redaction-fixture-key");
    expect(redacted).not.toContain("user:pass");
    expect(redactProjectText("Authorization: Bearer abcdefghijklmnop")).toContain("Bearer [REDACTED]");
    expect(redactProjectText("tool --token redaction-cli-token")).toContain("--token [REDACTED]");
  });

  test("redacts registry rows, events, runs, and agent handoff text", () => {
    const db = makeDb();
    try {
      const project = createWorkspace({
        id: "wks_redaction",
        name: "Redaction Project",
        slug: "redaction-project",
        kind: "project",
        primary_path: "/tmp/redaction-project",
        integrations: {
          github_url: "https://example.test/repo",
          api_token: "redaction-project-token",
        },
        metadata: {
          owner: "ops",
          clientSecret: "redaction-client-secret",
        },
      }, db);

      recordWorkspaceEvent({
        workspace_id: project.id,
        event_type: "security_check",
        source: "cli",
        prompt: "Use OPENROUTER_API_KEY=redaction-fixture-key",
        command: "PROJECTS_DASHBOARD_TOKEN=redaction-dashboard-token projects dashboard serve",
        before: { password: "redaction-before-password" },
        after: { result: "ok", authorization: "Bearer redactionbearertokenvalue" },
        metadata: { cookie: "redaction-cookie-value" },
      }, db);

      const run = startAgentRun({
        workspace_id: project.id,
        prompt: "Run with NPM_TOKEN=redaction-npm-token",
        plan: { apiKey: "redaction-plan-api-key" },
        metadata: { credential: "redaction-run-credential" },
      }, db);
      completeAgentRun(run.id, {
        result: { connectionString: "postgres://user:pass@example.test/projects" },
        error: "Authorization: Bearer redactionerrorbearer",
        tool_calls: [{ name: "shell", args: { password: "redaction-tool-password" } }],
      }, db);

      const payload = {
        project: getWorkspaceBySlug("redaction-project", db),
        events: listWorkspaceEvents(project.id, db),
        runs: listAgentRuns({ workspace_id: project.id }, db),
        handoff: toAgentText(buildProjectHandoff({ target: "redaction-project", db })),
      };

      const serialized = JSON.stringify(payload);
      expect(serialized).toContain(PROJECT_REDACTED_VALUE);
      for (const leaked of [
        "redaction-project-token",
        "redaction-client-secret",
        "redaction-before-password",
        "redaction-cookie-value",
        "redaction-plan-api-key",
        "redaction-run-credential",
        "redaction-tool-password",
        "redaction-dashboard-token",
        "user:pass",
      ]) {
        expect(serialized).not.toContain(leaked);
      }
    } finally {
      db.close();
    }
  });
});
