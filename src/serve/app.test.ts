import { describe, expect, test } from "bun:test";
import { mintApiKey } from "@hasna/contracts/auth";
import { createFetchHandler } from "./app.js";
import { NotFoundError, ProjectsPgStore } from "./pg-store.js";
import type { Workspace } from "../types/workspace.js";

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
  return {
    async ping() {
      return true;
    },
    async listWorkspaces() {
      return created;
    },
    async createWorkspace(input: { name: string; slug?: string }) {
      const ws = fakeWorkspace({ id: `wks_${created.length + 1}`, name: input.name, slug: input.slug ?? "demo" });
      created.push(ws);
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
