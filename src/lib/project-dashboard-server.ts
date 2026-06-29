import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildProjectDashboard,
  buildProjectDashboardRender,
  ensureProjectDashboardStructure,
  projectDashboardPaths,
  type BuildProjectDashboardSnapshotOptions,
} from "./project-dashboard.js";
import {
  buildProjectCanvasPayload,
  type ProjectsJsonRenderSpec,
} from "./project-render.js";
import { resolveRegisteredProjectTargetOrThrow } from "./project-resolver.js";
import {
  getProjectCanvas,
  listProjectCanvases,
  listProjectDataModels,
  updateProjectCanvasLayout,
  type ProjectCanvas,
  type ProjectCanvasNode,
} from "../db/project-store.js";
import type { JsonObject, Workspace } from "../types/workspace.js";

export interface ProjectDashboardServerOptions extends BuildProjectDashboardSnapshotOptions {
  target?: string;
  host?: string;
  port?: number;
  token?: string;
  trustNetwork?: boolean;
}

export interface ProjectDashboardServer {
  server: Bun.Server<undefined>;
  url: string;
  host: string;
  port: number;
  token: string;
}

interface DashboardCanvasSummary {
  id: string;
  slug: string;
  routeId: string;
  name: string;
  description: string | null;
  status: string;
  kind: "dashboard" | "project-canvas";
  href: string;
  active: boolean;
  nodes: number;
  edges: number;
}

interface DashboardCanvasContext {
  canvas: DashboardCanvasSummary;
  canvases: DashboardCanvasSummary[];
  render: ProjectsJsonRenderSpec;
}

interface DashboardLayoutState extends JsonObject {
  schema: "hasna.projects_dashboard_layout.v1";
  projectId: string;
  canvasRef: string;
  updatedAt: string;
  showConnections: boolean;
  viewport?: JsonObject;
  nodes: Array<{ id: string; position: { x: number; y: number } }>;
}

type DashboardRoute =
  | { kind: "redirect"; location: string }
  | { kind: "page"; canvasRef: string; canonicalPath: string }
  | { kind: "api"; canvasRef: string; api: string }
  | { kind: "not-found" };

