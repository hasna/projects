import { afterAll, describe, expect, test } from "bun:test";
import { createPgPool, createQueryClient } from "../generated/storage-kit/index.js";
import { runProjectsMigrations } from "./migrations.js";
import { ProjectsPgStore, generateWorkspaceId, generateRootId, slugify } from "./pg-store.js";

describe("pg-store pure helpers", () => {
  test("slugify normalizes to kebab-case", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  Multi   Space  ")).toBe("multi-space");
  });

  test("id generators carry stable prefixes", () => {
    expect(generateWorkspaceId()).toMatch(/^wks_/);
    expect(generateRootId()).toMatch(/^root_/);
  });
});

// Live CRUD against a real Postgres, gated on PROJECTS_TEST_DATABASE_URL.
const LIVE_URL = process.env.PROJECTS_TEST_DATABASE_URL;

if (LIVE_URL) describe("pg-store live CRUD", () => {
  const pool = createPgPool({ connectionString: LIVE_URL, applicationName: "projects-test" });
  const client = createQueryClient(pool);
  const store = new ProjectsPgStore(client);

  afterAll(async () => {
    await pool.end();
  });

  test("migrations apply idempotently", async () => {
    await runProjectsMigrations(client);
    const second = await runProjectsMigrations(client);
    expect(second.plan.every((p: { state: string }) => p.state === "already_applied")).toBe(true);
  });

  test("create/list/get/update/archive/delete a project", async () => {
    const name = `Test Project ${Date.now()}`;
    const created = await store.createWorkspace({ name, tags: ["test", "serve"] });
    expect(created.id).toMatch(/^wks_/);
    expect(created.tags).toContain("test");

    const fetched = await store.getWorkspace(created.slug);
    expect(fetched?.id).toBe(created.id);

    const updated = await store.updateWorkspace(created.id, { description: "updated" });
    expect(updated.description).toBe("updated");

    const archived = await store.archiveWorkspace(created.id);
    expect(archived.status).toBe("archived");

    const events = await store.listWorkspaceEvents(created.id);
    expect(events.some((e) => e.event_type === "created")).toBe(true);

    const del = await store.deleteWorkspace(created.id, { hard: true });
    expect(del.hard).toBe(true);
    expect(await store.getWorkspace(created.id)).toBeNull();
  });
});
