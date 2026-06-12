import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runMigrations } from "./schema.js";

export const PROJECTS_DB_PATH_ENV = "HASNA_PROJECTS_DB_PATH";
export const LEGACY_WORKSPACES_DB_PATH_ENV = "HASNA_WORKSPACES_DB_PATH";

export function getDbPath(): string {
  if (process.env[PROJECTS_DB_PATH_ENV]) {
    return process.env[PROJECTS_DB_PATH_ENV];
  }
  if (process.env[LEGACY_WORKSPACES_DB_PATH_ENV]) {
    return process.env[LEGACY_WORKSPACES_DB_PATH_ENV];
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
let _dbPath: string | null = null;

export function getDb(): Database { return getDatabase(); }

export function getDatabase(path?: string): Database {
  if (path) {
    ensureDir(path);
    const db = new Database(path);
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA foreign_keys=ON");
    runMigrations(db);
    return db;
  }
  const dbPath = getDbPath();
  if (!_db || _dbPath !== dbPath) {
    if (_db) _db.close();
    ensureDir(dbPath);
    _db = new Database(dbPath);
    _dbPath = dbPath;
    _db.run("PRAGMA journal_mode=WAL");
    _db.run("PRAGMA foreign_keys=ON");
    runMigrations(_db);
  }
  return _db;
}

export function closeDatabase(): void {
  if (_db) _db.close();
  _db = null;
  _dbPath = null;
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
    .query("SELECT id FROM workspaces WHERE id LIKE ? OR slug = ? LIMIT 1")
    .get(`${partial}%`, partial) as { id: string } | null;
  return row?.id ?? null;
}
