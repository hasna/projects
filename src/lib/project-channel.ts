import type { Database } from "bun:sqlite";
import { getWorkspace, linkWorkspaceIntegrations, recordWorkspaceEvent } from "../db/workspaces.js";
import type { EventSource, Workspace, WorkspaceIntegrations, WorkspaceKind } from "../types/workspace.js";
import { resolveRegisteredProjectTargetOrThrow } from "./project-resolver.js";

/**
 * Project -> conversations channel linkage.
 *
 * Every project has exactly one conversations channel (fleet comms protocol).
 * The channel name is stored on the project record as
 * `integrations.conversations_channel`; when unset it is derived
 * deterministically from the project slug + kind per the fleet channel naming
 * convention (knowledge items tagged `convention`):
 *
 * - `open-source`      -> package channel: flat repo name (`open-` prefix stripped)
 * - `platform`         -> product channel: `platform-<slug>`
 * - `internal-app`     -> product channel: `iapp-<slug>`
 * - `company-website`  -> product channel: `cweb-<slug>`
 * - `community`        -> product channel: `community-<slug>`
 * - `experiment`       -> initiative channel: `research-<slug>`
 * - everything else    -> initiative channel: `internal-<slug>`
 *
 * Slugs that already carry a recognized class prefix are kept as-is so the
 * derivation never double-prefixes (`platform-alumia` stays `platform-alumia`).
 */

export const PROJECT_CHANNEL_CLASSES = ["package", "product", "initiative", "loop-lane"] as const;
export type ProjectChannelClass = (typeof PROJECT_CHANNEL_CLASSES)[number];

export const PROJECT_CHANNEL_INTEGRATION_KEY = "conversations_channel";

const CHANNEL_PREFIX_CLASSES: ReadonlyArray<{ prefix: string; channel_class: ProjectChannelClass }> = [
  { prefix: "platform-", channel_class: "product" },
  { prefix: "iapp-", channel_class: "product" },
  { prefix: "cweb-", channel_class: "product" },
  { prefix: "community-", channel_class: "product" },
  { prefix: "oss-", channel_class: "initiative" },
  { prefix: "internal-", channel_class: "initiative" },
  { prefix: "research-", channel_class: "initiative" },
  { prefix: "loops-", channel_class: "loop-lane" },
];

const KIND_CHANNEL_RULES: Record<WorkspaceKind, { channel_class: ProjectChannelClass; prefix: string | null }> = {
  "open-source": { channel_class: "package", prefix: null },
  "internal-app": { channel_class: "product", prefix: "iapp-" },
  platform: { channel_class: "product", prefix: "platform-" },
  "company-website": { channel_class: "product", prefix: "cweb-" },
  community: { channel_class: "product", prefix: "community-" },
  experiment: { channel_class: "initiative", prefix: "research-" },
  scaffold: { channel_class: "initiative", prefix: "internal-" },
  project: { channel_class: "initiative", prefix: "internal-" },
  docs: { channel_class: "initiative", prefix: "internal-" },
  "remote-only": { channel_class: "initiative", prefix: "internal-" },
  generic: { channel_class: "initiative", prefix: "internal-" },
};

export interface ProjectChannelDerivation {
  channel: string;
  channel_class: ProjectChannelClass;
  source: "integration" | "derived";
}

export interface ProjectChannelResolution extends ProjectChannelDerivation {
  project: Pick<Workspace, "id" | "slug" | "name" | "kind">;
  linked: boolean;
  integration_key: typeof PROJECT_CHANNEL_INTEGRATION_KEY;
}

export interface ConversationsRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type ConversationsChannelRunner = (args: string[]) => ConversationsRunResult;

export interface EnsureProjectChannelOptions {
  db?: Database;
  agentId?: string;
  source?: EventSource;
  command?: string;
  /** Conversations identity recorded as channel creator. */
  from?: string;
  /** Persist the resolved channel name on the project record (default true). */
  persist?: boolean;
  dryRun?: boolean;
  runner?: ConversationsChannelRunner;
}

export interface ProjectChannelEnsureResult extends ProjectChannelDerivation {
  status: "created" | "exists" | "planned" | "error";
  created: boolean;
  linked: boolean;
  persisted: boolean;
  message?: string;
  project: Workspace;
}

export function normalizeProjectChannelName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export function classifyProjectChannelName(channel: string): ProjectChannelClass {
  const match = CHANNEL_PREFIX_CLASSES.find(({ prefix }) => channel.startsWith(prefix));
  return match?.channel_class ?? "package";
}

