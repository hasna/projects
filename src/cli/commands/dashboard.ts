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
import { ProjectSnapshotSchema } from "@hasna/contracts/schemas";

function wantsJson(options: { json?: boolean }): boolean {
  return Boolean(options.json || process.env["PROJECTS_JSON"]);
}

function print(value: unknown, options: { json?: boolean }): void {
  if (wantsJson(options)) console.log(JSON.stringify(value, null, 2));
  else console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
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
  });
  let paths;
  if (options.write) paths = writeProjectDashboardSnapshot(resolution.project, snapshot);
  print(options.write ? { snapshot, paths } : snapshot, options);
}

async function renderAction(target: string, options: { snapshot?: string; write?: boolean; json?: boolean }) {
  const resolution = resolveRegisteredProjectTargetOrThrow(target);
  const snapshot = options.snapshot
    ? ProjectSnapshotSchema.parse(JSON.parse(readFileSync(options.snapshot, "utf-8")))
    : await buildProjectDashboardSnapshot(target);
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
    print({ render, path: paths.renderManifestPath }, options);
    return;
  }
  print(render, options);
}

async function validateAction(targetOrFile: string, options: { json?: boolean }) {
  let result: unknown;
  if (targetOrFile.endsWith(".json")) {
    const parsed = JSON.parse(readFileSync(targetOrFile, "utf-8"));
    result = { ok: true, snapshot: ProjectSnapshotSchema.parse(parsed) };
  } else {
    const resolution = resolveRegisteredProjectTargetOrThrow(targetOrFile);
    const manifest = loadProjectDashboardRenderManifest(resolution.project);
    const dashboard = await buildProjectDashboard(targetOrFile);
    result = {
      ok: true,
      project: resolution.project.slug,
      manifest,
      panels: dashboard.snapshot.panels.length,
      renderRoot: dashboard.render.root,
    };
  }
  print(result, options);
}

async function serveAction(target: string, options: { host?: string; port?: string; provider?: string[]; json?: boolean }) {
  const port = options.port ? Number.parseInt(options.port, 10) : undefined;
  if (options.port && (!Number.isInteger(port) || port! <= 0)) throw new Error("--port must be a positive integer");
  const served = await serveProjectDashboard({
    target,
    host: options.host ?? "127.0.0.1",
    port,
    providerKinds: splitProviders(options.provider),
  });
  const payload = {
    ok: true,
    url: served.url,
    host: served.host,
    port: served.port,
    project: resolveRegisteredProjectTargetOrThrow(target).project.slug,
    auth: "http-only-cookie",
  };
  print(payload, options);
  if (!wantsJson(options)) console.log(`Dashboard listening at ${served.url}`);
  await new Promise(() => undefined);
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
    .action(snapshotAction);
  dashboard
    .command("render <target>")
    .description("Emit a React Flow Canvas render spec for a project dashboard")
    .option("--snapshot <file>", "Use an existing ProjectSnapshot JSON file")
    .option("--write", "Ensure and update the project dashboard render manifest")
    .option("-j, --json", "Print JSON", false)
    .action(renderAction);
  dashboard
    .command("validate <target-or-file>")
    .description("Validate a dashboard project or ProjectSnapshot JSON file")
    .option("-j, --json", "Print JSON", false)
    .action(validateAction);
  dashboard
    .command("serve <target>")
    .description("Serve the local React Flow project dashboard")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <port>", "Port to bind")
    .option("--provider <kind...>", "Limit provider ids/kinds, comma-separated or repeated")
    .option("-j, --json", "Print server info as JSON", false)
    .action(serveAction);

  program.command("view <target>").description("Serve a project dashboard viewer").option("--host <host>", "Host to bind", "127.0.0.1").option("--port <port>", "Port to bind").option("-j, --json", "Print server info as JSON", false).action(serveAction);
  program.command("render <target>").description("Render a project dashboard Canvas spec").option("--snapshot <file>", "Use an existing ProjectSnapshot JSON file").option("--write", "Ensure and update the project dashboard render manifest").option("-j, --json", "Print JSON", false).action(renderAction);
  program.command("validate <target-or-file>").description("Validate a project dashboard or snapshot file").option("-j, --json", "Print JSON", false).action(validateAction);
  program.command("serve <target>").description("Serve a project dashboard viewer").option("--host <host>", "Host to bind", "127.0.0.1").option("--port <port>", "Port to bind").option("-j, --json", "Print server info as JSON", false).action(serveAction);
}
