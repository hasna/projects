import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/schema.js";
import type { Workspace } from "../types/workspace.js";

interface StoreLike {
  mode: "local" | "api";
  resolveTarget(target: string | undefined, options?: Record<string, unknown>): Promise<Workspace>;
}

describe("unified ProjectStore context resolution", () => {
  test("an explicit database selects a local authority even when API mode is configured", async () => {
    const storeModule = await import("./project-store.js");
    const database = new Database(":memory:");
    try {
      database.run("PRAGMA foreign_keys=ON");
      runMigrations(database);
      const selected = storeModule.resolveProjectStoreForTarget({ db: database });
      expect(selected.mode).toBe("local");

      const explicitApi = storeModule.resolveProjectStore({
        HASNA_PROJECTS_API_URL: "https://projects.example",
        HASNA_PROJECTS_API_KEY: "test-key",
      }, (async () => Response.json({ workspaces: [] })) as unknown as typeof fetch);
      expect(storeModule.resolveProjectStoreForTarget({ db: database, store: explicitApi }).mode).toBe("api");
    } finally {
      database.close();
    }
  });

  test("maps a local marker to a remote canonical id with GET only", async () => {
    const modulePath = "./project-store.js";
    const storeModule = await import(modulePath).catch(() => null) as null | Record<string, unknown>;
    expect(storeModule).not.toBeNull();
    if (!storeModule) return;
    expect(storeModule.resolveProjectStore).toBeFunction();
    const resolveStore = storeModule.resolveProjectStore as (
      env: Record<string, string>,
      fetchImpl: typeof fetch,
    ) => StoreLike;

    const root = mkdtempSync(join(tmpdir(), "projects-store-marker-api-"));
    const calls: Array<{ method: string; url: string }> = [];
    const canonical: Workspace = {
      id: "wks_remote_marker",
      slug: "remote-marker",
      name: "Remote Canonical",
      description: null,
      kind: "project",
      status: "active",
      root_id: null,
      recipe_id: null,
      primary_path: "/remote/canonical",
      git_remote: null,
      s3_bucket: null,
      s3_prefix: null,
      tags: [],
      integrations: {},
      metadata: {},
      last_opened_at: null,
      created_at: "2026-07-22 00:00:00",
      updated_at: "2026-07-22 00:00:00",
      synced_at: null,
    };
    try {
      writeFileSync(join(root, ".project.json"), JSON.stringify({
        id: canonical.id,
        slug: canonical.slug,
        name: "Stale local marker name",
        primary_path: "/stale/local",
      }), "utf-8");
      const fetchImpl = (async (input, init) => {
        calls.push({ method: init?.method ?? "GET", url: String(input) });
        return Response.json(canonical);
      }) as typeof fetch;
      const store = resolveStore({
        HASNA_PROJECTS_API_URL: "https://projects.example",
        HASNA_PROJECTS_API_KEY: "test-key",
        HASNA_PROJECTS_DB_PATH: join(root, "locator.db"),
      }, fetchImpl);

      expect(store.mode).toBe("api");
      const project = await store.resolveTarget(root, { intent: "read", machineId: "station01" });
      expect(project).toEqual(canonical);
      expect(project.name).toBe("Remote Canonical");
      expect(calls).toEqual([{
        method: "GET",
        url: `https://projects.example/v1/projects/${canonical.id}`,
      }]);
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
