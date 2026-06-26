import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECTS_HOME_ENV,
  createProjectCanvas,
  createProjectDataModel,
  createProjectDataRecord,
  ensureDefaultProjectCanvas,
  ensureProjectStore,
  getProjectStorePaths,
  inspectProjectStoreWithLoops,
  linkProjectLoop,
  listProjectCanvases,
  listProjectDataRecords,
  listProjectLoopSummaries,
  type LoopsClientLike,
  type ProjectStoreProject,
} from "./project-store.js";

describe("project store", () => {
  afterEach(() => {
    delete process.env[PROJECTS_HOME_ENV];
  });

  test("stores project-specific app data under by-id/<project_id>/project.db", () => {
    const root = mkdtempSync(join(tmpdir(), "project-store-"));
    process.env[PROJECTS_HOME_ENV] = root;
    const project: ProjectStoreProject = {
      id: "wks_storetest",
      name: "Store Test",
      slug: "store-test",
      status: "active",
      kind: "project",
      primary_path: "/tmp/store-test",
    };

    try {
      const summary = ensureProjectStore(project);
      const paths = getProjectStorePaths(project);
      expect(summary.paths.db_path).toBe(join(root, "by-id", project.id, "project.db"));
      expect(existsSync(paths.db_path)).toBe(true);

      const dashboard = ensureDefaultProjectCanvas(project);
      expect(dashboard.slug).toBe("dashboard");
      expect(dashboard.layout_engine).toBe("react-flow");
      expect(dashboard.data.ui).toMatchObject({ canvas: "react-flow", infinite_canvas: true });

      const custom = createProjectCanvas(project, {
        name: "Research Board",
        nodes: [{ id: "note", type: "note", position: { x: 1, y: 2 }, data: { title: "Note" } }],
      });
      expect(custom.slug).toBe("research-board");
      expect(listProjectCanvases(project).map((canvas) => canvas.slug)).toEqual(["research-board", "dashboard"]);

      const model = createProjectDataModel(project, {
        name: "Dataset",
        schema: { type: "object", properties: { title: { type: "string" } } },
      });
      const record = createProjectDataRecord(project, {
        model_id: model.id,
        key: "alpha",
        title: "Alpha",
        data: { title: "Alpha" },
      });
      expect(listProjectDataRecords(project, model.id)).toEqual([record]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects path traversal project ids for project store paths", () => {
    const root = mkdtempSync(join(tmpdir(), "project-store-paths-"));
    process.env[PROJECTS_HOME_ENV] = root;

    try {
      expect(() => getProjectStorePaths(".")).toThrow("Invalid project id");
      expect(() => getProjectStorePaths("..")).toThrow("Invalid project id");
      expect(() => getProjectStorePaths("../escape")).toThrow("Invalid project id");
      expect(getProjectStorePaths("wks_safe").project_dir).toBe(join(root, "by-id", "wks_safe"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("links OpenLoops records and summarizes them through an SDK-like client", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-store-loops-"));
    process.env[PROJECTS_HOME_ENV] = root;
    const project: ProjectStoreProject = {
      id: "wks_looptest",
      name: "Loop Test",
      slug: "loop-test",
      status: "active",
      kind: "project",
      primary_path: null,
    };
    const fakeClient: LoopsClientLike = {
      get(idOrName) {
        if (idOrName !== "loop_123") throw new Error("missing");
        return {
          id: "loop_123",
          name: "Daily Check",
          status: "active",
          schedule: { type: "interval", everyMs: 86_400_000 },
          target: { type: "command" },
          nextRunAt: "2026-06-27T00:00:00.000Z",
          updatedAt: "2026-06-26T00:00:00.000Z",
        };
      },
      runs(loopId) {
        expect(loopId).toBe("loop_123");
        return [{
          id: "run_123",
          scheduledFor: "2026-06-26T00:00:00.000Z",
          attempt: 1,
          status: "succeeded",
          finishedAt: "2026-06-26T00:00:01.000Z",
          durationMs: 1000,
        }];
      },
    };

    try {
      const link = linkProjectLoop(project, { loop_id: "loop_123", loop_name: "Daily Check", role: "maintenance" });
      expect(link.role).toBe("maintenance");

      const loops = await listProjectLoopSummaries(project, { loopsClient: fakeClient, includeRuns: true });
      expect(loops[0]?.status).toBe("linked");
      expect(loops[0]?.loop?.name).toBe("Daily Check");
      expect(loops[0]?.runs[0]?.status).toBe("succeeded");

      const summary = await inspectProjectStoreWithLoops(project, { loopsClient: fakeClient, includeRuns: true });
      expect(summary.counts.loop_links).toBe(1);
      expect(summary.loops?.[0]?.link.loop_id).toBe("loop_123");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
