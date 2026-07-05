import type { Command } from "commander";
import {
  getStorageStatus,
  parseStorageTables,
  storagePull,
  storagePush,
  storageSync,
  type SyncResult,
} from "../../db/storage-sync.js";

function wantsJson(opts?: { json?: boolean }): boolean {
  return Boolean(opts?.json || process.env["PROJECTS_JSON"] || process.env["WORKSPACES_JSON"] || process.argv.includes("--json") || process.argv.includes("-j"));
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printResults(results: SyncResult[], label: string): void {
  const total = results.reduce((sum, result) => sum + result.rowsWritten, 0);
  for (const result of results) {
    const errors = result.errors.length > 0 ? ` (${result.errors.join("; ")})` : "";
    console.log(`  ${result.table}: ${result.rowsWritten}/${result.rowsRead} rows ${label}${errors}`);
  }
  console.log(`Done. ${total} rows ${label}.`);
}

function printReadiness(info: ReturnType<typeof getStorageStatus>): void {
  console.log(`Cloud-backed runtime ready: ${info.readiness.cloudBackedRuntimeReady ? "yes" : "no"}`);
  console.log("Storage surfaces:");
  for (const surface of info.readiness.surfaces) {
    const remoteState = surface.remote.active ? "available" : surface.state === "cloud-planned" ? "planned" : "not configured";
    console.log(`  ${surface.surface}: local ${surface.local.backend} active; remote ${surface.remote.backend} ${remoteState}`);
    if (surface.migration.blocker) console.log(`    blocker: ${surface.migration.blocker}`);
  }
}

export function registerStorageCommands(program: Command): void {
  const cmd = program.command("storage").description("Storage sync commands");

  cmd
    .command("status")
    .description("Show storage config and local sync state")
    .option("-j, --json", "Output JSON")
    .action((opts) => {
      const info = getStorageStatus();
      if (wantsJson(opts)) {
        printJson(info);
        return;
      }
      console.log(`Storage configured: ${info.configured ? "yes" : "no"}`);
      console.log(`Mode: ${info.mode}`);
      console.log(`Canonical RDS cluster: ${info.canonical.cluster}`);
      console.log(`Canonical database: ${info.canonical.database}`);
      console.log(`Runtime secret path: ${info.canonical.runtimeSecretPath}`);
      console.log(`Database env: ${info.canonical.env} (fallback: ${info.canonical.fallbackEnv})`);
      console.log(`Tables: ${info.tables.join(", ")}`);
      printReadiness(info);
      if (info.sync.length === 0) console.log("Sync: no local sync history");
      for (const entry of info.sync) {
        console.log(`  ${entry.table_name} ${entry.direction}: ${entry.last_synced_at ?? "never"}`);
      }
    });

  cmd
    .command("push")
    .description("Push local workspace data to storage PostgreSQL")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .option("-j, --json", "Output JSON")
    .action(async (opts) => {
      try {
        const results = await storagePush({ tables: parseStorageTables(opts.tables) });
        if (wantsJson(opts)) {
          printJson(results);
          return;
        }
        printResults(results, "pushed");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("pull")
    .description("Pull workspace data from storage PostgreSQL to local SQLite")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .option("-j, --json", "Output JSON")
    .action(async (opts) => {
      try {
        const results = await storagePull({ tables: parseStorageTables(opts.tables) });
        if (wantsJson(opts)) {
          printJson(results);
          return;
        }
        printResults(results, "pulled");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  cmd
    .command("sync")
    .description("Bidirectional sync: pull then push")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .option("-j, --json", "Output JSON")
    .action(async (opts) => {
      try {
        const result = await storageSync({ tables: parseStorageTables(opts.tables) });
        if (wantsJson(opts)) {
          printJson(result);
          return;
        }
        printResults(result.pull, "pulled");
        printResults(result.push, "pushed");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
