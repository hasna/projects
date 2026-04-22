import type { Database } from "bun:sqlite";
import { getDatabase, now, uuid } from "./database.js";
import { getProject, getProjectBySlug } from "./projects.js";

export interface TmuxGroupRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface SavedGroup {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  sessions: SavedGroupSession[];
}

export interface SavedGroupSession {
  session_name: string;
  project_id: string | null;
}

export function createSavedGroup(name: string, description?: string, db?: Database): TmuxGroupRow {
  const d = db || getDatabase();
  const id = uuid();
  const ts = now();
  d.run(
    "INSERT INTO tmux_groups (id, name, description, created_at) VALUES (?, ?, ?, ?)",
    [id, name, description || null, ts],
  );
  return d.query("SELECT * FROM tmux_groups WHERE id = ?").get(id) as TmuxGroupRow;
}

export function getSavedGroup(name: string, db?: Database): SavedGroup | null {
  const d = db || getDatabase();
  const row = d.query("SELECT * FROM tmux_groups WHERE name = ?").get(name) as TmuxGroupRow | null;
  if (!row) return null;

  const sessions = d.query(
    "SELECT session_name, project_id FROM tmux_group_sessions WHERE group_id = ?",
  ).all(row.id) as SavedGroupSession[];

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: row.created_at,
    sessions,
  };
}

export function listSavedGroups(db?: Database): SavedGroup[] {
  const d = db || getDatabase();
  const rows = d.query("SELECT * FROM tmux_groups ORDER BY name").all() as TmuxGroupRow[];
  return rows.map(row => {
    const sessions = d.query(
      "SELECT session_name, project_id FROM tmux_group_sessions WHERE group_id = ?",
    ).all(row.id) as SavedGroupSession[];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      created_at: row.created_at,
      sessions,
    };
  });
}

export function addSessionToGroup(groupId: string, sessionName: string, projectId?: string, db?: Database): void {
  const d = db || getDatabase();
  const id = uuid();
  d.run(
    "INSERT INTO tmux_group_sessions (id, group_id, session_name, project_id) VALUES (?, ?, ?, ?)",
    [id, groupId, sessionName, projectId || null],
  );
}

export function removeSessionFromGroup(groupId: string, sessionName: string, db?: Database): void {
  const d = db || getDatabase();
  d.run(
    "DELETE FROM tmux_group_sessions WHERE group_id = ? AND session_name = ?",
    [groupId, sessionName],
  );
}

export function deleteSavedGroup(name: string, db?: Database): void {
  const d = db || getDatabase();
  d.run("DELETE FROM tmux_groups WHERE name = ?", [name]);
}

export function updateSavedGroupDescription(name: string, description: string, db?: Database): void {
  const d = db || getDatabase();
  d.run("UPDATE tmux_groups SET description = ? WHERE name = ?", [description, name]);
}

export function saveGroupFromLive(name: string, db?: Database): SavedGroup {
  const d = db || getDatabase();
  // Import listSessions from tmux lib at runtime to avoid circular dependency
  // For now, this is called from the CLI which imports it separately
  throw new Error("saveGroupFromLive must be called with explicit session data");
}
