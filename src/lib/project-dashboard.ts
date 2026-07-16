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
import {
  listExistingProjectCanvases,
  type ProjectCanvas,
} from "../db/project-store.js";
import type { JsonObject, Workspace } from "../types/workspace.js";
import { resolveRegisteredProjectTargetOrThrow } from "./project-resolver.js";
import {
  buildProjectCanvasPayload,
  validateProjectsRenderSpec,
  type ProjectsJsonRenderSpec,
} from "./project-render.js";

export const PROJECT_DASHBOARD_DIR = ".hasna/project" as const;
export const PROJECT_DASHBOARD_RENDER_DIR = ".hasna/project/dashboard" as const;
export const PROJECT_DASHBOARD_SNAPSHOTS_DIR =
  ".hasna/project/dashboard/snapshots" as const;

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

export type ProjectDashboardProviderRunner = (
  request: ProviderRunRequest,
) => Promise<ProviderRunResult>;

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

export interface ProjectDashboardRenderImportRef extends JsonObject {
  id: string;
  path: string;
  kind: string;
  status: "ready";
  renderRef: string;
}

export interface ProjectDashboardLinkedCanvasRef extends JsonObject {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  kind: "project-canvas";
  nodes: number;
  edges: number;
  updated_at: string;
  renderRef: string;
}

export interface BuildProjectDashboardRenderOptions {
  imports?: ProjectDashboardRenderManifest["imports"];
  linkedCanvases?: ProjectCanvas[];
}

