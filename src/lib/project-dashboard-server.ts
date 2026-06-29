import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  buildProjectDashboard,
  buildProjectDashboardRender,
  type BuildProjectDashboardSnapshotOptions,
} from "./project-dashboard.js";
import { buildProjectCanvasPayload, type ProjectsJsonRenderSpec } from "./project-render.js";
import { resolveRegisteredProjectTargetOrThrow } from "./project-resolver.js";
import {
  getProjectCanvas,
  listProjectCanvases,
  listProjectDataModels,
  type ProjectCanvas,
} from "../db/project-store.js";
import type { Workspace } from "../types/workspace.js";

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

type DashboardRoute =
  | { kind: "redirect"; location: string }
  | { kind: "page"; canvasRef: string; canonicalPath: string }
  | { kind: "api"; canvasRef: string; api: string }
  | { kind: "not-found" };

export async function serveProjectDashboard(options: ProjectDashboardServerOptions): Promise<ProjectDashboardServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3344;
  const explicitToken = options.token ?? process.env["PROJECTS_DASHBOARD_TOKEN"];
  const loopback = isLoopbackDashboardHost(host);
  const trustNetwork = Boolean(options.trustNetwork);
  if (!loopback && !trustNetwork && !explicitToken) {
    throw new Error("Serving a dashboard on a non-loopback host requires --token, PROJECTS_DASHBOARD_TOKEN, or --trust-network.");
  }
  const token = explicitToken ?? randomBytes(24).toString("base64url");
  const selfIssueCookie = loopback || trustNetwork;
  const target = options.target ?? ".";
  const resolution = resolveRegisteredProjectTargetOrThrow(target, { db: options.db });
  let dashboard = await buildProjectDashboard(target, options);
  const canonicalDashboardPath = dashboardCanvasPath(resolution.project.slug, "dashboard");

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
        return Response.redirect(new URL(route.canonicalPath, url).toString(), 302);
      }
      if (route.kind === "page") {
        return new Response(projectDashboardHtml({
          projectSlug: resolution.project.slug,
          canvasRef: route.canvasRef,
          canonicalPath: route.canonicalPath,
        }), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...(selfIssueCookie ? { "set-cookie": dashboardCookie(token) } : {}),
          },
        });
      }
      if (route.kind !== "api") return new Response("not found", { status: 404 });

      if (route.api === "session" && request.method === "POST") {
        const submitted = await readSubmittedToken(request);
        if (!submitted || !tokensMatch(submitted, token)) {
          return Response.json({ ok: false, error: "invalid dashboard token" }, { status: 401 });
        }
        return Response.json({ ok: true }, { headers: { "set-cookie": dashboardCookie(token) } });
      }
      if (!hasDashboardCookie(request, token)) {
        return Response.json({ ok: false, error: "dashboard token required" }, { status: 401 });
      }
      if (route.api === "snapshot") {
        if (url.searchParams.get("refresh") === "1") dashboard = await buildProjectDashboard(target, options);
        return Response.json(dashboard.snapshot);
      }
      if (route.api === "render") {
        const context = buildDashboardCanvasContext(resolution.project, route.canvasRef, dashboard.snapshot);
        if (!context) return Response.json({ ok: false, error: `canvas not found: ${route.canvasRef}` }, { status: 404 });
        return Response.json(context.render);
      }
      if (route.api === "canvases") {
        return Response.json({
          project: projectPayload(resolution.project),
          canvases: listDashboardCanvasSummaries(resolution.project, route.canvasRef),
        });
      }
      if (route.api === "bootstrap") {
        if (url.searchParams.get("refresh") === "1") dashboard = await buildProjectDashboard(target, options);
        const context = buildDashboardCanvasContext(resolution.project, route.canvasRef, dashboard.snapshot);
        if (!context) return Response.json({ ok: false, error: `canvas not found: ${route.canvasRef}` }, { status: 404 });
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
  const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments.length === 0) return { kind: "redirect", location: dashboardCanvasPath(projectSlug, "dashboard") };
  if (segments.length === 1 && segments[0] === "dashboard") return { kind: "redirect", location: dashboardCanvasPath(projectSlug, "dashboard") };
  if (segments[0] === "api") return { kind: "api", canvasRef: "dashboard", api: segments[1] ?? "" };
  if (segments[0] !== projectSlug) return { kind: "not-found" };
  if (segments.length === 1) return { kind: "redirect", location: dashboardCanvasPath(projectSlug, "dashboard") };
  const canvasRef = segments[1] || "dashboard";
  if (segments.length === 2) return { kind: "page", canvasRef, canonicalPath: dashboardCanvasPath(projectSlug, canvasRef) };
  if (segments.length === 4 && segments[2] === "api") return { kind: "api", canvasRef, api: segments[3] };
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
  return {
    canvas: storedCanvasSummary(project, canvas, true),
    canvases: listDashboardCanvasSummaries(project, routeIdForCanvas(canvas)),
    render,
  };
}

