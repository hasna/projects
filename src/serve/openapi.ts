// OpenAPI 3.1 document for projects-serve. Single source of truth for the
// served /openapi.json and for the generated SDK (scripts/generate-sdk.ts uses
// @hasna/contracts/sdk `generateSdkFromOpenApi` on this exact object).

export function buildOpenApiSpec(version: string): Record<string, unknown> {
  const ID_PARAM = {
    name: "id",
    in: "path",
    required: true,
    description: "Resource id or slug",
    schema: { type: "string" },
  } as const;

  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const jsonBody = (schemaName: string, required = true) => ({
    required,
    content: { "application/json": { schema: ref(schemaName) } },
  });
  const jsonResp = (schemaName: string, description = "OK") => ({
    description,
    content: { "application/json": { schema: ref(schemaName) } },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Projects API",
      version,
      description:
        "Self-hosted HTTP API for @hasna/projects (workspace/project management). Amendment A1 pure-remote: reads and writes go directly to cloud Postgres. All /v1 routes require an API key (x-api-key or Authorization: Bearer).",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: {
        Root: {
          type: "object",
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
            base_path: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            default_kind: { type: "string", nullable: true },
            repo_visibility: { type: "string", nullable: true },
            allowed_recipes: { type: "array", items: { type: "string" } },
            allowed_agents: { type: "array", items: { type: "string" } },
            metadata: { type: "object", additionalProperties: true },
            created_at: { type: "string" },
            updated_at: { type: "string" },
          },
          required: ["id", "slug", "name", "base_path"],
        },
        CreateRoot: {
          type: "object",
          properties: {
            name: { type: "string" },
            base_path: { type: "string" },
            slug: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            default_kind: { type: "string" },
            repo_visibility: { type: "string", enum: ["public", "private"] },
            github_org: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
          required: ["name", "base_path"],
        },
        UpdateRoot: {
          type: "object",
          properties: {
            name: { type: "string" },
            base_path: { type: "string" },
            slug: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            default_kind: { type: "string" },
            repo_visibility: { type: "string", enum: ["public", "private"] },
            github_org: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
        Agent: {
          type: "object",
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
            kind: { type: "string", enum: ["human", "ai", "service", "cli"] },
            provider: { type: "string", nullable: true },
            model: { type: "string", nullable: true },
            role: { type: "string", nullable: true },
            permissions: { type: "array", items: { type: "string" } },
            metadata: { type: "object", additionalProperties: true },
            created_at: { type: "string" },
            updated_at: { type: "string" },
          },
          required: ["id", "slug", "name", "kind"],
        },
        CreateAgent: {
          type: "object",
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: ["human", "ai", "service", "cli"] },
            slug: { type: "string" },
            provider: { type: "string" },
            model: { type: "string" },
            role: { type: "string" },
            permissions: { type: "array", items: { type: "string" } },
            metadata: { type: "object", additionalProperties: true },
          },
          required: ["name"],
        },
        Recipe: {
          type: "object",
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
            description: { type: "string", nullable: true },
            kind: { type: "string", nullable: true },
            version: { type: "integer" },
            steps: { type: "array", items: { type: "object", additionalProperties: true } },
            default_tags: { type: "array", items: { type: "string" } },
            metadata: { type: "object", additionalProperties: true },
            created_at: { type: "string" },
            updated_at: { type: "string" },
          },
          required: ["id", "slug", "name"],
        },
        CreateRecipe: {
          type: "object",
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            description: { type: "string" },
            kind: { type: "string" },
            version: { type: "integer" },
            steps: { type: "array", items: { type: "object", additionalProperties: true } },
            default_tags: { type: "array", items: { type: "string" } },
            metadata: { type: "object", additionalProperties: true },
          },
          required: ["name"],
        },
        Workspace: {
          type: "object",
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
            description: { type: "string", nullable: true },
            kind: { type: "string" },
            status: { type: "string", enum: ["active", "archived", "deleted"] },
            root_id: { type: "string", nullable: true },
            recipe_id: { type: "string", nullable: true },
            primary_path: { type: "string", nullable: true },
            git_remote: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
            integrations: { type: "object", additionalProperties: true },
            metadata: { type: "object", additionalProperties: true },
            created_at: { type: "string" },
            updated_at: { type: "string" },
          },
          required: ["id", "slug", "name", "kind", "status"],
        },
        CreateWorkspace: {
          type: "object",
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            description: { type: "string" },
            kind: { type: "string" },
            root_id: { type: "string" },
            recipe_id: { type: "string" },
            primary_path: { type: "string" },
            git_remote: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            integrations: { type: "object", additionalProperties: true },
            metadata: { type: "object", additionalProperties: true },
            agent_id: { type: "string" },
          },
          required: ["name"],
        },
        UpdateWorkspace: {
          type: "object",
          properties: {
            name: { type: "string" },
            slug: { type: "string" },
            description: { type: "string", nullable: true },
            kind: { type: "string" },
            status: { type: "string", enum: ["active", "archived", "deleted"] },
            root_id: { type: "string", nullable: true },
            recipe_id: { type: "string", nullable: true },
            primary_path: { type: "string", nullable: true },
            git_remote: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
            integrations: { type: "object", additionalProperties: true },
            metadata: { type: "object", additionalProperties: true },
            agent_id: { type: "string" },
          },
        },
        WorkspaceEvent: {
          type: "object",
          properties: {
            id: { type: "string" },
            workspace_id: { type: "string", nullable: true },
            agent_id: { type: "string", nullable: true },
            event_type: { type: "string" },
            source: { type: "string" },
            metadata: { type: "object", additionalProperties: true },
            created_at: { type: "string" },
          },
          required: ["id", "event_type", "source"],
        },
        WorkspaceList: {
          type: "object",
          properties: {
            workspaces: { type: "array", items: ref("Workspace") },
            count: { type: "integer" },
          },
          required: ["workspaces", "count"],
        },
        RootList: {
          type: "object",
          properties: { roots: { type: "array", items: ref("Root") }, count: { type: "integer" } },
          required: ["roots", "count"],
        },
        AgentList: {
          type: "object",
          properties: { agents: { type: "array", items: ref("Agent") }, count: { type: "integer" } },
          required: ["agents", "count"],
        },
        RecipeList: {
          type: "object",
          properties: { recipes: { type: "array", items: ref("Recipe") }, count: { type: "integer" } },
          required: ["recipes", "count"],
        },
        EventList: {
          type: "object",
          properties: { events: { type: "array", items: ref("WorkspaceEvent") }, count: { type: "integer" } },
          required: ["events", "count"],
        },
        RecordEvent: {
          type: "object",
          properties: {
            event_type: { type: "string" },
            source: { type: "string" },
            agent_id: { type: "string" },
            prompt: { type: "string" },
            command: { type: "string" },
            before: { type: "object", additionalProperties: true, nullable: true },
            after: { type: "object", additionalProperties: true, nullable: true },
            metadata: { type: "object", additionalProperties: true },
          },
          required: ["event_type"],
        },
        EventRecorded: {
          type: "object",
          properties: { event: ref("WorkspaceEvent") },
          required: ["event"],
        },
        DeleteResult: {
          type: "object",
          properties: { deleted: { type: "boolean" }, hard: { type: "boolean" }, id: { type: "string" } },
          required: ["deleted"],
        },
        Health: {
          type: "object",
          properties: { status: { type: "string" }, version: { type: "string" }, mode: { type: "string" } },
          required: ["status", "version", "mode"],
        },
        Error: {
          type: "object",
          properties: { error: { type: "string" }, reason: { type: "string" } },
          required: ["error"],
        },
      },
    },
    security: [{ apiKey: [] }],
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Liveness probe",
          security: [],
          responses: { "200": jsonResp("Health") },
        },
      },
      "/ready": {
        get: {
          operationId: "getReady",
          summary: "Readiness probe (checks DB connectivity)",
          security: [],
          responses: { "200": jsonResp("Health"), "503": jsonResp("Health", "Not ready") },
        },
      },
      "/version": {
        get: {
          operationId: "getVersion",
          summary: "Service version",
          security: [],
          responses: { "200": jsonResp("Health") },
        },
      },
      "/v1/projects": {
        get: {
          operationId: "listProjects",
          summary: "List projects (workspaces)",
          parameters: [
            { name: "status", in: "query", required: false, schema: { type: "string" } },
            { name: "kind", in: "query", required: false, schema: { type: "string" } },
            { name: "root_id", in: "query", required: false, schema: { type: "string" } },
            { name: "query", in: "query", required: false, schema: { type: "string" } },
            { name: "tag", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer" } },
            { name: "offset", in: "query", required: false, schema: { type: "integer" } },
          ],
          responses: { "200": jsonResp("WorkspaceList") },
        },
        post: {
          operationId: "createProject",
          summary: "Create a project (workspace)",
          requestBody: jsonBody("CreateWorkspace"),
          responses: { "201": jsonResp("Workspace", "Created"), "400": jsonResp("Error", "Invalid") },
        },
      },
      "/v1/projects/{id}": {
        get: {
          operationId: "getProject",
          summary: "Get a project by id or slug",
          parameters: [ID_PARAM],
          responses: { "200": jsonResp("Workspace"), "404": jsonResp("Error", "Not found") },
        },
        patch: {
          operationId: "updateProject",
          summary: "Update a project",
          parameters: [ID_PARAM],
          requestBody: jsonBody("UpdateWorkspace"),
          responses: { "200": jsonResp("Workspace"), "404": jsonResp("Error", "Not found") },
        },
        delete: {
          operationId: "deleteProject",
          summary: "Delete a project (soft by default, ?hard=true for hard delete)",
          parameters: [
            ID_PARAM,
            { name: "hard", in: "query", required: false, schema: { type: "boolean" } },
          ],
          responses: { "200": jsonResp("DeleteResult"), "404": jsonResp("Error", "Not found") },
        },
      },
      "/v1/projects/{id}/archive": {
        post: {
          operationId: "archiveProject",
          summary: "Archive a project",
          parameters: [ID_PARAM],
          responses: { "200": jsonResp("Workspace"), "404": jsonResp("Error", "Not found") },
        },
      },
      "/v1/projects/{id}/unarchive": {
        post: {
          operationId: "unarchiveProject",
          summary: "Unarchive a project",
          parameters: [ID_PARAM],
          responses: { "200": jsonResp("Workspace"), "404": jsonResp("Error", "Not found") },
        },
      },
      "/v1/projects/{id}/events": {
        get: {
          operationId: "listProjectEvents",
          summary: "List a project's events",
          parameters: [ID_PARAM, { name: "limit", in: "query", required: false, schema: { type: "integer" } }],
          responses: { "200": jsonResp("EventList"), "404": jsonResp("Error", "Not found") },
        },
        post: {
          operationId: "recordProjectEvent",
          summary: "Record a custom audit event for a project",
          parameters: [ID_PARAM],
          requestBody: jsonBody("RecordEvent"),
          responses: { "201": jsonResp("EventRecorded", "Created"), "400": jsonResp("Error", "Invalid"), "404": jsonResp("Error", "Not found") },
        },
      },
      "/v1/roots": {
        get: {
          operationId: "listRoots",
          summary: "List roots",
          responses: { "200": jsonResp("RootList") },
        },
        post: {
          operationId: "createRoot",
          summary: "Create a root",
          requestBody: jsonBody("CreateRoot"),
          responses: { "201": jsonResp("Root", "Created"), "400": jsonResp("Error", "Invalid") },
        },
      },
      "/v1/roots/{id}": {
        get: {
          operationId: "getRoot",
          summary: "Get a root by id or slug",
          parameters: [ID_PARAM],
          responses: { "200": jsonResp("Root"), "404": jsonResp("Error", "Not found") },
        },
        patch: {
          operationId: "updateRoot",
          summary: "Update a root",
          parameters: [ID_PARAM],
          requestBody: jsonBody("UpdateRoot"),
          responses: { "200": jsonResp("Root"), "404": jsonResp("Error", "Not found") },
        },
        delete: {
          operationId: "deleteRoot",
          summary: "Delete a root",
          parameters: [
            ID_PARAM,
            { name: "detach", in: "query", required: false, schema: { type: "boolean" } },
          ],
          responses: { "200": jsonResp("DeleteResult"), "404": jsonResp("Error", "Not found") },
        },
      },
      "/v1/agents": {
        get: {
          operationId: "listAgents",
          summary: "List agents",
          responses: { "200": jsonResp("AgentList") },
        },
        post: {
          operationId: "createAgent",
          summary: "Create an agent",
          requestBody: jsonBody("CreateAgent"),
          responses: { "201": jsonResp("Agent", "Created"), "400": jsonResp("Error", "Invalid") },
        },
      },
      "/v1/agents/{id}": {
        get: {
          operationId: "getAgent",
          summary: "Get an agent by id or slug",
          parameters: [ID_PARAM],
          responses: { "200": jsonResp("Agent"), "404": jsonResp("Error", "Not found") },
        },
      },
      "/v1/recipes": {
        get: {
          operationId: "listRecipes",
          summary: "List recipes",
          responses: { "200": jsonResp("RecipeList") },
        },
        post: {
          operationId: "createRecipe",
          summary: "Create a recipe",
          requestBody: jsonBody("CreateRecipe"),
          responses: { "201": jsonResp("Recipe", "Created"), "400": jsonResp("Error", "Invalid") },
        },
      },
      "/v1/recipes/{id}": {
        get: {
          operationId: "getRecipe",
          summary: "Get a recipe by id or slug",
          parameters: [ID_PARAM],
          responses: { "200": jsonResp("Recipe"), "404": jsonResp("Error", "Not found") },
        },
      },
    },
  };
}
