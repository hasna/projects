import type { Command } from "commander";
import { serveProjectReports } from "../../lib/project-reports-server.js";
import { redactProjectValue } from "../../lib/redaction.js";

function wantsJson(options: { json?: boolean }): boolean {
  return Boolean(options.json || process.env["PROJECTS_JSON"]);
}

async function print(value: unknown, options: { json?: boolean }): Promise<void> {
  const safeValue = redactProjectValue(value);
  const output = wantsJson(options) ? JSON.stringify(safeValue, null, 2) : typeof safeValue === "string" ? safeValue : JSON.stringify(safeValue, null, 2);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${output}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function errorPayload(error: unknown): { ok: false; error: { name: string; message: string } } {
  return {
    ok: false,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function findJsonOptions(args: unknown[]): { json?: boolean } | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const value = args[index];
    if (!value || typeof value !== "object") continue;
    if ("json" in value) return value as { json?: boolean };
    if ("opts" in value && typeof (value as { opts?: unknown }).opts === "function") {
      const opts = (value as { opts: () => unknown }).opts();
      if (opts && typeof opts === "object" && "json" in opts) return opts as { json?: boolean };
    }
  }
  return undefined;
}

function withJsonErrors<T extends unknown[]>(handler: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    try {
      await handler(...args);
    } catch (error) {
      const options = findJsonOptions(args);
      if (options && wantsJson(options)) {
        await print(errorPayload(error), options);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  };
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0) throw new Error("--port must be a positive integer");
  return port;
}

async function serveAction(options: { host?: string; port?: string; json?: boolean }) {
  const served = await serveProjectReports({
    host: options.host ?? "0.0.0.0",
    port: parsePort(options.port),
  });
  const payload = {
    ok: true,
    mode: "reports",
    url: served.url,
    host: served.host,
    port: served.port,
  };
  await print(payload, options);
  if (!wantsJson(options)) await print(`Reports listening at ${served.url}`, options);
  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      served.server.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function registerReportsCommands(program: Command): void {
  const reports = program.command("reports").description("Serve registered project report files");
  reports
    .command("serve")
    .description("Serve reports for all registered projects from each project reports directory")
    .option("--host <host>", "Host to bind", "0.0.0.0")
    .option("--port <port>", "Port to bind")
    .option("-j, --json", "Print server info as JSON", false)
    .action(withJsonErrors(serveAction));
}