export const DEFAULT_PROJECT_DASHBOARD_PROVIDERS: ProjectDashboardProvider[] = [
  {
    id: "todos",
    kind: "todos",
    panelKind: "tasks",
    title: "Tasks",
    command: "todos",
    args: ["project-panel", "--project", "{todosProject}", "--json", "--contract"],
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
    args: [
      "project-panel",
      "--project",
      "{project}",
      "--limit",
      "20",
      "--json",
      "--contract",
    ],
    optional: true,
    warning:
      "Mailery provider is workspace-scoped until project-to-email mapping is configured.",
  },
  {
    id: "conversations",
    kind: "conversations",
    panelKind: "conversations",
    title: "Conversations",
    command: "conversations",
    args: [
      "project-panel",
      "--project",
      "{project}",
      "--limit",
      "30",
      "--json",
      "--contract",
    ],
    optional: true,
  },
  {
    id: "knowledge",
    kind: "knowledge",
    panelKind: "knowledge",
    title: "Knowledge",
    command: "knowledge",
    args: [
      "project-panel",
      "--project",
      "{project}",
      "--scope",
      "project",
      "--limit",
      "30",
      "--json",
      "--contract",
    ],
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
  {
    id: "datasets",
    kind: "custom",
    panelKind: "custom",
    title: "Datasets",
    command: "datasets",
    args: ["project-panel", "--project", "{project}", "--json", "--contract"],
    optional: true,
    warning:
      "Datasets provider uses the @hasna/datasets custom panel until contracts add a first-class datasets kind.",
  },
];

export function projectDashboardPaths(
  project: Workspace,
): ProjectDashboardPaths {
  const projectPath = project.primary_path
    ? resolve(project.primary_path)
    : process.cwd();
  return {
    projectPath,
    rootDir: join(projectPath, PROJECT_DASHBOARD_DIR),
    manifestPath: join(projectPath, PROJECT_DASHBOARD_DIR, "manifest.json"),
    renderDir: join(projectPath, PROJECT_DASHBOARD_RENDER_DIR),
    renderManifestPath: join(
      projectPath,
      PROJECT_DASHBOARD_RENDER_DIR,
      "render.json",
    ),
    snapshotsDir: join(projectPath, PROJECT_DASHBOARD_SNAPSHOTS_DIR),
    latestSnapshotPath: join(
      projectPath,
      PROJECT_DASHBOARD_SNAPSHOTS_DIR,
      "latest.snapshot.json",
    ),
  };
}

export function ensureProjectDashboardStructure(
  project: Workspace,
  now = new Date().toISOString(),
): ProjectDashboardPaths {
  const paths = projectDashboardPaths(project);
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.renderDir, { recursive: true });
  mkdirSync(paths.snapshotsDir, { recursive: true });
  if (!existsSync(paths.manifestPath)) {
    writeFileSync(
      paths.manifestPath,
      `${JSON.stringify(
        {
          schema: "hasna.projects_dashboard_manifest.v1",
          projectId: project.slug,
          projectName: project.name,
          generatedBy: "@hasna/projects",
          updatedAt: now,
          layout: {
            dashboardDir: PROJECT_DASHBOARD_RENDER_DIR,
            snapshotsDir: PROJECT_DASHBOARD_SNAPSHOTS_DIR,
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  if (!existsSync(paths.renderManifestPath)) {
    const manifest: ProjectDashboardRenderManifest = {
      schema: "hasna.projects_dashboard_render.v1",
      projectId: project.slug,
      defaultView: "canvas",
      imports: [],
      updatedAt: now,
    };
    writeFileSync(
      paths.renderManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  return paths;
}

export function loadProjectDashboardRenderManifest(
  project: Workspace,
): ProjectDashboardRenderManifest | null {
  const paths = projectDashboardPaths(project);
  if (!existsSync(paths.renderManifestPath)) return null;
  const parsed = JSON.parse(
    readFileSync(paths.renderManifestPath, "utf-8"),
  ) as ProjectDashboardRenderManifest;
  resolveDashboardImports(paths.renderDir, parsed.imports ?? []);
  return parsed;
}

export function writeProjectDashboardRenderManifest(
  project: Workspace,
  updatedAt = new Date().toISOString(),
): ProjectDashboardPaths {
  const paths = ensureProjectDashboardStructure(project, updatedAt);
  const existing = loadProjectDashboardRenderManifest(project);
  const manifest: ProjectDashboardRenderManifest = {
    schema: "hasna.projects_dashboard_render.v1",
    projectId: project.slug,
    defaultView: existing?.defaultView ?? "canvas",
    imports: existing?.imports ?? [],
    updatedAt,
  };
  writeFileSync(
    paths.renderManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return paths;
}

export function resolveDashboardImports(
  baseDir: string,
  imports: Array<{ id: string; path: string; kind?: string }>,
): string[] {
  return imports.map((item) => {
    if (isAbsolute(item.path))
      throw new Error(`Dashboard import must be relative: ${item.path}`);
    const resolved = resolve(baseDir, normalize(item.path));
    const rel = relative(baseDir, resolved);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error(
        `Dashboard import escapes render directory: ${item.path}`,
      );
    if (!existsSync(resolved) || !statSync(resolved).isFile())
      throw new Error(`Dashboard import not found: ${item.path}`);
    return resolved;
  });
}

export async function buildProjectDashboardSnapshot(
  target: string | undefined,
  options: BuildProjectDashboardSnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const resolution = resolveRegisteredProjectTargetOrThrow(target, {
    db: options.db,
  });
  const project = resolution.project;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const paths = options.initialize
    ? ensureProjectDashboardStructure(project, generatedAt)
    : projectDashboardPaths(project);
  const cwd = options.cwd ?? project.primary_path ?? paths.projectPath;
  const requestedKinds = new Set(options.providerKinds ?? []);
  const providers = (
    options.providers ?? DEFAULT_PROJECT_DASHBOARD_PROVIDERS
  ).filter(
    (provider) =>
      requestedKinds.size === 0 ||
      requestedKinds.has(provider.id) ||
      requestedKinds.has(provider.kind),
  );
  const runner = options.runner ?? defaultProjectDashboardProviderRunner;
  const warnings: string[] = [];
  const panels: ProjectPanel[] = [overviewPanel(project, generatedAt)];

  for (const provider of providers) {
    if (provider.warning) warnings.push(`${provider.id}: ${provider.warning}`);
    panels.push(
      await collectProviderPanel({
        provider,
        project,
        cwd,
        generatedAt,
        timeoutMs: options.timeoutMs ?? provider.timeoutMs ?? 15_000,
        runner,
      }),
    );
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
    freshness: panels.some((panel) => panel.freshness === "stale")
      ? "stale"
      : "fresh",
  });
  return snapshot;
}

export function writeProjectDashboardSnapshot(
  project: Workspace,
  snapshot: ProjectSnapshot,
): ProjectDashboardPaths {
  const paths = ensureProjectDashboardStructure(project, snapshot.generatedAt);
  writeFileSync(
    paths.latestSnapshotPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  return paths;
}

export function buildProjectDashboardRender(
  project: Workspace,
  snapshot: ProjectSnapshot,
  options: BuildProjectDashboardRenderOptions = {},
): ProjectsJsonRenderSpec {
  const panelStartX = 680;
  const panelStartY = 40;
  const panelColumnGap = 1120;
  const panelRowGap = 640;
  const dashboardImports = dashboardImportRefs(options.imports ?? []);
  const linkedCanvases = linkedCanvasRefs(
    project,
    options.linkedCanvases ?? [],
  );
  const supportNodes = [
    ...(linkedCanvases.length > 0
      ? [projectCanvasesNode(linkedCanvases)]
      : []),
    ...(dashboardImports.length > 0
      ? [dashboardImportsNode(dashboardImports)]
      : []),
  ];
  const nodes = [
    {
      id: "overview",
      type: "projectOverview",
      position: { x: 40, y: 80 },
      data: {
        id: "overview",
        title: project.name,
        subtitle: project.description ?? project.slug,
        status: project.status,
        slug: project.slug,
        kind: project.kind,
        path: project.primary_path ? "set" : "",
        warnings: snapshot.warnings,
        component: "ProjectCanvasCard",
        size: "XL",
        actions: [
          {
            label: "Show project",
            value: "show-project",
            variant: "secondary",
          },
        ],
      },
    },
    ...supportNodes,
    ...snapshot.panels.map((panel, index) => ({
      id: panel.id,
      type: "projectPanel",
      position: {
        x: panelStartX + (index % 3) * panelColumnGap,
        y: panelStartY + Math.floor(index / 3) * panelRowGap,
      },
      data: {
        id: panel.id,
        title: panel.title,
        kind: panel.kind,
        provider: panel.provider.kind,
        state: panel.state,
        summary: panel.summary ?? panel.stateReason ?? "",
        component: "ProjectCanvasCard",
        size: dashboardPanelSize(panel.kind),
        metrics: panel.metrics.slice(0, 6).map((metric) => ({
          ...metric,
          tone: metricTone(metric.status),
        })),
        items: panel.items.slice(0, 5),
        actions: [
          { label: "Open", value: `open:${panel.id}`, variant: "secondary" },
          ...(panel.kind === "files" || panel.kind === "documents"
            ? [
                {
                  label: "Preview",
                  value: `preview:${panel.id}`,
                  variant: "primary",
                },
              ]
            : []),
        ],
        warnings: panel.warnings,
      },
    })),
  ];
  const edges = [
    ...supportNodes.map((node) => ({
      id: `overview-${node.id}`,
      source: "overview",
      target: node.id,
      animated: false,
      data: { provider: "projects" },
    })),
    ...snapshot.panels.map((panel) => ({
      id: `overview-${panel.id}`,
      source: "overview",
      target: panel.id,
      animated: panel.state === "loading",
      data: { provider: panel.provider.kind },
    })),
  ];
  const canvas = {
    id: `dashboard:${project.slug}`,
    slug: "dashboard",
    name: "Project Dashboard",
    description: "Provider-backed project dashboard canvas",
    status: "active" as const,
    layout_engine: "react-flow",
    viewport: { x: 0, y: 0, zoom: 0.82 },
    nodes,
    edges: [],
    data: {
      snapshot,
      linked_canvases: linkedCanvases,
      dashboard_imports: dashboardImports,
      availableEdges: edges,
      ui: { show_connections: false },
    },
    metadata: {
      generatedAt: snapshot.generatedAt,
      linked_canvases: linkedCanvases,
      dashboard_imports: dashboardImports,
    },
    created_at: snapshot.createdAt,
    updated_at: snapshot.generatedAt,
  };
  const payload = buildProjectCanvasPayload({ project, canvas });
  return validateProjectsRenderSpec(payload.render) as ProjectsJsonRenderSpec;
}

function dashboardImportRefs(
  imports: ProjectDashboardRenderManifest["imports"],
): ProjectDashboardRenderImportRef[] {
  return imports.map((item) => ({
    id: item.id,
    path: item.path,
    kind: item.kind ?? "render",
    status: "ready",
    renderRef: `dashboard-import://${encodeURIComponent(item.id)}`,
  }));
}

