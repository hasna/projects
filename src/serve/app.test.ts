import { describe, expect, test } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { createFetchHandler } from "./app.js";
import { NotFoundError, ProjectsPgStore } from "./pg-store.js";
import type { Workspace } from "../types/workspace.js";
import { ProjectContextError } from "../lib/project-context-errors.js";

const SIGNING_SECRET = "test-signing-secret-projects-0000000000";

function fakeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "wks_test1",
    slug: "demo",
    name: "Demo",
    description: null,
    kind: "generic",
    status: "active",
    root_id: null,
    recipe_id: null,
    primary_path: null,
    git_remote: null,
    s3_bucket: null,
    s3_prefix: null,
    tags: [],
    integrations: {},
    metadata: {},
    last_opened_at: null,
    created_at: "2026-07-06 00:00:00",
    updated_at: "2026-07-06 00:00:00",
    synced_at: null,
    ...overrides,
  };
}

/** Minimal fake store — exercises routing/auth without a live Postgres. */
function fakeStore(): ProjectsPgStore {
  const created: Workspace[] = [];
  const idempotency = new Map<string, { hash: string; workspace: Workspace }>();
  return {
    async ping() {
      return true;
    },
    async listWorkspaces() {
      return created;
    },
    async createWorkspace(input: { name: string; slug?: string; primary_path?: string }, options?: { idempotencyKey?: string }) {
      const hash = JSON.stringify(input);
      const key = options?.idempotencyKey;
      if (key) {
        const prior = idempotency.get(key);
        if (prior && prior.hash !== hash) {
          throw Object.assign(new Error("Idempotency key was already used for a different request"), {
            status: 409,
            code: "PROJECT_IDEMPOTENCY_KEY_REUSED",
          });
        }
        if (prior) return prior.workspace;
      }
      const existing = input.primary_path
        ? created.find((workspace) => workspace.primary_path === input.primary_path)
        : undefined;
      if (existing) {
        throw Object.assign(new Error("Project path is already registered"), {
          status: 409,
          code: "PROJECT_ALREADY_REGISTERED",
          project: existing,
        });
      }
      const ws = fakeWorkspace({
        id: `wks_${created.length + 1}`,
        name: input.name,
        slug: input.slug ?? "demo",
        primary_path: input.primary_path ?? null,
      });
      created.push(ws);
      if (key) idempotency.set(key, { hash, workspace: ws });
      return ws;
    },
    async requireWorkspace(id: string) {
      const ws = created.find((w) => w.id === id || w.slug === id);
      if (!ws) throw new NotFoundError(`Workspace not found: ${id}`);
      return ws;
    },
    async listRoots() {
      return [];
    },
  } as unknown as ProjectsPgStore;
}

function handler() {
  return createFetchHandler({ store: fakeStore(), version: "9.9.9", app: "projects", signingSecret: SIGNING_SECRET });
}

function keyWith(scopes: string[]): string {
  return mintApiKey({ app: "projects", scopes, signingSecret: SIGNING_SECRET }).token;
}

