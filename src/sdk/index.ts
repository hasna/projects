// Typed SDK for @hasna/projects — the self_hosted client surface.
//
// The client is GENERATED from the projects-serve OpenAPI document
// (src/sdk/client.ts, regenerate with `bun run sdk:generate`). Client
// self_hosted mode uses PROJECTS_API_URL + PROJECTS_API_KEY (never a DSN).

export * from "./client.js";
import { ProjectsClient, type ProjectsClientOptions } from "./client.js";

export const PROJECTS_API_URL_ENV = "PROJECTS_API_URL";
export const PROJECTS_API_KEY_ENV = "PROJECTS_API_KEY";

/**
 * Build a ProjectsClient from the environment (self_hosted convention):
 *   PROJECTS_API_URL  — base URL of projects-serve (behind the ALB)
 *   PROJECTS_API_KEY  — issued API key (hasna_projects_…)
 */
export function createProjectsClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<ProjectsClientOptions> = {},
): ProjectsClient {
  const baseUrl = overrides.baseUrl ?? env[PROJECTS_API_URL_ENV];
  if (!baseUrl) {
    throw new Error(`projects SDK: set ${PROJECTS_API_URL_ENV} (base URL of projects-serve).`);
  }
  const apiKey = overrides.apiKey ?? env[PROJECTS_API_KEY_ENV];
  return new ProjectsClient({ baseUrl, ...(apiKey ? { apiKey } : {}), ...overrides });
}
