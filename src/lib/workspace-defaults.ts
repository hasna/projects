import type { Database } from "bun:sqlite";
import { createRecipe, getRecipeBySlug } from "../db/workspaces.js";
import type { CreateRecipeInput, Recipe } from "../types/workspace.js";

const BUILT_IN_RECIPES: CreateRecipeInput[] = [
  { slug: "open-source-typescript-cli", name: "Open Source TypeScript CLI", kind: "open-source", default_tags: ["open-source", "typescript", "cli"], steps: [{ type: "mkdir", path: "{path}/src" }, { type: "file", path: "{path}/README.md" }] },
  { slug: "open-source-mcp-server", name: "Open Source MCP Server", kind: "open-source", default_tags: ["open-source", "mcp", "typescript"], steps: [{ type: "mkdir", path: "{path}/src/mcp" }] },
  { slug: "internal-app", name: "Internal App", kind: "internal-app", default_tags: ["internal", "app"], steps: [{ type: "mkdir", path: "{path}/src" }] },
  { slug: "platform-product", name: "Platform Product", kind: "platform", default_tags: ["platform", "product"], steps: [{ type: "mkdir", path: "{path}/src" }, { type: "mkdir", path: "{path}/docs" }] },
  { slug: "company-website", name: "Company Website", kind: "company-website", default_tags: ["website", "company"], steps: [{ type: "mkdir", path: "{path}/src" }, { type: "mkdir", path: "{path}/assets" }] },
  { slug: "generic-project", name: "Generic Project", kind: "generic", default_tags: ["generic"], steps: [{ type: "mkdir", path: "{path}/docs" }] },
  { slug: "scaffold-template", name: "Scaffold Template", kind: "scaffold", default_tags: ["scaffold", "template"], steps: [{ type: "mkdir", path: "{path}/templates" }] },
  { slug: "docs-research", name: "Docs Research Workspace", kind: "docs", default_tags: ["docs", "research"], steps: [{ type: "mkdir", path: "{path}/notes" }] },
  { slug: "remote-only-github", name: "Remote Only GitHub Registration", kind: "remote-only", default_tags: ["github", "remote-only"], steps: [] },
  { slug: "empty-folder", name: "Empty Arbitrary Folder", kind: "generic", default_tags: ["empty"], steps: [] },
];

export function builtInWorkspaceRecipes(): CreateRecipeInput[] {
  return BUILT_IN_RECIPES.map((recipe) => ({
    ...recipe,
    steps: recipe.steps ? [...recipe.steps] : [],
    default_tags: recipe.default_tags ? [...recipe.default_tags] : [],
  }));
}

export function ensureBuiltInWorkspaceRecipes(db?: Database): { created: Recipe[]; existing: Recipe[] } {
  const created: Recipe[] = [];
  const existing: Recipe[] = [];
  for (const recipe of BUILT_IN_RECIPES) {
    const current = getRecipeBySlug(recipe.slug!, db);
    if (current) {
      existing.push(current);
      continue;
    }
    created.push(createRecipe(recipe, db));
  }
  return { created, existing };
}
