import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../db/schema.js";
import { createWorkspace } from "../db/workspaces.js";
import {
  listProjectsWithReports,
  serveProjectReports,
} from "./project-reports-server.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

function makeReportsProject(
  db: Database,
  root: string,
  input: {
    id: string;
    slug: string;
    name: string;
    reports: Record<string, Record<string, string>>;
  },
) {
  const projectPath = join(root, input.slug);
  for (const [date, files] of Object.entries(input.reports)) {
    const datePath = join(projectPath, "reports", date);
    mkdirSync(datePath, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(datePath, name), body);
    }
  }
  return createWorkspace({
    id: input.id,
    name: input.name,
    slug: input.slug,
    kind: "project",
    primary_path: projectPath,
  }, db);
}

describe("project reports server", () => {
  test("lists registered projects with dated reports without leaking local paths", async () => {
    const root = join(tmpdir(), `projects-reports-list-${randomUUID()}`);
    const db = makeDb();
    try {
      makeReportsProject(db, root, {
        id: "wks_reports_alpha",
        slug: "alpha",
        name: "Alpha Project",
        reports: {
          "2026-07-03": { "daily.md": "# Alpha daily" },
          "2026-07-04": { "index.html": "<h1>Alpha</h1>" },
        },
      });
      makeReportsProject(db, root, {
        id: "wks_reports_beta",
        slug: "beta",
        name: "Beta Project",
        reports: {
          "2026-07-04": { "summary.md": "# Beta summary" },
        },
      });
      createWorkspace({
        id: "wks_reports_empty",
        name: "Empty Project",
        slug: "empty",
        kind: "project",
        primary_path: join(root, "empty"),
      }, db);

      const indexed = listProjectsWithReports({ db });
      expect(indexed.map((item) => item.project.slug)).toEqual(["alpha", "beta"]);
      expect(indexed[0]?.latestDate).toBe("2026-07-04");
      expect(indexed[0]?.reportCount).toBe(2);

      const served = await serveProjectReports({ db, host: "127.0.0.1", port: 0 });
      try {
        const rootPage = await fetch(`http://127.0.0.1:${served.port}/`);
        expect(rootPage.status).toBe(200);
        const rootHtml = await rootPage.text();
        expect(rootHtml).toContain("Alpha Project");
        expect(rootHtml).toContain("Beta Project");
        expect(rootHtml).not.toContain(root);
        expect(rootHtml).not.toContain("Empty Project");

        const projectPage = await fetch(`http://127.0.0.1:${served.port}/alpha`);
        expect(projectPage.status).toBe(200);
        const projectHtml = await projectPage.text();
        expect(projectHtml).toContain("2026-07-04");
        expect(projectHtml).toContain("index.html");
        expect(projectHtml).toContain("daily.md");
      } finally {
        served.server.stop(true);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renders markdown with dark mode typography, code blocks, and escaped HTML", async () => {
    const root = join(tmpdir(), `projects-reports-markdown-${randomUUID()}`);
    const db = makeDb();
    try {
      makeReportsProject(db, root, {
        id: "wks_reports_markdown",
        slug: "markdown",
        name: "Markdown Reports",
        reports: {
          "2026-07-04": {
            "daily.md": [
              "# Daily Report",
              "",
              "A paragraph with **strong** text and `inline()` code.",
              "",
              "```ts",
              "const answer = 42;",
              "```",
              "",
              "<script>alert('x')</script>",
            ].join("\n"),
          },
        },
      });
      const served = await serveProjectReports({ db, host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(`http://127.0.0.1:${served.port}/markdown/2026-07-04/daily.md`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        const html = await response.text();
        expect(html).toContain("markdown-body");
        expect(html).toContain("prefers-color-scheme: dark");
        expect(html).toContain("<h1>Daily Report</h1>");
        expect(html).toContain("<strong>strong</strong>");
        expect(html).toContain("<code>inline()</code>");
        expect(html).toContain('<pre><code class="language-ts">const answer = 42;</code></pre>');
        expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
        expect(html).not.toContain("<script>alert");
      } finally {
        served.server.stop(true);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serves raw HTML as-is with a CSP sandbox", async () => {
    const root = join(tmpdir(), `projects-reports-html-${randomUUID()}`);
    const db = makeDb();
    try {
      makeReportsProject(db, root, {
        id: "wks_reports_html",
        slug: "html",
        name: "HTML Reports",
        reports: {
          "2026-07-04": {
            "report.html": "<!doctype html><h1>Raw HTML</h1><script>window.ran = true</script>",
          },
        },
      });
      const served = await serveProjectReports({ db, host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(`http://127.0.0.1:${served.port}/html/2026-07-04/report.html`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        const csp = response.headers.get("content-security-policy") ?? "";
        expect(csp).toContain("sandbox");
        expect(csp).toContain("script-src 'none'");
        expect(await response.text()).toBe("<!doctype html><h1>Raw HTML</h1><script>window.ran = true</script>");
      } finally {
        served.server.stop(true);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects traversal and non-report paths", async () => {
    const root = join(tmpdir(), `projects-reports-traversal-${randomUUID()}`);
    const db = makeDb();
    try {
      makeReportsProject(db, root, {
        id: "wks_reports_safe",
        slug: "safe",
        name: "Safe Reports",
        reports: {
          "2026-07-04": {
            "daily.md": "# Safe",
            "notes.txt": "not a report",
          },
        },
      });
      const served = await serveProjectReports({ db, host: "127.0.0.1", port: 0 });
      try {
        const traversal = await fetch(`http://127.0.0.1:${served.port}/safe/2026-07-04/%2e%2e%2Fsecret.md`);
        expect(traversal.status).toBe(400);
        expect(await traversal.text()).toContain("invalid report path");

        const unsupported = await fetch(`http://127.0.0.1:${served.port}/safe/2026-07-04/notes.txt`);
        expect(unsupported.status).toBe(404);
        expect(await unsupported.text()).toContain("unsupported report type");

        const extraSegment = await fetch(`http://127.0.0.1:${served.port}/safe/2026-07-04/daily.md/extra`);
        expect(extraSegment.status).toBe(404);
      } finally {
        served.server.stop(true);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked reports root that escapes the project directory", async () => {
    const root = join(tmpdir(), `projects-reports-symlink-${randomUUID()}`);
    const db = makeDb();
    try {
      const projectPath = join(root, "symlinked");
      const outsideReports = join(root, "outside-reports");
      mkdirSync(join(outsideReports, "2026-07-04"), { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(join(outsideReports, "2026-07-04", "outside.md"), "# Outside");
      symlinkSync(outsideReports, join(projectPath, "reports"), "dir");
      createWorkspace({
        id: "wks_reports_symlink",
        name: "Symlink Reports",
        slug: "symlinked",
        kind: "project",
        primary_path: projectPath,
      }, db);

      expect(listProjectsWithReports({ db }).map((item) => item.project.slug)).not.toContain("symlinked");

      const served = await serveProjectReports({ db, host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(`http://127.0.0.1:${served.port}/symlinked/2026-07-04/outside.md`);
        expect(response.status).toBe(404);
      } finally {
        served.server.stop(true);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults to 0.0.0.0 and accepts a configured bind host", async () => {
    const db = makeDb();
    const defaultServer = await serveProjectReports({ db, port: 0 });
    try {
      expect(defaultServer.host).toBe("0.0.0.0");
      expect(defaultServer.url).toBe(`http://127.0.0.1:${defaultServer.port}/`);
      const health = await fetch(`http://127.0.0.1:${defaultServer.port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, mode: "reports" });
    } finally {
      defaultServer.server.stop(true);
      db.close();
    }

    const configured = await serveProjectReports({ host: "127.0.0.1", port: 0 });
    try {
      expect(configured.host).toBe("127.0.0.1");
      expect(configured.url).toBe(`http://127.0.0.1:${configured.port}/`);
    } finally {
      configured.server.stop(true);
    }
  });
});