function isDashboardCanvasRef(canvasRef: string): boolean {
  return canvasRef === "" || canvasRef === "dashboard";
}

function findProjectCanvas(project: Workspace, canvasRef: string): ProjectCanvas | null {
  const exact = getProjectCanvas(project, canvasRef);
  if (exact) return exact;
  return listProjectCanvases(project).find((canvas) => routeIdForCanvas(canvas) === canvasRef || shortCanvasId(canvas.id) === canvasRef) ?? null;
}

function listDashboardCanvasSummaries(project: Workspace, activeRef: string): DashboardCanvasSummary[] {
  const dashboard = virtualDashboardCanvasSummary(project, "dashboard", isDashboardCanvasRef(activeRef));
  const stored = listProjectCanvases(project)
    .filter((canvas) => canvas.status === "active")
    .map((canvas) => storedCanvasSummary(project, canvas, activeRef === routeIdForCanvas(canvas) || activeRef === canvas.id || activeRef === shortCanvasId(canvas.id)));
  return [dashboard, ...stored];
}

function virtualDashboardCanvasSummary(project: Workspace, routeId: string, active: boolean, render?: ProjectsJsonRenderSpec): DashboardCanvasSummary {
  const root = render?.elements?.[String(render.root)]?.props as { nodes?: unknown[]; edges?: unknown[] } | undefined;
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

function storedCanvasSummary(project: Workspace, canvas: ProjectCanvas, active: boolean): DashboardCanvasSummary {
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

function dashboardCookie(token: string): string {
  return `projects_dashboard=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/`;
}

function hasDashboardCookie(request: Request, token: string): boolean {
  const cookie = request.headers.get("cookie") ?? "";
  return cookie.split(";").map((part) => part.trim()).some((part) => part === `projects_dashboard=${encodeURIComponent(token)}`);
}

export function isLoopbackDashboardHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

async function readSubmittedToken(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const parsed = await request.json() as { token?: unknown };
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

export function projectDashboardHtml(args: { projectSlug: string; canvasRef?: string; canonicalPath?: string }): string {
  const bootstrap = JSON.stringify({
    projectSlug: args.projectSlug,
    canvasRef: args.canvasRef ?? "dashboard",
    canonicalPath: args.canonicalPath ?? dashboardCanvasPath(args.projectSlug, args.canvasRef ?? "dashboard"),
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
      .overview-node { width: 340px; border-color: #cbd8ff; }
      .generic-node { width: 300px; }
      .overview-path { color: var(--muted); font-size: 11px; padding: 0 12px 12px; overflow-wrap: anywhere; }
      .empty-state { padding: 16px; color: var(--muted); }
      .react-flow__node { cursor: default; }
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
      import { ReactFlow, Background, Controls, MiniMap, Handle, Position } from "@xyflow/react";
      window.__PROJECTS_DASHBOARD__ = ${bootstrap};

      const h = React.createElement;
      const tone = (value) => String(value || "unknown").replace(/[^a-z0-9_-]/gi, "").toLowerCase();

      function ProjectNode({ data }) {
        const metrics = data.metrics || [];
        const items = data.items || [];
        return h("div", { className: "node" }, [
          h(Handle, { key: "target", type: "target", position: Position.Left }),
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
          h(Handle, { key: "source", type: "source", position: Position.Right }),
        ]);
      }

      function OverviewNode({ data }) {
        return h("div", { className: "node overview-node" }, [
          h("div", { key: "head", className: "node-header" }, [
            h("h3", { key: "title", className: "node-title" }, data.title),
            h("span", { key: "state", className: "badge good" }, data.status),
          ]),
          h("p", { key: "summary", className: "node-summary" }, data.subtitle),
          h("div", { key: "path", className: "overview-path" }, data.path || "No primary path"),
          h(Handle, { key: "source", type: "source", position: Position.Right }),
        ]);
      }

      function GenericNode({ id, data, type }) {
        const title = data.title || data.name || data.label || id;
        const summary = data.description || data.summary || data.kind || type || "";
        return h("div", { className: "node generic-node" }, [
          h(Handle, { key: "target", type: "target", position: Position.Left }),
          h("div", { key: "head", className: "node-header" }, [
            h("h3", { key: "title", className: "node-title" }, String(title)),
            h("span", { key: "state", className: "badge" }, String(data.status || type || "node")),
          ]),
          h("p", { key: "summary", className: "node-summary" }, String(summary)),
          h(Handle, { key: "source", type: "source", position: Position.Right }),
        ]);
      }

      function apiPath(name, refresh = false) {
        return "api/" + name + (refresh ? "?refresh=1" : "");
      }

      function renderCanvas(render) {
        const rootId = render?.root || "root";
        return render?.elements?.[rootId]?.props || {};
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

      function App() {
        const [snapshot, setSnapshot] = useState(null);
        const [render, setRender] = useState(null);
        const [canvasMeta, setCanvasMeta] = useState(null);
        const [canvases, setCanvases] = useState([]);
        const [selected, setSelected] = useState(null);
        const [error, setError] = useState("");
        const [needsToken, setNeedsToken] = useState(false);
        const [token, setToken] = useState("");
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
        const nodes = canvas.nodes || [];
        const edges = canvas.edges || [];
        const nodeTypes = useMemo(() => {
          const types = { projectPanel: ProjectNode, projectOverview: OverviewNode };
          for (const node of nodes) {
            if (node?.type && !types[node.type]) types[node.type] = GenericNode;
          }
          return types;
        }, [nodes]);
        const onNodeClick = useCallback((_, node) => {
          setSelected(selectedFromNode(snapshot, node));
        }, [snapshot]);
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
              h(ReactFlow, { nodes, edges, nodeTypes, fitView: true, onNodeClick }, [
                h(Background, { key: "bg", gap: 18, size: 1 }),
                h(Controls, { key: "controls" }),
                h(MiniMap, { key: "map", pannable: true, zoomable: true }),
              ])
            ),
            h("aside", { key: "side", className: "side" }, selected ? [
              h("h2", { key: "title" }, selected.title),
              h("p", { key: "summary" }, selected.summary || selected.stateReason || selected.state),
              h("div", { key: "badge", className: "badge " + tone(selected.state) }, selected.provider?.kind || selected.kind),
              ...(selected.warnings || []).map((warning, index) => h("p", { key: "warning-" + index }, warning)),
              ...(selected.items || []).slice(0, 8).map((item) => h("p", { key: item.id }, item.title + (item.status ? " - " + item.status : ""))),
            ] : h("div", { className: "empty-state" }, "Select a dashboard node")),
          ]),
        ]);
      }

      createRoot(document.getElementById("root")).render(h(App));
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
}
