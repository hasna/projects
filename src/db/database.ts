import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runMigrations } from "./schema.js";

function getDbPath(): string {
  if (process.env["HASNA_PROJECTS_DB_PATH"]) {
    return process.env["HASNA_PROJECTS_DB_PATH"];
  }
  if (process.env["PROJECTS_DB_PATH"]) {
    return process.env["PROJECTS_DB_PATH"];
  }
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  return join(home, ".hasna", "projects", "projects.db");
}

function ensureDir(filePath: string): void {
  if (filePath === ":memory:") return;
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

let _db: Database | null = null;

export function getDatabase(path?: string): Database {
  if (path) {
    ensureDir(path);
    const db = new Database(path);
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA foreign_keys=ON");
    runMigrations(db);
    return db;
  }
  if (!_db) {
    const dbPath = getDbPath();
    ensureDir(dbPath);
    _db = new Database(dbPath);
    _db.run("PRAGMA journal_mode=WAL");
    _db.run("PRAGMA foreign_keys=ON");
    runMigrations(_db);
  }
  return _db;
}

export function now(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function resolvePartialId(partial: string, db?: Database): string | null {
  const d = db || getDatabase();
  if (partial.length < 4) return null;
  const row = d
    .query("SELECT id FROM projects WHERE id LIKE ? OR slug = ? LIMIT 1")
    .get(`${partial}%`, partial) as { id: string } | null;
  return row?.id ?? null;
}
