import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  assertAgentPermission,
  inferWorkspaceKind,
  renderTemplate,
  workspaceSlugify,
} from "../db/workspaces.js";
import type { ProjectStore } from "../store/project-store.js";
import type { EventSource, JsonObject, Root, Workspace, WorkspaceIntegrations, WorkspaceKind, WorkspaceLock } from "../types/workspace.js";

export type GitHubVisibility = "public" | "private";
export type GitHubRemoteProtocol = "https" | "ssh";

export interface WorkspaceGitHubPublishOptions {
  org?: string;
  repoName?: string;
  visibility?: GitHubVisibility;
  description?: string;
  remoteProtocol?: GitHubRemoteProtocol;
  push?: boolean;
  dryRun?: boolean;
  agent_id?: string;
  source?: EventSource;
  prompt?: string;
  command?: string;
}

export interface WorkspaceGitHubPublishResult {
  status: "planned" | "published";
  dry_run: boolean;
  workspace: Workspace;
  full_name: string;
  repo_name: string;
  org: string;
  visibility: GitHubVisibility;
  url: string;
  remote: string;
  remote_protocol: GitHubRemoteProtocol;
  remote_only: boolean;
  local_path: string | null;
  commands: string[];
  pushed: boolean;
  git_remote_updated: boolean;
}

export interface WorkspaceGitHubUnpublishOptions {
  clearIntegrations?: boolean;
  dryRun?: boolean;
  agent_id?: string;
  source?: EventSource;
  prompt?: string;
  command?: string;
}

export interface WorkspaceGitHubUnpublishResult {
  status: "planned" | "unpublished";
  dry_run: boolean;
  workspace: Workspace;
  local_path: string | null;
  remote_removed: boolean;
  integrations_cleared: boolean;
}

export interface WorkspaceGitHubImportOptions {
  root?: string;
  path?: string;
  clone?: boolean;
  remoteOnly?: boolean;
  tags?: string[];
  kind?: WorkspaceKind;
  visibility?: GitHubVisibility;
  remoteProtocol?: GitHubRemoteProtocol;
  dryRun?: boolean;
  agent_id?: string;
  source?: EventSource;
  prompt?: string;
  command?: string;
}

export interface WorkspaceGitHubImportResult {
  status: "planned" | "imported" | "skipped";
  dry_run: boolean;
  full_name: string;
  repo_name: string;
  org: string;
  url: string;
  remote: string;
  remote_protocol: GitHubRemoteProtocol;
  remote_only: boolean;
  path: string | null;
  root_id: string | null;
  kind: WorkspaceKind;
  tags: string[];
  commands: string[];
  workspace?: Workspace;
  skipped?: string;
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: process.env,
    stdio: "pipe",
  }).trim();
}

function git(path: string, args: string[]): string {
  return run("git", args, path);
}

function gh(args: string[], cwd?: string): string {
  return run("gh", args, cwd);
}

