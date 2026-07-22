import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { PoolQueryClient, TypedQueryClient } from "../generated/storage-kit/query.js";
import { ProjectsPgStore } from "./pg-store.js";

function normalizeSql(sql: string): string {
  return sql
    .replace(/\$(\d+)/g, "?$1")
    .replace(/::jsonb\b/g, "")
    .replace(/::text\b/g, "")
    .replace(/\bNOW\(\)/g, "datetime('now')")
    .replace(/\s+FOR\s+UPDATE\b/gi, "");
}

function sqliteAuthority(): {
  client: PoolQueryClient;
  database: Database;
  concurrency: { pending: number; maxPending: number };
} {
  const database = new Database(":memory:");
  database.run("PRAGMA foreign_keys=ON");
  database.run(`
    CREATE TABLE roots (id TEXT PRIMARY KEY, slug TEXT UNIQUE, tags TEXT, default_kind TEXT, default_recipe_id TEXT);
    CREATE TABLE recipes (id TEXT PRIMARY KEY, slug TEXT UNIQUE, kind TEXT, default_tags TEXT);
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      root_id TEXT,
      recipe_id TEXT,
      primary_path TEXT,
      git_remote TEXT,
      s3_bucket TEXT,
      s3_prefix TEXT,
      tags TEXT NOT NULL,
      integrations TEXT NOT NULL,
      metadata TEXT NOT NULL,
      last_opened_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE TABLE workspace_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      agent_id TEXT,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      prompt TEXT,
      command TEXT,
      before_json TEXT,
      after_json TEXT,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE project_idempotency (
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER,
      response_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(operation, idempotency_key)
    );
    CREATE TABLE workspace_identity_bindings (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      location_owner_id TEXT NOT NULL,
      real_path TEXT NOT NULL,
      logical_path TEXT,
      station_id TEXT,
      machine_id TEXT,
      source TEXT NOT NULL DEFAULT 'authority',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(location_owner_id, real_path)
    );
    CREATE TABLE project_identity_migration_audit (
      id TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      location_owner_id TEXT NOT NULL,
      real_path TEXT NOT NULL,
      workspace_ids TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const base: TypedQueryClient = {
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const statement = database.query(normalizeSql(sql));
      const rows = statement.all(...params as SQLQueryBindings[]) as T[];
      return { rows, rowCount: rows.length };
    },
    async many<T>(sql: string, params: readonly unknown[] = []) {
      return database.query(normalizeSql(sql)).all(...params as SQLQueryBindings[]) as T[];
    },
    async get<T>(sql: string, params: readonly unknown[] = []) {
      return (database.query(normalizeSql(sql)).get(...params as SQLQueryBindings[]) as T | null) ?? null;
    },
    async one<T>(sql: string, params: readonly unknown[] = []) {
      const rows = database.query(normalizeSql(sql)).all(...params as SQLQueryBindings[]) as T[];
      if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
      return rows[0]!;
    },
    async execute(sql: string, params: readonly unknown[] = []) {
      database.query(normalizeSql(sql)).run(...params as SQLQueryBindings[]);
    },
  };

  let tail = Promise.resolve();
  const concurrency = { pending: 0, maxPending: 0 };
  const client: PoolQueryClient = {
    ...base,
    pool: null as never,
    async transaction<T>(fn: (transactionClient: TypedQueryClient) => Promise<T>): Promise<T> {
      concurrency.pending++;
      concurrency.maxPending = Math.max(concurrency.maxPending, concurrency.pending);
      const prior = tail;
      let release = (): void => undefined;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      database.run("BEGIN IMMEDIATE");
      try {
        const result = await fn(base);
        database.run("COMMIT");
        return result;
      } catch (error) {
        database.run("ROLLBACK");
        throw error;
      } finally {
        concurrency.pending--;
        release();
      }
    },
    async close() {
      database.close();
    },
  };
  return { client, database, concurrency };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

describe("ProjectsPgStore authority idempotency", () => {
  test("serializes concurrent creates and replays persisted responses across store instances", async () => {
    const authority = sqliteAuthority();
    try {
      const firstStore = new ProjectsPgStore(authority.client);
      const secondStore = new ProjectsPgStore(authority.client);
      const input = { name: "Concurrent", slug: "concurrent", primary_path: "/srv/concurrent" };
      const options = {
        idempotencyKey: "ope4-concurrent-create",
        locationOwnerId: "station-1",
        realPath: "/srv/concurrent",
      };

      const [first, concurrent] = await Promise.all([
        firstStore.createWorkspace(input, options),
        secondStore.createWorkspace(input, options),
      ]);
      expect(concurrent.id).toBe(first.id);
      expect(authority.concurrency.maxPending).toBeGreaterThanOrEqual(2);
      expect((authority.database.query("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number }).count).toBe(1);

      const persisted = authority.database.query(
        "SELECT request_hash, response_status, response_json FROM project_idempotency WHERE operation = ? AND idempotency_key = ?",
      ).get("workspace.create", options.idempotencyKey) as {
        request_hash: string;
        response_status: number;
        response_json: string;
      };
      expect(persisted.request_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(persisted.response_status).toBe(201);
      expect((JSON.parse(persisted.response_json) as { id: string }).id).toBe(first.id);

      const afterLostResponse = await new ProjectsPgStore(authority.client).createWorkspace(input, options);
      expect(afterLostResponse).toEqual(first);

      try {
        await secondStore.createWorkspace({ ...input, name: "Different request" }, options);
        throw new Error("expected idempotency collision");
      } catch (error) {
        expect(errorCode(error)).toBe("PROJECT_IDEMPOTENCY_KEY_REUSED");
      }
    } finally {
      await authority.client.close();
    }
  });

  test("retains canonical binding conflicts across soft deletion and does not suffix around them", async () => {
    const authority = sqliteAuthority();
    try {
      const store = new ProjectsPgStore(authority.client);
      const bound = await store.createWorkspace(
        { name: "Bound", slug: "bound", primary_path: "/srv/shared" },
        { idempotencyKey: "bound-1", locationOwnerId: "station-1", realPath: "/srv/shared" },
      );
      await store.deleteWorkspace(bound.id);

      try {
        await store.createWorkspace(
          { name: "Suffix Must Not Bypass", slug: "bound", primary_path: "/srv/shared" },
          { idempotencyKey: "bound-2", locationOwnerId: "station-1", realPath: "/srv/shared" },
        );
        throw new Error("expected identity collision");
      } catch (error) {
        expect(errorCode(error)).toBe("PROJECT_ALREADY_REGISTERED");
        const project = (error as { project?: { id?: string; slug?: string; status?: string } }).project;
        expect(project).toEqual({ id: bound.id, slug: bound.slug, status: "deleted" });
      }

      const otherStation = await store.createWorkspace(
        { name: "Other Station", slug: "other-station", primary_path: "/srv/shared" },
        { idempotencyKey: "bound-3", locationOwnerId: "station-2", realPath: "/srv/shared" },
      );
      expect(otherStation.slug).toBe("other-station");
    } finally {
      await authority.client.close();
    }
  });

  test("fails closed with stable lifecycle errors for archived and deleted projects", async () => {
    const authority = sqliteAuthority();
    try {
      const store = new ProjectsPgStore(authority.client);
      const project = await store.createWorkspace({ name: "Lifecycle", slug: "lifecycle" });
      const archived = await store.archiveWorkspace(project.id);
      expect(archived.status).toBe("archived");

      for (const operation of [
        () => store.updateWorkspace(project.id, { name: "Must Not Change" }),
        () => store.archiveWorkspace(project.id),
      ]) {
        try {
          await operation();
          throw new Error("expected archived project rejection");
        } catch (error) {
          expect(errorCode(error)).toBe("PROJECT_ARCHIVED");
          expect((error as { project?: { id?: string; status?: string } }).project).toMatchObject({
            id: project.id,
            status: "archived",
          });
        }
      }

      expect((await store.unarchiveWorkspace(project.id)).status).toBe("active");
      expect((await store.deleteWorkspace(project.id)).workspace.status).toBe("deleted");

      for (const operation of [
        () => store.updateWorkspace(project.id, { name: "Must Not Change" }),
        () => store.unarchiveWorkspace(project.id),
        () => store.deleteWorkspace(project.id),
      ]) {
        try {
          await operation();
          throw new Error("expected deleted project rejection");
        } catch (error) {
          expect(errorCode(error)).toBe("PROJECT_DELETED");
          expect((error as { project?: { id?: string; status?: string } }).project).toMatchObject({
            id: project.id,
            status: "deleted",
          });
        }
      }
    } finally {
      await authority.client.close();
    }
  });

  test("rejects primary paths without an attested identity", async () => {
    const authority = sqliteAuthority();
    try {
      const store = new ProjectsPgStore(authority.client);
      try {
        await store.createWorkspace({ name: "Unattested", primary_path: "/srv/unattested" });
        throw new Error("expected identity requirement");
      } catch (error) {
        expect(errorCode(error)).toBe("PROJECT_IDENTITY_CONFLICT");
      }
      expect((authority.database.query("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number }).count).toBe(0);
    } finally {
      await authority.client.close();
    }
  });

  test("does not promote unattested historical location paths into authority bindings", async () => {
    const authority = sqliteAuthority();
    try {
      authority.database.query(
        `INSERT INTO project_identity_migration_audit
          (id, reason, location_owner_id, real_path, workspace_ids, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        "audit-unattested",
        "historical_location_unattested",
        "station-legacy",
        "/srv/unattested-history",
        JSON.stringify(["wks_legacy"]),
        JSON.stringify({ binding_created: false }),
      );
      const store = new ProjectsPgStore(authority.client);
      try {
        await store.createWorkspace(
          { name: "Must Await Reconciliation", primary_path: "/srv/unattested-history" },
          {
            idempotencyKey: "audit-unattested-create",
            locationOwnerId: "station-legacy",
            realPath: "/srv/unattested-history",
          },
        );
        throw new Error("expected historical audit rejection");
      } catch (error) {
        expect(errorCode(error)).toBe("PROJECT_IDENTITY_CONFLICT");
      }
      expect((authority.database.query("SELECT COUNT(*) AS count FROM workspaces").get() as { count: number }).count).toBe(0);
    } finally {
      await authority.client.close();
    }
  });
});
