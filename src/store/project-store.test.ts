import { describe, expect, test } from "bun:test";
import { resolveProjectStore, __resetProjectStore } from "./project-store.js";

describe("projects store resolution (client-flip)", () => {
  test("no env -> local store", () => {
    __resetProjectStore();
    const store = resolveProjectStore({});
    expect(store.mode).toBe("local");
    expect(store.baseUrl).toBeNull();
  });

  test("self_hosted + url + key -> api store", () => {
    __resetProjectStore();
    const store = resolveProjectStore({
      HASNA_PROJECTS_STORAGE_MODE: "self_hosted",
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "k",
    });
    expect(store.mode).toBe("api");
    expect(store.baseUrl).toBe("https://projects.hasna.xyz/v1");
  });

  // Regression: the fleet flip writes ONLY HASNA_PROJECTS_API_URL +
  // HASNA_PROJECTS_API_KEY (no STORAGE_MODE). Their joint presence must route to
  // the api store, otherwise a flipped CLI silently keeps reading local sqlite.
  test("url + key (no explicit mode) -> api store", () => {
    __resetProjectStore();
    const store = resolveProjectStore({
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "k",
    });
    expect(store.mode).toBe("api");
  });

  test("cloud requested but no key -> throws (never silently local)", () => {
    __resetProjectStore();
    expect(() => resolveProjectStore({ HASNA_PROJECTS_STORAGE_MODE: "self_hosted" })).toThrow();
  });

  test("cloud alias 'cloud' -> api store", () => {
    __resetProjectStore();
    const store = resolveProjectStore({
      HASNA_PROJECTS_STORAGE_MODE: "cloud",
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "k",
    });
    expect(store.mode).toBe("api");
  });

  test("baseUrl never embeds the api key", () => {
    __resetProjectStore();
    const store = resolveProjectStore({
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "super-secret-key",
    });
    expect(store.baseUrl).not.toContain("super-secret-key");
  });
});

// Regression for the split-brain the review flagged: in api mode, roots, agents
// and recipes MUST route to `<url>/v1/...` over HTTP with the bearer key — never
// to local sqlite. These drive the ApiProjectStore through a stub fetch and
// assert both the request path and the response unwrapping.
describe("projects store api transport (roots/agents/recipes)", () => {
  const CLOUD_ENV = {
    HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
    HASNA_PROJECTS_API_KEY: "secret-key",
  };

  function stubStore(handler: (method: string, path: string, body: unknown) => unknown) {
    const calls: Array<{ method: string; path: string; auth: string | null }> = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      const url = new URL(input);
      const headers = new Headers(init?.headers);
      calls.push({ method, path: `${url.pathname}${url.search}`, auth: headers.get("authorization") });
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const result = handler(method, `${url.pathname}${url.search}`, body);
      return new Response(JSON.stringify(result ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    };
    __resetProjectStore();
    const store = resolveProjectStore(CLOUD_ENV, fetchImpl);
    return { store, calls };
  }

  test("listRoots unwraps { roots } from GET /v1/roots with bearer auth", async () => {
    const { store, calls } = stubStore(() => ({ roots: [{ id: "r1", slug: "ws" }], count: 1 }));
    const roots = await store.listRoots();
    expect(roots).toEqual([{ id: "r1", slug: "ws" } as never]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/roots", auth: "Bearer secret-key" });
  });

  test("createRoot POSTs to /v1/roots", async () => {
    const { store, calls } = stubStore((_m, _p, body) => ({ id: "r2", slug: "new", ...(body as object) }));
    const created = await store.createRoot({ name: "New", base_path: "/tmp/new" });
    expect(created).toMatchObject({ id: "r2", slug: "new", name: "New" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/roots" });
  });

  test("matchRoots scores server-fetched roots (no local sqlite)", async () => {
    const { store, calls } = stubStore(() => ({
      roots: [
        { id: "a", slug: "a", name: "a", base_path: "/code/a", tags: [], default_kind: null, github_org: "acme" },
        { id: "b", slug: "b", name: "b", base_path: "/code/b", tags: [], default_kind: null, github_org: "other" },
      ],
    }));
    const matches = await store.matchRoots({ github_org: "acme" });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.root.id).toBe("a");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/roots" });
  });

  test("listAgents unwraps { agents } from GET /v1/agents", async () => {
    const { store, calls } = stubStore(() => ({ agents: [{ id: "ag1", slug: "cli" }], count: 1 }));
    const agents = await store.listAgents();
    expect(agents).toEqual([{ id: "ag1", slug: "cli" } as never]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/agents" });
  });

  test("listRecipes unwraps { recipes } from GET /v1/recipes", async () => {
    const { store, calls } = stubStore(() => ({ recipes: [{ id: "rc1", slug: "cli" }], count: 1 }));
    const recipes = await store.listRecipes();
    expect(recipes).toEqual([{ id: "rc1", slug: "cli" } as never]);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/recipes" });
  });

  test("deleteRoot resolves the root then DELETEs /v1/roots/{id}?detach=true", async () => {
    const { store, calls } = stubStore((method) => {
      if (method === "GET") return { id: "r9", slug: "gone", name: "gone" };
      return { deleted: true, id: "r9", detached_workspaces: 3 };
    });
    const result = await store.deleteRoot("gone", { detachProjects: true });
    expect(result.root.id).toBe("r9");
    expect(result.detached_workspaces).toBe(3);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/roots/r9?detach=true" });
  });

  // Regression for the review's write findings: in api mode an explicit event
  // record MUST POST to the server, and the on-box-only sub-resources (agent
  // assignment, extra locations, mutation locks) MUST NOT silently touch local
  // sqlite — they route through the Store and refuse rather than split-brain.
  test("recordEvent POSTs to /v1/projects/{id}/events and unwraps { event }", async () => {
    const { store, calls } = stubStore((method, _p, body) => {
      if (method === "POST") return { event: { id: "e1", event_type: (body as { event_type: string }).event_type } };
      return {};
    });
    const event = await store.recordEvent("proj1", { event_type: "note", source: "mcp", metadata: { k: 1 } });
    expect(event).toMatchObject({ id: "e1", event_type: "note" });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/v1/projects/proj1/events", auth: "Bearer secret-key" });
  });

  test("on-box sub-resource reads return empty in api mode (no sqlite)", async () => {
    const { store, calls } = stubStore(() => ({}));
    expect(await store.getProjectAgents("p")).toEqual([]);
    expect(await store.getProjectLocations("p")).toEqual([]);
    expect(await store.listLocks()).toEqual([]);
    expect(await store.releaseLock("k")).toBe(false);
    expect(calls).toHaveLength(0); // never hit the network or local sqlite
  });

  test("local-only writes throw in api mode instead of writing local sqlite", async () => {
    const { store } = stubStore(() => ({}));
    await expect(store.assignAgent("p", { agentId: "a" })).rejects.toThrow(/local-only/);
    await expect(store.addLocation("p", { path: "/x" })).rejects.toThrow(/local-only/);
    await expect(store.acquireLock({ key: "k" })).rejects.toThrow(/local-only/);
  });
});
