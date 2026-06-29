import { defineCatalog, defineSchema, type InferSpec } from "@json-render/core";
import { z } from "zod/v4";
import type {
  ProjectCanvas,
  ProjectDataModel,
  ProjectDataRecord,
  ProjectLoopSummary,
} from "../db/project-store.js";
import type {
  JsonObject,
  Workspace,
  WorkspaceAgentAssignment,
  WorkspaceEvent,
  WorkspaceLocation,
} from "../types/workspace.js";
import {
  projectDashboardSummary,
  projectExternalLinksSummary,
  projectManagementSummary,
  projectWithManagement,
} from "./project-management.js";
import type {
  WorkspaceRuntimeAction,
  WorkspaceTmuxResult,
  WorkspaceTmuxWindowSpec,
} from "./workspace-runtime.js";

export const PROJECT_RENDER_SCHEMA_VERSION = 1 as const;

export const projectsJsonRenderSchema = defineSchema((s) => ({
  spec: s.object({
    root: s.string(),
    elements: s.record(
      s.object({
        type: s.ref("catalog.components"),
        props: s.propsOf("catalog.components"),
        children: s.array(s.string()),
      }),
    ),
    metadata: s.any(),
  }),
  catalog: s.object({
    components: s.map({
      props: s.zod(),
      description: s.string(),
    }),
    actions: s.map({
      props: s.zod(),
      description: s.string(),
    }),
  }),
}));

const catalogSchema = <T>(value: T): never => value as never;

const renderActionSchema = z.object({
  label: z.string(),
  command: z.string().optional(),
  href: z.string().optional(),
  variant: z.enum(["primary", "secondary", "danger"]).optional(),
});

const canvasSizeSchema = z.enum(["M", "XL", "XXL", "4XL"]);
const canvasToneSchema = z.enum([
  "neutral",
  "good",
  "warning",
  "danger",
  "info",
]);
const canvasMetricSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  tone: canvasToneSchema.nullable().optional(),
});
const canvasItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
});
const canvasActionSchema = z.object({
  label: z.string(),
  value: z.string(),
  variant: z.enum(["primary", "secondary", "danger"]).nullable().optional(),
});
const canvasHandleSchema = z.object({
  id: z.string(),
  type: z.enum(["source", "target"]),
  position: z.enum(["left", "right", "top", "bottom"]),
});

