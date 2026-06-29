import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  buildProjectDashboard,
  buildProjectDashboardRender,
  type BuildProjectDashboardSnapshotOptions,
} from "./project-dashboard.js";
import { resolveRegisteredProjectTargetOrThrow } from "./project-resolver.js";

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

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/" || url.pathname === "") {
        return Response.redirect(new URL("/dashboard", url).toString(), 302);
      }
      if (url.pathname === "/health") {
        return Response.json({ ok: true, project: resolution.project.slug });
      }
      if (url.pathname === "/dashboard") {
        return new Response(projectDashboardHtml({ projectSlug: resolution.project.slug }), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            ...(selfIssueCookie ? { "set-cookie": dashboardCookie(token) } : {}),
          },
        });
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        const submitted = await readSubmittedToken(request);
        if (!submitted || !tokensMatch(submitted, token)) {
          return Response.json({ ok: false, error: "invalid dashboard token" }, { status: 401 });
        }
        return Response.json({ ok: true }, { headers: { "set-cookie": dashboardCookie(token) } });
      }
      if (!hasDashboardCookie(request, token)) {
        return Response.json({ ok: false, error: "dashboard token required" }, { status: 401 });
      }
      if (url.pathname === "/api/snapshot") {
        if (url.searchParams.get("refresh") === "1") dashboard = await buildProjectDashboard(target, options);
        return Response.json(dashboard.snapshot);
      }
      if (url.pathname === "/api/render") {
        return Response.json(buildProjectDashboardRender(resolution.project, dashboard.snapshot));
      }
      if (url.pathname === "/api/bootstrap") {
        return Response.json({
          project: {
            id: resolution.project.id,
            slug: resolution.project.slug,
            name: resolution.project.name,
            kind: resolution.project.kind,
            status: resolution.project.status,
            primary_path: resolution.project.primary_path,
          },
          snapshot: dashboard.snapshot,
          render: dashboard.render,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    server,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${server.port}/dashboard`,
    host,
    port: server.port ?? port,
    token,
  };
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

export function projectDashboardHtml(args: { projectSlug: string }): string {
  const bootstrap = JSON.stringify({ projectSlug: args.projectSlug });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Projects Dashboard - ${escapeHtml(args.projectSlug)}</title>
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
      .toolbar { display: flex; gap: 8px; align-items: center; }
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

      function App() {
        const [snapshot, setSnapshot] = useState(null);
        const [render, setRender] = useState(null);
        const [selected, setSelected] = useState(null);
        const [error, setError] = useState("");
        const [needsToken, setNeedsToken] = useState(false);
        const [token, setToken] = useState("");
        const load = useCallback(async (refresh = false) => {
          setError("");
          setNeedsToken(false);
          const suffix = refresh ? "?refresh=1" : "";
          const [nextSnapshot, nextRender] = await Promise.all([
            fetch("/api/snapshot" + suffix, { credentials: "same-origin" }).then((res) => {
              if (res.status === 401) setNeedsToken(true);
              if (!res.ok) throw new Error("Snapshot request failed " + res.status);
              return res.json();
            }),
            fetch("/api/render", { credentials: "same-origin" }).then((res) => {
              if (res.status === 401) setNeedsToken(true);
              if (!res.ok) throw new Error("Render request failed " + res.status);
              return res.json();
            }),
          ]);
          setSnapshot(nextSnapshot);
          setRender(nextRender);
          setSelected(nextSnapshot.panels?.[0] || null);
        }, []);
        const unlock = useCallback(async (event) => {
          event.preventDefault();
          setError("");
          const res = await fetch("/api/session", {
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
        const canvas = render?.elements?.root?.props || {};
        const nodes = canvas.nodes || [];
        const edges = canvas.edges || [];
        const nodeTypes = useMemo(() => ({ projectPanel: ProjectNode, projectOverview: OverviewNode }), []);
        const onNodeClick = useCallback((_, node) => {
          const panel = snapshot?.panels?.find((item) => item.id === node.id);
          setSelected(panel || null);
        }, [snapshot]);
        return h("div", { className: "shell" }, [
          h("header", { key: "top", className: "topbar" }, [
            h("div", { key: "brand", className: "brand" }, [
              h("h1", { key: "title" }, snapshot?.projectId || window.__PROJECTS_DASHBOARD__.projectSlug),
              h("span", { key: "subtitle" }, snapshot ? snapshot.generatedAt : "Loading dashboard"),
            ]),
            h("div", { key: "tools", className: "toolbar" }, [
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
