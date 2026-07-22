import { describe, expect, test } from "bun:test";
import { ApiError, ProjectsClient } from "./client.js";
import { projectContextBundleHash } from "../lib/project-context-bundle.js";

function contextBundlePayload() {
  return {
    schema: "hasna.projects.project_context_bundle.v1" as const,
    generated_at: "2026-07-22T10:00:00.000Z",
    revision: "rev-1",
    freshness: "fresh" as const,
    resolution: { source: "id-or-slug", conflict: false, create_allowed: false },
    authority: { owner: "projects", mode: "api" as const, storage: "cloud" as const, availability: "available" as const },
    project: { id: "wks_test", slug: "test", name: "Test", kind: "project", status: "active" as const, path: null, updated_at: "2026-07-22 10:00:00" },
    links: {
      todos: { state: "unlinked" as const, project_id: null, task_list_id: null },
      conversations: { state: "unlinked" as const, channel: null },
      mementos: { state: "unlinked" as const, project_id: null, scope: null },
    },
    station: null,
    commands: [],
  };
}

describe("ProjectsClient project context bundle", () => {
  test("exposes the additive typed context-bundle endpoint", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const client = new ProjectsClient({
      baseUrl: "https://projects.example",
      apiKey: "test-key",
      fetch: (async (input, init) => {
        requests.push({ url: String(input), method: init?.method ?? "GET" });
        const payload = contextBundlePayload();
        return Response.json({ ...payload, hash: projectContextBundleHash(payload) });
      }) as typeof fetch,
    });

    const bundle = await client.getProjectContextBundle("wks_test");
    expect(bundle.schema).toBe("hasna.projects.project_context_bundle.v1");
    expect(bundle.project.id).toBe("wks_test");
    expect(bundle.authority.storage).toBe("cloud");
    expect(requests).toEqual([{ url: "https://projects.example/v1/projects/wks_test/context-bundle", method: "GET" }]);
  });

  test("rejects extra fields and hash mismatches at the SDK boundary", async () => {
    const payload = contextBundlePayload();
    const clientWithExtra = new ProjectsClient({
      baseUrl: "https://projects.example",
      fetch: (async () => Response.json({
        ...payload,
        hash: projectContextBundleHash(payload),
        forbidden_extra: true,
      })) as unknown as typeof fetch,
    });
    await expect(clientWithExtra.getProjectContextBundle("wks_test")).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_BUNDLE_INVALID",
    });

    const clientWithBadHash = new ProjectsClient({
      baseUrl: "https://projects.example",
      fetch: (async () => Response.json({ ...payload, hash: `sha256:${"0".repeat(64)}` })) as unknown as typeof fetch,
    });
    await expect(clientWithBadHash.getProjectContextBundle("wks_test")).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_BUNDLE_INVALID",
    });

    const oversizedPayload = {
      ...payload,
      project: { ...payload.project, name: "x".repeat(8_000) },
    };
    const clientWithOversizedBundle = new ProjectsClient({
      baseUrl: "https://projects.example",
      fetch: (async () => Response.json({
        ...oversizedPayload,
        hash: projectContextBundleHash(oversizedPayload),
      })) as unknown as typeof fetch,
    });
    await expect(clientWithOversizedBundle.getProjectContextBundle("wks_test")).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_BUNDLE_TOO_LARGE",
    });
  });

  test("surfaces stable project error codes on ApiError", async () => {
    const client = new ProjectsClient({
      baseUrl: "https://projects.example",
      fetch: (async () => Response.json({
        error: { code: "PROJECT_ALREADY_REGISTERED", message: "Project path is already registered" },
        project: { id: "wks_bound", slug: "bound", status: "active" },
      }, { status: 409 })) as unknown as typeof fetch,
    });

    try {
      await client.createProject({ name: "Duplicate" });
      throw new Error("expected createProject to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).code).toBe("PROJECT_ALREADY_REGISTERED");
    }
  });
});