export const projectsJsonRenderCatalog = defineCatalog(
  projectsJsonRenderSchema,
  {
    components: {
      Card: {
        props: catalogSchema(
          z.object({
            title: z.string(),
            subtitle: z.string().optional(),
            status: z.string().optional(),
          }),
        ),
        description: "A compact project summary card.",
      },
      Table: {
        props: catalogSchema(
          z.object({
            title: z.string().optional(),
            columns: z.array(z.string()),
            rows: z.array(z.record(z.string(), z.unknown())),
          }),
        ),
        description: "A table for scannable project records.",
      },
      Stat: {
        props: catalogSchema(
          z.object({
            label: z.string(),
            value: z.unknown(),
            tone: z.enum(["neutral", "good", "warning", "danger"]).optional(),
          }),
        ),
        description: "A single metric or labeled project value.",
      },
      Badge: {
        props: catalogSchema(
          z.object({
            label: z.string(),
            tone: z
              .enum(["neutral", "good", "warning", "danger", "info"])
              .optional(),
          }),
        ),
        description: "A short status, tag, or classification badge.",
      },
      Tabs: {
        props: catalogSchema(
          z.object({
            tabs: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                children: z.array(z.string()),
              }),
            ),
            active: z.string().optional(),
          }),
        ),
        description: "A tabbed grouping for related project sections.",
      },
      Timeline: {
        props: catalogSchema(
          z.object({
            title: z.string().optional(),
            items: z.array(
              z.object({
                title: z.string(),
                subtitle: z.string().optional(),
                timestamp: z.string().optional(),
                status: z.string().optional(),
              }),
            ),
          }),
        ),
        description: "A chronological list of project events or sessions.",
      },
      Actions: {
        props: catalogSchema(
          z.object({
            actions: z.array(renderActionSchema),
          }),
        ),
        description: "A set of commands or links related to the project.",
      },
      Canvas: {
        props: catalogSchema(
          z.object({
            title: z.string(),
            project: z.record(z.string(), z.unknown()),
            canvas: z.record(z.string(), z.unknown()),
            engine: z.literal("react-flow").or(z.string()),
            viewport: z.record(z.string(), z.unknown()),
            nodes: z.array(z.record(z.string(), z.unknown())),
            edges: z.array(z.record(z.string(), z.unknown())),
            defaultShowConnections: z.boolean().optional(),
            data: z.record(z.string(), z.unknown()),
            capabilities: z.record(z.string(), z.unknown()),
            ui_contract: z.record(z.string(), z.unknown()),
          }),
        ),
        description:
          "A React Flow-compatible infinite canvas surface for project dashboards and custom project views.",
      },
      ProjectCanvasCard: {
        props: catalogSchema(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string().nullable().optional(),
            provider: z.string().nullable().optional(),
            status: z.string().nullable().optional(),
            size: canvasSizeSchema.nullable().optional(),
            selected: z.boolean().nullable().optional(),
            metrics: z.array(canvasMetricSchema).nullable().optional(),
            items: z.array(canvasItemSchema).nullable().optional(),
            actions: z.array(canvasActionSchema).nullable().optional(),
            connectionsEnabled: z.boolean().nullable().optional(),
            handles: z.array(canvasHandleSchema).nullable().optional(),
            className: z.string().nullable().optional(),
          }),
        ),
        description:
          "Open-render shadcn project canvas node. Repeated controls use select:<item.id> and action:<value> event names.",
      },
      SourcePanel: {
        props: catalogSchema(
          z.object({
            title: z.string(),
            activeSourceId: z.string().nullable().optional(),
            size: canvasSizeSchema.nullable().optional(),
            emptyText: z.string().nullable().optional(),
            sources: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                kind: z.string(),
                status: z.string().nullable().optional(),
                description: z.string().nullable().optional(),
                count: z.number().nullable().optional(),
                freshness: z
                  .enum(["fresh", "stale", "unknown"])
                  .nullable()
                  .optional(),
              }),
            ),
            sections: z
              .array(
                z.object({
                  title: z.string(),
                  items: z.array(canvasItemSchema),
                }),
              )
              .nullable()
              .optional(),
            className: z.string().nullable().optional(),
          }),
        ),
        description:
          "Open-render shadcn provider source summary panel for todos, files, mailery, conversations, knowledge, mementos, datasets, and related sources.",
      },
      FilePreviewDialog: {
        props: catalogSchema(
          z.object({
            title: z.string(),
            description: z.string().nullable().optional(),
            openPath: z.string(),
            viewer: z
              .enum([
                "auto",
                "pdf",
                "image",
                "video",
                "audio",
                "markdown",
                "text",
                "metadata",
              ])
              .nullable()
              .optional(),
            src: z.string().nullable().optional(),
            previewText: z.string().nullable().optional(),
            file: z
              .object({
                name: z.string(),
                mime: z.string().nullable().optional(),
                sizeLabel: z.string().nullable().optional(),
                uri: z.string().nullable().optional(),
                referenceLabel: z.string().nullable().optional(),
              })
              .nullable()
              .optional(),
            actions: z.array(canvasActionSchema).nullable().optional(),
          }),
        ),
        description:
          "Open-render shadcn bounded file preview dialog using scoped local/blob preview URLs and redacted metadata.",
      },
    },
    actions: {
      runCommand: {
        props: catalogSchema(z.object({ command: z.string() })),
        description: "Run or copy a local CLI command.",
      },
      openPath: {
        props: catalogSchema(z.object({ path: z.string() })),
        description: "Open a local project path.",
      },
    },
  },
);

export interface ProjectsJsonRenderSpec extends JsonObject {
  root: string;
  elements: Record<string, ProjectsRenderElement>;
  metadata: JsonObject;
}

type ProjectsRenderComponent =
  keyof typeof projectsJsonRenderCatalog.data.components;

interface ProjectsRenderElement {
  type: ProjectsRenderComponent;
  props: Record<string, unknown>;
  children: string[];
}

interface RenderField {
  label: string;
  value: unknown;
}

interface RenderAction {
  label: string;
  command: string;
}

interface RenderSection {
  title: string;
  items: unknown[];
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_/:=@%+.,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderCommand(command: string, args: string[] = []): string {
  return [command, ...args.map(shellArg)].join(" ");
}

function renderElement(
  type: ProjectsRenderComponent,
  props: Record<string, unknown>,
  children: string[] = [],
): ProjectsRenderElement {
  return { type, props, children };
}

export function validateProjectsRenderSpec(
  spec: unknown,
): ProjectsJsonRenderSpec {
  const result = projectsJsonRenderCatalog.validate(spec);
  if (!result.success) {
    throw new Error(
      `Invalid Projects JSON Render spec: ${result.error?.message ?? "validation failed"}`,
    );
  }
  const validated = result.data! as unknown as ProjectsJsonRenderSpec;
  for (const [id, element] of Object.entries(validated.elements)) {
    const component = projectsJsonRenderCatalog.data.components[element.type];
    const propsResult = (
      component.props as {
        safeParse: (value: unknown) => { success: boolean; error?: unknown };
      }
    ).safeParse(element.props);
    if (!propsResult.success) {
      throw new Error(
        `Invalid props for Projects JSON Render element ${id} (${element.type})`,
      );
    }
  }
  return validated;
}

export function isProjectsRenderSpec(
  value: unknown,
): value is ProjectsJsonRenderSpec {
  try {
    validateProjectsRenderSpec(value);
    return true;
  } catch {
    return false;
  }
}

function objectRow(item: unknown): Record<string, unknown> {
  if (item && typeof item === "object" && !Array.isArray(item))
    return item as Record<string, unknown>;
  return { value: item };
}

function columnsForRows(rows: Array<Record<string, unknown>>): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key);
  }
  return Array.from(columns);
}

