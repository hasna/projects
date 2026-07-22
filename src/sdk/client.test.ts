import { describe, expect, test } from "bun:test";
import { ProjectsClient } from "./client.js";
import { projectContextBundleHash } from "../lib/project-context-bundle.js";

describe("ProjectsClient project context bundle", () => {
  test("exposes the additive typed context-bundle endpoint", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const client = new ProjectsClient({
      baseUrl: "https://projects.example",
      apiKey: "test-key",
      fetch: (async (input, init) => {
        requests.push({ url: String(input), method: init?.method ?? "GET" });
        const payload = {
          schema: "hasna.projects.project_context_bundle.v1",
          generated_at: "2026-07-22T10:00:00.000Z",
          revision: "rev-1",
          freshness: "fresh",
          resolution: { source: "id-or-slug", conflict: false, create_allowed: false },
          authority: { owner: "projects", mode: "api", storage: "cloud", availability: "available" },
          project: { id: "wks_test", slug: "test", name: "Test", kind: "project", status: "active", path: null, updated_at: "2026-07-22 10:00:00" },
          links: {
            todos: { state: "unlinked", project_id: null, task_list_id: null },
            conversations: { state: "unlinked", channel: null },
            mementos: { state: "unlinked", project_id: null, scope: null },
          },
          station: null,
          commands: [],
        };
        return Response.json({ ...payload, hash: projectContextBundleHash(payload) });
      }) as typeof fetch,
    });

    const bundle = await client.getProjectContextBundle("wks_test");
    expect(bundle.schema).toBe("hasna.projects.project_context_bundle.v1");
    expect(bundle.project.id).toBe("wks_test");
    expect(bundle.authority.storage).toBe("cloud");
    expect(requests).toEqual([{ url: "https://projects.example/v1/projects/wks_test/context-bundle", method: "GET" }]);
  });
});
