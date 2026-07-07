import { describe, expect, test } from "bun:test";
import { resolveStorageClient, createStorageClient, createHttpTransport, resolveTransport } from "./client.js";
import { resolveProjectsBackend, __resetProjectsBackend } from "./backend.js";

const APP = "projects";

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = (init?.method || "GET").toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, headers, body });
    const { status, body: resBody } = handler(url, init || {});
    return new Response(resBody === undefined ? "" : JSON.stringify(resBody), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

describe("projects client-flip resolution", () => {
  test("no env -> local (backend null)", () => {
    __resetProjectsBackend();
    expect(resolveProjectsBackend({})).toBeNull();
  });

  test("self_hosted + url + key -> cloud-http", () => {
    __resetProjectsBackend();
    const b = resolveProjectsBackend({
      HASNA_PROJECTS_STORAGE_MODE: "self_hosted",
      HASNA_PROJECTS_API_URL: "https://projects.hasna.xyz",
      HASNA_PROJECTS_API_KEY: "k",
    });
    expect(b?.mode).toBe("cloud-http");
    expect(b?.baseUrl).toBe("https://projects.hasna.xyz/v1");
  });

  test("cloud requested but no key -> throws", () => {
    expect(() => resolveProjectsBackend({ HASNA_PROJECTS_STORAGE_MODE: "self_hosted" })).toThrow();
  });
});

describe("projects cloud workspace CRUD mapping", () => {
  const base = "https://projects.hasna.xyz/v1";
  test("list maps {workspaces} envelope + bearer auth", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: { workspaces: [{ id: "1", slug: "a" }], count: 1 } }));
    const client = createStorageClient(APP, createHttpTransport({ name: APP, baseUrl: base, apiKey: "sek", fetchImpl }));
    const raw = await client.transport.get<{ workspaces: unknown[] }>("/projects", { query: { limit: 5 } });
    expect(raw.workspaces.length).toBe(1);
    expect(calls[0].headers.Authorization).toBe("Bearer sek");
    expect(calls[0].url).toContain("limit=5");
  });

  test("create posts to /v1/projects with idempotency key", async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 201, body: { id: "w1", slug: "proof" } }));
    const client = createStorageClient(APP, createHttpTransport({ name: APP, baseUrl: base, apiKey: "k", fetchImpl }));
    const res = await client.create<{ id: string }>("projects", { name: "proof" });
    expect(res.id).toBe("w1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${base}/projects`);
    expect(calls[0].headers["Idempotency-Key"]).toBeTruthy();
  });

  test("get 404 -> null", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: { error: "not found" } }));
    const client = createStorageClient(APP, createHttpTransport({ name: APP, baseUrl: base, apiKey: "k", fetchImpl }));
    expect(await client.get("projects", "missing")).toBeNull();
  });
});
