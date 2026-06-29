import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Database } from "bun:sqlite";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  ProjectPanelSchema,
  ProjectSnapshotSchema,
  SCHEMA_IDS,
  type ProjectPanel,
  type ProjectSnapshot,
} from "@hasna/contracts/schemas";
import type { JsonObject, Workspace } from "../types/workspace.js";
import { resolveRegisteredProjectTargetOrThrow } from "./project-resolver.js";
import { buildProjectCanvasPayload, validateProjectsRenderSpec, type ProjectsJsonRenderSpec } from "./project-render.js";

export const PROJECT_DASHBOARD_DIR = ".hasna/project" as const;
export const PROJECT_DASHBOARD_RENDER_DIR = ".hasna/project/dashboard" as const;
export const PROJECT_DASHBOARD_SNAPSHOTS_DIR = ".hasna/project/dashboard/snapshots" as const;

export interface ProjectDashboardProvider {
  id: string;
  kind: ProjectPanel["provider"]["kind"];
  panelKind: ProjectPanel["kind"];
  title: string;
  command: string;
  args: string[];
  timeoutMs?: number;
  optional?: boolean;
  warning?: string;
}

export interface ProviderRunRequest {
  provider: ProjectDashboardProvider;
  project: Workspace;
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface ProviderRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  unavailable?: boolean;
}

export type ProjectDashboardProviderRunner = (request: ProviderRunRequest) => Promise<ProviderRunResult>;

export interface BuildProjectDashboardSnapshotOptions {
  db?: Database;
  providers?: ProjectDashboardProvider[];
  providerKinds?: string[];
  runner?: ProjectDashboardProviderRunner;
  timeoutMs?: number;
  generatedAt?: string;
  cwd?: string;
  initialize?: boolean;
}

export interface ProjectDashboardPaths {
  projectPath: string;
  rootDir: string;
  manifestPath: string;
  renderDir: string;
  renderManifestPath: string;
  snapshotsDir: string;
  latestSnapshotPath: string;
}

export interface ProjectDashboardRenderManifest {
  schema: "hasna.projects_dashboard_render.v1";
  projectId: string;
  defaultView: "canvas";
  imports: Array<{ id: string; path: string; kind?: string }>;
  updatedAt: string;
}

export const DEFAULT_PROJECT_DASHBOARD_PROVIDERS: ProjectDashboardProvider[] = [
  {
    id: "todos",
    kind: "todos",
    panelKind: "tasks",
    title: "Tasks",
    command: "todos",
    args: ["project-panel", "--project", "{project}", "--json", "--contract"],
    optional: true,
  },
  {
    id: "files",
    kind: "files",
    panelKind: "files",
    title: "Files",
    command: "files",
    args: ["project-panel", "--project", "{project}", "--json", "--contract"],
    optional: true,
  },
  {
    id: "mailery",
    kind: "mailery",
    panelKind: "mailery",
    title: "Mailery",
    command: "mailery",
    args: ["project-panel", "--project", "{project}", "--limit", "20", "--json", "--contract"],
    optional: true,
    warning: "Mailery provider is workspace-scoped until project-to-email mapping is configured.",
  },
  {
    id: "conversations",
    kind: "conversations",
    panelKind: "conversations",
    title: "Conversations",
    command: "conversations",
    args: ["project-panel", "--project", "{project}", "--limit", "30", "--json", "--contract"],
    optional: true,
  },
  {
    id: "knowledge",
    kind: "knowledge",
    panelKind: "knowledge",
    title: "Knowledge",
    command: "knowledge",
    args: ["project-panel", "--project", "{project}", "--scope", "project", "--limit", "30", "--json", "--contract"],
    optional: true,
  },
  {
    id: "mementos",
    kind: "mementos",
    panelKind: "mementos",
    title: "Mementos",
    command: "mementos",
    args: ["--json", "project-panel", "--project", "{project}", "--contract"],
    optional: true,
  },
  {
    id: "reports",
    kind: "reports",
    panelKind: "reports",
    title: "Reports",
    command: "reports",
    args: ["project-panel", "--project", "{project}", "--json", "--contract"],
    optional: true,
  },
];

export function projectDashboardPaths(project: Workspace): ProjectDashboardPaths {
  const projectPath = project.primary_path ? resolve(project.primary_path) : process.cwd();
  return {
    projectPath,
    rootDir: join(projectPath, PROJECT_DASHBOARD_DIR),
    manifestPath: join(projectPath, PROJECT_DASHBOARD_DIR, "manifest.json"),
    renderDir: join(projectPath, PROJECT_DASHBOARD_RENDER_DIR),
    renderManifestPath: join(projectPath, PROJECT_DASHBOARD_RENDER_DIR, "render.json"),
    snapshotsDir: join(projectPath, PROJECT_DASHBOARD_SNAPSHOTS_DIR),
    latestSnapshotPath: join(projectPath, PROJECT_DASHBOARD_SNAPSHOTS_DIR, "latest.snapshot.json"),
  };
}