function shellCommand(command: string, args: string[]): string {
  return [command, ...args.map((arg) => /^[A-Za-z0-9_/:=@%+.,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)].join(" ");
}

function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function currentBranch(path: string): string {
  try {
    return git(path, ["branch", "--show-current"]) || "main";
  } catch {
    return "main";
  }
}

function normalizeRepoName(name: string): string {
  return workspaceSlugify(name).replace(/^-+|-+$/g, "") || "workspace";
}

function metadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataVisibility(metadata: JsonObject | undefined): GitHubVisibility | undefined {
  const value = metadataString(metadata, "repo_visibility") ?? metadataString(metadata, "github_visibility");
  return value === "public" || value === "private" ? value : undefined;
}

async function resolvePublishRoot(store: ProjectStore, workspace: Workspace): Promise<Root | null> {
  if (workspace.root_id) return store.getRoot(workspace.root_id);
  if (workspace.primary_path) {
    const matches = await store.matchRoots({ path: workspace.primary_path });
    return matches[0]?.root ?? null;
  }
  return null;
}

async function publishVisibility(
  store: ProjectStore,
  workspace: Workspace,
  root: Root | null,
  requested?: GitHubVisibility,
): Promise<GitHubVisibility> {
  const recipe = workspace.recipe_id ? await store.getRecipe(workspace.recipe_id) : null;
  return requested
    ?? root?.repo_visibility
    ?? metadataVisibility(recipe?.metadata)
    ?? metadataVisibility(workspace.metadata)
    ?? (workspace.kind === "open-source" ? "public" : "private");
}

function workspaceGithubIntegrations(fullName: string, url: string): WorkspaceIntegrations {
  return {
    github_repo: fullName,
    github_url: url,
  };
}

export function normalizeWorkspaceIntegrations(integrations: WorkspaceIntegrations): WorkspaceIntegrations {
  const aliases: Record<string, string> = {
    github: "github_url",
    repo: "github_repo",
    github_full_name: "github_repo",
    todos: "todos_project_id",
    todo: "todos_project_id",
    todos_project: "todos_project_id",
    mementos: "mementos_project_id",
    memento: "mementos_project_id",
    conversations: "conversations_space",
    conversation: "conversations_space",
    channel: "conversations_channel",
    files: "files_index_id",
    file_index: "files_index_id",
  };
  const normalized: WorkspaceIntegrations = {};
  for (const [key, value] of Object.entries(integrations)) {
    normalized[aliases[key] ?? key] = value;
  }
  return normalized;
}

function remoteFor(fullName: string, protocol: GitHubRemoteProtocol): string {
  return protocol === "ssh" ? `git@github.com:${fullName}.git` : `https://github.com/${fullName}.git`;
}

function setOrigin(path: string, remote: string): void {
  const remotes = git(path, ["remote"]);
  if (remotes.split(/\s+/).includes("origin")) {
    git(path, ["remote", "set-url", "origin", remote]);
  } else {
    git(path, ["remote", "add", "origin", remote]);
  }
}

// Import reservation locks are a machine-local coordination primitive: they
// serialize concurrent local imports racing for the same slug/path. In api mode
// the Store cannot acquire local locks (uniqueness is enforced cloud-side), so
// we skip them rather than writing invisible local-sqlite locks (split-brain).
async function acquireImportLocks(
  store: ProjectStore,
  specs: Array<{ key: string; reason: string }>,
  agentId?: string,
): Promise<WorkspaceLock[]> {
  if (store.mode !== "local") return [];
  const acquired: WorkspaceLock[] = [];
  try {
    for (const spec of specs) {
      acquired.push(await store.acquireLock({ key: spec.key, agentId, reason: spec.reason, ttlSeconds: 600 }));
    }
  } catch (err) {
    await releaseImportLocks(store, acquired);
    throw err;
  }
  return acquired;
}

async function releaseImportLocks(store: ProjectStore, locks: WorkspaceLock[]): Promise<void> {
  for (const lock of locks.slice().reverse()) await store.releaseLock(lock.lock_key);
}

function githubImportLocks(plan: WorkspaceGitHubImportResult): Array<{ key: string; reason: string }> {
  const slug = workspaceSlugify(plan.repo_name);
  const locks = [{ key: `workspace-slug:${slug}`, reason: `Reserve GitHub import workspace slug ${slug}` }];
  if (plan.path) locks.push({ key: `workspace-path:${plan.path}`, reason: `Reserve GitHub import path ${plan.path}` });
  if (plan.root_id) locks.push({ key: `root-path:${plan.root_id}:${slug}`, reason: `Reserve GitHub import root segment ${slug}` });
  return locks;
}

export function parseGitHubRepo(input: string): { org: string; repo: string; fullName: string } {
  const trimmed = input.trim();
  const match = trimmed.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:[#?].*)?$/i)
    ?? trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Invalid GitHub repository: ${input}`);
  const org = match[1]!;
  const repo = match[2]!.replace(/\.git$/, "");
  return { org, repo, fullName: `${org}/${repo}` };
}

export async function planWorkspaceGitHubPublish(store: ProjectStore, workspace: Workspace, options: WorkspaceGitHubPublishOptions = {}): Promise<WorkspaceGitHubPublishResult> {
  const root = await resolvePublishRoot(store, workspace);
  const org = options.org ?? root?.github_org ?? metadataString(workspace.metadata, "github_org") ?? "hasnaxyz";
  const repoName = normalizeRepoName(options.repoName ?? workspace.slug ?? workspace.name);
  const fullName = `${org}/${repoName}`;
  const visibility = await publishVisibility(store, workspace, root, options.visibility);
  const protocol = options.remoteProtocol ?? "https";
  const remote = remoteFor(fullName, protocol);
  const url = `https://github.com/${fullName}`;
  const localPath = workspace.primary_path ? resolve(workspace.primary_path) : null;
  const createArgs = ["repo", "create", fullName, `--${visibility}`];
  const description = options.description ?? workspace.description ?? undefined;
  if (description) createArgs.push("--description", description);
  const commands = [shellCommand("gh", createArgs)];
  if (localPath) {
    commands.push(`git -C ${JSON.stringify(localPath)} remote add-or-set origin ${remote}`);
    if (options.push !== false) commands.push(`git -C ${JSON.stringify(localPath)} push -u origin <current-branch>`);
  }

  return {
    status: "planned",
    dry_run: true,
    workspace,
    full_name: fullName,
    repo_name: repoName,
    org,
    visibility,
    url,
    remote,
    remote_protocol: protocol,
    remote_only: !localPath || workspace.kind === "remote-only",
    local_path: localPath,
    commands,
    pushed: false,
    git_remote_updated: false,
  };
}

export async function publishWorkspaceToGitHub(store: ProjectStore, workspace: Workspace, options: WorkspaceGitHubPublishOptions = {}): Promise<WorkspaceGitHubPublishResult> {
  const plan = await planWorkspaceGitHubPublish(store, workspace, options);
  if (options.dryRun) return plan;
  // Authz: in api/cloud mode the server enforces the bearer key's scope; the
  // local agent-permission table is meaningless there, so only check on-box.
  if (store.mode === "local") assertAgentPermission(options.agent_id, "github:publish");

  const createArgs = ["repo", "create", plan.full_name, `--${plan.visibility}`];
  const description = options.description ?? workspace.description ?? undefined;
  if (description) createArgs.push("--description", description);
  gh(createArgs);

  let pushed = false;
  let gitRemoteUpdated = false;
  if (plan.local_path && existsSync(plan.local_path) && isGitRepo(plan.local_path)) {
    setOrigin(plan.local_path, plan.remote);
    gitRemoteUpdated = true;
    if (options.push !== false) {
      git(plan.local_path, ["push", "-u", "origin", currentBranch(plan.local_path), "--quiet"]);
      pushed = true;
    }
  }

  const updated = await store.updateProject(workspace.id, {
    git_remote: plan.remote,
    integrations: { ...workspace.integrations, ...workspaceGithubIntegrations(plan.full_name, plan.url) },
    agent_id: options.agent_id,
    source: options.source ?? "cli",
    prompt: options.prompt,
    command: options.command,
  });
  await store.recordEvent(workspace.id, {
    agentId: options.agent_id,
    event_type: "github_published",
    source: options.source ?? "cli",
    prompt: options.prompt,
    command: options.command,
    after: {
      full_name: plan.full_name,
      url: plan.url,
      remote: plan.remote,
      visibility: plan.visibility,
      pushed,
      git_remote_updated: gitRemoteUpdated,
    },
  });

  return {
    ...plan,
    status: "published",
    dry_run: false,
    workspace: updated,
    pushed,
    git_remote_updated: gitRemoteUpdated,
  };
}

export async function unpublishWorkspaceFromGitHub(store: ProjectStore, workspace: Workspace, options: WorkspaceGitHubUnpublishOptions = {}): Promise<WorkspaceGitHubUnpublishResult> {
  const localPath = workspace.primary_path ? resolve(workspace.primary_path) : null;
  const planned: WorkspaceGitHubUnpublishResult = {
    status: options.dryRun ? "planned" : "unpublished",
    dry_run: Boolean(options.dryRun),
    workspace,
    local_path: localPath,
    remote_removed: false,
    integrations_cleared: Boolean(options.clearIntegrations),
  };
  if (options.dryRun) return planned;

  let remoteRemoved = false;
  if (localPath && existsSync(localPath) && isGitRepo(localPath)) {
    try {
      git(localPath, ["remote", "remove", "origin"]);
      remoteRemoved = true;
    } catch {
      remoteRemoved = false;
    }
  }

  let updated = await store.updateProject(workspace.id, {
    git_remote: null,
    agent_id: options.agent_id,
    source: options.source ?? "cli",
    prompt: options.prompt,
    command: options.command,
  });
  if (options.clearIntegrations) {
    const { github_repo: _repo, github_url: _url, ...rest } = updated.integrations;
    updated = await store.updateProject(workspace.id, {
      integrations: rest,
      agent_id: options.agent_id,
      source: options.source ?? "cli",
      prompt: options.prompt,
      command: options.command,
    });
  }
  await store.recordEvent(workspace.id, {
    agentId: options.agent_id,
    event_type: "github_unpublished",
    source: options.source ?? "cli",
    prompt: options.prompt,
    command: options.command,
    after: { remote_removed: remoteRemoved, integrations_cleared: Boolean(options.clearIntegrations) },
  });

  return { ...planned, workspace: updated, dry_run: false, remote_removed: remoteRemoved };
}

async function resolveImportRoot(store: ProjectStore, input: string | undefined): Promise<Root | null> {
  if (!input) return null;
  const root = await store.getRoot(input);
  if (!root) throw new Error(`Root not found: ${input}`);
  return root;
}

function rootDerivedPath(root: Root, slug: string, name: string, kind: WorkspaceKind, org: string): string {
  const rendered = renderTemplate(root.path_template || root.name_template || "{slug}", {
    slug,
    name,
    kind,
    root: root.slug,
    org,
  });
  return isAbsolute(rendered) ? resolve(rendered) : resolve(join(root.base_path, rendered));
}

export async function planWorkspaceGitHubImport(store: ProjectStore, repoInput: string, options: WorkspaceGitHubImportOptions = {}): Promise<WorkspaceGitHubImportResult> {
  const parsed = parseGitHubRepo(repoInput);
  const protocol = options.remoteProtocol ?? "https";
  const remote = remoteFor(parsed.fullName, protocol);
  const root = await resolveImportRoot(store, options.root);
  const slug = normalizeRepoName(parsed.repo);
  const tags = [...new Set(["github", ...(options.tags ?? [])])];
  const explicitPath = options.path ? resolve(options.path) : undefined;
  const kind = options.kind
    ?? root?.default_kind
    ?? inferWorkspaceKind(slug, explicitPath ?? parsed.fullName, tags);
  const shouldClone = Boolean(options.clone);
  const hasLocalTarget = Boolean(shouldClone || explicitPath || root);
  const remoteOnly = !hasLocalTarget && (options.remoteOnly ?? true);
  const targetPath = remoteOnly
    ? null
    : explicitPath ?? (root ? rootDerivedPath(root, slug, parsed.repo, kind, parsed.org) : resolve(parsed.repo));
  const commands = shouldClone && targetPath ? [shellCommand("gh", ["repo", "clone", remote, targetPath])] : [];

  return {
    status: "planned",
    dry_run: true,
    full_name: parsed.fullName,
    repo_name: parsed.repo,
    org: parsed.org,
    url: `https://github.com/${parsed.fullName}`,
    remote,
    remote_protocol: protocol,
    remote_only: remoteOnly,
    path: targetPath,
    root_id: root?.id ?? null,
    kind: remoteOnly ? "remote-only" : kind,
    tags,
    commands,
  };
}

function findExistingGitHubWorkspace(plan: WorkspaceGitHubImportResult, projects: Workspace[]): Workspace | null {
  const remotes = githubRemoteSet(plan);
  const normalizedFullName = plan.full_name.toLowerCase();
  return projects.find((workspace) => {
    const repo = workspace.integrations.github_repo?.toLowerCase();
    if (repo === normalizedFullName) return true;
    const url = workspace.integrations.github_url?.toLowerCase();
    if (url === plan.url.toLowerCase()) return true;
    return workspace.git_remote ? remotes.has(workspace.git_remote) : false;
  }) ?? null;
}

function githubRemoteSet(plan: WorkspaceGitHubImportResult): Set<string> {
  return new Set([plan.remote, remoteFor(plan.full_name, "https"), remoteFor(plan.full_name, "ssh")]);
}

function gitOrigin(path: string): string | null {
  try {
    return git(path, ["remote", "get-url", "origin"]) || null;
  } catch {
    return null;
  }
}

function existingPathSkipReason(plan: WorkspaceGitHubImportResult): string | null {
  if (!plan.path || !existsSync(plan.path)) return null;
  if (!isGitRepo(plan.path)) return "path-exists-not-git";
  const origin = gitOrigin(plan.path);
  if (!origin) return "path-exists-git-without-origin";
  if (!githubRemoteSet(plan).has(origin)) return "path-exists-git-remote-mismatch";
  return null;
}

async function reconciledGitHubWorkspace(store: ProjectStore, workspace: Workspace, plan: WorkspaceGitHubImportResult, options: WorkspaceGitHubImportOptions): Promise<Workspace> {
  const integrations = { ...workspace.integrations, ...workspaceGithubIntegrations(plan.full_name, plan.url) };
  return store.updateProject(workspace.id, {
    git_remote: workspace.git_remote ?? plan.remote,
    integrations,
    agent_id: options.agent_id,
    source: options.source ?? "cli",
    prompt: options.prompt,
    command: options.command ?? "workspaces import-github",
  });
}

export async function importWorkspaceFromGitHub(store: ProjectStore, repoInput: string, options: WorkspaceGitHubImportOptions = {}): Promise<WorkspaceGitHubImportResult> {
  const plan = await planWorkspaceGitHubImport(store, repoInput, options);
  if (options.dryRun) return plan;

  const locks = await acquireImportLocks(store, githubImportLocks(plan), options.agent_id);
  try {
    // Dedup against the registry through the active Store (cloud in api mode,
    // sqlite in local) so imports never create duplicate rows on the wrong side.
    const projects = await store.listProjects({ limit: 10000 });
    const existingByIdentity = findExistingGitHubWorkspace(plan, projects);
    if (existingByIdentity) {
      const workspace = await reconciledGitHubWorkspace(store, existingByIdentity, plan, options);
      return { ...plan, status: "skipped", dry_run: false, workspace, skipped: "github-already-registered" };
    }
    if (plan.path) {
      const targetPath = resolve(plan.path);
      const existingByPath = projects.find((w) => w.primary_path && resolve(w.primary_path) === targetPath) ?? null;
      if (existingByPath) {
        return { ...plan, status: "skipped", dry_run: false, workspace: existingByPath, skipped: "path-already-registered" };
      }
      const existingPathReason = existingPathSkipReason(plan);
      if (existingPathReason) {
        return { ...plan, status: "skipped", dry_run: false, skipped: existingPathReason };
      }
    }
    const importSlug = workspaceSlugify(plan.repo_name);
    const existingBySlug = projects.find((w) => w.slug === importSlug) ?? null;
    if (existingBySlug) {
      return { ...plan, status: "skipped", dry_run: false, workspace: existingBySlug, skipped: "slug-already-registered" };
    }

    let cloned = false;
    if (options.clone && plan.path && !existsSync(plan.path)) {
      gh(["repo", "clone", plan.remote, plan.path]);
      cloned = true;
    }

    const workspace = await store.createProject({
      name: plan.repo_name,
      slug: importSlug,
      kind: plan.kind,
      root_id: plan.root_id ?? undefined,
      primary_path: plan.path ?? undefined,
      git_remote: plan.remote,
      tags: plan.tags,
      integrations: workspaceGithubIntegrations(plan.full_name, plan.url),
      metadata: {
        github_imported: true,
        github_full_name: plan.full_name,
        remote_only: plan.remote_only,
        cloned,
      },
      agent_id: options.agent_id,
      source: options.source ?? "cli",
      prompt: options.prompt,
      command: options.command ?? "workspaces import-github",
    });
    await store.recordEvent(workspace.id, {
      agentId: options.agent_id,
      event_type: "github_imported",
      source: options.source ?? "cli",
      prompt: options.prompt,
      command: options.command ?? "workspaces import-github",
      after: plan as unknown as JsonObject,
    });

    return { ...plan, status: "imported", dry_run: false, workspace };
  } finally {
    await releaseImportLocks(store, locks);
  }
}

export interface WorkspaceGitHubRootSyncOptions extends Omit<WorkspaceGitHubImportOptions, "root" | "path" | "remoteOnly" | "dryRun"> {
  root?: string;
  repoPrefix?: string;
  limit?: number;
  clone?: boolean;
  dryRun?: boolean;
  repoNamesByOrg?: Record<string, string[]>;
}

export interface WorkspaceGitHubRootSyncRootResult {
  root: Root;
  repos: string[];
  results: WorkspaceGitHubImportResult[];
  errors: Array<{ repo: string; error: string }>;
}

export interface WorkspaceGitHubRootSyncResult {
  dry_run: boolean;
  roots: WorkspaceGitHubRootSyncRootResult[];
  imported: WorkspaceGitHubImportResult[];
  planned: WorkspaceGitHubImportResult[];
  skipped: WorkspaceGitHubImportResult[];
  errors: Array<{ root: string; repo: string; error: string }>;
}

function listGitHubRepoNames(org: string, limit: number): string[] {
  const output = gh(["repo", "list", org, "--limit", String(limit), "--json", "name", "--jq", ".[].name"]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function githubSyncRoots(store: ProjectStore, options: WorkspaceGitHubRootSyncOptions): Promise<Root[]> {
  const roots = (await store.listRoots()).filter((root) => root.github_org);
  const filtered = options.root
    ? roots.filter((root) => root.id === options.root || root.slug === options.root)
    : roots;
  if (options.root && filtered.length === 0) throw new Error("GitHub root not found: " + options.root);
  return filtered;
}

export async function syncWorkspaceGitHubRoots(store: ProjectStore, options: WorkspaceGitHubRootSyncOptions = {}): Promise<WorkspaceGitHubRootSyncResult> {
  const dryRun = Boolean(options.dryRun);
  const result: WorkspaceGitHubRootSyncResult = {
    dry_run: dryRun,
    roots: [],
    imported: [],
    planned: [],
    skipped: [],
    errors: [],
  };
  for (const root of await githubSyncRoots(store, options)) {
    const org = root.github_org!;
    const repoNames = (options.repoNamesByOrg?.[org] ?? listGitHubRepoNames(org, options.limit ?? 500))
      .filter((name) => !options.repoPrefix || name.startsWith(options.repoPrefix));
    const rootResult: WorkspaceGitHubRootSyncRootResult = { root, repos: repoNames, results: [], errors: [] };
    for (const repo of repoNames) {
      try {
        const item = await importWorkspaceFromGitHub(store, org + "/" + repo, {
          root: root.id,
          clone: options.clone ?? !dryRun,
          tags: options.tags,
          kind: options.kind,
          visibility: options.visibility,
          remoteProtocol: options.remoteProtocol,
          dryRun,
          agent_id: options.agent_id,
          source: options.source ?? "cli",
          prompt: options.prompt,
          command: options.command ?? (dryRun ? "projects scan-roots" : "projects sync-roots"),
        });
        rootResult.results.push(item);
        if (item.status === "planned") result.planned.push(item);
        if (item.status === "imported") result.imported.push(item);
        if (item.status === "skipped") result.skipped.push(item);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        rootResult.errors.push({ repo, error });
        result.errors.push({ root: root.slug, repo, error });
      }
    }
    result.roots.push(rootResult);
  }
  return result;
}
export async function linkWorkspaceExternalIntegrations(
  store: ProjectStore,
  workspace: Workspace,
  integrations: WorkspaceIntegrations,
  options: Pick<WorkspaceGitHubPublishOptions, "agent_id" | "source" | "prompt" | "command"> = {},
): Promise<Workspace> {
  // Merge onto the current integrations client-side (ignoring empty values) and
  // persist through the Store so the link lands wherever the project lives.
  const merged: WorkspaceIntegrations = { ...workspace.integrations };
  for (const [key, value] of Object.entries(normalizeWorkspaceIntegrations(integrations))) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) merged[key] = trimmed;
  }
  return store.updateProject(workspace.id, {
    integrations: merged,
    agent_id: options.agent_id,
    source: options.source ?? "cli",
    prompt: options.prompt,
    command: options.command,
  });
}
