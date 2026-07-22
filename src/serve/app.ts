// projects-serve HTTP application (framework-agnostic Bun.serve handler).
//
// Amendment A1 pure-remote: every /v1 request reads/writes cloud Postgres via
// the ProjectsPgStore. Auth is @hasna/contracts API-key verification
// (verifyApiKey), scoped projects:read for reads and projects:write for writes.

import { verifyApiKey, type ApiKeyVerifier, type AuthAuditHook } from "@hasna/contracts/auth";
import { NotFoundError, ProjectsPgStore, ValidationError } from "./pg-store.js";
import {
  ProjectContextError,
  isProjectContextError,
  projectContextErrorStatus,
} from "../lib/project-context-errors.js";
import { buildProjectContextBundle } from "../lib/project-context-bundle.js";
import { buildOpenApiSpec } from "./openapi.js";

export interface ServeAppOptions {
  store: ProjectsPgStore;
  version: string;
  app?: string;
  signingSecret: string | Buffer;
  isRevoked?: (kid: string) => boolean | Promise<boolean>;
  audit?: AuthAuditHook;
  /** Reported in /health,/ready,/version. Defaults to "cloud". */
  mode?: string;
}

const READ_SCOPE = "projects:read";
const WRITE_SCOPE = "projects:write";

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function errorResponse(message: string, status: number, reason?: string): Response {
  return jsonResponse(reason ? { error: message, reason } : { error: message }, status);
}

function statusForError(err: unknown): number {
  if (isProjectContextError(err)) return projectContextErrorStatus(err.code);
  if (err && typeof err === "object" && "status" in err) {
    const status = Number((err as { status: unknown }).status);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ValidationError) return 400;
  return 500;
}

function allowlistedProjectErrorDetails(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const details: Record<string, boolean> = {};
  for (const key of ["identity_required", "migration_audit_required"] as const) {
    if (typeof input[key] === "boolean") details[key] = input[key];
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function projectErrorResponse(error: unknown, status: number): Response {
  if (isProjectContextError(error)) {
    const message = error.message.startsWith(`${error.code}: `)
      ? error.message.slice(error.code.length + 2)
      : error.message;
    const rawProject = error.project as Record<string, unknown> | undefined;
    const project = rawProject
      && typeof rawProject["id"] === "string"
      && typeof rawProject["slug"] === "string"
      && typeof rawProject["status"] === "string"
      ? { id: rawProject["id"], slug: rawProject["slug"], status: rawProject["status"] }
      : undefined;
    const details = allowlistedProjectErrorDetails(error.details);
    return jsonResponse({
      error: { code: error.code, message },
      ...(project ? { project } : {}),
      ...(details ? { details } : {}),
    }, status);
  }
  if (error instanceof NotFoundError) {
    return jsonResponse({
      error: { code: "PROJECT_NOT_FOUND", message: error.message },
    }, 404);
  }
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  if (typeof candidate["code"] === "string") {
    const rawProject = candidate["project"] && typeof candidate["project"] === "object"
      ? candidate["project"] as Record<string, unknown>
      : null;
    const project = rawProject
      && typeof rawProject["id"] === "string"
      && typeof rawProject["slug"] === "string"
      && typeof rawProject["status"] === "string"
      ? { id: rawProject["id"], slug: rawProject["slug"], status: rawProject["status"] }
      : undefined;
    const details = allowlistedProjectErrorDetails(candidate["details"]);
    return jsonResponse({
      error: {
        code: candidate["code"],
        message: error instanceof Error ? error.message : "request failed",
      },
      ...(project ? { project } : {}),
      ...(details ? { details } : {}),
    }, status);
  }
  return errorResponse(error instanceof Error ? error.message : "internal error", status);
}

function toBool(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new ValidationError("request body must be a JSON object");
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("invalid JSON body");
  }
}

/** Build the fetch handler used by Bun.serve (and directly testable). */
export function createFetchHandler(options: ServeAppOptions): (req: Request) => Promise<Response> {
  const { store, version } = options;
  const appName = options.app ?? "projects";
  const mode = options.mode ?? "cloud";
  const verifier: ApiKeyVerifier = verifyApiKey({
    app: appName,
    signingSecret: options.signingSecret,
    ...(options.isRevoked ? { isRevoked: options.isRevoked } : {}),
    ...(options.audit ? { audit: options.audit } : {}),
  });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    // --- unauthenticated probes ---
    if (path === "/health" && method === "GET") {
      return jsonResponse({ status: "ok", version, mode });
    }
    if (path === "/version" && method === "GET") {
      return jsonResponse({ status: "ok", version, mode });
    }
    if (path === "/ready" && method === "GET") {
      try {
        const ok = await store.ping();
        return ok
          ? jsonResponse({ status: "ready", version, mode })
          : jsonResponse({ status: "degraded", version, mode }, 503);
      } catch {
        return jsonResponse({ status: "unavailable", version, mode }, 503);
      }
    }
    if (path === "/openapi.json" && method === "GET") {
      return jsonResponse(buildOpenApiSpec(version));
    }
    if (path === "/" && method === "GET") {
      return jsonResponse({ name: `${appName}-serve`, version, mode, openapi: "/openapi.json" });
    }

    // --- everything under /v1 requires auth ---
    if (!path.startsWith("/v1/")) {
      return errorResponse("Not found", 404);
    }

    const requiredScopes = method === "GET" ? [READ_SCOPE] : [WRITE_SCOPE];
    const decision = await verifier.authenticate(req.headers, { method, path, requiredScopes });
    if (!decision.ok) {
      return errorResponse(decision.message, decision.status, decision.reason);
    }

    try {
      return await route(req, url, path, method, store, {
        owner: appName,
        storage: mode === "self-hosted" ? "self-hosted" : "cloud",
      });
    } catch (err) {
      const status = statusForError(err);
      if (status === 500) console.error("projects-serve error:", err);
      return projectErrorResponse(err, status);
    }
  };
}