export function ensureProjectDashboardStructure(project: Workspace, now = new Date().toISOString()): ProjectDashboardPaths {
  const paths = projectDashboardPaths(project);
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.renderDir, { recursive: true });
  mkdirSync(paths.snapshotsDir, { recursive: true });
  if (!existsSync(paths.manifestPath)) {
    writeFileSync(paths.manifestPath, `${JSON.stringify({
      schema: "hasna.projects_dashboard_manifest.v1",
      projectId: project.slug,
      projectName: project.name,
      generatedBy: "@hasna/projects",
      updatedAt: now,
      layout: {
        dashboardDir: PROJECT_DASHBOARD_RENDER_DIR,
        snapshotsDir: PROJECT_DASHBOARD_SNAPSHOTS_DIR,
      },
    }, null, 2)}\n`);
  }
  if (!existsSync(paths.renderManifestPath)) {
    const manifest: ProjectDashboardRenderManifest = {
      schema: "hasna.projects_dashboard_render.v1",
      projectId: project.slug,
      defaultView: "canvas",
      imports: [],
      updatedAt: now,
    };
    writeFileSync(paths.renderManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return paths;
}

export function loadProjectDashboardRenderManifest(project: Workspace): ProjectDashboardRenderManifest | null {
  const paths = projectDashboardPaths(project);
  if (!existsSync(paths.renderManifestPath)) return null;
  const parsed = JSON.parse(readFileSync(paths.renderManifestPath, "utf-8")) as ProjectDashboardRenderManifest;
  resolveDashboardImports(paths.renderDir, parsed.imports ?? []);
  return parsed;
}

export function resolveDashboardImports(baseDir: string, imports: Array<{ id: string; path: string; kind?: string }>): string[] {
  return imports.map((item) => {
    if (isAbsolute(item.path)) throw new Error(`Dashboard import must be relative: ${item.path}`);
    const resolved = resolve(baseDir, normalize(item.path));
    const rel = relative(baseDir, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Dashboard import escapes render directory: ${item.path}`);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`Dashboard import not found: ${item.path}`);
    return resolved;
  });
}

export async function buildProjectDashboardSnapshot(
  target: string | undefined,
  options: BuildProjectDashboardSnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const resolution = resolveRegisteredProjectTargetOrThrow(target, { db: options.db });
  const project = resolution.project;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const paths = options.initialize ? ensureProjectDashboardStructure(project, generatedAt) : projectDashboardPaths(project);
  const cwd = options.cwd ?? project.primary_path ?? paths.projectPath;
  const requestedKinds = new Set(options.providerKinds ?? []);
  const providers = (options.providers ?? DEFAULT_PROJECT_DASHBOARD_PROVIDERS)
    .filter((provider) => requestedKinds.size === 0 || requestedKinds.has(provider.id) || requestedKinds.has(provider.kind));
  const runner = options.runner ?? defaultProjectDashboardProviderRunner;
  const warnings: string[] = [];
  const panels: ProjectPanel[] = [
    overviewPanel(project, generatedAt),
  ];

  for (const provider of providers) {
    if (provider.warning) warnings.push(`${provider.id}: ${provider.warning}`);
    panels.push(await collectProviderPanel({
      provider,
      project,
      cwd,
      generatedAt,
      timeoutMs: options.timeoutMs ?? provider.timeoutMs ?? 15_000,
      runner,
    }));
  }

  panels.push(actionsPanel(project, generatedAt));

  const snapshot = ProjectSnapshotSchema.parse({
    schema: SCHEMA_IDS.projectSnapshot,
    id: `project-snapshot:${project.slug}:${generatedAt}`,
    createdAt: generatedAt,
    projectId: project.slug,
    generatedAt,
    status: "succeeded",
    manifestRef: {
      kind: "project",
      id: project.slug,
      name: project.name,
      uri: `project://${project.slug}`,
      tags: ["projects-dashboard"],
    },
    renderManifestRef: {
      kind: "render",
      id: `dashboard:${project.slug}`,
      name: "Project Dashboard",
      uri: `render://project/${project.slug}/dashboard`,
      tags: ["projects-dashboard"],
    },
    panels,
    resourceRefs: panels.flatMap((panel) => panel.resourceRefs),
    evidenceRefs: panels.flatMap((panel) => panel.evidenceRefs),
    warnings,
    freshness: panels.some((panel) => panel.freshness === "stale") ? "stale" : "fresh",
  });
  return snapshot;
}

export function writeProjectDashboardSnapshot(project: Workspace, snapshot: ProjectSnapshot): ProjectDashboardPaths {
  const paths = ensureProjectDashboardStructure(project, snapshot.generatedAt);
  writeFileSync(paths.latestSnapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return paths;
}

export function buildProjectDashboardRender(project: Workspace, snapshot: ProjectSnapshot): ProjectsJsonRenderSpec {
  const nodes = [
    {
      id: "overview",
      type: "projectOverview",
      position: { x: 40, y: 80 },
      data: {
        title: project.name,
        subtitle: project.description ?? project.slug,
        status: project.status,
        slug: project.slug,
        kind: project.kind,
        path: project.primary_path ?? "",
        warnings: snapshot.warnings,
      },
    },
    ...snapshot.panels.map((panel, index) => ({
      id: panel.id,
      type: "projectPanel",
      position: {
        x: 440 + (index % 3) * 380,
        y: 40 + Math.floor(index / 3) * 270,
      },
      data: {
        title: panel.title,
        kind: panel.kind,
        provider: panel.provider.kind,
        state: panel.state,
        summary: panel.summary ?? panel.stateReason ?? "",
        metrics: panel.metrics.slice(0, 6),
        items: panel.items.slice(0, 5),
        warnings: panel.warnings,
      },
    })),
  ];
  const edges = snapshot.panels.map((panel) => ({
    id: `overview-${panel.id}`,
    source: "overview",
    target: panel.id,
    animated: panel.state === "loading",
    data: { provider: panel.provider.kind },
  }));
  const canvas = {
    id: `dashboard:${project.slug}`,
    slug: "dashboard",
    name: "Project Dashboard",
    description: "Provider-backed project dashboard canvas",
    status: "active" as const,
    layout_engine: "react-flow",
    viewport: { x: 0, y: 0, zoom: 0.82 },
    nodes,
    edges,
    data: { snapshot },
    metadata: { generatedAt: snapshot.generatedAt },
    created_at: snapshot.createdAt,
    updated_at: snapshot.generatedAt,
  };
  const payload = buildProjectCanvasPayload({ project, canvas });
  return validateProjectsRenderSpec(payload.render) as ProjectsJsonRenderSpec;
}

export async function buildProjectDashboard(target: string | undefined, options: BuildProjectDashboardSnapshotOptions = {}) {
  const resolution = resolveRegisteredProjectTargetOrThrow(target, { db: options.db });
  const snapshot = await buildProjectDashboardSnapshot(target, options);
  const render = buildProjectDashboardRender(resolution.project, snapshot);
  return {
    project: resolution.project,
    snapshot,
    render,
    paths: projectDashboardPaths(resolution.project),
  };
}

async function collectProviderPanel(args: {
  provider: ProjectDashboardProvider;
  project: Workspace;
  cwd: string;
  generatedAt: string;
  timeoutMs: number;
  runner: ProjectDashboardProviderRunner;
}): Promise<ProjectPanel> {
  const commandArgs = args.provider.args.map((item) => interpolateProviderArg(item, args.project));
  try {
    const result = await args.runner({
      provider: args.provider,
      project: args.project,
      cwd: args.cwd,
      command: args.provider.command,
      args: commandArgs,
      timeoutMs: args.timeoutMs,
    });
    if (!result.ok) {
      return providerStatePanel(args.provider, args.project, args.generatedAt, result.unavailable ? "unavailable" : "error", summarizeProviderError(result));
    }
    const parsed = ProjectPanelSchema.parse(JSON.parse(result.stdout));
    if (parsed.projectId !== args.project.slug) {
      return providerStatePanel(args.provider, args.project, args.generatedAt, "error", `Provider returned projectId ${parsed.projectId}, expected ${args.project.slug}`);
    }
    return parsed;
  } catch (err) {
    return providerStatePanel(args.provider, args.project, args.generatedAt, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function defaultProjectDashboardProviderRunner(request: ProviderRunRequest): Promise<ProviderRunResult> {
  let timedOut = false;
  try {
    const proc = Bun.spawn([request.command, ...request.args], {
      cwd: request.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, request.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return {
      ok: exitCode === 0 && !timedOut,
      stdout,
      stderr,
      exitCode,
      timedOut,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: null,
      unavailable: true,
    };
  }
}

function interpolateProviderArg(value: string, project: Workspace): string {
  return value
    .replaceAll("{project}", project.slug)
    .replaceAll("{projectId}", project.id)
    .replaceAll("{projectPath}", project.primary_path ?? "");
}

function summarizeProviderError(result: ProviderRunResult): string {
  if (result.timedOut) return "Provider timed out";
  const stderr = result.stderr.trim();
  if (stderr) return stderr.split("\n").slice(0, 3).join("\n");
  return `Provider exited with code ${result.exitCode ?? "unknown"}`;
}

function overviewPanel(project: Workspace, generatedAt: string): ProjectPanel {
  return ProjectPanelSchema.parse({
    schema: SCHEMA_IDS.projectPanel,
    id: `overview:${project.slug}`,
    createdAt: generatedAt,
    projectId: project.slug,
    provider: {
      kind: "render",
      id: "open-projects",
      name: "Projects",
      sourcePackage: "@hasna/projects",
    },
    kind: "overview",
    title: "Project Overview",
    summary: project.description ?? `${project.name} (${project.kind})`,
    state: "ready",
    generatedAt,
    freshness: "fresh",
    metrics: [
      { id: "status", label: "Status", value: project.status, status: project.status === "active" ? "good" : "unknown" },
      { id: "kind", label: "Kind", value: project.kind, status: "unknown" },
      { id: "path", label: "Path", value: project.primary_path ? "set" : "missing", status: project.primary_path ? "good" : "warning" },
    ],
    items: [
      {
        id: "project",
        title: project.name,
        summary: project.primary_path ?? "No primary path",
        status: project.status,
        priority: project.metadata && typeof project.metadata["priority"] === "string" ? priorityFromString(project.metadata["priority"]) : "unknown",
        resourceRefs: [{ kind: "project", id: project.slug, name: project.name, uri: `project://${project.slug}`, tags: ["projects-dashboard"] }],
      },
    ],
    resourceRefs: [{ kind: "project", id: project.slug, name: project.name, uri: `project://${project.slug}`, tags: ["projects-dashboard"] }],
  });
}

function actionsPanel(project: Workspace, generatedAt: string): ProjectPanel {
  return ProjectPanelSchema.parse({
    schema: SCHEMA_IDS.projectPanel,
    id: `actions:${project.slug}`,
    createdAt: generatedAt,
    projectId: project.slug,
    provider: {
      kind: "actions",
      id: "open-projects-dashboard-actions",
      name: "Dashboard Actions",
      sourcePackage: "@hasna/projects",
    },
    kind: "actions",
    title: "Safe Actions",
    summary: "Read-only validation, explicit artifact writes, and token-gated dashboard serving.",
    state: "ready",
    generatedAt,
    freshness: "fresh",
    metrics: [{ id: "available_actions", label: "Actions", value: 3, status: "good" }],
    items: [
      {
        id: "refresh-snapshot",
        title: "Refresh snapshot",
        summary: `projects dashboard snapshot ${project.slug} --write --json`,
        status: "write/server-issued",
        priority: "low",
        resourceRefs: [{ kind: "action", id: "projects.dashboard.snapshot", name: "Refresh snapshot", tags: ["write", "dashboard-artifact", "server-issued"] }],
      },
      {
        id: "validate-dashboard",
        title: "Validate dashboard",
        summary: `projects dashboard validate ${project.slug} --json`,
        status: "read-only",
        priority: "low",
        resourceRefs: [{ kind: "action", id: "projects.dashboard.validate", name: "Validate dashboard", tags: ["read-only"] }],
      },
      {
        id: "serve-dashboard",
        title: "Serve dashboard",
        summary: `PROJECTS_DASHBOARD_TOKEN=<token> projects dashboard serve ${project.slug} --host 0.0.0.0`,
        status: "server-issued",
        priority: "low",
        resourceRefs: [{ kind: "action", id: "projects.dashboard.serve", name: "Serve dashboard", tags: ["server-issued", "network"] }],
      },
    ],
    actions: [
      { kind: "action", id: "projects.dashboard.snapshot", name: "Refresh snapshot", tags: ["write", "dashboard-artifact", "server-issued"] },
      { kind: "action", id: "projects.dashboard.validate", name: "Validate dashboard", tags: ["read-only"] },
      { kind: "action", id: "projects.dashboard.serve", name: "Serve dashboard", tags: ["server-issued", "network"] },
    ],
  });
}

function providerStatePanel(
  provider: ProjectDashboardProvider,
  project: Workspace,
  generatedAt: string,
  state: "error" | "unavailable",
  reason: string,
): ProjectPanel {
  return ProjectPanelSchema.parse({
    schema: SCHEMA_IDS.projectPanel,
    id: `${provider.id}:${project.slug}`,
    createdAt: generatedAt,
    projectId: project.slug,
    provider: {
      kind: provider.kind,
      id: provider.id,
      name: provider.title,
    },
    kind: provider.panelKind,
    title: provider.title,
    state,
    stateReason: reason.slice(0, 500),
    generatedAt,
    freshness: "unknown",
    warnings: provider.warning ? [provider.warning] : [],
  });
}

function priorityFromString(value: string): "low" | "medium" | "high" | "critical" | "unknown" {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  return "unknown";
}