export async function serveProjectDashboard(
  options: ProjectDashboardServerOptions,
): Promise<ProjectDashboardServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3344;
  const explicitToken =
    options.token ?? process.env["PROJECTS_DASHBOARD_TOKEN"];
  const loopback = isLoopbackDashboardHost(host);
  const trustNetwork = Boolean(options.trustNetwork);
  if (!loopback && !trustNetwork && !explicitToken) {
    throw new Error(
      "Serving a dashboard on a non-loopback host requires --token, PROJECTS_DASHBOARD_TOKEN, or --trust-network.",
    );
  }
  const token = explicitToken ?? randomBytes(24).toString("base64url");
  const selfIssueCookie = loopback || trustNetwork;
  const target = options.target ?? ".";
  const resolution = resolveRegisteredProjectTargetOrThrow(target, {
    db: options.db,
  });
  let dashboard = await buildProjectDashboard(target, options);
  const canonicalDashboardPath = dashboardCanvasPath(
    resolution.project.slug,
    "dashboard",
  );

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, project: resolution.project.slug });
      }

      const route = dashboardRoute(url.pathname, resolution.project.slug);
      if (route.kind === "redirect") {
        return Response.redirect(new URL(route.location, url).toString(), 302);
      }
      if (route.kind === "page" && url.pathname !== route.canonicalPath) {
        return Response.redirect(
          new URL(route.canonicalPath, url).toString(),
          302,
        );
      }
      if (route.kind === "page") {
        return new Response(
          projectDashboardHtml({
            projectSlug: resolution.project.slug,
            canvasRef: route.canvasRef,
            canonicalPath: route.canonicalPath,
          }),
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              ...(selfIssueCookie
                ? { "set-cookie": dashboardCookie(token) }
                : {}),
            },
          },
        );
      }
      if (route.kind !== "api")
        return new Response("not found", { status: 404 });

      if (route.api === "session" && request.method === "POST") {
        const submitted = await readSubmittedToken(request);
        if (!submitted || !tokensMatch(submitted, token)) {
          return Response.json(
            { ok: false, error: "invalid dashboard token" },
            { status: 401 },
          );
        }
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": dashboardCookie(token) } },
        );
      }
      if (!hasDashboardCookie(request, token)) {
        return Response.json(
          { ok: false, error: "dashboard token required" },
          { status: 401 },
        );
      }
      if (route.api === "snapshot") {
        if (url.searchParams.get("refresh") === "1")
          dashboard = await buildProjectDashboard(target, options);
        return Response.json(dashboard.snapshot);
      }
      if (route.api === "render") {
        const context = buildDashboardCanvasContext(
          resolution.project,
          route.canvasRef,
          dashboard.snapshot,
        );
        if (!context)
          return Response.json(
            { ok: false, error: `canvas not found: ${route.canvasRef}` },
            { status: 404 },
          );
        return Response.json(context.render);
      }
      if (route.api === "layout" && request.method === "PATCH") {
        const updated = await saveDashboardCanvasLayout(
          resolution.project,
          route.canvasRef,
          request,
        );
        if (!updated)
          return Response.json(
            { ok: false, error: `canvas not found: ${route.canvasRef}` },
            { status: 404 },
          );
        return Response.json(updated);
      }
      if (route.api === "canvases") {
        return Response.json({
          project: projectPayload(resolution.project),
          canvases: listDashboardCanvasSummaries(
            resolution.project,
            route.canvasRef,
          ),
        });
      }
      if (route.api === "bootstrap") {
        if (url.searchParams.get("refresh") === "1")
          dashboard = await buildProjectDashboard(target, options);
        const context = buildDashboardCanvasContext(
          resolution.project,
          route.canvasRef,
          dashboard.snapshot,
        );
        if (!context)
          return Response.json(
            { ok: false, error: `canvas not found: ${route.canvasRef}` },
            { status: 404 },
          );
        return Response.json({
          project: projectPayload(resolution.project),
          canvas: context.canvas,
          canvases: context.canvases,
          snapshot: dashboard.snapshot,
          render: context.render,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${server.port}${canonicalDashboardPath}`,
    host,
    port: server.port ?? port,
    token,
  };
}

function projectPayload(project: Workspace): Record<string, unknown> {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    kind: project.kind,
    status: project.status,
    primary_path: project.primary_path,
  };
}

function dashboardRoute(pathname: string, projectSlug: string): DashboardRoute {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length === 0)
    return {
      kind: "redirect",
      location: dashboardCanvasPath(projectSlug, "dashboard"),
    };
  if (segments.length === 1 && segments[0] === "dashboard")
    return {
      kind: "redirect",
      location: dashboardCanvasPath(projectSlug, "dashboard"),
    };
  if (segments[0] !== projectSlug) return { kind: "not-found" };
  if (segments.length === 1)
    return {
      kind: "redirect",
      location: dashboardCanvasPath(projectSlug, "dashboard"),
    };
  const canvasRef = segments[1] || "dashboard";
  if (segments.length === 2)
    return {
      kind: "page",
      canvasRef,
      canonicalPath: dashboardCanvasPath(projectSlug, canvasRef),
    };
  if (segments.length === 4 && segments[2] === "api")
    return { kind: "api", canvasRef, api: segments[3] };
  return { kind: "not-found" };
}

function dashboardCanvasPath(projectSlug: string, canvasRef: string): string {
  return `/${encodeURIComponent(projectSlug)}/${encodeURIComponent(canvasRef)}/`;
}

function buildDashboardCanvasContext(
  project: Workspace,
  canvasRef: string,
  snapshot: Awaited<ReturnType<typeof buildProjectDashboard>>["snapshot"],
): DashboardCanvasContext | null {
  if (isDashboardCanvasRef(canvasRef)) {
    const render = buildProjectDashboardRender(project, snapshot);
    applyDashboardLayout(project, "dashboard", render);
    return {
      canvas: virtualDashboardCanvasSummary(project, "dashboard", true, render),
      canvases: listDashboardCanvasSummaries(project, "dashboard"),
      render,
    };
  }
  const canvas = findProjectCanvas(project, canvasRef);
  if (!canvas) return null;
  const render = buildProjectCanvasPayload({
    project,
    canvas,
    dataModels: listProjectDataModels(project),
  }).render as ProjectsJsonRenderSpec;
  applyDashboardLayout(project, routeIdForCanvas(canvas), render, canvas);
  return {
    canvas: storedCanvasSummary(project, canvas, true),
    canvases: listDashboardCanvasSummaries(project, routeIdForCanvas(canvas)),
    render,
  };
}

function isDashboardCanvasRef(canvasRef: string): boolean {
  return canvasRef === "" || canvasRef === "dashboard";
}

function findProjectCanvas(
  project: Workspace,
  canvasRef: string,
): ProjectCanvas | null {
  const exact = getProjectCanvas(project, canvasRef);
  if (exact) return exact;
  return (
    listProjectCanvases(project).find(
      (canvas) =>
        routeIdForCanvas(canvas) === canvasRef ||
        shortCanvasId(canvas.id) === canvasRef,
    ) ?? null
  );
}

function listDashboardCanvasSummaries(
  project: Workspace,
  activeRef: string,
): DashboardCanvasSummary[] {
  const dashboard = virtualDashboardCanvasSummary(
    project,
    "dashboard",
    isDashboardCanvasRef(activeRef),
  );
  const stored = listProjectCanvases(project)
    .filter((canvas) => canvas.status === "active")
    .map((canvas) =>
      storedCanvasSummary(
        project,
        canvas,
        activeRef === routeIdForCanvas(canvas) ||
          activeRef === canvas.id ||
          activeRef === shortCanvasId(canvas.id),
      ),
    );
  return [dashboard, ...stored];
}

function virtualDashboardCanvasSummary(
  project: Workspace,
  routeId: string,
  active: boolean,
  render?: ProjectsJsonRenderSpec,
): DashboardCanvasSummary {
  const root = render?.elements?.[String(render.root)]?.props as
    | { nodes?: unknown[]; edges?: unknown[] }
    | undefined;
  return {
    id: `dashboard:${project.slug}`,
    slug: "dashboard",
    routeId,
    name: "Dashboard",
    description: "Provider-backed project dashboard canvas",
    status: "active",
    kind: "dashboard",
    href: dashboardCanvasPath(project.slug, routeId),
    active,
    nodes: Array.isArray(root?.nodes) ? root.nodes.length : 0,
    edges: Array.isArray(root?.edges) ? root.edges.length : 0,
  };
}

function storedCanvasSummary(
  project: Workspace,
  canvas: ProjectCanvas,
  active: boolean,
): DashboardCanvasSummary {
  const routeId = routeIdForCanvas(canvas);
  return {
    id: canvas.id,
    slug: canvas.slug,
    routeId,
    name: canvas.name,
    description: canvas.description,
    status: canvas.status,
    kind: "project-canvas",
    href: dashboardCanvasPath(project.slug, routeId),
    active,
    nodes: canvas.nodes.length,
    edges: canvas.edges.length,
  };
}

function routeIdForCanvas(canvas: ProjectCanvas): string {
  return canvas.slug || shortCanvasId(canvas.id);
}

function shortCanvasId(id: string): string {
  return id.startsWith("pcv_") ? id.slice(4, 12) : id.slice(0, 8);
}

function applyDashboardLayout(
  project: Workspace,
  canvasRef: string,
  render: ProjectsJsonRenderSpec,
  canvas?: ProjectCanvas,
): void {
  const root = canvasRootProps(render);
  if (!root) return;
  const layout = loadDashboardLayout(project, canvasRef);
  const showConnections =
    layout?.showConnections ??
    Boolean(
      (canvas?.data?.["ui"] as JsonObject | undefined)?.["show_connections"],
    );
  const rootData = isJsonObject(root.data) ? root.data : {};
  const originalEdges = Array.isArray(root.edges) && root.edges.length > 0
    ? root.edges
    : Array.isArray(rootData["availableEdges"])
      ? rootData["availableEdges"].filter(isJsonObject)
      : [];
  root.data = {
    ...rootData,
    availableEdges: originalEdges,
    layout: {
      saved: Boolean(layout),
      showConnections,
      viewport:
        layout?.viewport ?? (isJsonObject(root.viewport) ? root.viewport : {}),
      updatedAt: layout?.updatedAt ?? null,
    },
  };
  root.defaultShowConnections = false;
  root.ui_contract = {
    ...(isJsonObject(root.ui_contract) ? root.ui_contract : {}),
    connections_optional: true,
    connections_default_visible: false,
    persistent_node_positions: true,
    non_overlapping_nodes: true,
  };
  if (layout?.viewport) root.viewport = layout.viewport;
  root.nodes = normalizeCanvasNodes(
    applySavedNodePositions(root.nodes, layout),
  );
  root.edges = showConnections ? originalEdges : [];
}

function canvasRootProps(render: ProjectsJsonRenderSpec): JsonObject | null {
  const root = render.elements?.[String(render.root)];
  const props = root?.props;
  return isJsonObject(props) ? props : null;
}

function applySavedNodePositions(
  nodes: unknown,
  layout: DashboardLayoutState | null,
): JsonObject[] {
  const source = Array.isArray(nodes) ? nodes.filter(isJsonObject) : [];
  if (!layout) return source;
  const positions = new Map(
    layout.nodes.map((node) => [node.id, node.position]),
  );
  return source.map((node) => {
    const id = typeof node["id"] === "string" ? node["id"] : "";
    const position = positions.get(id);
    return position ? { ...node, position } : node;
  });
}

function normalizeCanvasNodes(nodes: JsonObject[]): JsonObject[] {
  const placed: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  return nodes.map((node, index) => {
    const size = estimatedNodeSize(node);
    const rawPosition = isJsonObject(node["position"]) ? node["position"] : {};
    const id = typeof node["id"] === "string" ? node["id"] : `node-${index}`;
    let x = numeric(rawPosition["x"], (index % 4) * 380);
    let y = numeric(rawPosition["y"], Math.floor(index / 4) * 240);
    let guard = 0;
    while (guard < 80) {
      const colliding = placed.find((other) =>
        boxesOverlap({ x, y, width: size.width, height: size.height }, other),
      );
      if (!colliding) break;
      y = colliding.y + colliding.height + 44;
      guard += 1;
    }
    placed.push({ id, x, y, width: size.width, height: size.height });
    return { ...node, position: { x, y } };
  });
}

function estimatedNodeSize(node: JsonObject): {
  width: number;
  height: number;
} {
  const type = typeof node["type"] === "string" ? node["type"] : "";
  const data = isJsonObject(node["data"]) ? node["data"] : {};
  const size = typeof data["size"] === "string" ? data["size"] : "";
  const metrics = Array.isArray(data["metrics"]) ? data["metrics"].length : 0;
  const items = Array.isArray(data["items"]) ? data["items"].length : 0;
  if (size === "4XL") return { width: 1180, height: 700 };
  if (size === "XXL") return { width: 980, height: 620 };
  if (size === "XL") return { width: 880, height: 480 };
  const width =
    type === "projectOverview" ? 340 : type === "projectPanel" ? 320 : 300;
  const height =
    type === "projectPanel"
      ? 112 + Math.ceil(Math.min(metrics, 6) / 2) * 43 + Math.min(items, 5) * 24
      : type === "projectOverview"
        ? 122
        : 112;
  return { width, height };
}

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const gap = 28;
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

function numeric(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

async function saveDashboardCanvasLayout(
  project: Workspace,
  canvasRef: string,
  request: Request,
): Promise<{
  ok: true;
  canvas: DashboardCanvasSummary;
  layout: DashboardLayoutState;
} | null> {
  const body = await readLayoutRequest(request);
  const normalizedNodes = normalizeCanvasNodes(body.nodes);
  const layout: DashboardLayoutState = {
    schema: "hasna.projects_dashboard_layout.v1",
    projectId: project.slug,
    canvasRef,
    updatedAt: new Date().toISOString(),
    showConnections: body.showConnections,
    viewport: body.viewport,
    nodes: normalizedNodes.map((node) => ({
      id: String(node["id"]),
      position: isJsonObject(node["position"])
        ? {
            x: numeric(node["position"]["x"], 0),
            y: numeric(node["position"]["y"], 0),
          }
        : { x: 0, y: 0 },
    })),
  };

  if (isDashboardCanvasRef(canvasRef)) {
    writeDashboardLayout(project, "dashboard", layout);
    return {
      ok: true,
      canvas: virtualDashboardCanvasSummary(project, "dashboard", true),
      layout,
    };
  }

  const canvas = findProjectCanvas(project, canvasRef);
  if (!canvas) return null;
  const positionById = new Map(
    layout.nodes.map((node) => [node.id, node.position]),
  );
  const nodes = normalizeCanvasNodes(
    canvas.nodes.map((node) => {
      const position = positionById.get(node.id) ?? node.position;
      return { ...node, position } as unknown as JsonObject;
    }),
  ) as unknown as ProjectCanvasNode[];
  const data = {
    ...canvas.data,
    ui: {
      ...(isJsonObject(canvas.data["ui"]) ? canvas.data["ui"] : {}),
      show_connections: body.showConnections,
    },
  };
  const updated = updateProjectCanvasLayout(project, canvas.id, {
    nodes,
    viewport: body.viewport,
    data,
  });
  writeDashboardLayout(project, routeIdForCanvas(updated), layout);
  return {
    ok: true,
    canvas: storedCanvasSummary(project, updated, true),
    layout,
  };
}

async function readLayoutRequest(request: Request): Promise<{
  nodes: JsonObject[];
  viewport: JsonObject;
  showConnections: boolean;
}> {
  const parsed = (await request.json()) as {
    nodes?: unknown;
    viewport?: unknown;
    showConnections?: unknown;
  };
  const nodes = Array.isArray(parsed.nodes)
    ? parsed.nodes.flatMap((item) => {
        if (
          !isJsonObject(item) ||
          typeof item["id"] !== "string" ||
          !isJsonObject(item["position"])
        )
          return [];
        return [
          {
            id: item["id"],
            type: typeof item["type"] === "string" ? item["type"] : undefined,
            position: {
              x: numeric(item["position"]["x"], 0),
              y: numeric(item["position"]["y"], 0),
            },
            data: isJsonObject(item["data"])
              ? {
                  size:
                    typeof item["data"]["size"] === "string"
                      ? item["data"]["size"]
                      : undefined,
                }
              : {},
          },
        ];
      })
    : [];
  return {
    nodes,
    viewport: isJsonObject(parsed.viewport) ? parsed.viewport : {},
    showConnections: parsed.showConnections === true,
  };
}

function loadDashboardLayout(
  project: Workspace,
  canvasRef: string,
): DashboardLayoutState | null {
  const path = dashboardLayoutPath(project, canvasRef, false);
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as Partial<DashboardLayoutState>;
    if (
      parsed.schema !== "hasna.projects_dashboard_layout.v1" ||
      !Array.isArray(parsed.nodes)
    )
      return null;
    return {
      schema: "hasna.projects_dashboard_layout.v1",
      projectId:
        typeof parsed.projectId === "string" ? parsed.projectId : project.slug,
      canvasRef:
        typeof parsed.canvasRef === "string" ? parsed.canvasRef : canvasRef,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      showConnections: parsed.showConnections === true,
      viewport: isJsonObject(parsed.viewport) ? parsed.viewport : {},
      nodes: parsed.nodes.flatMap((node) => {
        if (!node || typeof node.id !== "string") return [];
        return [
          {
            id: node.id,
            position: {
              x: numeric(node.position?.x, 0),
              y: numeric(node.position?.y, 0),
            },
          },
        ];
      }),
    };
  } catch {
    return null;
  }
}

function writeDashboardLayout(
  project: Workspace,
  canvasRef: string,
  layout: DashboardLayoutState,
): void {
  const path = dashboardLayoutPath(project, canvasRef, true);
  if (!path)
    throw new Error(`Unable to resolve dashboard layout path for ${canvasRef}`);
  writeFileSync(path, `${JSON.stringify(layout, null, 2)}\n`);
}

function dashboardLayoutPath(
  project: Workspace,
  canvasRef: string,
  create: boolean,
): string | null {
  const paths = create
    ? ensureProjectDashboardStructure(project)
    : projectDashboardPaths(project);
  const dir = join(paths.renderDir, "layouts");
  if (create) mkdirSync(dir, { recursive: true });
  return join(dir, `${safeLayoutName(canvasRef)}.layout.json`);
}

function safeLayoutName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "dashboard";
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dashboardCookie(token: string): string {
  return `projects_dashboard=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`;
}

function hasDashboardCookie(request: Request, token: string): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `projects_dashboard=${encodeURIComponent(token)}`);
}

export function isLoopbackDashboardHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

async function readSubmittedToken(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const parsed = (await request.json()) as { token?: unknown };
      return typeof parsed.token === "string" ? parsed.token : null;
    }
    const form = await request.formData();
    const token = form.get("token");
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

function tokensMatch(submitted: string, expected: string): boolean {
  const left = Buffer.from(submitted);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function projectDashboardHtml(args: {
  projectSlug: string;
  canvasRef?: string;
  canonicalPath?: string;
}): string {
  const bootstrap = JSON.stringify({
    projectSlug: args.projectSlug,
    canvasRef: args.canvasRef ?? "dashboard",
    canonicalPath:
      args.canonicalPath ??
      dashboardCanvasPath(args.projectSlug, args.canvasRef ?? "dashboard"),
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Projects Dashboard - ${escapeHtml(args.projectSlug)} / ${escapeHtml(args.canvasRef ?? "dashboard")}</title>
    <link rel="stylesheet" href="https://esm.sh/@xyflow/react@12.8.2/dist/style.css" />
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fb;
        --ink: #15202b;
        --muted: #657386;
        --line: #d9e0ea;
        --panel: #ffffff;
        --good: #147d52;
        --warn: #a15c00;
        --bad: #b42318;
        --info: #1f5eff;
      }
      * { box-sizing: border-box; }
      html, body, #root { height: 100%; margin: 0; }
      body {
        background: var(--bg);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }
      button, input { font: inherit; letter-spacing: 0; }
      .shell { height: 100%; display: grid; grid-template-rows: 56px 1fr; }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 0 18px;
        border-bottom: 1px solid var(--line);
        background: #ffffff;
      }
      .brand { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
      .brand h1 { margin: 0; font-size: 16px; line-height: 1.2; font-weight: 700; white-space: nowrap; }
      .brand span { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .toolbar { display: flex; gap: 8px; align-items: center; min-width: 0; }
      .canvas-select {
        max-width: min(280px, 32vw);
        height: 36px;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--ink);
        border-radius: 8px;
        padding: 0 10px;
      }
      .toggle {
        height: 36px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--line);
        background: #fff;
        border-radius: 8px;
        padding: 0 10px;
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .toggle input { width: 16px; height: 16px; margin: 0; }
      .save-state { color: var(--muted); font-size: 12px; min-width: 44px; text-align: right; }
      .icon-button {
        width: 36px;
        height: 36px;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--ink);
        border-radius: 8px;
        display: inline-grid;
        place-items: center;
        cursor: pointer;
      }
      .workspace { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 340px; }
      .flow { min-width: 0; min-height: 0; }
      .side {
        min-width: 0;
        overflow: auto;
        border-left: 1px solid var(--line);
        background: #fff;
        padding: 16px;
      }
      .side h2 { margin: 0 0 4px; font-size: 15px; }
      .side p { margin: 0 0 14px; color: var(--muted); font-size: 13px; line-height: 1.45; }
      .source-panel {
        display: grid;
        gap: 8px;
        padding-bottom: 16px;
        margin-bottom: 16px;
        border-bottom: 1px solid var(--line);
      }
      .source-list { display: grid; gap: 6px; }
      .source-item {
        width: 100%;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--ink);
        border-radius: 8px;
        padding: 9px 10px;
        text-align: left;
        cursor: pointer;
        display: grid;
        gap: 3px;
      }
      .source-item:hover { background: #f7f8fb; }
      .source-item span { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
      .source-item small { color: var(--muted); font-size: 11px; line-height: 1.3; overflow-wrap: anywhere; }
      .selection-panel { display: grid; gap: 8px; }
      .node {
        width: 320px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: 0 8px 20px rgba(21, 32, 43, 0.08);
        overflow: hidden;
      }
      .node-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 8px; }
      .node-title { margin: 0; font-size: 14px; line-height: 1.25; font-weight: 700; overflow-wrap: anywhere; }
      .badge { border-radius: 999px; padding: 3px 8px; font-size: 11px; line-height: 1.2; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
      .badge.ready, .badge.good { color: var(--good); border-color: rgba(20, 125, 82, .32); background: rgba(20, 125, 82, .08); }
      .badge.error, .badge.critical { color: var(--bad); border-color: rgba(180, 35, 24, .32); background: rgba(180, 35, 24, .08); }
      .badge.warning, .badge.stale, .badge.unavailable { color: var(--warn); border-color: rgba(161, 92, 0, .32); background: rgba(161, 92, 0, .08); }
      .node-summary { margin: 0; padding: 0 12px 10px; color: var(--muted); font-size: 12px; line-height: 1.4; max-height: 52px; overflow: hidden; }
      .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 0 12px 12px; }
      .metric { border: 1px solid #edf0f5; border-radius: 6px; padding: 7px; min-width: 0; }
      .metric strong { display: block; font-size: 13px; line-height: 1.2; overflow-wrap: anywhere; }
      .metric span { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; overflow-wrap: anywhere; }
      .items { border-top: 1px solid #edf0f5; padding: 8px 12px 12px; display: grid; gap: 6px; }
      .item { font-size: 12px; color: var(--ink); line-height: 1.35; overflow-wrap: anywhere; }
      .side-item {
        width: 100%;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--ink);
        border-radius: 8px;
        padding: 9px 10px;
        text-align: left;
        cursor: pointer;
      }
      .side-item:hover { background: #f7f8fb; }
      .overview-node { width: 340px; border-color: #cbd8ff; }
      .generic-node { width: 300px; }
      .overview-path { color: var(--muted); font-size: 11px; padding: 0 12px 12px; overflow-wrap: anywhere; }
      .empty-state { padding: 16px; color: var(--muted); }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 80;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(21, 32, 43, .42);
      }
      .modal {
        width: min(920px, calc(100vw - 32px));
        max-height: min(760px, calc(100vh - 48px));
        overflow: hidden;
        border-radius: 8px;
        border: 1px solid var(--line);
        background: #fff;
        box-shadow: 0 24px 80px rgba(21, 32, 43, .24);
      }
      .modal-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--line);
      }
      .modal-head h2 { margin: 0; font-size: 16px; line-height: 1.25; }
      .modal-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 1.4; }
      .modal-body { max-height: 620px; overflow: auto; padding: 16px 18px; }
      .preview-frame { width: 100%; height: min(560px, 58vh); border: 1px solid var(--line); border-radius: 8px; background: #fff; }
      .preview-media { display: block; max-width: 100%; max-height: min(560px, 58vh); margin: 0 auto; }
      .preview-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      .meta-grid { display: grid; gap: 8px; }
      .meta-row { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 10px; font-size: 13px; }
      .meta-row span:first-child { color: var(--muted); }
      .react-flow__node { cursor: grab; }
      .react-flow__node.dragging { cursor: grabbing; }
      .react-flow__attribution { display: none; }
      @media (max-width: 900px) {
        .workspace { grid-template-columns: 1fr; grid-template-rows: minmax(420px, 1fr) 260px; }
        .side { border-left: 0; border-top: 1px solid var(--line); }
        .brand span { display: none; }
      }
    </style>
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@18.3.1",
          "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
          "react-dom": "https://esm.sh/react-dom@18.3.1?external=react",
          "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
          "@xyflow/react": "https://esm.sh/@xyflow/react@12.8.2?external=react,react-dom"
        }
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React, { useCallback, useEffect, useMemo, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges } from "@xyflow/react";
      window.__PROJECTS_DASHBOARD__ = ${bootstrap};

      const h = React.createElement;
      const tone = (value) => String(value || "unknown").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
      const text = (value, fallback = "") => typeof value === "string" ? value : fallback;
      const safePreviewSrc = (value) => {
        const src = text(value).trim();
        if (!src) return "";
        if (src.startsWith("/") && !src.startsWith("//")) return src;
        if (src.startsWith("blob:")) return src;
        return "";
      };
      const boundedText = (value) => {
        const input = text(value);
        return input.length > 20000 ? input.slice(0, 20000) + "\\n\\n[Preview truncated]" : input;
      };
      const nodeSizeStyle = (size) => {
        if (size === "4XL") return { width: 960, minHeight: 560 };
        if (size === "XXL") return { width: 820, minHeight: 500 };
        if (size === "XL") return { width: 680, minHeight: 400 };
        return {};
      };
      const previewKind = (preview) => {
        const viewer = text(preview?.viewer || preview?.metadata?.viewer, "auto");
        const mime = text(preview?.mime || preview?.metadata?.mime).toLowerCase();
        const src = text(preview?.src || preview?.metadata?.src).toLowerCase();
        if (viewer && viewer !== "auto") return viewer;
        if (mime.includes("pdf") || src.endsWith(".pdf")) return "pdf";
        if (mime.startsWith("image/")) return "image";
        if (mime.startsWith("video/")) return "video";
        if (mime.startsWith("audio/")) return "audio";
        if (mime.includes("markdown") || src.endsWith(".md")) return "markdown";
        if (mime.startsWith("text/")) return "text";
        return "metadata";
      };
      const previewFromItem = (item) => {
        const metadata = item?.metadata || {};
        const refs = Array.isArray(item?.resourceRefs) ? item.resourceRefs : [];
        const evidence = Array.isArray(item?.evidenceRefs) ? item.evidenceRefs : [];
        const firstRef = refs[0] || {};
        return {
          title: item?.title || firstRef.name || item?.id || "Preview",
          summary: item?.summary || evidence[0]?.summary || "",
          status: item?.status || item?.priority || "",
          kind: firstRef.kind || evidence[0]?.kind || "metadata",
          id: item?.id || firstRef.id || "",
          refs,
          evidence,
          metadata,
          viewer: metadata.viewer || "auto",
          src: safePreviewSrc(metadata.src || metadata.previewUrl || ""),
          mime: metadata.mime || "",
          previewText: metadata.previewText || item?.summary || evidence[0]?.summary || "",
        };
      };

      function ProjectNode({ data }) {
        const metrics = data.metrics || [];
        const items = data.items || [];
        const handles = data.showConnections === true;
        return h("div", { className: "node", style: nodeSizeStyle(data.size) }, [
          handles ? h(Handle, { key: "target", type: "target", position: Position.Left }) : null,
          h("div", { key: "head", className: "node-header" }, [
            h("h3", { key: "title", className: "node-title" }, data.title),
            h("span", { key: "state", className: "badge " + tone(data.state) }, data.state || data.provider),
          ]),
          h("p", { key: "summary", className: "node-summary" }, data.summary || data.kind || ""),
          metrics.length ? h("div", { key: "metrics", className: "metrics" }, metrics.map((metric) =>
            h("div", { key: metric.id, className: "metric" }, [
              h("strong", { key: "value" }, String(metric.value)),
              h("span", { key: "label" }, metric.label),
            ])
          )) : null,
          items.length ? h("div", { key: "items", className: "items" }, items.map((item) =>
            h("div", { key: item.id, className: "item" }, item.title)
          )) : null,
          handles ? h(Handle, { key: "source", type: "source", position: Position.Right }) : null,
        ]);
      }

      function OverviewNode({ data }) {
        const handles = data.showConnections === true;
        return h("div", { className: "node overview-node", style: nodeSizeStyle(data.size) }, [
          h("div", { key: "head", className: "node-header" }, [
            h("h3", { key: "title", className: "node-title" }, data.title),
            h("span", { key: "state", className: "badge good" }, data.status),
          ]),
          h("p", { key: "summary", className: "node-summary" }, data.subtitle),
          h("div", { key: "path", className: "overview-path" }, data.path || "No primary path"),
          handles ? h(Handle, { key: "source", type: "source", position: Position.Right }) : null,
        ]);
      }

      function GenericNode({ id, data, type }) {
        const title = data.title || data.name || data.label || id;
        const summary = data.description || data.summary || data.kind || type || "";
        const handles = data.showConnections === true;
        return h("div", { className: "node generic-node", style: nodeSizeStyle(data.size) }, [
          handles ? h(Handle, { key: "target", type: "target", position: Position.Left }) : null,
          h("div", { key: "head", className: "node-header" }, [
            h("h3", { key: "title", className: "node-title" }, String(title)),
            h("span", { key: "state", className: "badge" }, String(data.status || type || "node")),
          ]),
          h("p", { key: "summary", className: "node-summary" }, String(summary)),
          handles ? h(Handle, { key: "source", type: "source", position: Position.Right }) : null,
        ]);
      }

      function apiPath(name, refresh = false) {
        return "api/" + name + (refresh ? "?refresh=1" : "");
      }

      function renderCanvas(render) {
        const rootId = render?.root || "root";
        return render?.elements?.[rootId]?.props || {};
      }

      function renderSourcePanel(render, onSelectSource) {
        const sourceProps = render?.elements?.source_panel?.props;
        const sources = Array.isArray(sourceProps?.sources) ? sourceProps.sources : [];
        if (!sources.length) return null;
        return h("section", { className: "source-panel" }, [
          h("h2", { key: "title" }, sourceProps.title || "Project Sources"),
          sourceProps.emptyText && !sources.length ? h("p", { key: "empty" }, sourceProps.emptyText) : null,
          h("div", { key: "sources", className: "source-list" }, sources.slice(0, 14).map((source) =>
            h("button", {
              key: source.id,
              className: "source-item",
              title: source.description || source.label,
              onClick: () => onSelectSource(source.id),
            }, [
              h("span", { key: "label" }, source.label || source.id),
              h("small", { key: "meta" }, [source.kind, source.status, Number.isFinite(source.count) ? source.count + " items" : null].filter(Boolean).join(" · ")),
            ])
          )),
        ]);
      }

      function selectedFromNode(snapshot, node) {
        const panel = snapshot?.panels?.find((item) => item.id === node.id);
        if (panel) return panel;
        return {
          id: node.id,
          title: node.data?.title || node.data?.name || node.data?.label || node.id,
          summary: node.data?.description || node.data?.summary || node.type || "",
          state: node.data?.status || "ready",
          kind: node.type || "node",
          warnings: node.data?.warnings || [],
          items: [],
        };
      }

      function PreviewModal({ preview, onClose }) {
        if (!preview) return null;
        const kind = previewKind(preview);
        const src = safePreviewSrc(preview.src);
        const rows = [
          ["Type", preview.kind || kind],
          ["Status", preview.status || "unknown"],
          ["ID", preview.id || ""],
          ["References", String((preview.refs || []).length)],
          ["Evidence", String((preview.evidence || []).length)],
        ];
        const body = kind === "image" && src
          ? h("img", { className: "preview-media", src, alt: preview.title })
          : kind === "video" && src
            ? h("video", { className: "preview-media", src, controls: true })
            : kind === "audio" && src
              ? h("audio", { className: "preview-media", src, controls: true })
              : kind === "pdf" && src
                ? h("iframe", { className: "preview-frame", src, title: preview.title, sandbox: "" })
                : (kind === "text" || kind === "markdown") && preview.previewText
                  ? h("pre", { className: "preview-text" }, boundedText(preview.previewText))
                  : h("div", { className: "meta-grid" }, rows.filter((row) => row[1]).map((row) =>
                      h("div", { key: row[0], className: "meta-row" }, [
                        h("span", { key: "label" }, row[0]),
                        h("span", { key: "value" }, row[1]),
                      ])
                    ));
        return h("div", { className: "modal-backdrop", role: "dialog", "aria-modal": "true", onClick: onClose }, [
          h("div", { key: "modal", className: "modal", onClick: (event) => event.stopPropagation() }, [
            h("div", { key: "head", className: "modal-head" }, [
              h("div", { key: "title" }, [
                h("h2", { key: "h" }, preview.title),
                preview.summary ? h("p", { key: "p" }, preview.summary) : null,
              ]),
              h("button", { key: "close", className: "icon-button", title: "Close", onClick: onClose }, "X"),
            ]),
            h("div", { key: "body", className: "modal-body" }, body),
          ]),
        ]);
      }

      function mergeSavedPositions(nodes, layout) {
        const positions = new Map((layout?.nodes || []).map((item) => [item.id, item.position]));
        return (nodes || []).map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id) } : node);
      }

      function validViewport(value) {
        return value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.zoom);
      }

      function App() {
        const [snapshot, setSnapshot] = useState(null);
        const [render, setRender] = useState(null);
        const [canvasMeta, setCanvasMeta] = useState(null);
        const [canvases, setCanvases] = useState([]);
        const [flowNodes, setFlowNodes] = useState([]);
        const [showConnections, setShowConnections] = useState(false);
        const [selected, setSelected] = useState(null);
        const [preview, setPreview] = useState(null);
        const [error, setError] = useState("");
        const [needsToken, setNeedsToken] = useState(false);
        const [token, setToken] = useState("");
        const [saveState, setSaveState] = useState("");
        const [flowViewport, setFlowViewport] = useState(null);
        const load = useCallback(async (refresh = false) => {
          setError("");
          setNeedsToken(false);
          const res = await fetch(apiPath("bootstrap", refresh), { credentials: "same-origin" });
          if (res.status === 401) {
            setNeedsToken(true);
            throw new Error("Dashboard access token required");
          }
          if (!res.ok) throw new Error("Dashboard bootstrap failed " + res.status);
          const next = await res.json();
          setSnapshot(next.snapshot);
          setRender(next.render);
          setCanvasMeta(next.canvas);
          setCanvases(next.canvases || []);
          const nextCanvas = renderCanvas(next.render);
          const layout = nextCanvas.data?.layout || {};
          setFlowNodes(nextCanvas.nodes || []);
          setShowConnections(layout.showConnections === true);
          setFlowViewport(validViewport(nextCanvas.viewport) ? nextCanvas.viewport : null);
          const firstNode = (nextCanvas.nodes || [])[0] || { id: "canvas", data: next.canvas || {}, type: "canvas" };
          setSelected(next.canvas?.kind === "dashboard" && next.snapshot?.panels?.[0] ? next.snapshot.panels[0] : selectedFromNode(next.snapshot, firstNode));
        }, []);
        const unlock = useCallback(async (event) => {
          event.preventDefault();
          setError("");
          const res = await fetch(apiPath("session"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ token }),
          });
          if (!res.ok) {
            setError("Dashboard access token was rejected");
            setNeedsToken(true);
            return;
          }
          setToken("");
          await load(true);
        }, [load, token]);
        useEffect(() => { load().catch((err) => setError(err.message)); }, [load]);
        const canvas = renderCanvas(render);
        const availableEdges = canvas.data?.availableEdges || canvas.edges || [];
        const edges = showConnections ? availableEdges : [];
        const renderedNodes = useMemo(() => flowNodes.map((node) => ({
          ...node,
          data: { ...(node.data || {}), showConnections },
        })), [flowNodes, showConnections]);
        const saveLayout = useCallback(async (nextNodes, nextShowConnections = showConnections, nextViewport = flowViewport) => {
          if (!canvasMeta) return;
          setSaveState("Saving");
          const res = await fetch(apiPath("layout"), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              showConnections: nextShowConnections,
              viewport: validViewport(nextViewport) ? nextViewport : {},
              nodes: (nextNodes || []).map((node) => ({
                id: node.id,
                type: node.type,
                position: node.position,
                data: { size: node.data?.size || null },
              })),
            }),
          });
          if (!res.ok) throw new Error("Layout save failed " + res.status);
          const saved = await res.json();
          setSaveState("Saved");
          setTimeout(() => setSaveState(""), 1600);
          return saved.layout;
        }, [canvasMeta, flowViewport, showConnections]);
        const onNodesChange = useCallback((changes) => {
          setFlowNodes((current) => applyNodeChanges(changes, current));
        }, []);
        const onNodeDragStop = useCallback((_, node) => {
          setFlowNodes((current) => {
            const next = current.map((item) => item.id === node.id ? { ...item, position: node.position } : item);
            saveLayout(next).then((layout) => {
              setFlowNodes((latest) => mergeSavedPositions(latest, layout));
            }).catch((err) => {
              setSaveState("Error");
              setError(err.message);
            });
            return next;
          });
        }, [saveLayout]);
        const onConnectionsChange = useCallback((event) => {
          const next = event.target.checked;
          setShowConnections(next);
          saveLayout(flowNodes, next).then((layout) => {
            setFlowNodes((latest) => mergeSavedPositions(latest, layout));
          }).catch((err) => {
            setSaveState("Error");
            setError(err.message);
          });
        }, [flowNodes, saveLayout]);
        const onMoveEnd = useCallback((_, nextViewport) => {
          if (!validViewport(nextViewport)) return;
          setFlowViewport(nextViewport);
          saveLayout(flowNodes, showConnections, nextViewport).catch((err) => {
            setSaveState("Error");
            setError(err.message);
          });
        }, [flowNodes, saveLayout, showConnections]);
        const nodeTypes = useMemo(() => {
          const types = { projectPanel: ProjectNode, projectOverview: OverviewNode };
          for (const node of flowNodes) {
            if (node?.type && !types[node.type]) types[node.type] = GenericNode;
          }
          return types;
        }, [flowNodes]);
        const onNodeClick = useCallback((_, node) => {
          setSelected(selectedFromNode(snapshot, node));
        }, [snapshot]);
        const onSelectSource = useCallback((sourceId) => {
          const panel = snapshot?.panels?.find((item) => item.id === sourceId);
          if (panel) {
            setSelected(panel);
            return;
          }
          const node = flowNodes.find((item) => item.id === sourceId);
          if (node) setSelected(selectedFromNode(snapshot, node));
        }, [flowNodes, snapshot]);
        return h("div", { className: "shell" }, [
          h("header", { key: "top", className: "topbar" }, [
            h("div", { key: "brand", className: "brand" }, [
              h("h1", { key: "title" }, snapshot?.projectId || window.__PROJECTS_DASHBOARD__.projectSlug),
              h("span", { key: "subtitle" }, canvasMeta ? canvasMeta.name : "Loading dashboard"),
            ]),
            h("div", { key: "tools", className: "toolbar" }, [
              canvases.length ? h("select", {
                key: "canvas",
                className: "canvas-select",
                value: canvasMeta?.routeId || window.__PROJECTS_DASHBOARD__.canvasRef,
                title: "Canvas",
                onChange: (event) => {
                  const next = canvases.find((item) => item.routeId === event.target.value);
                  if (next?.href) window.location.href = next.href;
                },
              }, canvases.map((item) => h("option", { key: item.routeId, value: item.routeId }, item.name))) : null,
              h("label", { key: "connections", className: "toggle", title: "Show connection lines" }, [
                h("input", { key: "input", type: "checkbox", checked: showConnections, onChange: onConnectionsChange }),
                h("span", { key: "text" }, "Connections"),
              ]),
              h("span", { key: "save", className: "save-state" }, saveState),
              h("button", { key: "refresh", className: "icon-button", title: "Refresh", onClick: () => load(true).catch((err) => setError(err.message)) }, "R"),
            ]),
          ]),
          h("main", { key: "main", className: "workspace" }, [
            h("section", { key: "flow", className: "flow" },
              needsToken ? h("form", { className: "empty-state", onSubmit: unlock }, [
                h("label", { key: "label", style: { display: "grid", gap: "8px", maxWidth: "360px" } }, [
                  h("span", { key: "text" }, "Dashboard access token"),
                  h("input", { key: "input", type: "password", value: token, onChange: (event) => setToken(event.target.value), autoFocus: true }),
                ]),
                h("button", { key: "submit", className: "icon-button", title: "Unlock", style: { marginTop: "12px", width: "auto", padding: "0 12px" } }, "Unlock"),
              ]) :
              error ? h("div", { className: "empty-state" }, error) :
              h(ReactFlow, {
                key: canvasMeta?.routeId || "loading",
                nodes: renderedNodes,
                edges,
                nodeTypes,
                defaultViewport: flowViewport || undefined,
                fitView: !flowViewport,
                nodesDraggable: true,
                nodesConnectable: showConnections,
                proOptions: { hideAttribution: true },
                onNodeClick,
                onNodesChange,
                onNodeDragStop,
                onMoveEnd,
              }, [
                h(Background, { key: "bg", gap: 18, size: 1 }),
                h(Controls, { key: "controls" }),
              ])
            ),
            h("aside", { key: "side", className: "side" }, [
              renderSourcePanel(render, onSelectSource),
              h("section", { key: "selected", className: "selection-panel" }, selected ? [
                h("h2", { key: "title" }, selected.title),
                h("p", { key: "summary" }, selected.summary || selected.stateReason || selected.state),
                h("div", { key: "badge", className: "badge " + tone(selected.state) }, selected.provider?.kind || selected.kind),
                ...(selected.warnings || []).map((warning, index) => h("p", { key: "warning-" + index }, warning)),
                ...(selected.items || []).slice(0, 8).map((item) =>
                  h("button", {
                    key: item.id,
                    className: "side-item",
                    title: "Open item preview",
                    onClick: () => setPreview(previewFromItem(item)),
                  }, item.title + (item.status ? " - " + item.status : ""))
                ),
              ] : h("div", { className: "empty-state" }, "Select a dashboard node")),
            ]),
          ]),
          h(PreviewModal, { key: "preview", preview, onClose: () => setPreview(null) }),
        ]);
      }

      createRoot(document.getElementById("root")).render(h(App));
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] ?? char,
  );
}
