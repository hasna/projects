import type { Database } from "bun:sqlite";
import { getWorkspace, linkWorkspaceIntegrations, recordWorkspaceEvent } from "../db/workspaces.js";
import type { EventSource, JsonObject, Workspace, WorkspaceIntegrations, WorkspaceKind } from "../types/workspace.js";
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

/**
 * What actually landed during an ensure run. Ensure touches three independent
 * systems (conversations channel, project integration link, audit event), so a
 * single boolean cannot describe the outcome: callers need to know which side
 * effects were committed before deciding whether (and how) to retry.
 */
export interface ProjectChannelSideEffects {
  /** The conversations channel was created by this run. */
  channel_created: boolean;
  /** The conversations channel exists now (created by this run or already there). */
  channel_present: boolean;
  /** `integrations.conversations_channel` holds the derived channel on the project record. */
  integration_linked: boolean;
  /** The `channel_ensured` audit event was recorded on the project. */
  event_recorded: boolean;
}

export interface ProjectChannelEnsureResult extends ProjectChannelDerivation {
  status: "created" | "exists" | "planned" | "error";
  created: boolean;
  linked: boolean;
  persisted: boolean;
  message?: string;
  /**
   * Non-fatal problems (e.g. the audit event could not be recorded). Present
   * even on success; they never change `status`.
   */
  warnings: string[];
  side_effects: ProjectChannelSideEffects;
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

function projectChannelTopic(project: Workspace, channelClass: ProjectChannelClass): string {
  return `${project.name.trim() || project.slug} (${project.slug}) — ${channelClass} channel`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `conversations channel create` args. The derived channel class is passed
 * through as `--class` (stored by conversations at
 * `metadata.channel_schema.class`) so project channels satisfy the fleet
 * naming/class convention instead of landing class-less; `--topic` gives the
 * channel a human label. Older `conversations` builds do not know those flags,
 * so callers fall back to the minimal arg set — see {@link createConversationsChannel}.
 */
export function buildChannelCreateArgs(
  project: Workspace,
  derivation: ProjectChannelDerivation,
  options: { from?: string; withMetadata?: boolean } = {},
): string[] {
  const args = [
    "channel",
    "create",
    derivation.channel,
    "--description",
    projectChannelDescription(project, derivation.channel_class),
  ];
  if (options.withMetadata !== false) {
    args.push("--class", derivation.channel_class, "--topic", projectChannelTopic(project, derivation.channel_class));
  }
  args.push("-j");
  if (options.from?.trim()) args.push("--from", options.from.trim());
  return args;
}

/** A CLI rejection caused by an option the installed conversations build lacks. */
function isUnsupportedOptionFailure(result: ConversationsRunResult): boolean {
  const output = `${result.stderr} ${result.stdout}`.toLowerCase();
  return /unknown option|unrecognized option|unknown argument|invalid option|unknown flag/.test(output);
}

/**
 * Create the channel, retrying without the class/topic metadata flags when the
 * installed conversations CLI is too old to understand them. Never throws.
 */
function createConversationsChannel(
  runner: ConversationsChannelRunner,
  project: Workspace,
  derivation: ProjectChannelDerivation,
  from: string | undefined,
): { status: Exclude<ProjectChannelEnsureResult["status"], "planned">; message?: string } {
  let result = runner(buildChannelCreateArgs(project, derivation, { from }));
  if (!result.ok && isUnsupportedOptionFailure(result)) {
    result = runner(buildChannelCreateArgs(project, derivation, { from, withMetadata: false }));
  }
  if (result.ok) return { status: "created" };
  const output = `${result.stderr} ${result.stdout}`.toLowerCase();
  // `channel create` on an existing channel fails with an "already exists"
  // message, which doubles as the existence probe.
  if (output.includes("exist")) return { status: "exists" };
  return {
    status: "error",
    message: result.stderr.trim() || result.stdout.trim() || "conversations channel create failed",
  };
}

const NO_SIDE_EFFECTS: ProjectChannelSideEffects = {
  channel_created: false,
  channel_present: false,
  integration_linked: false,
  event_recorded: false,
};

function derivationErrorResult(project: Workspace, message: string): ProjectChannelEnsureResult {
  return {
    channel: "",
    channel_class: "initiative",
    source: "derived",
    status: "error",
    created: false,
    linked: false,
    persisted: false,
    message,
    warnings: [],
    side_effects: { ...NO_SIDE_EFFECTS },
    project,
  };
}

function plannedResult(
  project: Workspace,
  derivation: ProjectChannelDerivation,
  alreadyLinked: boolean,
): ProjectChannelEnsureResult {
  return {
    ...derivation,
    status: "planned",
    created: false,
    linked: alreadyLinked,
    persisted: false,
    warnings: [],
    side_effects: { ...NO_SIDE_EFFECTS, integration_linked: alreadyLinked },
    project,
    message: `Would ensure conversations channel ${derivation.channel} (${derivation.channel_class}).`,
  };
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
    return derivationErrorResult(project, errorText(err));
  }
  const alreadyLinked = project.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim() === derivation.channel;

  if (options.dryRun) {
    return plannedResult(project, derivation, alreadyLinked);
  }

  const runner = options.runner ?? conversationsCliRunner();
  // Create-first: one CLI call per ensure instead of listing every channel.
  const create = createConversationsChannel(runner, project, derivation, options.from);
  const status: ProjectChannelEnsureResult["status"] = create.status;
  const message = create.message;
  const warnings: string[] = [];

  let updated = project;
  let persisted = false;
  let eventRecorded = false;
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
    // Best-effort audit trail: the channel and the project link are already
    // committed at this point, so a failure to append the event must not turn a
    // completed ensure into a reported failure (see issue #28).
    try {
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
      eventRecorded = true;
    } catch (err) {
      warnings.push(`Channel ensure audit event was not recorded: ${errorText(err)}`);
    }
  }

