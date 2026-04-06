import chalk from "chalk";
import { type Command, suppressSslWarnings } from "./shared.js";
import { getScheduleConfig, saveScheduleConfig, installCron, removeCron } from "../../../lib/scheduler.js";
import { runPgMigrations } from "../../../db/pg-migrations.js";

export function registerCloudCommands(cmd: Command) {
  const cloudCmd = cmd.command("cloud").description("Cloud sync — push/pull between local SQLite and RDS PostgreSQL");

  cloudCmd
    .command("status")
    .description("Show cloud configuration and connection health")
    .action(async () => {
      process.env["NODE_NO_WARNINGS"] = "1";
      suppressSslWarnings(); const { getCloudConfig, getConnectionString, PgAdapterAsync } = await import("@hasna/cloud");
      const config = getCloudConfig();
      console.log(`mode:    ${config.mode}`);
      console.log(`service: projects`);
      console.log(`host:    ${config.rds?.host ?? chalk.red("(not configured)")}`);
      if (config.rds?.host) {
        try {
          const pg = new PgAdapterAsync(getConnectionString("postgres"));
          await (pg as { get: (s: string) => Promise<unknown> }).get("SELECT 1");
          console.log(`pg:      ${chalk.green("connected")}`);
          await (pg as { close: () => Promise<void> }).close();
        } catch (err: unknown) {
          console.log(`pg:      ${chalk.red((err instanceof Error ? err.message : String(err)))}`);
        }
      }
    });

  cloudCmd
    .command("pull")
    .description("Pull data from cloud PostgreSQL to local SQLite")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .action(async (opts) => {
      console.log(chalk.dim("Pulling from cloud..."));
      try {
        suppressSslWarnings(); const { syncPull, getCloudConfig, getConnectionString, PgAdapterAsync, SqliteAdapter } = await import("@hasna/cloud");
        const config = getCloudConfig();
        if (!((config.rds as unknown) as Record<string, unknown>)?.host) { console.error(chalk.red("Cloud not configured. Set HASNA_RDS_HOST.")); process.exit(1); }
        const tables = opts.tables ? opts.tables.split(",").map((t: string) => t.trim()) : ["projects", "project_workdirs", "project_files", "sync_log"];
        const localPath = process.env["HASNA_PROJECTS_DB_PATH"] ?? `${process.env["HOME"]}/.hasna/projects/projects.db`;
        const local = new SqliteAdapter(localPath);
        const remote = new PgAdapterAsync(getConnectionString("postgres"));
        const results = await syncPull(remote, local, { tables });
        remote.close(); local.close();
        const total = results.reduce((s, r) => s + r.rowsWritten, 0);
        console.log(chalk.green(`✓ Pulled ${total} rows`));
        results.forEach((r) => console.log(chalk.dim(`  ${r.table}: ${r.rowsWritten}`)));
      } catch (err: unknown) { console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`)); process.exit(1); }
    });

  cloudCmd
    .command("push")
    .description("Push local SQLite data to cloud PostgreSQL")
    .option("--tables <tables>", "Comma-separated table names (default: all)")
    .action(async (opts) => {
      console.log(chalk.dim("Pushing to cloud..."));
      try {
        suppressSslWarnings(); const { syncPush, getCloudConfig, getConnectionString, PgAdapterAsync, SqliteAdapter } = await import("@hasna/cloud");
        const config = getCloudConfig();
        if (!((config.rds as unknown) as Record<string, unknown>)?.host) { console.error(chalk.red("Cloud not configured. Set HASNA_RDS_HOST.")); process.exit(1); }
        const localPath = process.env["HASNA_PROJECTS_DB_PATH"] ?? `${process.env["HOME"]}/.hasna/projects/projects.db`;
        const local = new SqliteAdapter(localPath);
        const remote = new PgAdapterAsync(getConnectionString("postgres"));
        await runPgMigrations(remote);
        const tables = opts.tables ? opts.tables.split(",").map((t: string) => t.trim()) : ["projects", "project_workdirs", "project_files", "sync_log"];
        const results = await syncPush(local, remote, { tables });
        remote.close(); local.close();
        const total = results.reduce((s, r) => s + r.rowsWritten, 0);
        console.log(chalk.green(`✓ Pushed ${total} rows`));
        results.forEach((r) => console.log(chalk.dim(`  ${r.table}: ${r.rowsWritten}`)));
      } catch (err: unknown) { console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`)); process.exit(1); }
    });
}