function linkedCanvasRefs(
  project: Workspace,
  canvases: ProjectCanvas[],
): ProjectDashboardLinkedCanvasRef[] {
  return canvases
    .filter((canvas) => canvas.status === "active" && canvas.slug !== "dashboard")
    .map((canvas) => ({
      id: canvas.id,
      slug: canvas.slug,
      name: canvas.name,
      description: canvas.description,
      status: canvas.status,
      kind: "project-canvas" as const,
      nodes: canvas.nodes.length,
      edges: canvas.edges.length,
      updated_at: canvas.updated_at,
      renderRef: `projects://canvases/${encodeURIComponent(project.slug)}/${encodeURIComponent(canvas.slug || canvas.id)}`,
    }));
}

function projectCanvasesNode(
  canvases: ProjectDashboardLinkedCanvasRef[],
): ProjectCanvas["nodes"][number] {
  return {
    id: "project-canvases",
    type: "projectPanel",
    position: { x: 40, y: 480 },
    data: {
      id: "project-canvases",
      title: "Project Canvases",
      kind: "project-canvases",
      provider: "projects",
      state: "ready",
      summary: `${canvases.length} linked project canvas${canvases.length === 1 ? "" : "es"}`,
      component: "ProjectCanvasCard",
      size: "XL",
      metrics: [
        { id: "canvases", label: "Canvases", value: canvases.length, tone: "good" },
      ],
      items: canvases.slice(0, 5).map((canvas) => ({
        id: canvas.slug,
        title: canvas.name,
        summary: canvas.description,
        status: `${canvas.nodes} nodes, ${canvas.edges} edges`,
      })),
      actions: [
        { label: "List", value: "list-canvases", variant: "secondary" },
      ],
      warnings: [],
    },
  };
}

