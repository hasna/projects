// Migration runner for projects-serve (Amendment A1 pure-remote Postgres).
//
// Source of truth is the SQL files in the repo `migrations/` directory, applied
// in filename order through the vendored storage kit's MigrationLedger (which
// records a sha256 checksum per migration and refuses to run on drift). The
// api-keys table migrations from @hasna/contracts/auth are appended so the auth
// middleware's ApiKeyStore has its schema.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiKeyMigrations } from "@hasna/contracts/auth";
import {
  MigrationLedger,
  defineMigration,
  type Migration,
  type MigrationResult,
} from "../generated/storage-kit/index.js";
import type { TypedQueryClient } from "../generated/storage-kit/query.js";

export const MIGRATIONS_DIR_ENV = "PROJECTS_MIGRATIONS_DIR";

/** Resolve the on-disk migrations directory across dev, dist, and Docker layouts. */
export function resolveMigrationsDir(): string {
  const override = process.env[MIGRATIONS_DIR_ENV];
  if (override && existsSync(override)) return resolve(override);

  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();

  const candidates = [
    join(process.cwd(), "migrations"),
    join(here, "migrations"),
    join(here, "..", "migrations"),
    join(here, "..", "..", "migrations"),
    join(here, "..", "..", "..", "migrations"),
    "/app/migrations",
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "0001_baseline.sql"))) return dir;
  }
  throw new Error(
    `projects-serve: migrations directory not found (looked in: ${candidates.join(", ")}). ` +
      `Set ${MIGRATIONS_DIR_ENV} to the directory containing the *.sql files.`,
  );
}

/** Load the ordered baseline SQL migrations from disk plus the api-keys migrations. */
export function loadMigrations(): Migration[] {
  const dir = resolveMigrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  const schema = files.map((file) =>
    defineMigration(`projects:${file.replace(/\.sql$/, "")}`, readFileSync(join(dir, file), "utf-8")),
  );
  const apiKeys = apiKeyMigrations().map((m) => defineMigration(m.id, m.sql));
  return [...schema, ...apiKeys];
}

/** Apply all pending migrations against the given cloud client. */
export async function runProjectsMigrations(
  client: TypedQueryClient,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const ledger = new MigrationLedger(client, loadMigrations());
  return ledger.migrate(opts);
}
