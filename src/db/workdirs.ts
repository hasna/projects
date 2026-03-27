import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { getDatabase, now, uuid } from "./database.js";
import { getProject } from "./projects.js";
import type { ProjectWorkdir, ProjectWorkdirRow, AddWorkdirInput } from "../types/index.js";
import { ProjectNotFoundError } from "../types/index.js";

function rowToWorkdir(row: ProjectWorkdirRow): ProjectWorkdir {
  return {
    ...row,
    is_primary: row.is_primary === 1,
    claude_md_generated: row.claude_md_generated === 1,
    agents_md_generated: row.agents_md_generated === 1,
  };
}

export function getMachineId(): string {
  return process.env["HOSTNAME"] || hostname();
}

export function addWorkdir(input: AddWorkdirInput, db?: Database): ProjectWorkdir {
  const d = db || getDatabase();
  const project = getProject(input.project_id, d);
  if (!project) throw new ProjectNotFoundError(input.project_id);

  const id = uuid();
  const machineId = getMachineId();
  const ts = now();

  // If this is the first workdir or explicitly primary, clear existing primary first
  if (input.is_primary) {
    d.run("UPDATE project_workdirs SET is_primary = 0 WHERE project_id = ?", [input.project_id]);
  }

  const existingCount = (d.query("SELECT COUNT(*) as n FROM project_workdirs WHERE project_id = ?").get(input.project_id) as { n: number }).n;
  const isPrimary = input.is_primary !== undefined ? (input.is_primary ? 1 : 0) : existingCount === 0 ? 1 : 0;

  d.run(
    `INSERT INTO project_workdirs (id, project_id, path, machine_id, label, is_primary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET label = excluded.label, machine_id = excluded.machine_id`,
    [id, input.project_id, input.path, machineId, input.label ?? "main", isPrimary, ts],
  );

  return getWorkdir(input.project_id, input.path, d)!;
}

export function getWorkdir(projectId: string, path: string, db?: Database): ProjectWorkdir | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM project_workdirs WHERE project_id = ? AND path = ?").get(projectId, path) as ProjectWorkdirRow | null;
  return row ? rowToWorkdir(row) : null;
}

export function listWorkdirs(projectId: string, db?: Database): ProjectWorkdir[] {
  const d = db || getDatabase();
  const rows = d.query("SELECT * FROM project_workdirs WHERE project_id = ? ORDER BY is_primary DESC, created_at ASC").all(projectId) as ProjectWorkdirRow[];
  return rows.map(rowToWorkdir);
}

export function removeWorkdir(projectId: string, path: string, db?: Database): void {
  const d = db || getDatabase();
  d.run("DELETE FROM project_workdirs WHERE project_id = ? AND path = ?", [projectId, path]);
}

export function markWorkdirGenerated(projectId: string, path: string, db?: Database): void {
  const d = db || getDatabase();
  d.run(
    "UPDATE project_workdirs SET claude_md_generated = 1, agents_md_generated = 1 WHERE project_id = ? AND path = ?",
    [projectId, path],
  );
}

export function getWorkdirsForMachine(db?: Database): ProjectWorkdir[] {
  const d = db || getDatabase();
  const machineId = getMachineId();
  const rows = d.query("SELECT * FROM project_workdirs WHERE machine_id = ?").all(machineId) as ProjectWorkdirRow[];
  return rows.map(rowToWorkdir);
}
