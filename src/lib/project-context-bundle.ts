import { z } from "zod";
import type { Workspace } from "../types/workspace.js";
import { ProjectContextError } from "./project-context-errors.js";
import { stableJsonSha256 } from "./stable-json.js";

export const PROJECT_CONTEXT_BUNDLE_SCHEMA = "hasna.projects.project_context_bundle.v1" as const;
export const PROJECT_CONTEXT_BUNDLE_MAX_BYTES = 8 * 1024;

const nullableId = z.string().trim().min(1).max(512).nullable();
const linkState = z.enum(["linked", "partial", "unlinked"]);

export const projectContextBundleSchema = z.object({
  schema: z.literal(PROJECT_CONTEXT_BUNDLE_SCHEMA),
  generated_at: z.string().min(1),
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  revision: z.string().min(1).max(512),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  resolution: z.object({
    source: z.string().min(1).max(64),
    conflict: z.boolean(),
    create_allowed: z.boolean(),
  }).strict(),
  authority: z.object({
    owner: z.string().min(1).max(256),
    mode: z.enum(["local", "api"]),
    storage: z.enum(["sqlite", "cloud", "self-hosted"]),
    availability: z.enum(["available", "unavailable"]),
  }).strict(),
  project: z.object({
    id: z.string().min(1).max(512),
    slug: z.string().min(1).max(512),
    name: z.string().max(PROJECT_CONTEXT_BUNDLE_MAX_BYTES),
    kind: z.string().min(1).max(128),
    status: z.enum(["active", "archived", "deleted"]),
    path: z.string().max(4096).nullable(),
    updated_at: z.string().min(1).max(128),
  }).strict(),
  links: z.object({
    todos: z.object({
      state: linkState,
      project_id: nullableId,
      task_list_id: nullableId,
    }).strict(),
    conversations: z.object({
      state: linkState,
      channel: nullableId,
    }).strict(),
    mementos: z.object({
      state: linkState,
      project_id: nullableId,
      scope: nullableId,
    }).strict(),
  }).strict(),
  station: z.object({
    station_id: nullableId,
    machine_id: nullableId,
  }).strict().nullable(),
  commands: z.array(z.object({
    name: z.enum(["show", "context", "why", "context-bundle"]),
    argv: z.array(z.string().max(1024)).min(1).max(8),
  }).strict()).max(6),
}).strict();

export type ProjectContextBundle = z.infer<typeof projectContextBundleSchema>;

export interface ProjectContextBundleProviderResult {
  project_id?: unknown;
  task_list_id?: unknown;
  channel?: unknown;
  scope?: unknown;
  todos_project_id?: unknown;
  todos_task_list_id?: unknown;
  conversations_channel?: unknown;
  mementos_project_id?: unknown;
  mementos_scope?: unknown;
}

export interface ProjectContextBundleProviders {
  todos?: () => Promise<ProjectContextBundleProviderResult>;
  conversations?: () => Promise<ProjectContextBundleProviderResult>;
  mementos?: () => Promise<ProjectContextBundleProviderResult>;
}

export interface BuildProjectContextBundleInput {
  project: Workspace;
  resolution?: {
    source?: unknown;
    conflict?: unknown;
    create_allowed?: unknown;
  };
  authority?: {
    owner?: unknown;
    mode?: unknown;
    storage?: unknown;
    availability?: unknown;
  };
  station?: {
    station_id?: unknown;
    machine_id?: unknown;
  } | null;
  generated_at?: string;
  revision?: string;
  freshness?: "fresh" | "stale" | "unknown";
  providers?: ProjectContextBundleProviders;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function twoPartState(first: string | null, second: string | null): "linked" | "partial" | "unlinked" {
  if (first && second) return "linked";
  if (first || second) return "partial";
  return "unlinked";
}

function onePartState(value: string | null): "linked" | "unlinked" {
  return value ? "linked" : "unlinked";
}

export function projectContextBundleHash(value: unknown): string {
  return stableJsonSha256(value);
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

export function parseProjectContextBundle(input: unknown): ProjectContextBundle {
  let parsed: ProjectContextBundle;
  try {
    parsed = projectContextBundleSchema.parse(input);
  } catch (cause) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_BUNDLE_INVALID",
      "Project context bundle does not match the strict schema",
      { status: 400, cause },
    );
  }
  const { hash, ...payload } = parsed;
  const expected = projectContextBundleHash(payload);
  if (hash !== expected) {
    throw new ProjectContextError("PROJECT_CONTEXT_BUNDLE_INVALID", "Project context bundle hash does not match its payload", {
      status: 400,
    });
  }
  return parsed;
}