function statusTone(
  status: string,
): "neutral" | "good" | "warning" | "danger" | "info" {
  if (["ok", "running", "active", "completed", "imported"].includes(status))
    return "good";
  if (
    ["attention", "missing", "planned", "unavailable", "skipped"].includes(
      status,
    )
  )
    return "warning";
  if (["error", "failed", "deleted"].includes(status)) return "danger";
  return "neutral";
}

function renderBlock(
  kind: string,
  title: string,
  status: string,
  summary: string,
  fields: RenderField[] = [],
  sections: RenderSection[] = [],
  actions: RenderAction[] = [],
): JsonObject {
  const elements: Record<string, ProjectsRenderElement> = {
    root: renderElement("Card", { title, subtitle: summary, status }, [
      "status",
      "fields",
    ]),
    status: renderElement("Badge", { label: status, tone: statusTone(status) }),
    fields: renderElement("Table", {
      title: "Fields",
      columns: ["label", "value"],
      rows: fields.map((field) => ({ label: field.label, value: field.value })),
    }),
  };
  const rootChildren = elements.root.children;

  sections.forEach((section, index) => {
    const id = `section_${index + 1}`;
    const rows = section.items.map(objectRow);
    elements[id] = renderElement("Table", {
      title: section.title,
      columns: columnsForRows(rows),
      rows,
    });
    rootChildren.push(id);
  });

  if (actions.length) {
    elements.actions = renderElement("Actions", {
      actions: actions.map((action) => ({
        label: action.label,
        command: action.command,
        variant: "secondary",
      })),
    });
    rootChildren.push("actions");
  }

  return validateProjectsRenderSpec({
    root: "root",
    elements,
    metadata: {
      schema_version: PROJECT_RENDER_SCHEMA_VERSION,
      kind,
    },
  }) as unknown as JsonObject;
}

function tmuxActionLabel(action: WorkspaceRuntimeAction): string {
  const parts = action.target.split(":");
  return parts.length > 1 ? parts.slice(1).join(":") : action.target;
}

function compactWindowAction(action: WorkspaceRuntimeAction): JsonObject {
  return {
    name: tmuxActionLabel(action),
    target: action.target,
    status: action.status,
    message: action.message ?? null,
    path: action.metadata?.path ?? null,
    command: action.metadata?.command ?? null,
  };
}

export function buildProjectStartRender(args: {
  project: Workspace;
  tmux: WorkspaceTmuxResult;
  sessionPolicy: string;
  agentTool: string;
  toolCommand?: string;
  renameReport: JsonObject[];
  resolutionSource: string;
}): JsonObject {
  const windowNames = args.tmux.windows.map(tmuxActionLabel);
  const renamePending = args.renameReport.filter((item) => {
    const status = typeof item.status === "string" ? item.status : "";
    return status === "manual" || status === "unsupported";
  });
  return renderBlock(
    "projects.start",
    `Start ${args.project.name}`,
    args.tmux.success ? "ok" : "error",
    `${args.tmux.session_action} tmux session ${args.tmux.session_name}`,
    [
      { label: "project", value: args.project.slug },
      { label: "session", value: args.tmux.session_name },
      { label: "session_action", value: args.tmux.session_action },
      { label: "session_policy", value: args.sessionPolicy },
      { label: "agent", value: args.agentTool },
      { label: "command", value: args.toolCommand ?? null },
      { label: "resolution", value: args.resolutionSource },
      { label: "windows", value: windowNames },
      { label: "rename_pending", value: renamePending.length },
    ],
    [
      { title: "windows", items: args.tmux.windows.map(compactWindowAction) },
      { title: "coding_session_rename", items: args.renameReport },
    ],
    [
      {
        label: "attach tmux",
        command: renderCommand("tmux", [
          "attach",
          "-t",
          args.tmux.session_name,
        ]),
      },
      {
        label: "status",
        command: renderCommand("projects", ["status", args.project.slug]),
      },
      {
        label: "rename report",
        command: renderCommand("projects", ["sessions", args.project.slug]),
      },
    ],
  );
}

