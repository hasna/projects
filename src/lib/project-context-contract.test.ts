import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import type { Workspace } from "../types/workspace.js";

type StableCode =
  | "PROJECT_ALREADY_REGISTERED"
  | "PROJECT_IDENTITY_CONFLICT"
  | "PROJECT_ARCHIVED"
  | "PROJECT_DELETED"
  | "PROJECT_MARKER_ORPHANED"
  | "PROJECT_MARKER_INVALID"
  | "PROJECT_AUTHORITY_UNAVAILABLE";

interface Authority {
  mode: "local" | "api";
  owner: string;
  storage: "sqlite" | "cloud" | "self-hosted";
  getProject(idOrSlug: string): Promise<Workspace | null>;
  listProjects?(query: string): Promise<Workspace[]>;
  createProject?(input: unknown): Promise<Workspace>;
}

interface CanonicalResolverOptions {
  authority: Authority;
  db?: Database;
  machineId?: string;
  intent?: "read" | "mutate";
}

interface CanonicalResolution {
  project: Workspace;
  source: string;
  create_allowed: boolean;
  path?: string;
  realpath?: string;
  marker?: { id?: string; slug?: string; path?: string };
  authority: { mode: "local" | "api"; owner: string; storage: string; availability: string };
}

type CanonicalResolver = (
  target: string | undefined,
  options: CanonicalResolverOptions,
) => Promise<CanonicalResolution>;

async function canonicalResolver(): Promise<CanonicalResolver | null> {
  const modulePath = "./project-resolver.js";
  const resolver = await import(modulePath) as Record<string, unknown>;
  return typeof resolver.resolveCanonicalProjectTarget === "function"
    ? resolver.resolveCanonicalProjectTarget as CanonicalResolver
    : null;
}

function db(): Database {
  const database = new Database(":memory:");
  database.run("PRAGMA foreign_keys=ON");
  runMigrations(database);
  return database;
}

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: "wks_remote",
    slug: "remote-project",
    name: "Remote Project",
    description: null,
    kind: "project",
    status: "active",
    root_id: null,
    recipe_id: null,
    primary_path: "/canonical/remote",
    git_remote: null,
    s3_bucket: null,
    s3_prefix: null,
    tags: [],
    integrations: {},
    metadata: {},
    last_opened_at: null,
    created_at: "2026-07-22 00:00:00",
    updated_at: "2026-07-22 00:00:00",
    synced_at: null,
    ...overrides,
  };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function expectCode(promise: Promise<unknown>, code: StableCode): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(errorCode(error)).toBe(code);
  }
}