describe("projects-serve probes", () => {
  test("GET /health returns status/version/mode", async () => {
    const res = await handler()(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", version: "9.9.9", mode: "cloud" });
  });

  test("GET /version returns version", async () => {
    const res = await handler()(new Request("http://x/version"));
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe("9.9.9");
  });

  test("GET /ready returns ready when db pings", async () => {
    const res = await handler()(new Request("http://x/ready"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ready");
  });

  test("GET /openapi.json serves the spec", async () => {
    const res = await handler()(new Request("http://x/openapi.json"));
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/v1/projects"]).toBeDefined();
    expect(spec.components.schemas.ProjectContextErrorCode.enum).toContain("PROJECT_ALREADY_REGISTERED");
    expect(spec.components.schemas.ProjectContextErrorResponse.additionalProperties).toBe(false);
    expect(spec.components.schemas.ProjectContextErrorDetails.additionalProperties).toBe(false);
    expect(spec.paths["/v1/projects"].post.responses["409"].content["application/json"].schema.$ref)
      .toBe("#/components/schemas/ProjectContextErrorResponse");
    for (const [path, method] of [
      ["/v1/projects/{id}", "patch"],
      ["/v1/projects/{id}", "delete"],
      ["/v1/projects/{id}/archive", "post"],
      ["/v1/projects/{id}/unarchive", "post"],
    ] as const) {
      expect(spec.paths[path][method].responses["409"].content["application/json"].schema.$ref)
        .toBe("#/components/schemas/ProjectContextErrorResponse");
    }
    expect(spec.paths["/v1/projects/{id}/context-bundle"].get.responses["503"].content["application/json"].schema.$ref)
      .toBe("#/components/schemas/ProjectContextErrorResponse");
  });
});

describe("projects-serve auth", () => {
  test("/v1 without a key is 401", async () => {
    const res = await handler()(new Request("http://x/v1/projects"));
    expect(res.status).toBe(401);
  });

  test("/v1 with a wrong-app key is rejected", async () => {
    const token = mintApiKey({ app: "todos", scopes: ["todos:*"], signingSecret: SIGNING_SECRET }).token;
    const res = await handler()(new Request("http://x/v1/projects", { headers: { "x-api-key": token } }));
    expect(res.status).toBe(401);
  });

  test("maps a stable project error code to its HTTP status when a transport omits status", async () => {
    const store = fakeStore() as unknown as Record<string, unknown>;
    store["listWorkspaces"] = async () => {
      throw Object.assign(new Error("Project authority is unavailable"), {
        code: "PROJECT_AUTHORITY_UNAVAILABLE",
      });
    };
    const h = createFetchHandler({
      store: store as unknown as ProjectsPgStore,
      version: "9.9.9",
      app: "projects",
      signingSecret: SIGNING_SECRET,
    });
    const response = await h(new Request("http://x/v1/projects", {
      headers: { "x-api-key": keyWith(["projects:read"]) },
    }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("PROJECT_AUTHORITY_UNAVAILABLE");
  });

  test("returns only allowlisted project identity remediation details", async () => {
    const store = fakeStore() as unknown as Record<string, unknown>;
    store["createWorkspace"] = async () => {
      throw new ProjectContextError("PROJECT_IDENTITY_CONFLICT", "identity required", {
        details: { identity_required: true, secret_hint: "must-not-leak" },
      });
    };
    const h = createFetchHandler({
      store: store as unknown as ProjectsPgStore,
      version: "9.9.9",
      app: "projects",
      signingSecret: SIGNING_SECRET,
    });
    const response = await h(new Request("http://x/v1/projects", {
      method: "POST",
      headers: { "x-api-key": keyWith(["projects:write"]), "content-type": "application/json" },
      body: JSON.stringify({ name: "Needs Identity" }),
    }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: "PROJECT_IDENTITY_CONFLICT" },
      details: { identity_required: true },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  test("records project events through the remote authority route", async () => {
    const project = fakeWorkspace({ id: "wks_event", slug: "event-project" });
    const store = fakeStore() as unknown as Record<string, unknown>;
    store["requireWorkspace"] = async () => project;
    store["recordEvent"] = async (input: Record<string, unknown>) => ({
      id: "evt_api",
      workspace_id: input["workspace_id"],
      agent_id: input["agent_id"] ?? null,
      event_type: input["event_type"],
      source: input["source"],
      prompt: null,
      command: null,
      before: null,
      after: null,
      metadata: input["metadata"] ?? {},
      created_at: "2026-07-22 00:00:00",
    });
    const h = createFetchHandler({
      store: store as unknown as ProjectsPgStore,
      version: "9.9.9",
      app: "projects",
      signingSecret: SIGNING_SECRET,
    });
    const response = await h(new Request("http://x/v1/projects/wks_event/events", {
      method: "POST",
      headers: { "x-api-key": keyWith(["projects:write"]), "content-type": "application/json" },
      body: JSON.stringify({ event_type: "remote_boundary", source: "cli", metadata: { safe: true } }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      event: { id: "evt_api", workspace_id: "wks_event", event_type: "remote_boundary", source: "cli" },
    });
  });

  test("read scope allows GET but not POST", async () => {
    const h = handler();
    const token = keyWith(["projects:read"]);
    const listRes = await h(new Request("http://x/v1/projects", { headers: { "x-api-key": token } }));
    expect(listRes.status).toBe(200);
    const postRes = await h(
      new Request("http://x/v1/projects", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: JSON.stringify({ name: "Nope" }),
      }),
    );
    expect(postRes.status).toBe(403);
  });

  test("wildcard key can create and read back a project", async () => {
    const h = handler();
    const token = keyWith(["projects:*"]);
    const create = await h(
      new Request("http://x/v1/projects", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: JSON.stringify({ name: "Alpha", slug: "alpha" }),
      }),
    );
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.name).toBe("Alpha");

    const get = await h(new Request(`http://x/v1/projects/${created.id}`, { headers: { "x-api-key": token } }));
    expect(get.status).toBe(200);
    expect((await get.json()).slug).toBe("alpha");
  });

  test("GET project context-bundle returns the strict additive schema", async () => {
    const h = handler();
    const token = keyWith(["projects:*"]);
    const create = await h(new Request("http://x/v1/projects", {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bundle",
        slug: "bundle",
        integrations: { todos_project_id: "todo-project", todos_task_list_id: "todo-list" },
      }),
    }));
    const project = await create.json() as Workspace;
    const response = await h(new Request(`http://x/v1/projects/${project.id}/context-bundle`, {
      headers: { "x-api-key": token },
    }));
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const { parseProjectContextBundle } = await import("../lib/project-context-bundle.js");
    const parsed = parseProjectContextBundle(body);
    expect(parsed.schema).toBe("hasna.projects.project_context_bundle.v1");
    expect(parsed.project.id).toBe(project.id);
    expect(parsed.commands.length).toBeLessThanOrEqual(6);
    expect(Buffer.byteLength(JSON.stringify(body), "utf-8")).toBeLessThanOrEqual(8 * 1024);
    expect(() => parseProjectContextBundle({ ...(body as object), arbitrary: true })).toThrow();
  });

  test("replays concurrent and lost-response creates by persisted idempotency key", async () => {
    const h = handler();
    const token = keyWith(["projects:*"]);
    const request = () => new Request("http://x/v1/projects", {
      method: "POST",
      headers: {
        "x-api-key": token,
        "content-type": "application/json",
        "idempotency-key": "ope4-create-alpha",
      },
      body: JSON.stringify({
        name: "Alpha",
        slug: "alpha",
        primary_path: "/srv/alpha",
        identity: { location_owner_id: "station-1", real_path: "/srv/alpha" },
      }),
    });

    const [first, concurrent] = await Promise.all([h(request()), h(request())]);
    expect(first.status).toBe(201);
    expect(concurrent.status).toBe(201);
    const firstBody = await first.json() as Workspace;
    const concurrentBody = await concurrent.json() as Workspace;
    expect(concurrentBody.id).toBe(firstBody.id);

    const replay = await h(request());
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as Workspace).id).toBe(firstBody.id);

    const listed = await h(new Request("http://x/v1/projects", { headers: { "x-api-key": token } }));
    expect(((await listed.json()) as { count: number }).count).toBe(1);
  });

  test("rejects idempotency-key reuse with a different request", async () => {
    const h = handler();
    const token = keyWith(["projects:*"]);
    const create = (name: string) => h(new Request("http://x/v1/projects", {
      method: "POST",
      headers: {
        "x-api-key": token,
        "content-type": "application/json",
        "idempotency-key": "ope4-collision",
      },
      body: JSON.stringify({ name }),
    }));

    expect((await create("First")).status).toBe(201);
    const collision = await create("Second");
    expect(collision.status).toBe(409);
    expect((await collision.json()).error.code).toBe("PROJECT_IDEMPOTENCY_KEY_REUSED");
  });

  test("explicit create against an existing path is 409 with canonical identity", async () => {
    const h = handler();
    const token = keyWith(["projects:*"]);
    const create = (name: string, idempotencyKey: string) => h(new Request("http://x/v1/projects", {
      method: "POST",
      headers: {
        "x-api-key": token,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        name,
        slug: name.toLowerCase(),
        primary_path: "/srv/bound",
        identity: { location_owner_id: "station-1", real_path: "/srv/bound" },
      }),
    }));

    const first = await create("Bound", "ope4-bound-first");
    expect(first.status).toBe(201);
    const canonical = await first.json() as Workspace;

    const duplicate = await create("Duplicate", "ope4-bound-second");
    expect(duplicate.status).toBe(409);
    const body = await duplicate.json();
    expect(body.error.code).toBe("PROJECT_ALREADY_REGISTERED");
    expect(body.project).toEqual({ id: canonical.id, slug: canonical.slug, status: canonical.status });
  });

  test("Authorization: Bearer scheme is accepted", async () => {
    const token = keyWith(["projects:read"]);
    const res = await handler()(
      new Request("http://x/v1/roots", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.status).toBe(200);
  });

  test("missing resource under /v1 is 404 (authenticated)", async () => {
    const token = keyWith(["projects:*"]);
    const res = await handler()(new Request("http://x/v1/nope", { headers: { "x-api-key": token } }));
    expect(res.status).toBe(404);
  });
});
