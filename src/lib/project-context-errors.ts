export const PROJECT_CONTEXT_ERROR_CODES = [
  "PROJECT_ALREADY_REGISTERED",
  "PROJECT_IDENTITY_CONFLICT",
  "PROJECT_ARCHIVED",
  "PROJECT_DELETED",
  "PROJECT_MARKER_ORPHANED",
  "PROJECT_MARKER_INVALID",
  "PROJECT_AUTHORITY_UNAVAILABLE",
  "PROJECT_NOT_FOUND",
  "PROJECT_PATH_INVALID",
  "PROJECT_IDEMPOTENCY_KEY_REUSED",
  "PROJECT_CONTEXT_BUNDLE_TOO_LARGE",
  "PROJECT_CONTEXT_BUNDLE_INVALID",
] as const;

export type ProjectContextErrorCode = typeof PROJECT_CONTEXT_ERROR_CODES[number];

export interface CanonicalProjectSummary {
  id: string;
  slug: string;
  status: string;
}

export function canonicalProjectSummary(
  project: { id: string; slug: string; status: string },
): CanonicalProjectSummary {
  return { id: project.id, slug: project.slug, status: project.status };
}

export class ProjectContextError extends Error {
  readonly code: ProjectContextErrorCode;
  readonly status: number;
  readonly project?: CanonicalProjectSummary;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ProjectContextErrorCode,
    message: string,
    options: {
      status?: number;
      project?: { id: string; slug: string; status: string } | CanonicalProjectSummary;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProjectContextError";
    this.code = code;
    this.status = options.status ?? 409;
    this.project = options.project ? canonicalProjectSummary(options.project) : undefined;
    this.details = options.details;
  }
}

export function isProjectContextError(error: unknown): error is ProjectContextError {
  return error instanceof ProjectContextError
    || Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && PROJECT_CONTEXT_ERROR_CODES.includes(String((error as { code: unknown }).code) as ProjectContextErrorCode),
    );
}
