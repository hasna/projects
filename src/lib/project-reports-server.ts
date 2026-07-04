import type { Database } from "bun:sqlite";
import {
  type Dirent,
  type Stats,
  existsSync,
  lstatSync,
  realpathSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { listWorkspaces } from "../db/workspaces.js";
import type { Workspace } from "../types/workspace.js";

const REPORT_EXTENSIONS = new Set([".html", ".htm", ".md", ".markdown"]);
const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_REPORTS_PORT = 3345;

export interface ProjectReportsServerOptions {
  db?: Database;
  host?: string;
  port?: number;
}

export interface ProjectReportsServer {
  server: Bun.Server<undefined>;
  url: string;
  host: string;
  port: number;
}

export interface ProjectReportFile {
  name: string;
  href: string;
  kind: "html" | "markdown";
  size: number;
  updatedAt: string;
}

export interface ProjectReportDate {
  date: string;
  href: string;
  reports: ProjectReportFile[];
}

export interface ProjectReportsSummary {
  project: Pick<Workspace, "id" | "slug" | "name" | "kind" | "status" | "primary_path">;
  href: string;
  dates: ProjectReportDate[];
  latestDate: string | null;
  reportCount: number;
}

type ReportsRoute =
  | { kind: "root" }
  | { kind: "project"; slug: string }
  | { kind: "report"; slug: string; date: string; report: string }
  | { kind: "invalid"; reason: string }
  | { kind: "not-found" };

export async function serveProjectReports(
  options: ProjectReportsServerOptions = {},
): Promise<ProjectReportsServer> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? DEFAULT_REPORTS_PORT;

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, mode: "reports" });
      }

      const route = reportsRoute(url.pathname);
      if (route.kind === "invalid") {
        return textResponse(route.reason, 400);
      }
      if (route.kind === "root") {
        const projects = listProjectsWithReports({ db: options.db });
        return htmlResponse(
          reportsRootHtml(projects),
          { csp: reportsPageCsp() },
        );
      }
      if (route.kind === "not-found") return textResponse("not found", 404);

      const projects = listProjectsWithReports({ db: options.db });
      const project = projects.find((item) => item.project.slug === route.slug);
      if (!project) return textResponse("not found", 404);

      if (route.kind === "project") {
        return htmlResponse(
          reportsProjectHtml(project),
          { csp: reportsPageCsp() },
        );
      }

      if (route.kind === "report") {
        const resolved = resolveReportFile(project.project, route.date, route.report);
        if (!resolved.ok) {
          return textResponse(resolved.reason, resolved.status);
        }
        if (resolved.kind === "html") {
          return new Response(Bun.file(resolved.path), {
            headers: rawHtmlHeaders(),
          });
        }
        return htmlResponse(
          markdownReportHtml({
            project,
            date: route.date,
            report: resolved.reportName,
            markdown: readFileSync(resolved.path, "utf-8"),
          }),
          { csp: reportsPageCsp() },
        );
      }

      return textResponse("not found", 404);
    },
  });

  return {
    server,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${server.port ?? port}/`,
    host,
    port: server.port ?? port,
  };
}

export function listProjectsWithReports(
  options: { db?: Database } = {},
): ProjectReportsSummary[] {
  const projects = listAllWorkspaces(options.db)
    .filter((project) => project.status !== "deleted")
    .flatMap((project) => {
      const dates = listProjectReportDates(project);
      if (!dates.length) return [];
      return [{
        project: {
          id: project.id,
          slug: project.slug,
          name: project.name,
          kind: project.kind,
          status: project.status,
          primary_path: project.primary_path,
        },
        href: projectReportsPath(project.slug),
        dates,
        latestDate: dates[0]?.date ?? null,
        reportCount: dates.reduce((count, date) => count + date.reports.length, 0),
      }];
    });
  return projects.sort((left, right) => left.project.name.localeCompare(right.project.name));
}

function listAllWorkspaces(db?: Database): Workspace[] {
  const pageSize = 500;
  const projects: Workspace[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = listWorkspaces({ limit: pageSize, offset }, db);
    projects.push(...page);
    if (page.length < pageSize) return projects;
  }
}

function listProjectReportDates(project: Workspace): ProjectReportDate[] {
  const root = reportsRoot(project);
  if (!root || !isDirectory(root)) return [];
  return safeReadDir(root)
    .filter((entry) => entry.isDirectory() && DATE_DIR_PATTERN.test(entry.name))
    .map((entry) => {
      const date = entry.name;
      const reports = listReportsForDate(project, date);
      return {
        date,
        href: `${projectReportsPath(project.slug)}#${encodeURIComponent(date)}`,
        reports,
      };
    })
    .filter((date) => date.reports.length > 0)
    .sort((left, right) => right.date.localeCompare(left.date));
}