  const linked = Boolean(updated.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim());
  return {
    ...derivation,
    status,
    created: status === "created",
    linked,
    persisted,
    message,
    warnings,
    side_effects: {
      channel_created: status === "created",
      channel_present: status === "created" || status === "exists",
      integration_linked: linked,
      event_recorded: eventRecorded,
    },
    project: updated,
  };
}

/**
 * Minimal structural view of the projects Store used to persist the channel
 * link. `ProjectStore` (local + api) is assignable to this. Routing channel
 * persistence through the Store is what keeps `projects channel --ensure`
 * correct in api/cloud mode: the integration is written to the project record
 * wherever it actually lives (the cloud) instead of a local sqlite file that
 * does not contain the project (the split-brain the standard forbids).
 */
export interface ProjectChannelStore {
  readonly mode: "local" | "api";
  getProject(idOrSlug: string): Promise<Workspace | null>;
  updateProject(
    id: string,
    patch: { integrations?: WorkspaceIntegrations; agent_id?: string; source?: EventSource; command?: string },
  ): Promise<Workspace>;
  recordEvent(
    idOrSlug: string,
    input: { event_type: string; source: EventSource; agentId?: string; command?: string; after?: JsonObject | null },
  ): Promise<unknown>;
}

export interface StoreEnsureChannelOptions {
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

/**
 * Store-routed variant of {@link ensureProjectChannel}. The channel derivation
 * is pure and the conversations channel creation is a machine-local side effect
 * (the local `conversations` client itself routes to the shared cloud), but the
 * project-record persistence (integration link + audit event) goes through the
 * Store so it lands wherever the project actually lives. Never throws for
 * conversations/derivation failures; reports them via `status: "error"`.
 */
export async function ensureProjectChannelViaStore(
  store: ProjectChannelStore,
  project: Workspace,
  options: StoreEnsureChannelOptions = {},
): Promise<ProjectChannelEnsureResult> {
  let derivation: ProjectChannelDerivation;
  try {
    derivation = deriveProjectChannel(project);
  } catch (err) {
    return derivationErrorResult(project, errorText(err));
  }
  const alreadyLinked = project.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim() === derivation.channel;

  if (options.dryRun) {
    return plannedResult(project, derivation, alreadyLinked);
  }

  const runner = options.runner ?? conversationsCliRunner();
  const create = createConversationsChannel(runner, project, derivation, options.from);
  let status: ProjectChannelEnsureResult["status"] = create.status;
  const messages: string[] = create.message ? [create.message] : [];
  const warnings: string[] = [];

  let updated = project;
  let persisted = false;
  let eventRecorded = false;

  // Everything past the channel creation is a store round-trip. In api/cloud
  // mode any of these can fail against a backend that does not implement the
  // route (or is momentarily unreachable) AFTER the channel already exists, so
  // each step is fenced and reported through the result instead of thrown: a
  // partially completed ensure must never surface as a raw transport error with
  // no record of what landed (issue #28).
  let inStore: Workspace | null = null;
  try {
    inStore = await store.getProject(project.id);
  } catch (err) {
    status = "error";
    messages.push(`Could not read the project record back: ${errorText(err)}`);
  }

  if (
    inStore &&
    options.persist !== false &&
    inStore.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim() !== derivation.channel
  ) {
    try {
      updated = await store.updateProject(project.id, {
        integrations: { ...inStore.integrations, [PROJECT_CHANNEL_INTEGRATION_KEY]: derivation.channel },
        agent_id: options.agentId,
        source: options.source,
        command: options.command,
      });
      persisted = true;
    } catch (err) {
      status = "error";
      messages.push(`Could not link ${derivation.channel} on the project record: ${errorText(err)}`);
    }
  } else if (inStore) {
    updated = inStore;
  }

  if (inStore) {
    // Best-effort audit trail. The channel and the project link are already
    // committed here; a backend that does not expose POST /projects/:id/events
    // must not turn a completed ensure into a total failure.
    try {
      await store.recordEvent(project.id, {
        event_type: "channel_ensured",
        source: options.source ?? "cli",
        agentId: options.agentId,
        command: options.command,
        after: {
          channel: derivation.channel,
          channel_class: derivation.channel_class,
          status,
          created: status === "created",
          persisted,
          message: messages[0] ?? null,
        } as JsonObject,
      });
      eventRecorded = true;
    } catch (err) {
      warnings.push(`Channel ensure audit event was not recorded: ${errorText(err)}`);
    }
  }

  const linked = Boolean(updated.integrations[PROJECT_CHANNEL_INTEGRATION_KEY]?.trim());
  return {
    ...derivation,
    status,
    created: create.status === "created",
    linked,
    persisted,
    message: messages.length ? messages.join("; ") : undefined,
    warnings,
    side_effects: {
      channel_created: create.status === "created",
      channel_present: create.status === "created" || create.status === "exists",
      integration_linked: linked,
      event_recorded: eventRecorded,
    },
    project: updated,
  };
}
