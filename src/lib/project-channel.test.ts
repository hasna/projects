import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, getWorkspace, listWorkspaceEvents } from "../db/workspaces.js";
import { runMigrations } from "../db/schema.js";
import type { WorkspaceKind } from "../types/workspace.js";
import {
  classifyProjectChannelName,
  deriveProjectChannel,
  ensureProjectChannel,
  normalizeProjectChannelName,
  resolveProjectChannel,
  resolveProjectChannelForProject,
  shouldEnsureProjectChannel,
  type ConversationsChannelRunner,
  type ConversationsRunResult,
} from "./project-channel.js";
import { executeWorkspaceCreation } from "./workspace-plan.js";
import { startProject } from "./project-start.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  runMigrations(db);
  return db;
}

function recordingRunner(
  respond: (args: string[]) => ConversationsRunResult,
): { calls: string[][]; runner: ConversationsChannelRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runner: (args) => {
      calls.push(args);
      return respond(args);
    },
  };
}

const ok: ConversationsRunResult = { ok: true, stdout: "{}", stderr: "" };

describe("project channel derivation", () => {
  const cases: Array<{ slug: string; kind: WorkspaceKind; channel: string; channel_class: string }> = [
    { slug: "open-projects", kind: "open-source", channel: "projects", channel_class: "package" },
    { slug: "conversations", kind: "open-source", channel: "conversations", channel_class: "package" },
    { slug: "alumia", kind: "platform", channel: "platform-alumia", channel_class: "product" },
    { slug: "platform-alumia", kind: "platform", channel: "platform-alumia", channel_class: "product" },
    { slug: "dispatch", kind: "internal-app", channel: "iapp-dispatch", channel_class: "product" },
    { slug: "hasna-site", kind: "company-website", channel: "cweb-hasna-site", channel_class: "product" },
    { slug: "meetups", kind: "community", channel: "community-meetups", channel_class: "product" },
    { slug: "vector-lab", kind: "experiment", channel: "research-vector-lab", channel_class: "initiative" },
    { slug: "fleet-comms", kind: "project", channel: "internal-fleet-comms", channel_class: "initiative" },
    { slug: "handbook", kind: "docs", channel: "internal-handbook", channel_class: "initiative" },
    { slug: "misc", kind: "generic", channel: "internal-misc", channel_class: "initiative" },
    // Already-prefixed slugs keep their class prefix regardless of kind.
    { slug: "research-agents", kind: "project", channel: "research-agents", channel_class: "initiative" },
    { slug: "oss-cloud-runtime", kind: "project", channel: "oss-cloud-runtime", channel_class: "initiative" },
    { slug: "loops-comms", kind: "project", channel: "loops-comms", channel_class: "loop-lane" },
  ];

  for (const item of cases) {
    test(`derives ${item.kind}/${item.slug} -> #${item.channel} (${item.channel_class})`, () => {
      const derived = deriveProjectChannel({ slug: item.slug, kind: item.kind });
      expect(derived.channel).toBe(item.channel);
      expect(derived.channel_class).toBe(item.channel_class as typeof derived.channel_class);
      expect(derived.source).toBe("derived");
    });
  }

  test("linked integration wins over derivation and is normalized", () => {
    const derived = deriveProjectChannel({
      slug: "open-projects",
      kind: "open-source",
      integrations: { conversations_channel: "  Custom_Channel " },
    });
    expect(derived.channel).toBe("custom-channel");
    expect(derived.source).toBe("integration");
  });

  test("throws when the slug cannot produce a channel name", () => {
    expect(() => deriveProjectChannel({ slug: "___", kind: "project" })).toThrow("valid channel name");
  });

  test("normalizeProjectChannelName cleans separators, case, and edges", () => {
    expect(normalizeProjectChannelName("  My_Channel  ")).toBe("my-channel");
    expect(normalizeProjectChannelName("UPPER.case")).toBe("upper.case");
    expect(normalizeProjectChannelName("a--b---c")).toBe("a-b-c");
    expect(normalizeProjectChannelName("-lead-trail-")).toBe("lead-trail");
  });

  test("classifyProjectChannelName maps prefixes to classes", () => {
    expect(classifyProjectChannelName("platform-alumia")).toBe("product");
    expect(classifyProjectChannelName("loops-comms-digest")).toBe("loop-lane");
    expect(classifyProjectChannelName("oss-cloud-runtime")).toBe("initiative");
    expect(classifyProjectChannelName("projects")).toBe("package");
  });
});

