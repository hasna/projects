import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import { buildProjectListRender, projectsJsonRenderCatalog, validateProjectsRenderSpec } from "./project-render.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("Projects JSON Render specs", () => {
  test("builds validated specs from project surfaces", () => {
    const db = makeDb();
    const project = createWorkspace({
      name: "Render Project",
      slug: "render-project",
      kind: "project",
      primary_path: "/tmp/render-project",
      tags: ["render"],
    }, db);

    const spec = buildProjectListRender([project]);
    const validated = validateProjectsRenderSpec(spec);

    expect(projectsJsonRenderCatalog.componentNames).toEqual(expect.arrayContaining([
      "Card",
      "Table",
      "Stat",
      "Badge",
      "Tabs",
      "Timeline",
      "Actions",
    ]));
    expect(validated.root).toBe("root");
    expect(validated.elements.root?.type).toBe("Card");
    expect(projectsJsonRenderCatalog.validate(spec).success).toBe(true);
    db.close();
  });

  test("rejects component props that do not match the selected component", () => {
    const invalid = {
      root: "root",
      elements: {
        root: {
          type: "Card",
          props: { columns: ["a"], rows: [] },
          children: [],
        },
      },
      metadata: { kind: "projects.invalid" },
    };

    expect(() => validateProjectsRenderSpec(invalid)).toThrow("Invalid props");
  });

});
