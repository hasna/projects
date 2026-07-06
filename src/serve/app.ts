// projects-serve HTTP application (framework-agnostic Bun.serve handler).
//
// Amendment A1 pure-remote: every /v1 request reads/writes cloud Postgres via
// the ProjectsPgStore. Auth is @hasna/contracts API-key verification
// (verifyApiKey), scoped projects:read for reads and projects:write for writes.

import { verifyApiKey, type ApiKeyVerifier, type AuthAuditHook } from "@hasna/contracts/auth";
import { NotFoundError, ProjectsPgStore, ValidationError } from "./pg-store.js";
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
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ValidationError) return 400;
  return 500;
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
      return await route(req, url, path, method, store);
    } catch (err) {
      const status = statusForError(err);
      const message = err instanceof Error ? err.message : "internal error";
      if (status === 500) console.error("projects-serve error:", err);
      return errorResponse(message, status);
    }
  };
}

async function route(
  req: Request,
  url: URL,
  path: string,
  method: string,
  store: ProjectsPgStore,
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
        const workspace = await store.createWorkspace(body as never);
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
    if (sub === "events" && method === "GET") {
      const ws = await store.requireWorkspace(id);
      const limit = url.searchParams.get("limit");
      const events = await store.listWorkspaceEvents(ws.id, limit ? Number(limit) : undefined);
      return jsonResponse({ events, count: events.length });
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