function dashboardImportsNode(
  imports: ProjectDashboardRenderImportRef[],
): ProjectCanvas["nodes"][number] {
  return {
    id: "dashboard-imports",
    type: "projectPanel",
    position: { x: 40, y: 880 },
    data: {
      id: "dashboard-imports",
      title: "Dashboard Imports",
      kind: "dashboard-imports",
      provider: "projects",
      state: "ready",
      summary: `${imports.length} validated dashboard import${imports.length === 1 ? "" : "s"}`,
      component: "ProjectCanvasCard",
      size: "XL",
      metrics: [
        { id: "imports", label: "Imports", value: imports.length, tone: "good" },
      ],
      items: imports.slice(0, 5).map((item) => ({
        id: item.id,
        title: item.id,
        summary: item.path,
        status: item.kind,
      })),
      actions: [],
      warnings: [],
    },
  };
}

function dashboardPanelSize(
  kind: ProjectPanel["kind"],
): "M" | "XL" | "XXL" | "4XL" {
  if (kind === "files" || kind === "documents" || kind === "custom")
    return "XXL";
  if (
    kind === "tasks" ||
    kind === "knowledge" ||
    kind === "mailery" ||
    kind === "conversations" ||
    kind === "mementos"
  )
    return "XL";
  if (kind === "overview") return "XL";
  return "M";
}

function metricTone(
  status: ProjectPanel["metrics"][number]["status"],
): "neutral" | "good" | "warning" | "danger" | "info" {
  if (status === "good") return "good";
  if (status === "warning") return "warning";
  if (status === "critical") return "danger";
  return "neutral";
}