async function route(
  req: Request,
  url: URL,
  path: string,
  method: string,
  store: ProjectsPgStore,
  authority: { owner: string; storage: "cloud" | "self-hosted" },
): Promise<Response> {
  const segments = path.split("/").filter(Boolean); // e.g. ["v1","projects","abc","events"]
  const [, resource, id, sub] = segments;

  // ---------------- projects ----------------
  if (resource === "projects") {
    if (!id) {
      if (method === "GET") {
        const q = url.searchParams;
        const tag = q.get("tag");
        const workspaces = await store.listWorkspaces({
          ...(q.get("status") ? { status: q.get("status") as never } : {}),
          ...(q.get("kind") ? { kind: q.get("kind") as never } : {}),
          ...(q.get("root_id") ? { root_id: q.get("root_id")! } : {}),
          ...(q.get("query") ? { query: q.get("query")! } : {}),
          ...(tag ? { tags: [tag] } : {}),
          ...(q.get("limit") ? { limit: Number(q.get("limit")) } : {}),
          ...(q.get("offset") ? { offset: Number(q.get("offset")) } : {}),
        });
        return jsonResponse({ workspaces, count: workspaces.length });
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const identity = body["identity"];
        if (identity !== undefined && (!identity || typeof identity !== "object" || Array.isArray(identity))) {
          throw new ValidationError("identity must be a JSON object");
        }
        const identityRecord = identity as Record<string, unknown> | undefined;
        const identityKeys = new Set(["location_owner_id", "real_path", "logical_path", "station_id", "machine_id"]);
        for (const key of Object.keys(identityRecord ?? {})) {
          if (!identityKeys.has(key)) throw new ValidationError(`identity contains unsupported property: ${key}`);
        }
        const stringOrUndefined = (key: string): string | undefined => {
          const value = identityRecord?.[key];
          if (value === undefined || value === null) return undefined;
          if (typeof value !== "string" || !value.trim()) throw new ValidationError(`identity.${key} must be a non-empty string`);
          return value.trim();
        };
        const { identity: _identity, ...workspaceInput } = body;
        if (typeof workspaceInput["primary_path"] === "string"
          && (!stringOrUndefined("location_owner_id") || !stringOrUndefined("real_path"))) {
          throw new ProjectContextError(
            "PROJECT_IDENTITY_CONFLICT",
            "primary_path requires identity.location_owner_id and identity.real_path",
            { status: 409, details: { identity_required: true } },
          );
        }
        const workspace = await store.createWorkspace(workspaceInput as never, {
          idempotencyKey: req.headers.get("idempotency-key") ?? undefined,
          locationOwnerId: stringOrUndefined("location_owner_id"),
          realPath: stringOrUndefined("real_path"),
          logicalPath: stringOrUndefined("logical_path"),
          stationId: stringOrUndefined("station_id"),
          machineId: stringOrUndefined("machine_id"),
        });
        return jsonResponse(workspace, 201);
      }
      return errorResponse("Method not allowed", 405);
    }

    if (!sub) {
      if (method === "GET") return jsonResponse(await store.requireWorkspace(id));
      if (method === "PATCH" || method === "PUT") {
        const body = await readJsonBody(req);
        return jsonResponse(await store.updateWorkspace(id, body as never));
      }
      if (method === "DELETE") {
        const hard = toBool(url.searchParams.get("hard"));
        const result = await store.deleteWorkspace(id, { hard });
        return jsonResponse({ deleted: true, hard: result.hard, id: result.workspace.id });
      }
      return errorResponse("Method not allowed", 405);
    }

    if (sub === "archive" && method === "POST") return jsonResponse(await store.archiveWorkspace(id));
    if (sub === "unarchive" && method === "POST") return jsonResponse(await store.unarchiveWorkspace(id));
    if (sub === "context-bundle" && method === "GET") {
      const project = await store.requireWorkspace(id);
      return jsonResponse(await buildProjectContextBundle({
        project,
        resolution: { source: "id-or-slug", conflict: false, create_allowed: false },
        authority: { ...authority, mode: "api", availability: "available" },
      }));
    }
    if (sub === "events" && method === "GET") {
      const ws = await store.requireWorkspace(id);
      const limit = url.searchParams.get("limit");
      const events = await store.listWorkspaceEvents(ws.id, limit ? Number(limit) : undefined);
      return jsonResponse({ events, count: events.length });
    }
    if (sub === "events" && method === "POST") {
      const ws = await store.requireWorkspace(id);
      if (ws.status === "deleted") {
        throw new ProjectContextError("PROJECT_DELETED", "Deleted project cannot receive events", { project: ws });
      }
      if (ws.status === "archived") {
        throw new ProjectContextError("PROJECT_ARCHIVED", "Archived project cannot receive events", { project: ws });
      }
      const body = await readJsonBody(req);
      const allowed = new Set(["event_type", "source", "agent_id", "prompt", "command", "before", "after", "metadata"]);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new ValidationError(`event contains unsupported property: ${key}`);
      }
      if (typeof body["event_type"] !== "string" || !body["event_type"].trim()) {
        throw new ValidationError("event_type must be a non-empty string");
      }
      const requestedSource = typeof body["source"] === "string" ? body["source"].trim() : "";
      const source = (["cli", "mcp", "agent", "migration", "system"] as const).find(
        (candidate) => candidate === requestedSource,
      );
      if (requestedSource && !source) throw new ValidationError("source is invalid");
      for (const key of ["before", "after", "metadata"] as const) {
        const value = body[key];
        if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
          throw new ValidationError(`${key} must be a JSON object or null`);
        }
      }
      const event = await store.recordEvent({
        workspace_id: ws.id,
        event_type: body["event_type"].trim(),
        source: source ?? "system",
        agent_id: typeof body["agent_id"] === "string" ? body["agent_id"] : undefined,
        prompt: typeof body["prompt"] === "string" ? body["prompt"] : undefined,
        command: typeof body["command"] === "string" ? body["command"] : undefined,
        before: body["before"] as never,
        after: body["after"] as never,
        metadata: body["metadata"] && typeof body["metadata"] === "object" && !Array.isArray(body["metadata"])
          ? body["metadata"] as Record<string, unknown>
          : undefined,
      });
      return jsonResponse({ event }, 201);
    }
    return errorResponse("Not found", 404);
  }

  // ---------------- roots ----------------
  if (resource === "roots") {
    if (!id) {
      if (method === "GET") {
        const roots = await store.listRoots();
        return jsonResponse({ roots, count: roots.length });
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        return jsonResponse(await store.createRoot(body as never), 201);
      }
      return errorResponse("Method not allowed", 405);
    }
    if (method === "GET") {
      const root = await store.getRoot(id);
      if (!root) return errorResponse(`Root not found: ${id}`, 404);
      return jsonResponse(root);
    }
    if (method === "PATCH" || method === "PUT") {
      const body = await readJsonBody(req);
      return jsonResponse(await store.updateRoot(id, body as never));
    }
    if (method === "DELETE") {
      const detach = toBool(url.searchParams.get("detach"));
      const result = await store.deleteRoot(id, detach);
      return jsonResponse({ deleted: true, id: result.root.id, detached_workspaces: result.detached_workspaces });
    }
    return errorResponse("Method not allowed", 405);
  }

  // ---------------- agents ----------------
  if (resource === "agents") {
    if (!id) {
      if (method === "GET") {
        const agents = await store.listAgents();
        return jsonResponse({ agents, count: agents.length });
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        return jsonResponse(await store.createAgent(body as never), 201);
      }
      return errorResponse("Method not allowed", 405);
    }
    if (method === "GET") {
      const agent = await store.getAgent(id);
      if (!agent) return errorResponse(`Agent not found: ${id}`, 404);
      return jsonResponse(agent);
    }
    return errorResponse("Method not allowed", 405);
  }

  // ---------------- recipes ----------------
  if (resource === "recipes") {
    if (!id) {
      if (method === "GET") {
        const recipes = await store.listRecipes();
        return jsonResponse({ recipes, count: recipes.length });
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        return jsonResponse(await store.createRecipe(body as never), 201);
      }
      return errorResponse("Method not allowed", 405);
    }
    if (method === "GET") {
      const recipe = await store.getRecipe(id);
      if (!recipe) return errorResponse(`Recipe not found: ${id}`, 404);
      return jsonResponse(recipe);
    }
    return errorResponse("Method not allowed", 405);
  }

  return errorResponse("Not found", 404);
}