describe("shouldEnsureProjectChannel", () => {
  test("defaults on outside tests, off under NODE_ENV=test, and honors explicit flags", () => {
    expect(shouldEnsureProjectChannel({})).toBe(true);
    expect(shouldEnsureProjectChannel({ NODE_ENV: "production" })).toBe(true);
    expect(shouldEnsureProjectChannel({ NODE_ENV: "test" })).toBe(false);
    expect(shouldEnsureProjectChannel({ NODE_ENV: "test", PROJECTS_CHANNEL_ENSURE: "1" })).toBe(true);
    expect(shouldEnsureProjectChannel({ PROJECTS_CHANNEL_ENSURE: "off" })).toBe(false);
    expect(shouldEnsureProjectChannel({ OPEN_PROJECTS_CHANNEL_ENSURE: "false" })).toBe(false);
  });
});

describe("project channel resolution", () => {
  test("resolveProjectChannelForProject reports linked and derived channels", () => {
    const db = makeDb();
    const derivedProject = createWorkspace({ name: "Fleet Comms", slug: "fleet-comms", kind: "project" }, db);
    const linkedProject = createWorkspace({
      name: "Projects",
      slug: "open-projects",
      kind: "open-source",
      integrations: { conversations_channel: "projects" },
    }, db);

    const derived = resolveProjectChannelForProject(derivedProject);
    expect(derived.channel).toBe("internal-fleet-comms");
    expect(derived.linked).toBe(false);
    expect(derived.integration_key).toBe("conversations_channel");

    const linked = resolveProjectChannelForProject(linkedProject);
    expect(linked.channel).toBe("projects");
    expect(linked.linked).toBe(true);
    expect(linked.source).toBe("integration");
    db.close();
  });

  test("resolveProjectChannel resolves a registered target by slug", () => {
    const db = makeDb();
    createWorkspace({ name: "Alumia", slug: "alumia", kind: "platform" }, db);
    const resolution = resolveProjectChannel("alumia", { db });
    expect(resolution.channel).toBe("platform-alumia");
    expect(resolution.channel_class).toBe("product");
    expect(resolution.project.slug).toBe("alumia");
    db.close();
  });

  test("resolveProjectChannel throws for unknown targets", () => {
    const db = makeDb();
    expect(() => resolveProjectChannel("nope-not-here", { db })).toThrow("Project not found");
    db.close();
  });
});

describe("ensureProjectChannel", () => {
  test("creates the channel, links it on the project, and records an event", () => {
    const db = makeDb();
    const project = createWorkspace({ name: "Fleet Comms", slug: "fleet-comms", kind: "project" }, db);
    const { calls, runner } = recordingRunner(() => ok);

    const result = ensureProjectChannel(project, { db, runner, agentId: undefined, source: "cli", command: "test" });

    expect(result.status).toBe("created");
    expect(result.created).toBe(true);
    expect(result.channel).toBe("internal-fleet-comms");
    expect(result.persisted).toBe(true);
    expect(result.linked).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 3)).toEqual(["channel", "create", "internal-fleet-comms"]);
    expect(calls[0]).toContain("--description");

    const stored = getWorkspace(project.id, db);
    expect(stored?.integrations.conversations_channel).toBe("internal-fleet-comms");
    const events = listWorkspaceEvents(project.id, db);
    expect(events.some((event) => event.event_type === "channel_ensured")).toBe(true);
    db.close();
  });

  test("treats an already-existing channel as success", () => {
    const db = makeDb();
    const project = createWorkspace({ name: "Projects", slug: "open-projects", kind: "open-source" }, db);
    const { calls, runner } = recordingRunner(() => ({ ok: false, stdout: "", stderr: "Channel #projects already exists." }));

    const result = ensureProjectChannel(project, { db, runner });

    expect(result.status).toBe("exists");
    expect(result.created).toBe(false);
    expect(result.channel).toBe("projects");
    expect(result.persisted).toBe(true);
    expect(calls).toHaveLength(1);
    db.close();
  });

  test("reports runner failures as status error without throwing", () => {
    const db = makeDb();
    const project = createWorkspace({ name: "Fleet Comms", slug: "fleet-comms", kind: "project" }, db);
    const { runner } = recordingRunner(() => ({ ok: false, stdout: "", stderr: "connection refused" }));

    const result = ensureProjectChannel(project, { db, runner });

    expect(result.status).toBe("error");
    expect(result.message).toContain("connection refused");
    // The derived name is deterministic, so the link is still recorded.
    expect(result.persisted).toBe(true);
    db.close();
  });

  test("reports underivable slugs as status error without throwing", () => {
    const db = makeDb();
    const project = createWorkspace({ name: "Weird", slug: "weird", kind: "project" }, db);
    const broken = { ...project, slug: "___" };
    const { calls, runner } = recordingRunner(() => ok);

    const result = ensureProjectChannel(broken, { db, runner });

    expect(result.status).toBe("error");
    expect(result.message).toContain("valid channel name");
    expect(calls).toHaveLength(0);
    db.close();
  });

  test("dry run plans without calling the conversations CLI or persisting", () => {
    const db = makeDb();
    const project = createWorkspace({ name: "Fleet Comms", slug: "fleet-comms", kind: "project" }, db);
    const { calls, runner } = recordingRunner(() => ok);

    const result = ensureProjectChannel(project, { db, runner, dryRun: true });

    expect(result.status).toBe("planned");
    expect(result.persisted).toBe(false);
    expect(calls).toHaveLength(0);
    expect(getWorkspace(project.id, db)?.integrations.conversations_channel).toBeUndefined();
    db.close();
  });

  test("passes --from to the conversations CLI when provided", () => {
    const db = makeDb();
    const project = createWorkspace({ name: "Fleet Comms", slug: "fleet-comms", kind: "project" }, db);
    const { calls, runner } = recordingRunner(() => ok);

    ensureProjectChannel(project, { db, runner, from: "build-projects" });

    expect(calls[0]).toContain("--from");
    expect(calls[0]).toContain("build-projects");
    db.close();
  });
});

