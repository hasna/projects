#!/usr/bin/env bun
// Generate the typed projects SDK from the serve OpenAPI document, using
// @hasna/contracts/sdk generateSdkFromOpenApi. Output: src/sdk/client.ts.
// Run: bun run scripts/generate-sdk.ts

import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSdkFromOpenApi } from "@hasna/contracts/sdk";
import { buildOpenApiSpec } from "../src/serve/openapi.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version || "0.0.0";

const spec = buildOpenApiSpec(version);
const { code, operations, warnings } = generateSdkFromOpenApi(spec as never, {
  className: "ProjectsClient",
  apiKeyHeader: "x-api-key",
});

function replaceGeneratedBlock(source: string, expected: string, replacement: string, label: string): string {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(`SDK generator contract changed: expected exactly one ${label} block`);
  }
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

function applyProjectsSdkBoundaries(source: string): string {
  const apiError = `export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
  }
}`;
  const apiErrorWithCode = `function projectErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as Record<string, unknown>)["error"];
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : undefined;
}

export class ApiError extends Error {
  readonly code: string | undefined;

  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = projectErrorCode(body);
  }
}`;
  const contextBundleMethod = `    /** Get a strict, allowlisted project context bundle */
    async getProjectContextBundle(id: string, init?: RequestInit): Promise<ProjectContextBundle> {
      return this.request("GET", \`/v1/projects/\${encodeURIComponent(String(id))}/context-bundle\`, {
        body: undefined,
        query: undefined,
        init,
      });
    }`;
  const validatedContextBundleMethod = `    /** Get and validate a strict, allowlisted project context bundle */
    async getProjectContextBundle(id: string, init?: RequestInit): Promise<ProjectContextBundle> {
      const value = await this.request<unknown>("GET", \`/v1/projects/\${encodeURIComponent(String(id))}/context-bundle\`, {
        body: undefined,
        query: undefined,
        init,
      });
      const bundle = parseProjectContextBundle(value);
      encodeProjectContextBundle(bundle);
      return bundle;
    }`;

  return replaceGeneratedBlock(
    replaceGeneratedBlock(source, apiError, apiErrorWithCode, "ApiError"),
    contextBundleMethod,
    validatedContextBundleMethod,
    "getProjectContextBundle",
  );
}

const banner = `// @generated from the projects-serve OpenAPI document by scripts/generate-sdk.ts.
// DO NOT EDIT BY HAND. Regenerate: bun run sdk:generate
import { encodeProjectContextBundle, parseProjectContextBundle } from "../lib/project-context-bundle.js";

`;
const outPath = join(repoRoot, "src", "sdk", "client.ts");
writeFileSync(outPath, banner + applyProjectsSdkBoundaries(code));

console.error(`Generated ${operations.length} operations -> src/sdk/client.ts`);
if (warnings.length) console.error("Warnings:\n" + warnings.map((w) => `  - ${w}`).join("\n"));
