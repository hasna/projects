import chalk from "chalk";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  resolveProject,
  listProjects,
} from "../../../db/projects.js";
import { detectCurrentProject } from "../../../lib/detect.js";
import type { Command } from "commander";
import type { Project, ProjectFilter } from "../../../types/index.js";

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function suppressSslWarnings(): () => void {
  const orig = process.emitWarning;
  const handler = (...args: unknown[]) => {
    const msg = args[0];
    const text = typeof msg === "string" ? msg : (msg as Error).message;
    if (text?.includes("SSL modes")) return;
    (orig as (...a: unknown[]) => void)(...args);
  };
  process.emitWarning = handler;
  return () => { process.emitWarning = orig; };
}

export function wantsJsonOutput(opts?: { json?: boolean }): boolean {
  return Boolean(opts?.json || process.env["PROJECTS_JSON"]);
}

export function parsePositiveIntOrExit(raw: string | undefined, flagName: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    console.error(chalk.red(`Invalid value for ${flagName}: ${raw}. Expected a positive integer.`));
    process.exit(1);
  }
  return value;
}

export function exitProjectNotFound(idOrSlug: string): never {
  console.error(chalk.red(`Project not found: ${idOrSlug}`));

  const query = idOrSlug.toLowerCase();
  const candidates = [
    ...listProjects({ status: "active", limit: 500 }),
    ...listProjects({ status: "archived", limit: 500 }),
  ];

  const seen = new Set<string>();
  const matches: Project[] = [];
  for (const project of candidates) {
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    const haystack = `${project.slug} ${project.name}`.toLowerCase();
    if (haystack.includes(query) || project.id.startsWith(idOrSlug)) {
      matches.push(project);
    }
    if (matches.length >= 5) break;
  }

  if (matches.length) {
    console.error(chalk.dim("Did you mean:"));
    for (const project of matches) {
      console.error(chalk.dim(`  - ${project.slug} (${project.id})`));
    }
  } else {
    console.error(chalk.dim("Hint: run `project list --limit 20` to see available project IDs/slugs."));
  }

  process.exit(1);
}

export function resolveProjectOrExit(idOrSlug: string) {
  const project = resolveProject(idOrSlug);
  if (!project) exitProjectNotFound(idOrSlug);
  return project;
}

export function requireProject(idOrSlug: string | undefined): ReturnType<typeof resolveProject> {
  if (idOrSlug) return resolveProject(idOrSlug);
  const detected = detectCurrentProject();
  if (detected) {
    console.log(chalk.dim(`[detected: ${detected.slug}]`));
    return detected;
  }
  return null;
}

export function printProject(p: ReturnType<typeof resolveProject>) {
  if (!p) return;
  console.log(`${chalk.bold(p.name)} ${chalk.dim(`(${p.slug})`)} ${p.status === "archived" ? chalk.yellow("[archived]") : chalk.green("[active]")}`);
  console.log(`  ${chalk.dim("id:")}     ${p.id}`);
  console.log(`  ${chalk.dim("path:")}   ${p.path}`);
  if (p.description) console.log(`  ${chalk.dim("desc:")}   ${p.description}`);
  if (p.tags.length) console.log(`  ${chalk.dim("tags:")}   ${p.tags.join(", ")}`);
  if (p.git_remote) console.log(`  ${chalk.dim("remote:")} ${p.git_remote}`);
  if (p.s3_bucket) console.log(`  ${chalk.dim("s3:")}     s3://${p.s3_bucket}/${p.s3_prefix ?? ""}`);
  console.log(`  ${chalk.dim("created:")} ${p.created_at}`);
}

export type { Command, Project, ProjectFilter };
