import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./schema.js";
import {
  createSavedGroup,
  getSavedGroup,
  listSavedGroups,
  addSessionToGroup,
  removeSessionFromGroup,
  deleteSavedGroup,
  updateSavedGroupDescription,
} from "./tmux-groups.js";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

describe("tmux-groups CRUD", () => {
  test("creates a saved group", () => {
    const db = createTestDb();
    const group = createSavedGroup("my-group", "Test group", db);
    expect(group.name).toBe("my-group");
    expect(group.description).toBe("Test group");
    expect(group.id).toBeDefined();
  });

  test("creates a group without description", () => {
    const db = createTestDb();
    const group = createSavedGroup("bare-group", undefined, db);
    expect(group.description).toBeNull();
  });

  test("retrieves a saved group with sessions", () => {
    const db = createTestDb();
    const group = createSavedGroup("retrievable", "Desc", db);
    addSessionToGroup(group.id, "session-a", "proj-1", db);
    addSessionToGroup(group.id, "session-b", undefined, db);

    const found = getSavedGroup("retrievable", db);
    expect(found).not.toBeNull();
    expect(found!.sessions.length).toBe(2);
    expect(found!.sessions[0]!.session_name).toBe("session-a");
    expect(found!.sessions[0]!.project_id).toBe("proj-1");
    expect(found!.sessions[1]!.project_id).toBeNull();
  });

  test("returns null for non-existent group", () => {
    const db = createTestDb();
    const found = getSavedGroup("does-not-exist", db);
    expect(found).toBeNull();
  });

  test("lists all saved groups", () => {
    const db = createTestDb();
    createSavedGroup("alpha", "First", db);
    createSavedGroup("beta", "Second", db);

    const groups = listSavedGroups(db);
    expect(groups.length).toBe(2);
    expect(groups[0]!.name).toBe("alpha");
    expect(groups[1]!.name).toBe("beta");
  });

  test("lists empty array when no groups exist", () => {
    const db = createTestDb();
    const groups = listSavedGroups(db);
    expect(groups.length).toBe(0);
  });

  test("adds and removes sessions from group", () => {
    const db = createTestDb();
    const group = createSavedGroup("session-test", undefined, db);
    addSessionToGroup(group.id, "win-1", "p1", db);
    addSessionToGroup(group.id, "win-2", "p2", db);

    const before = getSavedGroup("session-test", db);
    expect(before!.sessions.length).toBe(2);

    removeSessionFromGroup(group.id, "win-1", db);
    const after = getSavedGroup("session-test", db);
    expect(after!.sessions.length).toBe(1);
    expect(after!.sessions[0]!.session_name).toBe("win-2");
  });

  test("deletes a saved group and its sessions", () => {
    const db = createTestDb();
    const group = createSavedGroup("deletable", undefined, db);
    addSessionToGroup(group.id, "s1", undefined, db);

    deleteSavedGroup("deletable", db);
    expect(getSavedGroup("deletable", db)).toBeNull();
  });

  test("updates group description", () => {
    const db = createTestDb();
    createSavedGroup("updatable", "Old desc", db);
    updateSavedGroupDescription("updatable", "New desc", db);

    const group = getSavedGroup("updatable", db);
    expect(group!.description).toBe("New desc");
  });

  test("prevents duplicate group names (UNIQUE constraint)", () => {
    const db = createTestDb();
    createSavedGroup("unique-name", undefined, db);
    expect(() => createSavedGroup("unique-name", undefined, db)).toThrow();
  });

  test("cascade deletes sessions when group is deleted", () => {
    const db = createTestDb();
    const group = createSavedGroup("cascade-test", undefined, db);
    addSessionToGroup(group.id, "s1", undefined, db);
    addSessionToGroup(group.id, "s2", undefined, db);

    // Direct SQL delete to test cascade
    db.run("DELETE FROM tmux_groups WHERE id = ?", [group.id]);
    const remaining = db
      .query("SELECT COUNT(*) as cnt FROM tmux_group_sessions WHERE group_id = ?")
      .get(group.id) as { cnt: number };
    expect(remaining.cnt).toBe(0);
  });
});