export function buildProjectStatusRender(args: {
  project: Workspace;
  sessionName: string;
  exists: boolean;
  tmuxAvailable: boolean;
  expectedWindows: WorkspaceTmuxWindowSpec[];
  currentWindows: Array<{ name: string; dead?: boolean; reason?: string }>;
  errors: string[];
}): JsonObject {
  const status = !args.tmuxAvailable
    ? "unavailable"
    : args.exists
      ? "running"
      : "missing";
  return renderBlock(
    "projects.tmux_status",
    `Status ${args.project.name}`,
    args.errors.length ? "error" : status,
    `${args.sessionName} is ${status}`,
    [
      { label: "project", value: args.project.slug },
      { label: "session", value: args.sessionName },
      { label: "tmux_available", value: args.tmuxAvailable },
      { label: "session_exists", value: args.exists },
      {
        label: "expected_windows",
        value: args.expectedWindows.map((window) => window.name),
      },
    ],
    [
      {
        title: "expected_windows",
        items: args.expectedWindows.map((window) => ({
          name: window.name,
          path: window.path ?? null,
          command: window.command ?? null,
        })),
      },
      {
        title: "current_windows",
        items: args.currentWindows.map((window) => ({
          name: window.name,
          status: window.dead ? (window.reason ?? "dead") : "alive",
        })),
      },
    ],
    [
      {
        label: "start",
        command: renderCommand("projects", ["start", args.project.slug]),
      },
    ],
  );
}

export function buildProjectListRender(projects: Workspace[]): JsonObject {
  const rows = projects.map((project) => {
    const management = projectManagementSummary(project);
    const externalLinks = projectExternalLinksSummary(project);
    const dashboard = projectDashboardSummary(project);
    return {
      slug: project.slug,
      kind: project.kind,
      status: project.status,
      stage: management.stage ?? "",
      priority: management.priority ?? "",
      owner: management.owner ?? "",
      health: dashboard.path_health.status,
      todos:
        externalLinks.todos.project_id ??
        externalLinks.todos.task_list_id ??
        "",
      brief: externalLinks.brief.id ?? externalLinks.brief.path ?? "",
      path: project.primary_path ?? "",
    };
  });
  return renderBlock(
    "projects.list",
    "Projects",
    "ok",
    `${projects.length} registered projects`,
    [{ label: "count", value: projects.length }],
    [{ title: "projects", items: rows }],
    [{ label: "create", command: "projects create --name <name>" }],
  );
}

export function buildProjectStartBulkRender(args: {
  dryRun: boolean;
  started: Array<{
    project: Workspace;
    tmux?: {
      success?: boolean;
      session_name?: string;
      session_action?: string;
    };
  }>;
  failed: Array<{ target: string; error: string }>;
  summary: Record<string, unknown>;
}): JsonObject {
  const failedCount =
    typeof args.summary.failed === "number"
      ? args.summary.failed
      : args.failed.length;
  return renderBlock(
    "projects.start_bulk",
    "Bulk Start Projects",
    failedCount > 0 ? "error" : "ok",
    `${args.started.length} started, ${args.failed.length} failed`,
    [
      { label: "dry_run", value: args.dryRun },
      {
        label: "total",
        value: args.summary.total ?? args.started.length + args.failed.length,
      },
      {
        label: "succeeded",
        value: args.summary.succeeded ?? args.started.length,
      },
      { label: "failed", value: failedCount },
    ],
    [
      { title: "summary", items: [args.summary] },
      {
        title: "started",
        items: args.started.map((item) => ({
          slug: item.project.slug,
          name: item.project.name,
          status: item.project.status,
          session: item.tmux?.session_name ?? null,
          session_action: item.tmux?.session_action ?? null,
          tmux_success: item.tmux?.success ?? null,
        })),
      },
      {
        title: "failures",
        items: args.failed.map((failure) => ({
          target: failure.target,
          error: failure.error,
        })),
      },
    ],
    [
      { label: "list", command: "projects list" },
      { label: "sessions", command: "projects sessions" },
    ],
  );
}

export function buildRootsRender(
  roots: Array<{
    slug: string;
    name: string;
    base_path: string;
    default_kind: string | null;
    github_org: string | null;
    tags: string[];
  }>,
): JsonObject {
  return renderBlock(
    "projects.roots",
    "Project Roots",
    "ok",
    `${roots.length} registered roots`,
    [{ label: "count", value: roots.length }],
    [
      {
        title: "roots",
        items: roots.map((root) => ({
          slug: root.slug,
          name: root.name,
          kind: root.default_kind,
          github_org: root.github_org,
          path: root.base_path,
          tags: root.tags,
        })),
      },
    ],
    [
      {
        label: "add root",
        command: "projects roots add --name <name> --path <path>",
      },
    ],
  );
}

export function buildRecipesRender(
  recipes: Array<{
    slug: string;
    name: string;
    kind: string | null;
    version: number;
    default_tags: string[];
  }>,
): JsonObject {
  return renderBlock(
    "projects.recipes",
    "Project Recipes",
    "ok",
    `${recipes.length} recipes`,
    [{ label: "count", value: recipes.length }],
    [
      {
        title: "recipes",
        items: recipes.map((recipe) => ({
          slug: recipe.slug,
          name: recipe.name,
          kind: recipe.kind,
          version: recipe.version,
          tags: recipe.default_tags,
        })),
      },
    ],
    [{ label: "seed defaults", command: "projects recipes seed-defaults" }],
  );
}

