#!/usr/bin/env bun
// projects-serve — self-hosted HTTP API for @hasna/projects.
//
// Amendment A1 pure-remote: reads and writes go directly to cloud Postgres via
// the vendored storage kit. Two entrypoints:
//   projects-serve            start the HTTP server
//   projects-serve migrate    apply pending migrations then exit (ECS one-shot)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiKeyStore } from "@hasna/contracts/auth";
import { createPgPool, createQueryClient } from "../generated/storage-kit/index.js";
import { ProjectsPgStore } from "./pg-store.js";
import { createFetchHandler } from "./app.js";
import { runProjectsMigrations } from "./migrations.js";

const APP = "projects";

export function getPackageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Resolve the cloud Postgres connection string from the fleet-standard envs. */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url =
    env.HASNA_PROJECTS_DATABASE_URL ||
    env.PROJECTS_DATABASE_URL ||
    env.DATABASE_URL ||
    "";
  if (!url.trim()) {
    throw new Error(
      "projects-serve: no database URL. Set HASNA_PROJECTS_DATABASE_URL (or PROJECTS_DATABASE_URL / DATABASE_URL).",
    );
  }
  return url.trim();
}

/** Resolve the HMAC signing secret for API-key verification. */
export function resolveSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret =
    env.HASNA_PROJECTS_API_SIGNING_KEY ||
    env.HASNA_API_SIGNING_KEY ||
    env.API_KEY_SIGNING_SECRET ||
    "";
  if (!secret.trim()) {
    throw new Error(
      "projects-serve: no API signing secret. Set HASNA_PROJECTS_API_SIGNING_KEY (or HASNA_API_SIGNING_KEY / API_KEY_SIGNING_SECRET).",
    );
  }
  return secret.trim();
}

export function resolvePort(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) return Number(argv[idx + 1]);
  if (env.PORT) return Number(env.PORT);
  return 8080;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const version = getPackageVersion();
  const connectionString = resolveDatabaseUrl();
  const pool = createPgPool({ connectionString, applicationName: `${APP}-serve`, max: 5 });
  const client = createQueryClient(pool);

  // --- migrate subcommand (ECS one-shot task) ---
  if (argv[0] === "migrate") {
    const dryRun = argv.includes("--dry-run");
    const result = await runProjectsMigrations(client, { dryRun });
    const pending = result.plan.filter((p) => p.state === "pending").map((p) => p.migration.id);
    console.error(
      `projects-serve migrate: ${dryRun ? "DRY RUN — " : ""}${result.applied.length} applied total, ` +
        `${pending.length} ${dryRun ? "pending" : "newly applied"}${pending.length ? `: ${pending.join(", ")}` : ""}`,
    );
    await pool.end();
    return;
  }

  // --- server ---
  const signingSecret = resolveSigningSecret();
  const keyStore = new ApiKeyStore(client);
  const store = new ProjectsPgStore(client);
  const port = resolvePort(argv);
  const hostname = process.env.HOST || "0.0.0.0";

  const handler = createFetchHandler({
    store,
    version,
    app: APP,
    signingSecret,
    isRevoked: keyStore.isRevoked,
    audit: (e) => {
      if (e.outcome === "deny") {
        console.error(`api_auth deny kid=${e.kid ?? "-"} reason=${e.reason ?? "-"} ${e.method} ${e.path}`);
      }
    },
    mode: "cloud",
  });

  Bun.serve({ hostname, port, fetch: handler, idleTimeout: 60 });
  console.error(`projects-serve v${version} listening on http://${hostname}:${port} (cloud/pure-remote)`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("projects-serve fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