function listReportsForDate(project: Workspace, date: string): ProjectReportFile[] {
  const root = reportsRoot(project);
  if (!root || !DATE_DIR_PATTERN.test(date)) return [];
  const dateDir = resolve(root, date);
  if (!isDirectory(dateDir) || !isPathInside(root, dateDir)) return [];
  return safeReadDir(dateDir)
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const extension = extname(entry.name).toLowerCase();
      if (!REPORT_EXTENSIONS.has(extension)) return [];
      const resolved = resolveReportFile(project, date, entry.name);
      if (!resolved.ok) return [];
      return [{
        name: entry.name,
        href: projectReportsPath(project.slug, date, entry.name),
        kind: resolved.kind,
        size: resolved.size,
        updatedAt: resolved.updatedAt,
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function resolveReportFile(
  project: Pick<Workspace, "primary_path">,
  date: string,
  report: string,
): {
  ok: true;
  path: string;
  kind: "html" | "markdown";
  reportName: string;
  size: number;
  updatedAt: string;
} | { ok: false; status: number; reason: string } {
  const root = reportsRoot(project);
  if (!root || !isDirectory(root)) return { ok: false, status: 404, reason: "reports not found" };
  if (!DATE_DIR_PATTERN.test(date) || !safePathSegment(date)) {
    return { ok: false, status: 400, reason: "invalid report date" };
  }
  if (!safePathSegment(report)) {
    return { ok: false, status: 400, reason: "invalid report path" };
  }
  const extension = extname(report).toLowerCase();
  if (!REPORT_EXTENSIONS.has(extension)) {
    return { ok: false, status: 404, reason: "unsupported report type" };
  }

  const filePath = resolve(root, date, report);
  if (!isPathInside(root, filePath)) {
    return { ok: false, status: 400, reason: "invalid report path" };
  }
  if (!existsSync(filePath)) return { ok: false, status: 404, reason: "report not found" };

  const stat = safeStat(filePath);
  if (!stat?.isFile()) return { ok: false, status: 404, reason: "report not found" };
  if (!realFilePathInside(root, filePath)) {
    return { ok: false, status: 400, reason: "invalid report path" };
  }

  return {
    ok: true,
    path: filePath,
    kind: extension === ".html" || extension === ".htm" ? "html" : "markdown",
    reportName: report,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function reportsRoot(project: Pick<Workspace, "primary_path">): string | null {
  if (!project.primary_path) return null;
  const projectPath = resolve(project.primary_path);
  const root = resolve(projectPath, "reports");
  if (!isPathInside(projectPath, root)) return null;
  if (!existsSync(root)) return root;
  const linkStat = safeLstat(root);
  if (!linkStat?.isDirectory()) return null;
  if (!realDirectoryPathInside(projectPath, root)) return null;
  return root;
}

function safePathSegment(value: string): boolean {
  return Boolean(value)
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function realFilePathInside(root: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    return isPathInside(realRoot, realCandidate);
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  return safeStat(path)?.isDirectory() ?? false;
}

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function realDirectoryPathInside(root: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    return isPathInside(realRoot, realCandidate);
  } catch {
    return false;
  }
}

function safeReadDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function reportsRoute(pathname: string): ReportsRoute {
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodePathSegment(segment));
  if (segments.some((segment) => segment === null)) {
    return { kind: "invalid", reason: "invalid report path" };
  }
  const decoded = segments as string[];
  if (decoded.length === 0) return { kind: "root" };
  if (decoded.length === 1) {
    const [slug] = decoded;
    return safePathSegment(slug) ? { kind: "project", slug } : { kind: "invalid", reason: "invalid project slug" };
  }
  if (decoded.length === 3) {
    const [slug, date, report] = decoded;
    if (!safePathSegment(slug)) return { kind: "invalid", reason: "invalid project slug" };
    if (!safePathSegment(date)) return { kind: "invalid", reason: "invalid report date" };
    if (!safePathSegment(report)) return { kind: "invalid", reason: "invalid report path" };
    return { kind: "report", slug, date, report };
  }
  return { kind: "not-found" };
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function projectReportsPath(slug: string, date?: string, report?: string): string {
  const parts = [slug, date, report].filter((part): part is string => Boolean(part));
  return `/${parts.map((part) => encodeURIComponent(part)).join("/")}`;
}

function reportsRootHtml(projects: ProjectReportsSummary[]): string {
  const rows = projects.map((project) => `
    <article class="report-card">
      <a class="report-card__title" href="${escapeHtml(project.href)}">${escapeHtml(project.project.name)}</a>
      <div class="report-card__meta">${escapeHtml(project.project.slug)} · ${project.reportCount} report${project.reportCount === 1 ? "" : "s"}${project.latestDate ? ` · latest ${escapeHtml(project.latestDate)}` : ""}</div>
      <div class="report-card__dates">${project.dates.slice(0, 5).map((date) => `<a href="${escapeHtml(date.href)}">${escapeHtml(date.date)}</a>`).join("")}</div>
    </article>`).join("");
  return pageShell({
    title: "Project Reports",
    eyebrow: "Registered Projects",
    body: projects.length ? `<section class="report-grid">${rows}</section>` : `<p class="empty">No registered projects have reports yet.</p>`,
  });
}

function reportsProjectHtml(project: ProjectReportsSummary): string {
  const sections = project.dates.map((date) => `
    <section class="report-date" id="${escapeHtml(date.date)}">
      <h2>${escapeHtml(date.date)}</h2>
      <ul class="report-list">
        ${date.reports.map((report) => `
          <li>
            <a href="${escapeHtml(report.href)}">${escapeHtml(report.name)}</a>
            <span>${escapeHtml(report.kind)} · ${formatBytes(report.size)} · ${escapeHtml(report.updatedAt)}</span>
          </li>`).join("")}
      </ul>
    </section>`).join("");
  return pageShell({
    title: `${project.project.name} Reports`,
    eyebrow: `<a href="/">Project Reports</a> / ${escapeHtml(project.project.slug)}`,
    body: sections,
  });
}

function markdownReportHtml(input: {
  project: ProjectReportsSummary;
  date: string;
  report: string;
  markdown: string;
}): string {
  return pageShell({
    title: input.report,
    eyebrow: `<a href="/">Project Reports</a> / <a href="${escapeHtml(input.project.href)}">${escapeHtml(input.project.project.slug)}</a> / ${escapeHtml(input.date)}`,
    body: `<article class="markdown-body">${renderMarkdown(input.markdown)}</article>`,
  });
}

function pageShell(input: { title: string; eyebrow: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(input.title)}</title>
  <style>${reportsCss()}</style>
</head>
<body>
  <main>
    <header class="page-header">
      <div class="eyebrow">${input.eyebrow}</div>
      <h1>${escapeHtml(input.title)}</h1>
    </header>
    ${input.body}
  </main>
</body>
</html>`;
}

function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | null = null;
  let fence: { language: string; lines: string[] } | null = null;

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      if (fenceMatch) {
        html.push(codeBlockHtml(fence.lines.join("\n"), fence.language));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      closeParagraph();
      closeList();
      fence = { language: fenceMatch[1] ?? "", lines: [] };
      continue;
    }
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2]!)}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      closeParagraph();
      if (list !== "ul") {
        closeList();
        list = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1]!)}</li>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      closeParagraph();
      if (list !== "ol") {
        closeList();
        list = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1]!)}</li>`);
      continue;
    }

    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      closeParagraph();
      closeList();
      html.push(`<blockquote>${renderInlineMarkdown(quote[1]!)}</blockquote>`);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (fence) html.push(codeBlockHtml(fence.lines.join("\n"), fence.language));
  closeParagraph();
  closeList();
  return html.join("\n");
}

function renderInlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  let output = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code: string) => {
    const token = `@@CODE_SPAN_${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const safe = safeLinkHref(href);
    if (!safe) return label;
    return `<a href="${escapeHtml(safe)}" rel="noreferrer">${label}</a>`;
  });
  output = output
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  for (const [index, code] of codeSpans.entries()) {
    output = output.replace(`@@CODE_SPAN_${index}@@`, code);
  }
  return output;
}

function codeBlockHtml(code: string, language: string): string {
  const className = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre><code${className}>${escapeHtml(code)}</code></pre>`;
}

function safeLinkHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:|#|\/|\.\.?\/)/i.test(trimmed)) return trimmed;
  return null;
}

function htmlResponse(
  body: string,
  options: { csp: string },
): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": options.csp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function rawHtmlHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "sandbox; default-src 'self' data: blob: https: http:; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function reportsPageCsp(): string {
  return "default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data:; base-uri 'none'; form-action 'none'";
}

function reportsCss(): string {
  return `
    :root {
      color-scheme: light dark;
      --bg: #fafafa;
      --text: #18181b;
      --muted: #5f6368;
      --border: #d4d4d8;
      --surface: #ffffff;
      --accent: #0f766e;
      --code-bg: #f4f4f5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111213;
        --text: #f4f4f5;
        --muted: #a1a1aa;
        --border: #3f3f46;
        --surface: #18181b;
        --accent: #5eead4;
        --code-bg: #27272a;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.6;
    }
    main {
      width: min(1060px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 40px 0 64px;
    }
    .page-header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
      margin-bottom: 28px;
    }
    .eyebrow {
      color: var(--muted);
      font-size: 0.9rem;
      margin-bottom: 8px;
    }
    h1 {
      font-size: clamp(2rem, 5vw, 3.5rem);
      line-height: 1.05;
      margin: 0;
      letter-spacing: 0;
    }
    h2, h3, h4, h5, h6 {
      line-height: 1.25;
      margin: 2rem 0 0.75rem;
    }
    a {
      color: var(--accent);
      text-decoration-thickness: 0.08em;
      text-underline-offset: 0.18em;
    }
    .report-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
      gap: 14px;
    }
    .report-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .report-card__title {
      display: inline-block;
      font-weight: 700;
      font-size: 1.05rem;
      margin-bottom: 6px;
    }
    .report-card__meta, .report-list span {
      color: var(--muted);
      font-size: 0.88rem;
    }
    .report-card__dates {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .report-card__dates a {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 10px;
      text-decoration: none;
      font-size: 0.85rem;
    }
    .report-date {
      margin-top: 28px;
    }
    .report-list {
      list-style: none;
      padding: 0;
      margin: 0;
      border-top: 1px solid var(--border);
    }
    .report-list li {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    .markdown-body {
      font-size: 1rem;
      max-width: 820px;
    }
    .markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote, .markdown-body pre {
      margin: 0 0 1rem;
    }
    .markdown-body blockquote {
      border-left: 3px solid var(--accent);
      color: var(--muted);
      padding-left: 1rem;
    }
    code {
      background: var(--code-bg);
      border-radius: 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.92em;
      padding: 0.14em 0.32em;
    }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow-x: auto;
      padding: 16px;
    }
    pre code {
      background: transparent;
      padding: 0;
    }
    .empty {
      color: var(--muted);
    }
    @media (max-width: 640px) {
      main {
        width: min(100vw - 24px, 1060px);
        padding-top: 28px;
      }
      .report-list li {
        display: block;
      }
      .report-list span {
        display: block;
        margin-top: 4px;
      }
    }
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
