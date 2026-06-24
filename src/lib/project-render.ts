import { defineCatalog, defineSchema, type InferSpec } from "@json-render/core";
import { z } from "zod/v4";
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
import type { WorkspaceRuntimeAction, WorkspaceTmuxResult, WorkspaceTmuxWindowSpec } from "./workspace-runtime.js";

export const PROJECT_RENDER_SCHEMA_VERSION = 1 as const;

export const projectsJsonRenderSchema = defineSchema((s) => ({
  spec: s.object({
    root: s.string(),
    elements: s.record(s.object({
      type: s.ref("catalog.components"),
      props: s.propsOf("catalog.components"),
      children: s.array(s.string()),
    })),
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

export const projectsJsonRenderCatalog = defineCatalog(projectsJsonRenderSchema, {
  components: {
    Card: {
      props: catalogSchema(z.object({
        title: z.string(),
        subtitle: z.string().optional(),
        status: z.string().optional(),
      })),
      description: "A compact project summary card.",
    },
    Table: {
      props: catalogSchema(z.object({
        title: z.string().optional(),
        columns: z.array(z.string()),
        rows: z.array(z.record(z.string(), z.unknown())),
      })),
      description: "A table for scannable project records.",
    },
    Stat: {
      props: catalogSchema(z.object({
        label: z.string(),
        value: z.unknown(),
        tone: z.enum(["neutral", "good", "warning", "danger"]).optional(),
      })),
      description: "A single metric or labeled project value.",
    },
    Badge: {
      props: catalogSchema(z.object({
        label: z.string(),
        tone: z.enum(["neutral", "good", "warning", "danger", "info"]).optional(),
      })),
      description: "A short status, tag, or classification badge.",
    },
    Tabs: {
      props: catalogSchema(z.object({
        tabs: z.array(z.object({
          id: z.string(),
          label: z.string(),
          children: z.array(z.string()),
        })),
        active: z.string().optional(),
      })),
      description: "A tabbed grouping for related project sections.",
    },
    Timeline: {
      props: catalogSchema(z.object({
        title: z.string().optional(),
        items: z.array(z.object({
          title: z.string(),
          subtitle: z.string().optional(),
          timestamp: z.string().optional(),
          status: z.string().optional(),
        })),
      })),
      description: "A chronological list of project events or sessions.",
    },
    Actions: {
      props: catalogSchema(z.object({
        actions: z.array(renderActionSchema),
      })),
      description: "A set of commands or links related to the project.",
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
});

export interface ProjectsJsonRenderSpec extends JsonObject {
  root: string;
  elements: Record<string, ProjectsRenderElement>;
  metadata: JsonObject;
}

type ProjectsRenderComponent = keyof typeof projectsJsonRenderCatalog.data.components;

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

function renderElement(type: ProjectsRenderComponent, props: Record<string, unknown>, children: string[] = []): ProjectsRenderElement {
  return { type, props, children };
}

export function validateProjectsRenderSpec(spec: unknown): ProjectsJsonRenderSpec {
  const result = projectsJsonRenderCatalog.validate(spec);
  if (!result.success) {
    throw new Error(`Invalid Projects JSON Render spec: ${result.error?.message ?? "validation failed"}`);
  }
  return result.data! as unknown as ProjectsJsonRenderSpec;
}

export function isProjectsRenderSpec(value: unknown): value is ProjectsJsonRenderSpec {
  return projectsJsonRenderCatalog.validate(value).success;
}

function objectRow(item: unknown): Record<string, unknown> {
  if (item && typeof item === "object" && !Array.isArray(item)) return item as Record<string, unknown>;
  return { value: item };
}

function columnsForRows(rows: Array<Record<string, unknown>>): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key);
  }
  return Array.from(columns);
}

function statusTone(status: string): "neutral" | "good" | "warning" | "danger" | "info" {
  if (["ok", "running", "active", "completed", "imported"].includes(status)) return "good";
  if (["attention", "missing", "planned", "unavailable", "skipped"].includes(status)) return "warning";
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
    root: renderElement("Card", { title, subtitle: summary, status }, ["status", "fields"]),
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
      { label: "attach tmux", command: `tmux attach -t ${args.tmux.session_name}` },
      { label: "status", command: `projects status ${args.project.slug}` },
      { label: "rename report", command: `projects sessions ${args.project.slug}` },
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
  const status = !args.tmuxAvailable ? "unavailable" : args.exists ? "running" : "missing";
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
      { label: "expected_windows", value: args.expectedWindows.map((window) => window.name) },
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
          status: window.dead ? window.reason ?? "dead" : "alive",
        })),
      },
    ],
    [{ label: "start", command: `projects start ${args.project.slug}` }],
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
      todos: externalLinks.todos.project_id ?? externalLinks.todos.task_list_id ?? "",
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

export function buildRootsRender(roots: Array<{ slug: string; name: string; base_path: string; default_kind: string | null; github_org: string | null; tags: string[] }>): JsonObject {
  return renderBlock(
    "projects.roots",
    "Project Roots",
    "ok",
    `${roots.length} registered roots`,
    [{ label: "count", value: roots.length }],
    [{ title: "roots", items: roots.map((root) => ({ slug: root.slug, name: root.name, kind: root.default_kind, github_org: root.github_org, path: root.base_path, tags: root.tags })) }],
    [{ label: "add root", command: "projects roots add --name <name> --path <path>" }],
  );
}

export function buildRecipesRender(recipes: Array<{ slug: string; name: string; kind: string | null; version: number; default_tags: string[] }>): JsonObject {
  return renderBlock(
    "projects.recipes",
    "Project Recipes",
    "ok",
    `${recipes.length} recipes`,
    [{ label: "count", value: recipes.length }],
    [{ title: "recipes", items: recipes.map((recipe) => ({ slug: recipe.slug, name: recipe.name, kind: recipe.kind, version: recipe.version, tags: recipe.default_tags })) }],
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
        { label: "start", command: `projects start ${args.project.slug}` },
        { label: "status", command: `projects status ${args.project.slug}` },
      ],
    ),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function renameReportFromEvent(event: WorkspaceEvent): JsonObject[] {
  const after = objectValue(event.after_json);
  const report = after?.rename_report;
  return Array.isArray(report)
    ? report.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
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

export function projectSessionRecords(project: Workspace, events: WorkspaceEvent[]): ProjectSessionRecord[] {
  return events
    .filter((event) => event.event_type === "started")
    .map((event) => {
      const after = objectValue(event.after_json);
      const tmux = objectValue(after?.tmux);
      const windows = Array.isArray(tmux?.windows)
        ? tmux.windows.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : [];
      const renameReport = renameReportFromEvent(event);
      return {
        event_id: event.id,
        project_id: event.workspace_id,
        project_slug: project.slug,
        created_at: event.created_at,
        source: event.source,
        session_name: typeof tmux?.session_name === "string" ? tmux.session_name : null,
        session_action: typeof tmux?.session_action === "string" ? tmux.session_action : null,
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
  const filtered = args.unrenamedOnly ? allRecords.filter((record) => record.unrenamed) : allRecords;
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
      [{ label: "start", command: `projects start ${args.project.slug}` }],
    ),
  };
}
