import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOssProjectMatrix, type OssMatrixCommandRunner } from "./oss-project-matrix.js";

describe("OSS project matrix", () => {
  test("builds a bounded open-* matrix with package, git, tmux, task, and PR refs", () => {
    const root = mkdtempSync(join(tmpdir(), "oss-matrix-"));
    const alpha = join(root, "open-alpha");
    const beta = join(root, "open-beta");
    const ignored = join(root, "closed-alpha");
    mkdirSync(alpha);
    mkdirSync(beta);
    mkdirSync(ignored);
    writeFileSync(join(alpha, "package.json"), JSON.stringify({
      name: "@hasna/open-alpha",
      version: "1.2.3",
      bin: { "open-alpha": "dist/cli.js" },
    }));

    const runner: OssMatrixCommandRunner = (command, args, options) => {
      if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") return "true";
      if (command === "git" && args.join(" ") === "status --short --branch") return "## main...origin/main [ahead 1]\n M src/index.ts";
      if (command === "git" && args.join(" ") === "remote get-url origin") return `https://github.com/hasna/${options?.cwd ? options.cwd.split("/").pop() : "open-alpha"}.git`;
      if (command === "todos") {
        return JSON.stringify([{
          id: "task-alpha-123",
          title: "Route alpha work",
          status: "in_progress",
          priority: "high",
          assigned_to: "cli",
          locked_by: "cli",
          updated_at: "2026-06-26T12:00:00.000Z",
        }]);
      }
      if (command === "gh") {
        return JSON.stringify([{
          number: 42,
          title: "Alpha PR",
          state: "OPEN",
          url: "https://github.com/hasna/open-alpha/pull/42",
          updatedAt: "2026-06-26T12:01:00Z",
          headRefName: "feat/alpha",
        }]);
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    try {
      const matrix = buildOssProjectMatrix({
        root,
        prefix: "open-",
        limit: 1,
        commandRunner: runner,
        tmuxSessions: [{ name: "open-alpha", group: "open-alpha", windows: 2, attached: true }],
        tmuxWindows: [
          { session: "open-alpha", index: 0, name: "01", active: true },
          { session: "open-alpha", index: 1, name: "02", active: false },
        ],
        generatedAt: "2026-06-26T12:02:00Z",
      });

      expect(matrix.kind).toBe("projects.oss_matrix");
      expect(matrix.total_candidates).toBe(2);
      expect(matrix.returned).toBe(1);
      expect(matrix.truncated).toBe(true);
      expect(matrix.rows[0]?.name).toBe("open-alpha");
      expect(matrix.rows[0]?.package?.name).toBe("@hasna/open-alpha");
      expect(matrix.rows[0]?.package?.bins).toEqual(["open-alpha"]);
      expect(matrix.rows[0]?.git).toMatchObject({
        is_repo: true,
        branch: "main",
        upstream: "origin/main",
        ahead: 1,
        dirty: true,
        changed_files: 1,
        github_repo: "hasna/open-alpha",
      });
      expect(matrix.rows[0]?.tmux?.sessions[0]).toMatchObject({
        name: "open-alpha",
        match: "exact",
        windows: 2,
        attached: true,
        window_names: ["01", "02"],
      });
      expect(matrix.rows[0]?.task_refs[0]).toMatchObject({ id: "task-alpha-123", status: "in_progress" });
      expect(matrix.rows[0]?.pr_refs[0]).toMatchObject({ number: 42, state: "OPEN" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps scanning when package metadata and external refs fail", () => {
    const root = mkdtempSync(join(tmpdir(), "oss-matrix-failures-"));
    const broken = join(root, "open-broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "package.json"), "{not-json");

    const runner: OssMatrixCommandRunner = (command, args) => {
      if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") return "true";
      if (command === "git" && args.join(" ") === "status --short --branch") return "## main\n";
      if (command === "git" && args.join(" ") === "remote get-url origin") return "https://github.com/hasna/open-broken.git";
      if (command === "todos") throw new Error("todos unavailable");
      if (command === "gh") throw new Error("gh unavailable");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    try {
      const matrix = buildOssProjectMatrix({
        root,
        commandRunner: runner,
        tmuxSessions: [],
        tmuxWindows: [],
        generatedAt: "2026-06-26T12:03:00Z",
      });

      expect(matrix.returned).toBe(1);
      expect(matrix.rows[0]?.package).toBeNull();
      expect(matrix.rows[0]?.task_refs).toEqual([]);
      expect(matrix.rows[0]?.pr_refs).toEqual([]);
      expect(matrix.rows[0]?.warnings.some((warning) => warning.includes("package.json parse failed"))).toBe(true);
      expect(matrix.rows[0]?.warnings.some((warning) => warning.includes("todos unavailable"))).toBe(true);
      expect(matrix.rows[0]?.warnings.some((warning) => warning.includes("gh pr list unavailable"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