describe("canonical project-context resolver contract", () => {
  test("treats the current EA marker as an identity locator and uses remote canonical fields", async () => {
    const resolveCanonical = await canonicalResolver();
    expect(resolveCanonical).toBeFunction();
    if (!resolveCanonical) return;

    const root = mkdtempSync(join(tmpdir(), "projects-ea-marker-"));
    const nested = join(root, "notes", "daily");
    mkdirSync(nested, { recursive: true });
    const calls = { get: [] as string[], create: 0 };
    const canonical = workspace({
      id: "wks_ZXg7liK4CFJ1KZjC_Fg_b",
      slug: "agent-executive-assistant",
      name: "Executive Assistant Canonical",
      status: "active",
      primary_path: "/remote/canonical/ea",
      updated_at: "2026-07-22 10:00:00",
    });
    const authority: Authority & { createProject(): Promise<never> } = {
      mode: "api",
      owner: "projects",
      storage: "cloud",
      async getProject(id) {
        calls.get.push(id);
        return id === canonical.id ? canonical : null;
      },
      async createProject() {
        calls.create++;
        throw new Error("must not create");
      },
    };
    try {
      writeFileSync(join(root, ".project.json"), JSON.stringify({
        schema_version: 1,
        id: canonical.id,
        slug: canonical.slug,
        name: "stale local name",
        status: "archived",
        primary_path: "/stale/local/path",
        integrations: { todos_project_id: "stale" },
      }), "utf-8");

      const result = await resolveCanonical(nested, { authority, intent: "read", machineId: "station01" });
      expect(result.project).toEqual(canonical);
      expect(result.project.name).toBe("Executive Assistant Canonical");
      expect(result.project.primary_path).toBe("/remote/canonical/ea");
      expect(result.source).toBe("marker");
      expect(result.create_allowed).toBe(false);
      expect(calls.get).toEqual([canonical.id]);
      expect(calls.create).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reproduces the iproj-missing-skills archived marker incident without suggesting import", async () => {
    const resolveCanonical = await canonicalResolver();
    expect(resolveCanonical).toBeFunction();
    if (!resolveCanonical) return;

    const root = mkdtempSync(join(tmpdir(), "projects-archived-marker-"));
    const archived = workspace({
      id: "wks_k41r3wi4b3rb",
      slug: "iproj-missing-skills",
      name: "Missing Skills",
      status: "archived",
      primary_path: "/authority/iproj-missing-skills",
    });
    let createCalls = 0;
    const authority: Authority = {
      mode: "api",
      owner: "projects",
      storage: "cloud",
      async getProject(id) {
        return id === archived.id ? archived : null;
      },
      async createProject() {
        createCalls++;
        throw new Error("must not create or import");
      },
    };
    try {
      writeFileSync(join(root, ".project.json"), JSON.stringify({
        schema_version: 1,
        id: archived.id,
        slug: archived.slug,
        name: archived.name,
        primary_path: root,
      }), "utf-8");

      const read = await resolveCanonical(root, { authority, intent: "read" });
      expect(read.project.status).toBe("archived");
      expect(read.create_allowed).toBe(false);
      await expectCode(resolveCanonical(root, { authority, intent: "mutate" }), "PROJECT_ARCHIVED");
      expect(createCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for marker/location and logical/realpath conflicts while surviving station drift", async () => {
    const resolveCanonical = await canonicalResolver();
    expect(resolveCanonical).toBeFunction();
    if (!resolveCanonical) return;

    const database = db();
    const real = mkdtempSync(join(tmpdir(), "projects-realpath-conflict-"));
    const parent = mkdtempSync(join(tmpdir(), "projects-realpath-link-"));
    const link = join(parent, "linked");
    symlinkSync(real, link, "dir");
    try {
      const locationProject = createWorkspace({
        name: "Location Identity",
        slug: "location-identity",
        kind: "project",
        primary_path: real,
      }, database);
      const markerProject = createWorkspace({
        name: "Marker Identity",
        slug: "marker-identity",
        kind: "project",
      }, database);
      writeFileSync(join(real, ".project.json"), JSON.stringify({ id: markerProject.id }), "utf-8");
      const authority: Authority = {
        mode: "api",
        owner: "projects",
        storage: "cloud",
        async getProject(id) {
          if (id === locationProject.id) return workspace({ id, slug: locationProject.slug });
          if (id === markerProject.id) return workspace({ id, slug: markerProject.slug });
          return null;
        },
      };

      await expectCode(resolveCanonical(real, { authority, db: database }), "PROJECT_IDENTITY_CONFLICT");
      await expectCode(resolveCanonical(link, { authority, db: database }), "PROJECT_IDENTITY_CONFLICT");

      writeFileSync(join(real, ".project.json"), JSON.stringify({ id: locationProject.id }), "utf-8");
      const drifted = await resolveCanonical(real, { authority, db: database, machineId: "different-station" });
      expect(drifted.create_allowed).toBe(false);
      expect(drifted.project.id).toBe(locationProject.id);
      expect(drifted.source).toBe("marker");
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
      database.close();
    }
  });

  test("returns lifecycle, orphan, and outage error codes without local create fallback", async () => {
    const resolveCanonical = await canonicalResolver();
    expect(resolveCanonical).toBeFunction();
    if (!resolveCanonical) return;

    const root = mkdtempSync(join(tmpdir(), "projects-lifecycle-marker-"));
    const calls = { create: 0 };
    const neverCreate = async (): Promise<Workspace> => {
      calls.create++;
      throw new Error("must not create or import");
    };
    try {
      writeFileSync(join(root, ".project.json"), JSON.stringify({ id: "wks_lifecycle" }), "utf-8");
      const deletedAuthority: Authority = {
        mode: "api",
        owner: "projects",
        storage: "cloud",
        async getProject() {
          return workspace({ id: "wks_lifecycle", status: "deleted" });
        },
        createProject: neverCreate,
      };
      await expectCode(resolveCanonical(root, { authority: deletedAuthority, intent: "mutate" }), "PROJECT_DELETED");

      const orphanAuthority: Authority = {
        mode: "api",
        owner: "projects",
        storage: "cloud",
        async getProject() {
          return null;
        },
        createProject: neverCreate,
      };
      await expectCode(resolveCanonical(root, { authority: orphanAuthority, intent: "read" }), "PROJECT_MARKER_ORPHANED");

      const unavailableAuthority: Authority = {
        mode: "api",
        owner: "projects",
        storage: "cloud",
        async getProject() {
          throw new Error("network unavailable");
        },
        createProject: neverCreate,
      };
      await expectCode(resolveCanonical(root, { authority: unavailableAuthority, intent: "read" }), "PROJECT_AUTHORITY_UNAVAILABLE");
      expect(calls.create).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hasna.projects.project_context_bundle.v1 contract", () => {
  test("is strict, allowlisted, provider-short-circuited, secret-safe, and <=8KiB", async () => {
    const modulePath = "./project-context-bundle.js";
    const bundleModule = await import(modulePath).catch(() => null) as null | Record<string, unknown>;
    expect(bundleModule).not.toBeNull();
    if (!bundleModule) return;
    expect(bundleModule.buildProjectContextBundle).toBeFunction();
    expect(bundleModule.parseProjectContextBundle).toBeFunction();
    const build = bundleModule.buildProjectContextBundle as (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    expect(bundleModule.encodeProjectContextBundle).toBeFunction();
    expect(bundleModule.projectContextBundleHash).toBeFunction();
    const parse = bundleModule.parseProjectContextBundle as (input: unknown) => unknown;
    const encode = bundleModule.encodeProjectContextBundle as (input: unknown) => string;
    const hashPayload = bundleModule.projectContextBundleHash as (input: unknown) => string;
    const rehash = (candidate: Record<string, unknown>): Record<string, unknown> => {
      const { hash: _hash, ...payload } = candidate;
      return { ...payload, hash: hashPayload(payload) };
    };
    const providerCalls = { todos: 0, conversations: 0, mementos: 0 };
    const project = workspace({
      id: "wks_bundle",
      slug: "bundle",
      name: "Bundle",
      kind: "project",
      status: "active",
      primary_path: "/safe/bundle",
      description: "FORBIDDEN DESCRIPTION",
      tags: ["FORBIDDEN_TAG"],
      metadata: { token: "FORBIDDEN_SECRET", arbitrary: "FORBIDDEN_METADATA" },
      integrations: {
        todos_project_id: "todo-project",
        todos_task_list_id: "todo-list",
        conversations_channel: "internal-bundle",
        mementos_project_id: "memory-project",
        mementos_scope: "project",
      },
    });
    const bundle = await build({
      project,
      resolution: { source: "marker", conflict: false, create_allowed: false },
      authority: {
        owner: "projects",
        mode: "api",
        storage: "cloud",
        availability: "available",
        url: "https://FORBIDDEN.example",
        api_key_present: true,
      },
      station: { station_id: "station01", machine_id: "machine-safe" },
      generated_at: "2026-07-22T10:00:00.000Z",
      revision: "rev-1",
      providers: {
        todos: async () => { providerCalls.todos++; return {}; },
        conversations: async () => { providerCalls.conversations++; return {}; },
        mementos: async () => { providerCalls.mementos++; return {}; },
      },
    });

    expect(bundle.schema).toBe("hasna.projects.project_context_bundle.v1");
    expect(() => parse(bundle)).not.toThrow();
    expect(bundle.generated_at).toBe("2026-07-22T10:00:00.000Z");
    expect(bundle.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundle.revision).toBe("rev-1");
    expect(bundle.freshness).toBe("fresh");
    expect(bundle.resolution).toEqual({ source: "marker", conflict: false, create_allowed: false });
    expect(bundle.authority).toEqual({
      owner: "projects",
      mode: "api",
      storage: "cloud",
      availability: "available",
    });
    expect(bundle.project).toEqual({
      id: project.id,
      slug: project.slug,
      name: project.name,
      kind: project.kind,
      status: project.status,
      path: project.primary_path,
      updated_at: project.updated_at,
    });
    expect(bundle.links).toEqual({
      todos: { state: "linked", project_id: "todo-project", task_list_id: "todo-list" },
      conversations: { state: "linked", channel: "internal-bundle" },
      mementos: { state: "linked", project_id: "memory-project", scope: "project" },
    });
    expect(providerCalls).toEqual({ todos: 0, conversations: 0, mementos: 0 });
    const encoded = JSON.stringify(bundle);
    expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(8 * 1024);
    expect(encoded).not.toContain("FORBIDDEN");
    expect(encoded).not.toContain("api_key_present");
    expect(encoded).not.toContain("https://");
    expect(encoded).not.toContain("description");
    expect(encoded).not.toContain("tags");
    expect(encoded).not.toContain("metadata");
    expect((bundle.commands as unknown[]).length).toBeLessThanOrEqual(6);
    expect((bundle.commands as Array<{ name: string; argv: string[] }>).every((command) =>
      typeof command.name === "string"
      && command.argv.length > 0
      && command.argv.every((arg) => typeof arg === "string")
      && Object.keys(command).sort().join(",") === "argv,name"
    )).toBe(true);

    expect(() => parse({ ...bundle, extra: true })).toThrow();
    const command = (bundle.commands as Array<Record<string, unknown>>)[0]!;
    expect(() => parse({ ...bundle, commands: [{ ...command, extra: true }] })).toThrow();
    expect(() => parse({ ...bundle, authority: { ...(bundle.authority as object), url: "https://forbidden" } })).toThrow();
    expect(() => parse({ ...bundle, project: { ...(bundle.project as object), description: "forbidden" } })).toThrow();
    expect(() => parse({ ...bundle, revision: "tampered" })).toThrow();

    const exactBase = {
      ...bundle,
      project: { ...(bundle.project as Record<string, unknown>), name: "" },
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(exactBase), "utf-8");
    const exact = rehash({
      ...exactBase,
      project: {
        ...(exactBase.project as Record<string, unknown>),
        name: "x".repeat((8 * 1024) - baseBytes),
      },
    });
    const exactDelta = (8 * 1024) - Buffer.byteLength(JSON.stringify(exact), "utf-8");
    exact.project = {
      ...(exact.project as Record<string, unknown>),
      name: `${String((exact.project as Record<string, unknown>)["name"])}${"x".repeat(exactDelta)}`,
    };
    Object.assign(exact, rehash(exact));
    const exactEncoded = encode(exact);
    expect(Buffer.byteLength(exactEncoded, "utf-8")).toBe(8 * 1024);
    expect(() => parse(JSON.parse(exactEncoded))).not.toThrow();

    try {
      const exactProject = exact.project as Record<string, unknown>;
      encode(rehash({
        ...exact,
        project: { ...exactProject, name: `${String(exactProject["name"])}é` },
      }));
      throw new Error("expected PROJECT_CONTEXT_BUNDLE_TOO_LARGE");
    } catch (error) {
      expect(errorCode(error)).toBe("PROJECT_CONTEXT_BUNDLE_TOO_LARGE");
    }
  });
});