export function buildProjectDetailPayload(args: {
  project: Workspace;
  agents: WorkspaceAgentAssignment[];
  locations: WorkspaceLocation[];
  events: WorkspaceEvent[];
}): JsonObject {
  const management = projectManagementSummary(args.project);
  const externalLinks = projectExternalLinksSummary(args.project);
  const dashboard = projectDashboardSummary(args.project);
  const recentEvents = args.events.slice(-5).reverse();
  return {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.project",
    project: projectWithManagement(args.project),
    management,
    external_links: externalLinks,
    dashboard,
    agents: args.agents,
    locations: args.locations,
    events: args.events,
    render: renderBlock(
      "projects.project",
      args.project.name,
      args.project.status,
      `${args.project.slug} (${args.project.kind})`,
      [
        { label: "id", value: args.project.id },
        { label: "slug", value: args.project.slug },
        { label: "kind", value: args.project.kind },
        { label: "status", value: args.project.status },
        { label: "path", value: args.project.primary_path },
        { label: "stage", value: management.stage },
        { label: "priority", value: management.priority },
        { label: "owner", value: management.owner },
        { label: "path_health", value: dashboard.path_health.status },
      ],
      [
        {
          title: "locations",
          items: args.locations.map((location) => ({
            label: location.label,
            path: location.path,
            primary: location.is_primary,
          })),
        },
        {
          title: "recent_events",
          items: recentEvents.map((event) => ({
            type: event.event_type,
            source: event.source,
            created_at: event.created_at,
          })),
        },
      ],
      [
        {
          label: "start",
          command: renderCommand("projects", ["start", args.project.slug]),
        },
        {
          label: "status",
          command: renderCommand("projects", ["status", args.project.slug]),
        },
      ],
    ),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function renameReportFromEvent(event: WorkspaceEvent): JsonObject[] {
  const after = objectValue(event.after_json);
  const report = after?.rename_report;
  return Array.isArray(report)
    ? report.filter(
        (item): item is JsonObject =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function isUnrenamedReport(report: JsonObject): boolean {
  const status = typeof report.status === "string" ? report.status : "";
  return status === "manual" || status === "unsupported";
}

export interface ProjectSessionRecord extends JsonObject {
  event_id: string;
  project_id: string | null;
  project_slug: string;
  created_at: string;
  source: string;
  session_name: string | null;
  session_action: string | null;
  windows: JsonObject[];
  rename_report: JsonObject[];
  unrenamed: boolean;
}

export function projectSessionRecords(
  project: Workspace,
  events: WorkspaceEvent[],
): ProjectSessionRecord[] {
  return events
    .filter((event) => event.event_type === "started")
    .map((event) => {
      const after = objectValue(event.after_json);
      const tmux = objectValue(after?.tmux);
      const windows = Array.isArray(tmux?.windows)
        ? tmux.windows.filter(
            (item): item is JsonObject =>
              Boolean(item) && typeof item === "object" && !Array.isArray(item),
          )
        : [];
      const renameReport = renameReportFromEvent(event);
      return {
        event_id: event.id,
        project_id: event.workspace_id,
        project_slug: project.slug,
        created_at: event.created_at,
        source: event.source,
        session_name:
          typeof tmux?.session_name === "string" ? tmux.session_name : null,
        session_action:
          typeof tmux?.session_action === "string" ? tmux.session_action : null,
        windows,
        rename_report: renameReport,
        unrenamed: renameReport.some(isUnrenamedReport),
      };
    })
    .reverse();
}

export function buildProjectSessionsPayload(args: {
  project: Workspace;
  events: WorkspaceEvent[];
  limit?: number;
  unrenamedOnly?: boolean;
}): JsonObject {
  const allRecords = projectSessionRecords(args.project, args.events);
  const filtered = args.unrenamedOnly
    ? allRecords.filter((record) => record.unrenamed)
    : allRecords;
  const sessions = filtered.slice(0, args.limit ?? 20);
  const unrenamedCount = allRecords.filter((record) => record.unrenamed).length;
  return {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.sessions",
    project: projectWithManagement(args.project),
    total: allRecords.length,
    returned: sessions.length,
    unrenamed_count: unrenamedCount,
    sessions,
    render: renderBlock(
      "projects.sessions",
      `Sessions ${args.project.name}`,
      unrenamedCount > 0 ? "attention" : "ok",
      `${sessions.length}/${allRecords.length} start session records`,
      [
        { label: "project", value: args.project.slug },
        { label: "total", value: allRecords.length },
        { label: "returned", value: sessions.length },
        { label: "unrenamed", value: unrenamedCount },
      ],
      [
        {
          title: "sessions",
          items: sessions.map((session) => ({
            created_at: session.created_at,
            session: session.session_name,
            action: session.session_action,
            unrenamed: session.unrenamed,
            rename_report: session.rename_report,
          })),
        },
      ],
      [
        {
          label: "start",
          command: renderCommand("projects", ["start", args.project.slug]),
        },
      ],
    ),
  };
}

export const PROJECT_RENDER_UI_CONTRACT = {
  frontend: "typescript-react",
  styling: "tailwind",
  components: "shadcn",
  component_package: "@json-render/shadcn",
  component_package_min_version: "0.19.1",
  dynamic_components: ["ProjectCanvasCard", "SourcePanel", "FilePreviewDialog"],
  canvas: "react-flow",
  infinite_canvas: true,
  multiple_canvases_per_project: true,
  optional_connections: true,
  persistent_node_positions: true,
  non_overlapping_nodes: true,
  file_preview_dialog: true,
} as const;

function canvasRows(canvases: ProjectCanvas[]): JsonObject[] {
  return canvases.map((canvas) => ({
    id: canvas.id,
    slug: canvas.slug,
    name: canvas.name,
    status: canvas.status,
    engine: canvas.layout_engine,
    nodes: canvas.nodes.length,
    edges: canvas.edges.length,
    updated_at: canvas.updated_at,
  }));
}

export function buildProjectCanvasesPayload(args: {
  project: Workspace;
  canvases: ProjectCanvas[];
}): JsonObject {
  return {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.canvases",
    project: projectWithManagement(args.project),
    canvases: args.canvases,
    ui_contract: PROJECT_RENDER_UI_CONTRACT,
    render: renderBlock(
      "projects.canvases",
      `Canvases ${args.project.name}`,
      "ok",
      `${args.canvases.length} project canvas${args.canvases.length === 1 ? "" : "es"}`,
      [
        { label: "project", value: args.project.slug },
        { label: "count", value: args.canvases.length },
        { label: "canvas_engine", value: "react-flow" },
      ],
      [{ title: "canvases", items: canvasRows(args.canvases) }],
      [
        {
          label: "create canvas",
          command: renderCommand("projects", [
            "canvases",
            "create",
            args.project.slug,
            "--name",
            "New Canvas",
          ]),
        },
        {
          label: "show project",
          command: renderCommand("projects", ["show", args.project.slug]),
        },
      ],
    ),
  };
}

function loopRows(loops: ProjectLoopSummary[] = []): JsonObject[] {
  return loops.map((item) => ({
    loop_id: item.link.loop_id,
    loop_name: item.link.loop_name,
    role: item.link.role,
    status: item.status,
    linked_status:
      item.loop && typeof item.loop.status === "string" ? item.loop.status : "",
    next_run_at:
      item.loop && typeof item.loop.next_run_at === "string"
        ? item.loop.next_run_at
        : "",
    error: item.error ?? "",
  }));
}

function dataModelRows(models: ProjectDataModel[] = []): JsonObject[] {
  return models.map((model) => ({
    id: model.id,
    slug: model.slug,
    name: model.name,
    description: model.description ?? "",
    updated_at: model.updated_at,
  }));
}

function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function sourceFreshness(value: unknown): "fresh" | "stale" | "unknown" {
  return value === "fresh" || value === "stale" || value === "unknown"
    ? value
    : "unknown";
}

function safePreviewSource(value: unknown): string | null {
  const source = asString(value).trim();
  if (!source) return null;
  if (source.startsWith("/") && !source.startsWith("//")) return source;
  if (source.startsWith("blob:")) return source;
  return null;
}

function safeReferenceLabel(value: unknown): string | null {
  const label = asString(value).trim();
  if (!label) return null;
  if (
    label.startsWith("/") ||
    label.includes("://") ||
    /token|signature|credential|secret|expires|x-amz|sig=/i.test(label)
  ) {
    return "redacted reference";
  }
  return label.length > 160 ? `${label.slice(0, 157)}...` : label;
}

function dashboardSnapshotPanels(canvas: ProjectCanvas): JsonObject[] {
  const snapshot = asJsonObject(canvas.data["snapshot"]);
  const panels = snapshot?.["panels"];
  return Array.isArray(panels)
    ? panels.filter((item): item is JsonObject => Boolean(asJsonObject(item)))
    : [];
}

function canvasItemFromUnknown(
  value: unknown,
  fallbackId: string,
): {
  id: string;
  title: string;
  summary?: string | null;
  status?: string | null;
} {
  const item = asJsonObject(value);
  if (!item) return { id: fallbackId, title: String(value ?? fallbackId) };
  return {
    id: asString(item["id"], fallbackId),
    title: asString(item["title"], asString(item["name"], fallbackId)),
    summary: asString(item["summary"], "") || null,
    status: asString(item["status"], "") || null,
  };
}

function sourcePanelProps(args: {
  project: Workspace;
  canvas: ProjectCanvas;
  loops?: ProjectLoopSummary[];
  dataModels?: ProjectDataModel[];
}): Record<string, unknown> {
  const panels = dashboardSnapshotPanels(args.canvas);
  const providerSources = panels.map((panel) => {
    const provider = asJsonObject(panel["provider"]);
    const items = Array.isArray(panel["items"]) ? panel["items"] : [];
    return {
      id: asString(panel["id"], asString(provider?.["id"], "panel")),
      label: asString(panel["title"], asString(provider?.["name"], "Panel")),
      kind: asString(panel["kind"], asString(provider?.["kind"], "custom")),
      status: asString(panel["state"], "") || null,
      description:
        asString(panel["summary"], asString(panel["stateReason"], "")) || null,
      count: items.length,
      freshness: sourceFreshness(panel["freshness"]),
    };
  });
  const dataModelSources = (args.dataModels ?? []).map((model) => ({
    id: model.id,
    label: model.name,
    kind: "dataset",
    status: "ready",
    description: model.description ?? null,
    count: null,
    freshness: "unknown" as const,
  }));
  const loopSources = (args.loops ?? []).map((loop) => ({
    id: loop.link.loop_id,
    label: loop.link.loop_name ?? loop.link.loop_id,
    kind: "open-loop",
    status: loop.status,
    description: loop.link.role ?? null,
    count: null,
    freshness: "unknown" as const,
  }));
  const canvasNodeSection = {
    title: "Canvas Nodes",
    items: args.canvas.nodes.slice(0, 12).map((node, index) =>
      canvasItemFromUnknown(
        {
          id: node.id,
          title: asString(asJsonObject(node.data)?.["title"], node.id),
          summary: asString(
            asJsonObject(node.data)?.["description"],
            asString(asJsonObject(node.data)?.["summary"], ""),
          ),
          status: node.type,
        },
        `node-${index + 1}`,
      ),
    ),
  };
  const panelSections = panels
    .slice(0, 6)
    .map((panel, index) => ({
      title: asString(panel["title"], `Panel ${index + 1}`),
      items: (Array.isArray(panel["items"]) ? panel["items"] : [])
        .slice(0, 8)
        .map((item, itemIndex) =>
          canvasItemFromUnknown(
            item,
            `panel-${index + 1}-item-${itemIndex + 1}`,
          ),
        ),
    }))
    .filter((section) => section.items.length > 0);

  return {
    title: "Project Sources",
    activeSourceId: providerSources[0]?.id ?? dataModelSources[0]?.id ?? null,
    size:
      providerSources.length > 6 || args.canvas.nodes.length > 8 ? "XXL" : "XL",
    emptyText: "No project sources available.",
    sources: [...providerSources, ...dataModelSources, ...loopSources],
    sections: panelSections.length > 0 ? panelSections : [canvasNodeSection],
    className: null,
  };
}

function filePreviewDialogProps(
  canvas: ProjectCanvas,
): Record<string, unknown> {
  const panels = dashboardSnapshotPanels(canvas);
  const firstFileItem = panels
    .flatMap((panel) => (Array.isArray(panel["items"]) ? panel["items"] : []))
    .map((item, index) => ({ item: asJsonObject(item), index }))
    .find(({ item }) => {
      const refs = Array.isArray(item?.["resourceRefs"])
        ? item?.["resourceRefs"]
        : [];
      return refs.some((ref) => {
        const resource = asJsonObject(ref);
        const kind = resource?.["kind"];
        return kind === "file" || kind === "document" || kind === "artifact";
      });
    });
  const metadata = asJsonObject(firstFileItem?.item?.["metadata"]);
  const viewer = asString(metadata?.["viewer"], "metadata");
  const src = safePreviewSource(metadata?.["src"] ?? metadata?.["previewUrl"]);
  const previewText =
    asString(
      metadata?.["previewText"],
      asString(firstFileItem?.item?.["summary"], ""),
    ) || null;
  const title = asString(firstFileItem?.item?.["title"], "File Preview");

  return {
    title,
    description: "Selected project file preview",
    openPath: "dashboard.filePreviewOpen",
    viewer,
    src,
    previewText,
    file: {
      name: title,
      mime: asString(metadata?.["mime"], "") || null,
      sizeLabel: asString(metadata?.["sizeLabel"], "") || null,
      uri: null,
      referenceLabel: safeReferenceLabel(metadata?.["referenceLabel"]),
    },
    actions: [
      { label: "Open source", value: "open-source", variant: "secondary" },
    ],
  };
}

export function buildProjectCanvasPayload(args: {
  project: Workspace;
  canvas: ProjectCanvas;
  loops?: ProjectLoopSummary[];
  dataModels?: ProjectDataModel[];
}): JsonObject {
  const sources = sourcePanelProps(args);
  const filePreview = filePreviewDialogProps(args.canvas);
  const canvasData = asJsonObject(args.canvas.data) ?? {};
  const uiData = asJsonObject(canvasData["ui"]) ?? {};
  const showConnections = uiData["show_connections"] === true;
  const availableEdges = Array.isArray(canvasData["availableEdges"])
    ? canvasData["availableEdges"]
        .map((edge) => asJsonObject(edge))
        .filter((edge): edge is JsonObject => Boolean(edge))
    : args.canvas.edges;
  const elements: Record<string, ProjectsRenderElement> = {
    root: renderElement(
      "Canvas",
      {
        title: args.canvas.name,
        project: {
          id: args.project.id,
          slug: args.project.slug,
          name: args.project.name,
          kind: args.project.kind,
          status: args.project.status,
          primary_path: args.project.primary_path ? "set" : null,
        },
        canvas: {
          id: args.canvas.id,
          slug: args.canvas.slug,
          name: args.canvas.name,
          description: args.canvas.description,
          status: args.canvas.status,
          updated_at: args.canvas.updated_at,
        },
        engine: args.canvas.layout_engine,
        viewport: args.canvas.viewport,
        nodes: args.canvas.nodes,
        edges: showConnections ? args.canvas.edges : [],
        defaultShowConnections: false,
        data: {
          ...canvasData,
          availableEdges,
          ui: {
            ...uiData,
            show_connections: showConnections,
          },
          open_render: {
            node_component: "ProjectCanvasCard",
            source_panel_element: "source_panel",
            file_preview_element: "file_preview_dialog",
          },
        },
        capabilities: {
          infinite_canvas: true,
          multiple_canvases_per_project: true,
          node_renderer: "react-flow",
          node_component: "ProjectCanvasCard",
          source_panel_component: "SourcePanel",
          file_preview_component: "FilePreviewDialog",
        },
        ui_contract: PROJECT_RENDER_UI_CONTRACT,
      },
      ["source_panel", "file_preview_dialog", "actions"],
    ),
    source_panel: renderElement("SourcePanel", sources),
    file_preview_dialog: renderElement("FilePreviewDialog", filePreview),
    actions: renderElement("Actions", {
      actions: [
        {
          label: "list canvases",
          command: renderCommand("projects", [
            "canvases",
            "list",
            args.project.slug,
          ]),
          variant: "secondary",
        },
        {
          label: "show project",
          command: renderCommand("projects", ["show", args.project.slug]),
          variant: "secondary",
        },
      ],
    }),
  };

  if (args.dataModels?.length) {
    elements.data_models = renderElement("Table", {
      title: "Data Models",
      columns: ["id", "slug", "name", "description", "updated_at"],
      rows: dataModelRows(args.dataModels),
    });
    elements.root.children.push("data_models");
  }

  if (args.loops?.length) {
    elements.loops = renderElement("Table", {
      title: "OpenLoops",
      columns: [
        "loop_id",
        "loop_name",
        "role",
        "status",
        "linked_status",
        "next_run_at",
        "error",
      ],
      rows: loopRows(args.loops),
    });
    elements.root.children.push("loops");
  }

  return {
    schema_version: PROJECT_RENDER_SCHEMA_VERSION,
    kind: "projects.canvas",
    project: projectWithManagement(args.project),
    canvas: args.canvas,
    loops: args.loops ?? [],
    data_models: args.dataModels ?? [],
    ui_contract: PROJECT_RENDER_UI_CONTRACT,
    render: validateProjectsRenderSpec({
      root: "root",
      elements,
      metadata: {
        schema_version: PROJECT_RENDER_SCHEMA_VERSION,
        kind: "projects.canvas",
        project_id: args.project.id,
        canvas_id: args.canvas.id,
        ui_contract: PROJECT_RENDER_UI_CONTRACT,
      },
    }) as unknown as JsonObject,
  };
}

export function buildProjectDataModelRender(args: {
  project: Workspace;
  model: ProjectDataModel;
  records: ProjectDataRecord[];
}): JsonObject {
  const rows = args.records.map((record) => ({
    key: record.key,
    title: record.title ?? "",
    data: record.data,
    updated_at: record.updated_at,
  }));
  return renderBlock(
    "projects.data_model",
    args.model.name,
    "ok",
    `${rows.length} record${rows.length === 1 ? "" : "s"} for ${args.project.slug}`,
    [
      { label: "project", value: args.project.slug },
      { label: "model", value: args.model.slug },
      { label: "records", value: rows.length },
    ],
    [
      { title: "schema", items: [args.model.schema] },
      { title: "records", items: rows },
    ],
    [
      {
        label: "show project",
        command: renderCommand("projects", ["show", args.project.slug]),
      },
    ],
  );
}