export function deriveProjectChannel(
  project: Pick<Workspace, "slug" | "kind"> & { integrations?: WorkspaceIntegrations },
): ProjectChannelDerivation {
  const linked = project.integrations?.[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim();
  if (linked) {
    const channel = normalizeProjectChannelName(linked);
    if (!channel) throw new Error(`Linked conversations channel is not a valid channel name: ${linked}`);
    return { channel, channel_class: classifyProjectChannelName(channel), source: "integration" };
  }

  const base = normalizeProjectChannelName(project.slug);
  if (!base) throw new Error(`Project slug does not produce a valid channel name: ${project.slug}`);

  const prefixed = CHANNEL_PREFIX_CLASSES.find(({ prefix }) => base.startsWith(prefix) && base.length > prefix.length);
  if (prefixed) {
    return { channel: base, channel_class: prefixed.channel_class, source: "derived" };
  }

  const rule = KIND_CHANNEL_RULES[project.kind] ?? KIND_CHANNEL_RULES.generic;
  if (rule.prefix === null) {
    const flat = base.replace(/^open-/, "");
    return { channel: flat || base, channel_class: rule.channel_class, source: "derived" };
  }
  return { channel: `${rule.prefix}${base}`, channel_class: rule.channel_class, source: "derived" };
}

export function resolveProjectChannelForProject(project: Workspace): ProjectChannelResolution {
  const derivation = deriveProjectChannel(project);
  return {
    ...derivation,
    project: { id: project.id, slug: project.slug, name: project.name, kind: project.kind },
    linked: Boolean(project.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim()),
    integration_key: PROJECT_CHANNEL_INTEGRATION_KEY,
  };
}

export function resolveProjectChannel(
  target: string | undefined,
  options: { cwd?: string; db?: Database } = {},
): ProjectChannelResolution {
  const effectiveTarget = target?.trim() || options.cwd?.trim() || ".";
  const resolution = resolveRegisteredProjectTargetOrThrow(effectiveTarget, { db: options.db });
  return resolveProjectChannelForProject(resolution.project);
}

/**
 * Channel ensure runs by default outside of tests; opt out with
 * PROJECTS_CHANNEL_ENSURE=0 (or force on in tests with PROJECTS_CHANNEL_ENSURE=1).
 */
export function shouldEnsureProjectChannel(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env["PROJECTS_CHANNEL_ENSURE"] ?? env["OPEN_PROJECTS_CHANNEL_ENSURE"])?.trim().toLowerCase();
  if (flag) {
    if (["1", "true", "on", "yes"].includes(flag)) return true;
    if (["0", "false", "off", "no"].includes(flag)) return false;
  }
  if (env["NODE_ENV"] === "test") return false;
  return true;
}

export const CONVERSATIONS_CLI_TIMEOUT_MS = 15_000;

export function conversationsCliRunner(binary?: string): ConversationsChannelRunner {
  const executable = binary?.trim() || process.env["PROJECTS_CONVERSATIONS_BIN"]?.trim() || "conversations";
  return (args) => {
    try {
      const result = Bun.spawnSync({
        cmd: [executable, ...args],
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        timeout: CONVERSATIONS_CLI_TIMEOUT_MS,
      });
      return {
        ok: result.exitCode === 0,
        stdout: Buffer.from(result.stdout).toString("utf-8"),
        stderr: Buffer.from(result.stderr).toString("utf-8"),
      };
    } catch (err) {
      return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  };
}

function projectChannelDescription(project: Workspace, channelClass: ProjectChannelClass): string {
  return `Project channel for ${project.name.trim() || project.slug} (${project.slug}) — class ${channelClass}; auto-created by @hasna/projects.`;
}

/**
 * Ensure the project's conversations channel exists and is linked on the
 * project record. Failures (unreachable conversations CLI, underivable slug)
 * never throw; they are reported through `status: "error"` so project
 * create/start keep working.
 */
export function ensureProjectChannel(
  project: Workspace,
  options: EnsureProjectChannelOptions = {},
): ProjectChannelEnsureResult {
  let derivation: ProjectChannelDerivation;
  try {
    derivation = deriveProjectChannel(project);
  } catch (err) {
    return {
      channel: "",
      channel_class: "initiative",
      source: "derived",
      status: "error",
      created: false,
      linked: false,
      persisted: false,
      message: err instanceof Error ? err.message : String(err),
      project,
    };
  }
  const alreadyLinked = project.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim() === derivation.channel;

  if (options.dryRun) {
    return {
      ...derivation,
      status: "planned",
      created: false,
      linked: alreadyLinked,
      persisted: false,
      project,
      message: `Would ensure conversations channel ${derivation.channel} (${derivation.channel_class}).`,
    };
  }

  const runner = options.runner ?? conversationsCliRunner();
  let status: ProjectChannelEnsureResult["status"];
  let message: string | undefined;

  // Create-first: `conversations channel create` on an existing channel fails
  // with an "already exists" message, which doubles as the existence probe —
  // one CLI call per ensure instead of listing every channel on each start.
  const createArgs = [
    "channel",
    "create",
    derivation.channel,
    "--description",
    projectChannelDescription(project, derivation.channel_class),
    "-j",
  ];
  if (options.from?.trim()) createArgs.push("--from", options.from.trim());
  const created = runner(createArgs);
  if (created.ok) {
    status = "created";
  } else {
    const output = `${created.stderr} ${created.stdout}`.toLowerCase();
    if (output.includes("exist")) {
      status = "exists";
    } else {
      status = "error";
      message = created.stderr.trim() || created.stdout.trim() || "conversations channel create failed";
    }
  }

  let updated = project;
  let persisted = false;
  const inStore = getWorkspace(project.id, options.db);
  if (inStore && options.persist !== false && inStore.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim() !== derivation.channel) {
    updated = linkWorkspaceIntegrations(project.id, { [PROJECT_CHANNEL_INTEGRATION_KEY]: derivation.channel }, {
      agent_id: options.agentId,
      source: options.source,
      command: options.command,
    }, options.db);
    persisted = true;
  } else if (inStore) {
    updated = inStore;
  }

  if (inStore) {
    recordWorkspaceEvent({
      workspace_id: project.id,
      agent_id: options.agentId,
      event_type: "channel_ensured",
      source: options.source ?? "cli",
      command: options.command,
      after: {
        channel: derivation.channel,
        channel_class: derivation.channel_class,
        status,
        created: status === "created",
        persisted,
        message,
      },
    }, options.db);
  }

  return {
    ...derivation,
    status,
    created: status === "created",
    linked: Boolean(updated.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim()),
    persisted,
    message,
    project: updated,
  };
}
