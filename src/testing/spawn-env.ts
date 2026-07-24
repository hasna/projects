/**
 * Test-only helper: build the environment for a spawned `projects` CLI/MCP
 * process.
 *
 * Tests inherit `process.env`, and operator machines routinely export
 * `HASNA_PROJECTS_API_URL` / `HASNA_PROJECTS_API_KEY` so their shell talks to
 * the cloud registry. Inheriting those turns every "local mode" test into an
 * api-mode run against the *real* backend, which both masks local-store
 * regressions and creates real project rows as a side effect of `bun test`.
 *
 * So: strip the api-mode selectors from the inherited environment unless the
 * test explicitly opts into api mode by passing them in `overrides`.
 */
export const API_MODE_ENV_KEYS = ["HASNA_PROJECTS_API_URL", "HASNA_PROJECTS_API_KEY"] as const;

export function testSpawnEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  for (const key of API_MODE_ENV_KEYS) {
    if (!(key in overrides)) delete env[key];
  }
  return { ...env, ...overrides };
}
