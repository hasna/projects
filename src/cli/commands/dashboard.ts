import type { Command } from "commander";
import { readFileSync } from "node:fs";
import {
  buildProjectDashboard,
  buildProjectDashboardRender,
  buildProjectDashboardSnapshot,
  ensureProjectDashboardStructure,
  loadProjectDashboardRenderManifest,
  writeProjectDashboardSnapshot,
} from "../../lib/project-dashboard.js";
import { serveProjectDashboard } from "../../lib/project-dashboard-server.js";
import { resolveRegisteredProjectTargetOrThrow } from "../../lib/project-resolver.js";
import { redactProjectValue } from "../../lib/redaction.js";
import { ProjectSnapshotSchema } from "@hasna/contracts/schemas";

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

function splitProviders(values: string[] | undefined): string[] | undefined {
  const providers = values?.flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean));
  return providers?.length ? [...new Set(providers)] : undefined;
}

async function snapshotAction(target: string, options: { provider?: string[]; timeoutMs?: string; write?: boolean; json?: boolean }) {
  const timeoutMs = options.timeoutMs ? Number.parseInt(options.timeoutMs, 10) : undefined;
  if (options.timeoutMs && (!Number.isInteger(timeoutMs) || timeoutMs! <= 0)) throw new Error("--timeout-ms must be a positive integer");
  const resolution = resolveRegisteredProjectTargetOrThrow(target);
  const snapshot = await buildProjectDashboardSnapshot(target, {
    providerKinds: splitProviders(options.provider),
    timeoutMs,
    initialize: false,
  });
  let paths;
  if (options.write) paths = writeProjectDashboardSnapshot(resolution.project, snapshot);
  await print(options.write ? { snapshot, paths } : snapshot, options);
}

async function renderAction(target: string, options: { snapshot?: string; write?: boolean; json?: boolean }) {
  const resolution = resolveRegisteredProjectTargetOrThrow(target);
  const snapshot = options.snapshot
    ? ProjectSnapshotSchema.parse(JSON.parse(readFileSync(options.snapshot, "utf-8")))
    : await buildProjectDashboardSnapshot(target, { initialize: false });
  const render = buildProjectDashboardRender(resolution.project, snapshot);
  if (options.write) {
    const paths = ensureProjectDashboardStructure(resolution.project, snapshot.generatedAt);
    await Bun.write(paths.renderManifestPath, `${JSON.stringify({
      schema: "hasna.projects_dashboard_render.v1",
      projectId: resolution.project.slug,
      defaultView: "canvas",
      imports: [],
      updatedAt: snapshot.generatedAt,
    }, null, 2)}\n`);
    await print({ render, path: paths.renderManifestPath }, options);
    return;
  }
  await print(render, options);
}

async function validateAction(targetOrFile: string, options: { json?: boolean }) {
  let result: unknown;
  if (targetOrFile.endsWith(".json")) {
    const parsed = JSON.parse(readFileSync(targetOrFile, "utf-8"));
    result = { ok: true, snapshot: ProjectSnapshotSchema.parse(parsed) };
  } else {
    const resolution = resolveRegisteredProjectTargetOrThrow(targetOrFile);
    const manifest = loadProjectDashboardRenderManifest(resolution.project);
    const dashboard = await buildProjectDashboard(targetOrFile, { initialize: false });
    result = {
      ok: true,
      project: resolution.project.slug,
      manifest,
      panels: dashboard.snapshot.panels.length,
      renderRoot: dashboard.render.root,
    };
  }
  await print(result, options);
}

async function serveAction(target: string, options: { host?: string; port?: string; provider?: string[]; token?: string; trustNetwork?: boolean; json?: boolean }) {
  const port = options.port ? Number.parseInt(options.port, 10) : undefined;
  if (options.port && (!Number.isInteger(port) || port! <= 0)) throw new Error("--port must be a positive integer");
  const served = await serveProjectDashboard({
    target,
    host: options.host ?? "127.0.0.1",
    port,
    providerKinds: splitProviders(options.provider),
    token: options.token,
    trustNetwork: options.trustNetwork,
    initialize: false,
  });
  const payload = {
    ok: true,
    url: served.url,
    host: served.host,
    port: served.port,
    project: resolveRegisteredProjectTargetOrThrow(target).project.slug,
    auth: options.trustNetwork ? "trusted-network-cookie" : "http-only-cookie-token",
  };
  await print(payload, options);
  if (!wantsJson(options)) await print(`Dashboard listening at ${served.url}`, options);
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

export function registerDashboardCommands(program: Command): void {
  const dashboard = program.command("dashboard").description("Build, validate, and serve project dashboards");
  dashboard
    .command("snapshot <target>")
    .description("Collect provider panels into a contract-valid ProjectSnapshot")
    .option("--provider <kind...>", "Limit provider ids/kinds, comma-separated or repeated")
    .option("--timeout-ms <n>", "Provider timeout in milliseconds")
    .option("--write", "Write latest snapshot under .hasna/project/dashboard/snapshots")
    .option("-j, --json", "Print JSON", false)
    .action(withJsonErrors(snapshotAction));
  dashboard
    .command("render <target>")
    .description("Emit a React Flow Canvas render spec for a project dashboard")
    .option("--snapshot <file>", "Use an existing ProjectSnapshot JSON file")
    .option("--write", "Ensure and update the project dashboard render manifest")
    .option("-j, --json", "Print JSON", false)
    .action(withJsonErrors(renderAction));
  dashboard
    .command("validate <target-or-file>")
    .description("Validate a dashboard project or ProjectSnapshot JSON file")
    .option("-j, --json", "Print JSON", false)
    .action(withJsonErrors(validateAction));
  dashboard
    .command("serve <target>")
    .description("Serve the local React Flow project dashboard")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <port>", "Port to bind")
    .option("--provider <kind...>", "Limit provider ids/kinds, comma-separated or repeated")
    .option("--token <token>", "Dashboard access token for non-loopback serving")
    .option("--trust-network", "Self-issue the dashboard cookie on non-loopback hosts; rely on network ACLs", false)
    .option("-j, --json", "Print server info as JSON", false)
    .action(withJsonErrors(serveAction));
}