export async function buildProjectDashboard(
  target: string | undefined,
  options: BuildProjectDashboardSnapshotOptions = {},
) {
  const resolution = resolveRegisteredProjectTargetOrThrow(target, {
    db: options.db,
  });
  const snapshot = await buildProjectDashboardSnapshot(target, options);
  const manifest = loadProjectDashboardRenderManifest(resolution.project);
  const linkedCanvases = listExistingProjectCanvases(resolution.project);
  const render = buildProjectDashboardRender(resolution.project, snapshot, {
    imports: manifest?.imports ?? [],
    linkedCanvases,
  });
  return {
    project: resolution.project,
    snapshot,
    render,
    manifest,
    linkedCanvases,
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
  if (args.provider.id === "mailery") {
    return projectScopedProviderRequiredPanel(
      args.provider,
      args.project,
      args.generatedAt,
      "Project-email mapping is not configured, so workspace-wide Mailery metadata is intentionally omitted.",
    );
  }
  const commandArgs = args.provider.args.map((item) =>
    interpolateProviderArg(item, args.project),
  );
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
      return providerStatePanel(
        args.provider,
        args.project,
        args.generatedAt,
        result.unavailable ? "unavailable" : "error",
        summarizeProviderError(result),
      );
    }
    const parsed = sanitizeProviderPanel(
      ProjectPanelSchema.parse(JSON.parse(result.stdout)),
    );
    if (!providerPanelMatchesProject(parsed, args.provider, args.project)) {
      return providerStatePanel(
        args.provider,
        args.project,
        args.generatedAt,
        "error",
        `Provider returned projectId ${parsed.projectId}, expected ${expectedProviderProjectIds(args.provider, args.project).join(" or ")}`,
      );
    }
    return normalizeProviderPanelProjectId(parsed, args.project);
  } catch (err) {
    return providerStatePanel(
      args.provider,
      args.project,
      args.generatedAt,
      "error",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function sanitizeProviderPanel(panel: ProjectPanel): ProjectPanel {
  const sanitized = ProjectPanelSchema.parse(sanitizeDashboardValue(panel));
  if (sanitized.provider.kind === "reports" || sanitized.kind === "reports") {
    return sanitizeReportsProviderPanel(sanitized);
  }
  return sanitized;
}

function sanitizeReportsProviderPanel(panel: ProjectPanel): ProjectPanel {
  return ProjectPanelSchema.parse({
    ...panel,
    summary: panel.summary
      ? "Report bodies are excluded from dashboard artifacts; use projects reports serve to view reports."
      : undefined,
    items: panel.items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      timestamp: item.timestamp,
      resourceRefs: item.resourceRefs,
      evidenceRefs: [],
    })),
    evidenceRefs: [],
    renderFragment: undefined,
    warnings: [
      ...panel.warnings,
      "Report bodies are excluded from ProjectSnapshot and React Flow dashboard artifacts.",
    ],
  });
}

function sanitizeDashboardValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeDashboardString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDashboardValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDashboardValue(item),
      ]),
    );
  }
  return value;
}

function sanitizeDashboardString(value: string): string {
  if (isLocalAbsolutePath(value)) return "[redacted local path]";
  return value.replace(
    /\/home\/hasna\/[^\s"'<>),\]]+/g,
    "[redacted local path]",
  );
}

function isLocalAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/home/hasna/") ||
    value.startsWith("/Users/") ||
    value.startsWith("/tmp/") ||
    value.startsWith("/var/folders/")
  );
}

export async function defaultProjectDashboardProviderRunner(
  request: ProviderRunRequest,
): Promise<ProviderRunResult> {
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
    .replaceAll("{todosProject}", todosProviderProjectTarget(project))
    .replaceAll("{projectId}", project.id)
    .replaceAll("{projectPath}", project.primary_path ?? "");
}

function todosProviderProjectTarget(project: Workspace): string {
  return (
    project.integrations.todos_project_id ??
    project.integrations.todos_task_list_id ??
    project.slug
  );
}

function expectedProviderProjectIds(
  provider: ProjectDashboardProvider,
  project: Workspace,
): string[] {
  if (provider.id !== "todos" && provider.kind !== "todos") return [project.slug];
  return [
    project.slug,
    project.integrations.todos_project_id,
    project.integrations.todos_task_list_id,
    todosTaskListSlugForPanel(project.integrations.todos_task_list_id),
  ].filter((item, index, values): item is string =>
    Boolean(item) && values.indexOf(item) === index
  );
}

function providerPanelMatchesProject(
  panel: ProjectPanel,
  provider: ProjectDashboardProvider,
  project: Workspace,
): boolean {
  const expected = expectedProviderProjectIds(provider, project);
  if (expected.includes(panel.projectId)) return true;
  if (provider.id !== "todos" && provider.kind !== "todos") return false;
  const linkedTodosProject = project.integrations.todos_project_id;
  return Boolean(
    linkedTodosProject &&
    panel.provider.kind === "todos" &&
    panel.provider.externalId === linkedTodosProject
  );
}

function normalizeProviderPanelProjectId(panel: ProjectPanel, project: Workspace): ProjectPanel {
  if (panel.projectId === project.slug) return panel;
  return ProjectPanelSchema.parse({
    ...panel,
    projectId: project.slug,
  });
}