describe("channel ensure on project create/start", () => {
  test("executeWorkspaceCreation derives the channel integration and ensures the channel", () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-channel-create-"));
    const { calls, runner } = recordingRunner(() => ok);
    try {
      const result = executeWorkspaceCreation({
        name: "Fleet Comms Create",
        slug: "fleet-comms-create",
        kind: "project",
        primary_path: path,
      }, { db, ensureChannel: true, channelRunner: runner });

      expect(result.success).toBe(true);
      expect(result.workspace?.integrations.conversations_channel).toBe("internal-fleet-comms-create");
      expect(result.channel?.status).toBe("created");
      expect(result.channel?.channel).toBe("internal-fleet-comms-create");
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(path, { recursive: true, force: true });
      db.close();
    }
  });

  test("executeWorkspaceCreation stores the derived channel even when ensure is disabled", () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-channel-create-off-"));
    try {
      const result = executeWorkspaceCreation({
        name: "Quiet Create",
        slug: "quiet-create",
        kind: "open-source",
        primary_path: path,
      }, { db, ensureChannel: false });

      expect(result.success).toBe(true);
      expect(result.channel).toBeNull();
      expect(result.workspace?.integrations.conversations_channel).toBe("quiet-create");
    } finally {
      rmSync(path, { recursive: true, force: true });
      db.close();
    }
  });

  test("executeWorkspaceCreation keeps a caller-provided channel name", () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-channel-create-linked-"));
    const { calls, runner } = recordingRunner(() => ok);
    try {
      const result = executeWorkspaceCreation({
        name: "Prelinked",
        slug: "prelinked",
        kind: "project",
        primary_path: path,
        integrations: { conversations_channel: "internal-custom-lane" },
      }, { db, ensureChannel: true, channelRunner: runner });

      expect(result.workspace?.integrations.conversations_channel).toBe("internal-custom-lane");
      expect(result.channel?.channel).toBe("internal-custom-lane");
      expect(result.channel?.source).toBe("integration");
      expect(calls[0]?.slice(0, 3)).toEqual(["channel", "create", "internal-custom-lane"]);
    } finally {
      rmSync(path, { recursive: true, force: true });
      db.close();
    }
  });

  test("startProject plans the channel ensure on dry run without side effects", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-channel-start-"));
    const { calls, runner } = recordingRunner(() => ok);
    try {
      createWorkspace({ name: "Start Me", slug: "start-me", kind: "project", primary_path: path }, db);
      const result = await startProject("start-me", { dryRun: true, db, ensureChannel: true, channelRunner: runner });

      expect(result.channel?.status).toBe("planned");
      expect(result.channel?.channel).toBe("internal-start-me");
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(path, { recursive: true, force: true });
      db.close();
    }
  });

  test("startProject skips the channel ensure when disabled", async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), "project-channel-start-off-"));
    try {
      createWorkspace({ name: "Quiet Start", slug: "quiet-start", kind: "project", primary_path: path }, db);
      const result = await startProject("quiet-start", { dryRun: true, db, ensureChannel: false });
      expect(result.channel).toBeNull();
    } finally {
      rmSync(path, { recursive: true, force: true });
      db.close();
    }
  });
});
