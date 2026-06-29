import pg from "pg";
import type { Pool } from "pg";

function translatePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParams(params: unknown[]): unknown[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map((value) => value === undefined ? null : value);
}

export function shouldUsePgSsl(connectionString: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(connectionString).searchParams;
  } catch {
    const queryStart = connectionString.indexOf("?");
    params = new URLSearchParams(queryStart >= 0 ? connectionString.slice(queryStart + 1) : "");
  }

  const ssl = params.get("ssl")?.toLowerCase();
  if (ssl && ["1", "true", "yes", "on", "require"].includes(ssl)) return true;

  const sslMode = params.get("sslmode")?.toLowerCase();
  return sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
}

export class PgAdapterAsync {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, ssl: shouldUsePgSsl(connectionString) || undefined });
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return { changes: result.rowCount ?? 0 };
  }

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    const result = await this.pool.query(translatePlaceholders(sql), normalizeParams(params));
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