function todosTaskListSlugForPanel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("todos-") ? value.slice("todos-".length) : value;
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
      {
        id: "status",
        label: "Status",
        value: project.status,
        status: project.status === "active" ? "good" : "unknown",
      },
      { id: "kind", label: "Kind", value: project.kind, status: "unknown" },
      {
        id: "path",
        label: "Path",
        value: project.primary_path ? "set" : "missing",
        status: project.primary_path ? "good" : "warning",
      },
    ],
    items: [
      {
        id: "project",
        title: project.name,
        summary: project.primary_path ? "Primary path set" : "No primary path",
        status: project.status,
        priority:
          project.metadata && typeof project.metadata["priority"] === "string"
            ? priorityFromString(project.metadata["priority"])
            : "unknown",
        resourceRefs: [
          {
            kind: "project",
            id: project.slug,
            name: project.name,
            uri: `project://${project.slug}`,
            tags: ["projects-dashboard"],
          },
        ],
      },
    ],
    resourceRefs: [
      {
        kind: "project",
        id: project.slug,
        name: project.name,
        uri: `project://${project.slug}`,
        tags: ["projects-dashboard"],
      },
    ],
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
    summary:
      "Read-only validation, explicit artifact writes, and token-gated dashboard serving.",
    state: "ready",
    generatedAt,
    freshness: "fresh",
    metrics: [
      { id: "available_actions", label: "Actions", value: 3, status: "good" },
    ],
    items: [
      {
        id: "refresh-snapshot",
        title: "Refresh snapshot",
        summary: `projects dashboard snapshot ${project.slug} --write --json`,
        status: "write/server-issued",
        priority: "low",
        resourceRefs: [
          {
            kind: "action",
            id: "projects.dashboard.snapshot",
            name: "Refresh snapshot",
            tags: ["write", "dashboard-artifact", "server-issued"],
          },
        ],
      },
      {
        id: "validate-dashboard",
        title: "Validate dashboard",
        summary: `projects dashboard validate ${project.slug} --json`,
        status: "read-only",
        priority: "low",
        resourceRefs: [
          {
            kind: "action",
            id: "projects.dashboard.validate",
            name: "Validate dashboard",
            tags: ["read-only"],
          },
        ],
      },
      {
        id: "serve-dashboard",
        title: "Serve dashboard",
        summary: `PROJECTS_DASHBOARD_TOKEN=<token> projects dashboard serve ${project.slug} --host 0.0.0.0`,
        status: "server-issued",
        priority: "low",
        resourceRefs: [
          {
            kind: "action",
            id: "projects.dashboard.serve",
            name: "Serve dashboard",
            tags: ["server-issued", "network"],
          },
        ],
      },
    ],
    actions: [
      {
        kind: "action",
        id: "projects.dashboard.snapshot",
        name: "Refresh snapshot",
        tags: ["write", "dashboard-artifact", "server-issued"],
      },
      {
        kind: "action",
        id: "projects.dashboard.validate",
        name: "Validate dashboard",
        tags: ["read-only"],
      },
      {
        kind: "action",
        id: "projects.dashboard.serve",
        name: "Serve dashboard",
        tags: ["server-issued", "network"],
      },
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

function projectScopedProviderRequiredPanel(
  provider: ProjectDashboardProvider,
  project: Workspace,
  generatedAt: string,
  reason: string,
): ProjectPanel {
  return ProjectPanelSchema.parse({
    schema: SCHEMA_IDS.projectPanel,
    id: `${provider.id}_panel_${project.slug}`,
    createdAt: generatedAt,
    projectId: project.slug,
    provider: {
      kind: provider.kind,
      id: `${provider.id}_${project.slug}`,
      name: provider.title,
      sourcePackage: "@hasna/projects",
      externalId: project.slug,
    },
    kind: provider.panelKind,
    title: provider.title,
    summary: reason,
    state: "empty",
    stateReason: reason,
    generatedAt,
    freshness: "unknown",
    metrics: [
      {
        id: "project_scoped_items",
        label: "Project-scoped items",
        value: 0,
        status: "unknown",
      },
    ],
    items: [],
    warnings: [
      provider.warning ?? "",
      "Workspace-wide provider data is omitted from dashboard artifacts until an explicit project mapping exists.",
    ].filter(Boolean),
    resourceRefs: [
      {
        kind: "project",
        id: project.slug,
        name: project.name,
        uri: `project://${project.slug}`,
        externalId: project.slug,
        sourcePackage: "@hasna/projects",
        tags: ["project-scoped-required"],
      },
    ],
    renderFragment: {
      renderer: "json_render",
      title: provider.title,
      spec: {
        component: `project.${provider.id}.summary`,
        state: "project_mapping_required",
      },
    },
  });
}

function priorityFromString(
  value: string,
): "low" | "medium" | "high" | "critical" | "unknown" {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "critical"
  )
    return value;
  return "unknown";
}
