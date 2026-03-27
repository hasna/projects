import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const TABLES = ["projects", "project_workdirs", "project_files", "sync_log"];

function dbPath(): string {
  return process.env["HASNA_PROJECTS_DB_PATH"] ?? `${process.env["HOME"] ?? "~"}/.hasna/projects/projects.db`;
}

export function registerCloudSyncTools(server: McpServer): void {
  server.tool(
    "projects_cloud_status",
    "Show cloud configuration and RDS connection health",
    {},
    async () => {
      try {
        const { getCloudConfig, getConnectionString, PgAdapterAsync } = await import("@hasna/cloud");
        const config = getCloudConfig();
        const host = ((config.rds as unknown) as Record<string, unknown>)?.host ?? "(not configured)";
        const lines = [`Mode: ${config.mode}`, `Service: projects`, `RDS Host: ${host}`];
        if (((config.rds as unknown) as Record<string, unknown>)?.host) {
          try {
            const pg = new PgAdapterAsync(getConnectionString("postgres"));
            pg.get("SELECT 1 as ok");
            lines.push("PostgreSQL: connected");
            pg.close();
          } catch (err) { lines.push(`PostgreSQL: failed — ${(err as Error).message}`); }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "projects_cloud_pull",
    "Pull cloud PostgreSQL data to local SQLite. Merges by primary key.",
    { tables: z.string().optional().describe("Comma-separated table names (default: all)") },
    async (input) => {
      try {
        const { syncPull, getConnectionString, PgAdapterAsync, SqliteAdapter, getCloudConfig } = await import("@hasna/cloud");
        const config = getCloudConfig();
        if (!((config.rds as unknown) as Record<string, unknown>)?.host) {
          return { content: [{ type: "text" as const, text: "Cloud not configured. Set HASNA_RDS_HOST." }], isError: true };
        }
        const tables = input.tables ? input.tables.split(",").map((t) => t.trim()) : TABLES;
        const local = new SqliteAdapter(dbPath());
        const remote = new PgAdapterAsync(getConnectionString("postgres"));
        const results = await syncPull(remote, local, { tables });
        remote.close(); local.close();
        const total = results.reduce((s, r) => s + r.rowsWritten, 0);
        const summary = results.map((r) => `${r.table}: ${r.rowsWritten} rows`).join("\n");
        return { content: [{ type: "text" as const, text: `Pulled ${total} rows across ${results.length} table(s).\n${summary}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    "projects_cloud_push",
    "Push local SQLite data to cloud PostgreSQL. Runs PG migrations if needed.",
    { tables: z.string().optional().describe("Comma-separated table names (default: all)") },
    async (input) => {
      try {
        const { syncPush, getConnectionString, PgAdapterAsync, SqliteAdapter, getCloudConfig } = await import("@hasna/cloud");
        const config = getCloudConfig();
        if (!((config.rds as unknown) as Record<string, unknown>)?.host) {
          return { content: [{ type: "text" as const, text: "Cloud not configured." }], isError: true };
        }
        const local = new SqliteAdapter(dbPath());
        const remote = new PgAdapterAsync(getConnectionString("postgres"));
        const { runPgMigrations } = await import("../../db/pg-migrations.js");
        await runPgMigrations(remote);
        const tables = input.tables ? input.tables.split(",").map((t) => t.trim()) : TABLES;
        const results = await syncPush(local, remote, { tables });
        remote.close(); local.close();
        const total = results.reduce((s, r) => s + r.rowsWritten, 0);
        const summary = results.map((r) => `${r.table}: ${r.rowsWritten} rows`).join("\n");
        return { content: [{ type: "text" as const, text: `Pushed ${total} rows across ${results.length} table(s).\n${summary}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