export function encodeProjectContextBundle(input: unknown): string {
  const parsed = parseProjectContextBundle(input);
  const encoded = JSON.stringify(parsed);
  const bytes = Buffer.byteLength(encoded, "utf-8");
  if (bytes > PROJECT_CONTEXT_BUNDLE_MAX_BYTES) {
    throw new ProjectContextError(
      "PROJECT_CONTEXT_BUNDLE_TOO_LARGE",
      `Project context bundle is ${bytes} bytes; maximum is ${PROJECT_CONTEXT_BUNDLE_MAX_BYTES}`,
      { status: 500, details: { bytes, maximum_bytes: PROJECT_CONTEXT_BUNDLE_MAX_BYTES } },
    );
  }
  return encoded;
}

export async function buildProjectContextBundle(
  input: BuildProjectContextBundleInput,
): Promise<ProjectContextBundle> {
  const integrations = input.project.integrations;

  let todosProjectId = optionalString(integrations.todos_project_id);
  let todosTaskListId = optionalString(integrations.todos_task_list_id);
  if ((!todosProjectId || !todosTaskListId) && input.providers?.todos) {
    const provided = await input.providers.todos();
    todosProjectId ??= optionalString(provided.project_id ?? provided.todos_project_id);
    todosTaskListId ??= optionalString(provided.task_list_id ?? provided.todos_task_list_id);
  }

  let conversationsChannel = optionalString(integrations.conversations_channel);
  if (!conversationsChannel && input.providers?.conversations) {
    const provided = await input.providers.conversations();
    conversationsChannel = optionalString(provided.channel ?? provided.conversations_channel);
  }

  let mementosProjectId = optionalString(integrations.mementos_project_id);
  let mementosScope = optionalString(integrations.mementos_scope);
  if ((!mementosProjectId || !mementosScope) && input.providers?.mementos) {
    const provided = await input.providers.mementos();
    mementosProjectId ??= optionalString(provided.project_id ?? provided.mementos_project_id);
    mementosScope ??= optionalString(provided.scope ?? provided.mementos_scope);
  }

  const generatedAt = input.generated_at ?? new Date().toISOString();
  const payload = {
    schema: PROJECT_CONTEXT_BUNDLE_SCHEMA,
    generated_at: generatedAt,
    revision: input.revision ?? input.project.updated_at,
    freshness: input.freshness ?? "fresh",
    resolution: {
      source: optionalString(input.resolution?.source) ?? "id-or-slug",
      conflict: input.resolution?.conflict === true,
      create_allowed: input.resolution?.create_allowed === true,
    },
    authority: {
      owner: optionalString(input.authority?.owner) ?? "projects",
      mode: assertEnum(input.authority?.mode, ["local", "api"] as const, "local"),
      storage: assertEnum(input.authority?.storage, ["sqlite", "cloud", "self-hosted"] as const, "sqlite"),
      availability: assertEnum(input.authority?.availability, ["available", "unavailable"] as const, "available"),
    },
    project: {
      id: input.project.id,
      slug: input.project.slug,
      name: input.project.name,
      kind: input.project.kind,
      status: input.project.status,
      path: input.project.primary_path,
      updated_at: input.project.updated_at,
    },
    links: {
      todos: {
        state: twoPartState(todosProjectId, todosTaskListId),
        project_id: todosProjectId,
        task_list_id: todosTaskListId,
      },
      conversations: {
        state: onePartState(conversationsChannel),
        channel: conversationsChannel,
      },
      mementos: {
        state: twoPartState(mementosProjectId, mementosScope),
        project_id: mementosProjectId,
        scope: mementosScope,
      },
    },
    station: input.station
      ? {
        station_id: optionalString(input.station.station_id),
        machine_id: optionalString(input.station.machine_id),
      }
      : null,
    commands: [
      { name: "show" as const, argv: ["projects", "show", input.project.id, "--json"] },
      { name: "context" as const, argv: ["projects", "context", input.project.id, "--json"] },
      { name: "why" as const, argv: ["projects", "why", input.project.id, "--json"] },
      { name: "context-bundle" as const, argv: ["projects", "context-bundle", input.project.id, "--json"] },
    ],
  };
  const bundle = parseProjectContextBundle({ ...payload, hash: projectContextBundleHash(payload) });
  encodeProjectContextBundle(bundle);
  return bundle;
}
